// Request history for the API client (separate from history.jsonl, which
// belongs to key testing and is keyed by keyId).
//
// Two rules that matter more than the storage format:
//   1. hard cap of MAX_ENTRIES - this file is a convenience log, not an archive
//   2. nothing secret is ever written: sensitive headers are masked by name,
//      and any value that matches a credential in the vault is scrubbed from
//      previews before the line is appended.

import { readFile, writeFile, appendFile, mkdir, rm, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { nanoid } from 'nanoid';

import { ROOT_DIR, getAllKeys } from './store.ts';
import type {
  HistoryDetail,
  RealtimeHistoryDetail,
  RealtimeMessage,
  RealtimeSpec,
  RealtimeSummary,
  ReqHistoryEntry,
  RequestSpec,
  SendResult,
} from '../../shared/collections.ts';

export const REQ_HISTORY_PATH = resolve(ROOT_DIR, 'requests-history.jsonl');
/** Full responses live next to the index, one file per entry: keeping bodies
 *  inside the JSONL would mean rewriting megabytes every time it is trimmed. */
export const RESPONSE_DIR = resolve(ROOT_DIR, '.history-bodies');

/** How long a request stays in the log. Days read better than a count now that
 *  the UI groups by day: "the last two weeks" is a thing you can picture, "the
 *  last 200 requests" is not. */
export const RETENTION_DAYS = Number(process.env.KEYWAY_HISTORY_DAYS ?? 14);
/** Backstop for a very busy day, so the file cannot grow without bound. */
export const MAX_ENTRIES = 2000;
const PREVIEW_BYTES = 4096;
/** Per-response cap. 200 entries × this is the worst case on disk. */
const STORED_BODY_BYTES = 256 * 1024;

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
  'x-auth-token',
]);

const REDACTED = '«redacted»';

// Every change to the log file goes through here, one at a time. Pinning,
// deleting and rewriting a realtime session's entry read the whole file and
// write it back; a request appended in between would otherwise be lost.
let queue: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

/** Credential fields that are actually secret. A vault entry also stores
 *  baseURL, model and friends - scrubbing those turned "api.deepseek.com/models"
 *  into "«redacted»/models" in the history, which helps nobody. */
const SECRET_FIELDS = new Set([
  'apiKey',
  'apiSecret',
  'secret',
  'token',
  'password',
  'accessKeyId',
  'secretAccessKey',
  'privateKey',
]);

/** Secret values from the vault, longest first so the longest match wins. */
async function secretValues(): Promise<string[]> {
  try {
    const keys = await getAllKeys();
    const out = new Set<string>();
    for (const k of keys) {
      for (const [field, v] of Object.entries(k.credentials ?? {})) {
        if (!SECRET_FIELDS.has(field)) continue;
        if (typeof v === 'string' && v.length >= 8) out.add(v);
      }
    }
    return [...out].sort((a, b) => b.length - a.length);
  } catch {
    return [];
  }
}

function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (out.includes(s)) out = out.split(s).join(REDACTED);
  }
  return out;
}

function maskHeaders(headers: Record<string, string>, secrets: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? REDACTED : scrub(v, secrets);
  }
  return out;
}

function preview(text: string | undefined, secrets: string[]): string | undefined {
  if (!text) return undefined;
  const cut = text.length > PREVIEW_BYTES ? `${text.slice(0, PREVIEW_BYTES)}…` : text;
  return scrub(cut, secrets);
}

export async function record(
  spec: RequestSpec,
  sentHeaders: Record<string, string>,
  sentBody: string | undefined,
  result: SendResult,
  /** the resolved URL; without it the log is a wall of "{{BASE_URL}}" */
  sentUrl?: string,
): Promise<ReqHistoryEntry> {
  const secrets = await secretValues();
  const entry: ReqHistoryEntry = {
    id: nanoid(12),
    requestId: spec.id,
    ts: new Date().toISOString(),
    name: spec.name,
    method: spec.method,
    url: scrub(sentUrl || spec.url, secrets),
    status: result.error ? undefined : result.status,
    statusText: result.statusText,
    latencyMs: result.latencyMs,
    size: result.size,
    error: result.error,
    request: {
      headers: maskHeaders(sentHeaders, secrets),
      bodyPreview: preview(sentBody, secrets),
    },
    responsePreview: preview(result.body, secrets),
    checks: countChecks(result),
  };

  await locked(async () => {
    await appendFile(REQ_HISTORY_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
    await storeDetail(entry, spec, sentHeaders, sentBody, result, secrets, sentUrl);
    await trim();
  });
  return entry;
}

/** Keep the whole response so clicking the entry later shows what came back. */
async function storeDetail(
  entry: ReqHistoryEntry,
  spec: RequestSpec,
  sentHeaders: Record<string, string>,
  sentBody: string | undefined,
  result: SendResult,
  secrets: string[],
  sentUrl?: string,
): Promise<void> {
  try {
    await mkdir(RESPONSE_DIR, { recursive: true });
    const detail: HistoryDetail = {
      entry,
      ...redactDetail(spec, sentHeaders, sentBody, result, secrets, sentUrl),
    };
    await writeFile(resolve(RESPONSE_DIR, `${entry.id}.json`), JSON.stringify(detail), 'utf8');
  } catch (e) {
    // A response we could not store is not a reason to fail the request.
    console.warn('[history] could not store the response body:', e);
  }
}

function redactDetail(
  spec: RequestSpec,
  sentHeaders: Record<string, string>,
  sentBody: string | undefined,
  result: SendResult,
  secrets: string[],
  sentUrl?: string,
): Omit<HistoryDetail, 'entry'> {
  const body = result.body ?? '';
  const stored = body.length > STORED_BODY_BYTES ? body.slice(0, STORED_BODY_BYTES) : body;
  return {
    request: {
      method: spec.method,
      url: scrub(sentUrl || spec.url, secrets),
      headers: maskHeaders(sentHeaders, secrets),
      body: sentBody ? scrub(sentBody, secrets) : undefined,
    },
    result: {
      ...result,
      body: scrub(stored, secrets),
      truncated: result.truncated || stored.length < body.length,
      streamText: result.streamText ? scrub(result.streamText, secrets) : undefined,
    },
  };
}

/** The request and response with the same redaction and size cap history
 *  uses - for callers (the collection runner) that keep it only in memory. */
export async function redactedDetail(
  spec: RequestSpec,
  sentHeaders: Record<string, string>,
  sentBody: string | undefined,
  result: SendResult,
  sentUrl?: string,
): Promise<Omit<HistoryDetail, 'entry'>> {
  return redactDetail(spec, sentHeaders, sentBody, result, await secretValues(), sentUrl);
}

/** An HTTP entry's request + response, or a realtime entry's session. */
export async function getHistoryDetail(id: string): Promise<HistoryDetail | RealtimeHistoryDetail | null> {
  const path = resolve(RESPONSE_DIR, `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as HistoryDetail | RealtimeHistoryDetail;
  } catch {
    return null;
  }
}

// ─── realtime sessions ──────────────────────────────────────────────────────

/** A realtime session as the recorder hands it over (realtime-history.ts). */
export interface RealtimeRecord {
  spec: RealtimeSpec;
  /** the resolved URL and headers, as they went out */
  url: string;
  headers: Record<string, string>;
  startedAt: number;
  status?: number;
  error?: string;
  summary: RealtimeSummary;
  /** already capped by the recorder; scrubbed here */
  transcript: RealtimeMessage[];
  streamText?: string;
}

/** A {{var}} in an auth field names a secret without being one, so it stays
 *  (that's what makes the reopened session usable). A literal is the secret
 *  itself, and never reaches the disk. */
function guardSecret(value: string | undefined, secrets: string[]): string | undefined {
  if (!value) return value;
  return /\{\{[^}]+\}\}/.test(value) ? scrub(value, secrets) : REDACTED;
}

function redactSpec(spec: RealtimeSpec, secrets: string[]): RealtimeSpec {
  const auth = {
    ...spec.auth,
    token: guardSecret(spec.auth.token, secrets),
    password: guardSecret(spec.auth.password, secrets),
    headerValue: guardSecret(spec.auth.headerValue, secrets),
  };
  if (auth.oauth2) {
    auth.oauth2 = {
      ...auth.oauth2,
      clientSecret: guardSecret(auth.oauth2.clientSecret, secrets),
      password: guardSecret(auth.oauth2.password, secrets),
      refreshToken: guardSecret(auth.oauth2.refreshToken, secrets),
    };
  }
  return {
    ...spec,
    url: scrub(spec.url, secrets),
    headers: spec.headers.map((h) => ({
      ...h,
      value: SENSITIVE_HEADERS.has(h.key.trim().toLowerCase())
        ? (guardSecret(h.value, secrets) ?? '')
        : scrub(h.value, secrets),
    })),
    auth,
    draft: undefined,
    heartbeat: spec.heartbeat && { ...spec.heartbeat, payload: scrub(spec.heartbeat.payload, secrets) },
  };
}

function realtimeEntry(id: string, r: RealtimeRecord, secrets: string[]): ReqHistoryEntry {
  return {
    id,
    // grouped under the day the session started, however long it ran
    ts: new Date(r.startedAt).toISOString(),
    name: r.spec.name || undefined,
    method: r.spec.kind === 'sse' ? 'SSE' : 'WS',
    url: scrub(r.url || r.spec.url, secrets),
    status: r.status,
    error: r.error,
    request: { headers: maskHeaders(r.headers, secrets) },
    kind: r.spec.kind,
    realtime: r.summary,
  };
}

async function storeRealtimeDetail(entry: ReqHistoryEntry, r: RealtimeRecord, secrets: string[]): Promise<void> {
  try {
    await mkdir(RESPONSE_DIR, { recursive: true });
    const detail: RealtimeHistoryDetail = {
      entry,
      spec: redactSpec(r.spec, secrets),
      request: { url: entry.url, headers: entry.request.headers },
      transcript: r.transcript.map((m) => ({ ...m, data: scrub(m.data, secrets) })),
      streamText: r.streamText ? scrub(r.streamText, secrets) : undefined,
    };
    await writeFile(resolve(RESPONSE_DIR, `${entry.id}.json`), JSON.stringify(detail), 'utf8');
  } catch (e) {
    console.warn('[history] could not store the realtime session:', e);
  }
}

/** First write of a session: when it connects, or fails to. */
export async function recordRealtime(r: RealtimeRecord): Promise<ReqHistoryEntry> {
  const secrets = await secretValues();
  const entry = realtimeEntry(nanoid(12), r, secrets);
  await locked(async () => {
    await appendFile(REQ_HISTORY_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
    await storeRealtimeDetail(entry, r, secrets);
    await trim();
  });
  return entry;
}

/** Rewrite a session's entry in place (keeping its pin). Null when the entry
 *  is gone — deleted or cleared while the session ran — and stays gone. */
export async function updateRealtime(id: string, r: RealtimeRecord): Promise<ReqHistoryEntry | null> {
  const secrets = await secretValues();
  const next = realtimeEntry(id, r, secrets);
  const updated = await rewrite(id, (old) => ({ ...next, pinned: old.pinned }));
  if (updated) await storeRealtimeDetail(updated, r, secrets);
  return updated;
}

function countChecks(result: SendResult): { passed: number; total: number } | undefined {
  const all = [...(result.tests ?? []), ...(result.assertions ?? [])];
  if (all.length === 0) return undefined;
  return { passed: all.filter((c) => c.passed).length, total: all.length };
}

/** Drop entries older than RETENTION_DAYS, and anything past MAX_ENTRIES if a
 *  single stretch was busy enough to reach it. Pinned entries survive both:
 *  pinning is how an interesting response outlives its fortnight. */
async function trim(): Promise<void> {
  if (!existsSync(REQ_HISTORY_PATH)) return;
  const lines = (await readFile(REQ_HISTORY_PATH, 'utf8')).split('\n').filter(Boolean);

  const parsed = lines.map((line) => {
    try {
      return { line, entry: JSON.parse(line) as ReqHistoryEntry };
    } catch {
      return { line, entry: null };
    }
  });

  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const evicted = new Set<string>();
  for (const { line, entry } of parsed) {
    if (!entry || entry.pinned) continue;
    if (Date.parse(entry.ts) < cutoff) evicted.add(line);
  }

  // Oldest first, so the backstop drops the stalest unpinned entries.
  const survivors = parsed.filter((p) => !evicted.has(p.line));
  let overflow = survivors.length - MAX_ENTRIES;
  for (const { line, entry } of survivors) {
    if (overflow <= 0) break;
    if (entry?.pinned) continue;
    evicted.add(line);
    overflow--;
  }
  if (evicted.size === 0) return;

  const kept = parsed.filter((p) => !evicted.has(p.line));
  await writeFile(REQ_HISTORY_PATH, `${kept.map((p) => p.line).join('\n')}\n`, 'utf8');

  for (const { line, entry } of parsed) {
    // Match on the original line, not a re-serialised copy of it.
    if (!entry?.id || !evicted.has(line)) continue;
    await unlink(resolve(RESPONSE_DIR, `${entry.id}.json`)).catch(() => {});
  }
}

/** Rewrite the log with one entry changed or removed. */
async function rewrite(
  id: string,
  change: (entry: ReqHistoryEntry) => ReqHistoryEntry | null,
): Promise<ReqHistoryEntry | null> {
  return locked(() => rewriteNow(id, change));
}

async function rewriteNow(
  id: string,
  change: (entry: ReqHistoryEntry) => ReqHistoryEntry | null,
): Promise<ReqHistoryEntry | null> {
  if (!existsSync(REQ_HISTORY_PATH)) return null;
  const lines = (await readFile(REQ_HISTORY_PATH, 'utf8')).split('\n').filter(Boolean);
  let updated: ReqHistoryEntry | null = null;
  const out: string[] = [];

  for (const line of lines) {
    let entry: ReqHistoryEntry;
    try {
      entry = JSON.parse(line) as ReqHistoryEntry;
    } catch {
      out.push(line);
      continue;
    }
    if (entry.id !== id) {
      out.push(line);
      continue;
    }
    const next = change(entry);
    if (next) {
      updated = next;
      out.push(JSON.stringify(next));
    }
  }

  await writeFile(REQ_HISTORY_PATH, out.length ? `${out.join('\n')}\n` : '', 'utf8');
  return updated;
}

export async function setPinned(id: string, pinned: boolean): Promise<ReqHistoryEntry | null> {
  return rewrite(id, (entry) => ({ ...entry, pinned }));
}

export async function deleteEntry(id: string): Promise<boolean> {
  let found = false;
  await rewrite(id, () => {
    found = true;
    return null;
  });
  if (found) await unlink(resolve(RESPONSE_DIR, `${id}.json`)).catch(() => {});
  return found;
}

export async function listHistory(limit = MAX_ENTRIES): Promise<ReqHistoryEntry[]> {
  if (!existsSync(REQ_HISTORY_PATH)) return [];
  const lines = (await readFile(REQ_HISTORY_PATH, 'utf8')).split('\n').filter(Boolean);
  const out: ReqHistoryEntry[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      out.push(JSON.parse(line) as ReqHistoryEntry);
    } catch {
      /* skip corrupt line */
    }
  }
  return out.reverse(); // newest first
}

export async function clearHistory(): Promise<void> {
  await locked(async () => {
    await writeFile(REQ_HISTORY_PATH, '', 'utf8');
    await rm(RESPONSE_DIR, { recursive: true, force: true });
  });
}
