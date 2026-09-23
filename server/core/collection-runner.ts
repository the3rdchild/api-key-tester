// Run a folder (or the whole collection) request by request.
//
// Sequential on purpose: a run is usually a flow - log in, then use the token -
// and the chaining that makes that work ({{res.…}}, bru.setVar) only means
// anything in order. Parallelism would buy speed and lose the one property the
// runner exists for.
//
// Runner requests deliberately do NOT land in requests-history.jsonl: one run
// of a 30-request folder would evict the entire hand-driven history.

import { nanoid } from 'nanoid';

import { activeEnvVars, applyEnvVarChanges, loadCollections, rootNodes } from './collections.ts';
import { redactedDetail } from './req-history.ts';
import { sendRequest } from './send.ts';
import type {
  CollectionsFile,
  RequestSpec,
  RunCheck,
  RunItemResult,
  RunSummary,
} from '../../shared/collections.ts';

export interface RunOptions {
  /** folder to run; omitted means every request in the collection */
  folderId?: string;
  /** explicit subset - used by "rerun failed" */
  requestIds?: string[];
  /** environment to use; omitted means the active one */
  envId?: string;
  /** pause between requests, to be kind to rate limits */
  delayMs?: number;
  /** stop at the first failing request */
  stopOnFailure?: boolean;
}

type Emitter = (event:
  | { type: 'started'; run: RunSummary }
  | { type: 'item'; runId: string; item: RunItemResult }
  | { type: 'done'; run: RunSummary }) => void;

let emit: Emitter = () => {};
export function setRunEmitter(fn: Emitter): void {
  emit = fn;
}

let cancelRequested = false;
let running: RunSummary | null = null;
const recent: RunSummary[] = [];
const MAX_RECENT = 10;

export function currentRun(): RunSummary | null {
  return running;
}

export function recentRuns(): RunSummary[] {
  return recent;
}

export function cancelRun(): boolean {
  if (!running) return false;
  cancelRequested = true;
  return true;
}

/** Requests in the order the runner will send them. */
export function collectRequests(file: CollectionsFile, opts: RunOptions): RequestSpec[] {
  if (opts.requestIds?.length) {
    return opts.requestIds.map((id) => file.requests[id]).filter((r): r is RequestSpec => !!r);
  }
  // Depth-first, in tree order - a folder that contains folders runs its own
  // requests first, then each subfolder.
  const out: RequestSpec[] = [];
  const walk = (nodeId: string) => {
    const spec = file.requests[nodeId];
    if (spec) {
      out.push(spec);
      return;
    }
    const folder = file.tree.find((n) => n.id === nodeId && n.type === 'folder');
    for (const child of folder?.children ?? []) walk(child);
  };

  if (opts.folderId) {
    walk(opts.folderId);
    return out;
  }
  for (const node of rootNodes(file)) walk(node.id);
  return out;
}

function labelFor(file: CollectionsFile, opts: RunOptions): string {
  if (opts.requestIds?.length) return `${opts.requestIds.length} selected request(s)`;
  if (opts.folderId) {
    return file.tree.find((n) => n.id === opts.folderId)?.name ?? 'folder';
  }
  return 'whole collection';
}

async function varsFor(file: CollectionsFile, envId?: string): Promise<Record<string, string>> {
  if (!envId) return activeEnvVars();
  const env = file.environments.find((e) => e.id === envId);
  if (!env) return activeEnvVars();
  const out: Record<string, string> = {};
  for (const row of env.vars) if (row.enabled && row.key) out[row.key] = row.value;
  return out;
}

export async function runCollection(opts: RunOptions = {}): Promise<RunSummary> {
  if (running) throw new Error('A run is already in progress');

  const file = await loadCollections();
  const specs = collectRequests(file, opts);
  const vars = await varsFor(file, opts.envId);
  const startedAt = Date.now();

  const summary: RunSummary = {
    id: nanoid(10),
    startedAt: new Date(startedAt).toISOString(),
    label: labelFor(file, opts),
    total: specs.length,
    passed: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0,
    items: [],
  };

  running = summary;
  cancelRequested = false;
  emit({ type: 'started', run: summary });

  try {
    for (const [index, spec] of specs.entries()) {
      if (cancelRequested) {
        summary.cancelled = true;
        for (const rest of specs.slice(index)) {
          const item: RunItemResult = {
            requestId: rest.id,
            name: rest.name,
            method: rest.method,
            url: rest.url,
            checks: [],
            passed: false,
            skipped: true,
          };
          summary.items.push(item);
          summary.skipped++;
          emit({ type: 'item', runId: summary.id, item });
        }
        break;
      }

      const outcome = await sendRequest(spec, { vars });
      if (outcome.envVars) await applyEnvVarChanges(outcome.envVars);

      const checks: RunCheck[] = [
        ...(outcome.result.tests ?? []).map((t) => ({
          name: t.name,
          passed: t.passed,
          detail: t.error,
        })),
        ...(outcome.result.assertions ?? []).map((a) => ({
          name: `${a.source} ${a.op}${a.value ? ` ${a.value}` : ''}`,
          passed: a.passed,
          detail: a.error ?? (a.passed ? undefined : `actual: ${a.actual}`),
        })),
      ];

      const item: RunItemResult = {
        requestId: spec.id,
        name: spec.name,
        method: spec.method,
        url: outcome.result.error ? spec.url : spec.url,
        status: outcome.result.error ? undefined : outcome.result.status,
        latencyMs: outcome.result.latencyMs,
        error: outcome.result.error ?? outcome.result.scriptError,
        checks,
        // No transport error, an HTTP status that isn't a failure, and every
        // check green. A 4xx with no assertions counts as a failure - if you
        // meant to assert a 404, say so in the Tests tab.
        passed:
          !outcome.result.error &&
          !outcome.result.scriptError &&
          (checks.length > 0 ? checks.every((c) => c.passed) : outcome.result.ok),
        detail: await redactedDetail(
          spec,
          outcome.sentHeaders,
          outcome.sentBody,
          outcome.result,
          outcome.sentUrl,
        ),
      };

      summary.items.push(item);
      if (item.passed) summary.passed++;
      else summary.failed++;
      emit({ type: 'item', runId: summary.id, item });

      if (!item.passed && opts.stopOnFailure) {
        summary.cancelled = true;
        for (const rest of specs.slice(index + 1)) {
          const skipped: RunItemResult = {
            requestId: rest.id,
            name: rest.name,
            method: rest.method,
            url: rest.url,
            checks: [],
            passed: false,
            skipped: true,
          };
          summary.items.push(skipped);
          summary.skipped++;
          emit({ type: 'item', runId: summary.id, item: skipped });
        }
        break;
      }

      if (opts.delayMs && index < specs.length - 1) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }
    }
  } finally {
    summary.finishedAt = new Date().toISOString();
    summary.durationMs = Date.now() - startedAt;
    running = null;
    cancelRequested = false;
    recent.unshift(summary);
    if (recent.length > MAX_RECENT) recent.pop();
    emit({ type: 'done', run: summary });
  }

  return summary;
}
