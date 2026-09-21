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
  ReqHistoryEntry,
  RequestSpec,
  SendResult,
} from '../../shared/collections.ts';

export const REQ_HISTORY_PATH = resolve(ROOT_DIR, 'requests-history.jsonl');
/** Full responses live next to the index, one file per entry: keeping bodies
 *  inside the JSONL would mean rewriting megabytes every time it is trimmed. */
export const RESPONSE_DIR = resolve(ROOT_DIR, '.history-bodies');

export const MAX_ENTRIES = 200;
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

  await appendFile(REQ_HISTORY_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
  await storeDetail(entry, spec, sentHeaders, sentBody, result, secrets, sentUrl);
  await trim();
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
    const body = result.body ?? '';
    const stored = body.length > STORED_BODY_BYTES ? body.slice(0, STORED_BODY_BYTES) : body;
    const detail: HistoryDetail = {
      entry,
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
    await writeFile(resolve(RESPONSE_DIR, `${entry.id}.json`), JSON.stringify(detail), 'utf8');
  } catch (e) {
    // A response we could not store is not a reason to fail the request.
    console.warn('[history] could not store the response body:', e);
  }
}

export async function getHistoryDetail(id: string): Promise<HistoryDetail | null> {
  const path = resolve(RESPONSE_DIR, `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as HistoryDetail;
  } catch {
    return null;
  }
}

function countChecks(result: SendResult): { passed: number; total: number } | undefined {
  const all = [...(result.tests ?? []), ...(result.assertions ?? [])];
  if (all.length === 0) return undefined;
  return { passed: all.filter((c) => c.passed).length, total: all.length };
}

/** Keep only the newest MAX_ENTRIES lines, and drop the bodies that go with
 *  the lines being evicted. */
async function trim(): Promise<void> {
  if (!existsSync(REQ_HISTORY_PATH)) return;
  const lines = (await readFile(REQ_HISTORY_PATH, 'utf8')).split('\n').filter(Boolean);
  if (lines.length <= MAX_ENTRIES) return;

  const dropped = lines.slice(0, lines.length - MAX_ENTRIES);
  await writeFile(REQ_HISTORY_PATH, `${lines.slice(-MAX_ENTRIES).join('\n')}\n`, 'utf8');
  for (const line of dropped) {
    try {
      const { id } = JSON.parse(line) as { id?: string };
      if (id) await unlink(resolve(RESPONSE_DIR, `${id}.json`)).catch(() => {});
    } catch {
      /* corrupt line - nothing to clean up */
    }
  }
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
  await writeFile(REQ_HISTORY_PATH, '', 'utf8');
  await rm(RESPONSE_DIR, { recursive: true, force: true });
}
