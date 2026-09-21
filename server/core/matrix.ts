// Matrix run: one request, many keys and models, side by side.
//
// This is the thing Postman cannot do, because Postman does not know your
// keys. "Which of my eleven gateways is alive, and which answers fastest?" is a
// question you can only answer by asking all of them the same thing at once.
//
// Parallel here, unlike the collection runner: the cells are independent, and
// comparing latency is the point - running them in sequence would just add
// each other's queueing to the numbers.

import { nanoid } from 'nanoid';

import { activeEnvVars } from './collections.ts';
import { sendRequest } from './send.ts';
import { getAllKeys } from './store.ts';
import type {
  MatrixItem,
  MatrixSummary,
  MatrixTarget,
  RequestSpec,
} from '../../shared/collections.ts';

const DEFAULT_CONCURRENCY = 3;
const PREVIEW_CHARS = 240;

type Emitter = (event:
  | { type: 'started'; run: MatrixSummary }
  | { type: 'item'; runId: string; item: MatrixItem }
  | { type: 'done'; run: MatrixSummary }) => void;

let emit: Emitter = () => {};
export function setMatrixEmitter(fn: Emitter): void {
  emit = fn;
}

let running: MatrixSummary | null = null;
let lastRun: MatrixSummary | null = null;

export function currentMatrix(): MatrixSummary | null {
  return running;
}

export function lastMatrix(): MatrixSummary | null {
  return lastRun;
}

export interface MatrixOptions {
  spec: RequestSpec;
  targets: MatrixTarget[];
  concurrency?: number;
}

async function labelFor(target: MatrixTarget): Promise<string> {
  if (target.label) return target.label;
  const parts: string[] = [];
  if (target.keyId) {
    const key = (await getAllKeys()).find((k) => k.id === target.keyId);
    if (key) parts.push(key.label ? `${key.provider} · ${key.label}` : key.provider);
  }
  if (target.model) parts.push(target.model);
  if (target.baseURL && parts.length === 0) parts.push(target.baseURL);
  return parts.join(' · ') || 'target';
}

export async function runMatrix(opts: MatrixOptions): Promise<MatrixSummary> {
  if (running) throw new Error('A matrix run is already in progress');
  if (opts.targets.length === 0) throw new Error('Pick at least one key or model');

  const baseVars = await activeEnvVars();
  const summary: MatrixSummary = {
    id: nanoid(10),
    startedAt: new Date().toISOString(),
    requestName: opts.spec.name,
    total: opts.targets.length,
    items: [],
  };
  running = summary;
  emit({ type: 'started', run: summary });

  const queue = [...opts.targets];
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? DEFAULT_CONCURRENCY, 8));

  const worker = async () => {
    for (;;) {
      const target = queue.shift();
      if (!target) return;
      const label = await labelFor(target);

      // Per-cell variables: a body that says "model": "{{model}}" is how one
      // request becomes eleven.
      const vars = { ...baseVars };
      if (target.model) vars.model = target.model;
      if (target.baseURL) vars.baseURL = target.baseURL;

      const spec: RequestSpec = {
        ...opts.spec,
        id: `${opts.spec.id}_${nanoid(6)}`,
        auth: target.keyId ? { type: 'vault', keyId: target.keyId } : opts.spec.auth,
      };

      let item: MatrixItem;
      try {
        const outcome = await sendRequest(spec, { vars });
        const r = outcome.result;
        const text = r.streamText || r.body;
        item = {
          label,
          keyId: target.keyId,
          model: target.model,
          status: r.error ? undefined : r.status,
          ok: !r.error && r.ok,
          latencyMs: r.latencyMs,
          ttftMs: r.stream?.ttftMs,
          tokensPerSecond: r.stream?.tokensPerSecond,
          size: r.size,
          error: r.error,
          preview: text ? text.slice(0, PREVIEW_CHARS) : undefined,
        };
      } catch (e) {
        item = { label, keyId: target.keyId, model: target.model, ok: false, error: String(e) };
      }

      summary.items.push(item);
      emit({ type: 'item', runId: summary.id, item });
    }
  };

  try {
    await Promise.all(Array.from({ length: concurrency }, worker));
  } finally {
    summary.finishedAt = new Date().toISOString();
    running = null;
    lastRun = summary;
    emit({ type: 'done', run: summary });
  }
  return summary;
}
