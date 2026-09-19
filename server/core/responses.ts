// Last-response registry, so one request can feed the next:
//
//   {{res.Login.body.access_token}}
//   {{res.r_8fK2.status}}
//
// In memory on purpose - a chained token is short-lived by nature, and keeping
// response bodies on disk would mean keeping secrets on disk. A restart simply
// means re-running the request that produced the value.

import type { RequestSpec, SendResult } from '../../shared/collections.ts';
import type { VarLookup } from './vars.ts';

interface Remembered {
  id: string;
  name: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  latencyMs: number;
  /** parsed when the body was JSON, else the raw text */
  body: unknown;
}

const MAX = 50;
const recent = new Map<string, Remembered>();

export function remember(spec: RequestSpec, result: SendResult): void {
  if (result.error) return;
  let body: unknown = result.body;
  try {
    body = JSON.parse(result.body);
  } catch {
    /* not JSON - keep the text */
  }
  const entry: Remembered = {
    id: spec.id,
    name: spec.name,
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
    latencyMs: result.latencyMs,
    body,
  };
  recent.set(spec.id, entry);
  if (recent.size > MAX) recent.delete(recent.keys().next().value as string);
}

function find(ref: string): Remembered | undefined {
  const byId = recent.get(ref);
  if (byId) return byId;
  const wanted = ref.toLowerCase();
  for (const entry of recent.values()) {
    if (entry.name.toLowerCase() === wanted) return entry;
  }
  return undefined;
}

function walk(value: unknown, path: string[]): unknown {
  let cur: unknown = value;
  for (const segment of path) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(segment);
      if (!Number.isInteger(i)) return undefined;
      cur = cur[i];
      continue;
    }
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}

/** Resolves {{res.<id|name>.<path>}} against the last response of that request. */
export function responseLookup(): VarLookup {
  return (name) => {
    if (!name.startsWith('res.')) return undefined;
    const [, ref, ...path] = name.split('.');
    if (!ref) return undefined;
    const entry = find(ref);
    if (!entry) return undefined;

    const head = path[0];
    let value: unknown;
    if (head === 'status') value = entry.status;
    else if (head === 'statusText') value = entry.statusText;
    else if (head === 'latencyMs') value = entry.latencyMs;
    else if (head === 'headers') value = walk(entry.headers, path.slice(1));
    else if (head === 'body' || head === undefined) value = walk(entry.body, path.slice(1));
    else value = walk(entry.body, path); // allow {{res.Login.access_token}} too

    if (value === undefined || value === null) return undefined;
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  };
}

/** What the UI shows in the "chain from" picker. */
export function listRemembered(): { id: string; name: string; status: number }[] {
  return [...recent.values()].map((e) => ({ id: e.id, name: e.name, status: e.status }));
}
