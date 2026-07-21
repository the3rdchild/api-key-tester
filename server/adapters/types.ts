import type { FieldDef, Provider, ProviderKind, TestResult } from '../../shared/types.ts';

export interface Adapter {
  id: Provider;
  label: string;
  kind: ProviderKind;
  fields: FieldDef[];
  defaultSection?: string;
  /** Run a lightweight test (target <3s). Should never throw — return error state. */
  test(creds: Record<string, string>): Promise<TestResult>;
}

/** Convenience: timed fetch with abort. Returns {res, latencyMs} or throws. */
export async function timedFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ res: Response; latencyMs: number }> {
  const { timeoutMs = 6000, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, { ...rest, signal: ctrl.signal });
    return { res, latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

/** Classify an HTTP response into a TestResult based on status + body hint. */
export function classifyResponse(
  res: Response,
  latencyMs: number,
  body: string,
): TestResult {
  const raw = truncateRaw(body);
  if (res.status === 401 || res.status === 403) {
    return { ...invalid(latencyMs, res.status, trim(body) || 'Unauthorized'), raw };
  }
  if (res.status === 429) {
    return { ...rateLimited(latencyMs, res.status, trim(body)), raw };
  }
  if (res.status >= 200 && res.status < 300) {
    return { ...valid(latencyMs, res.status), raw };
  }
  if (res.status >= 500) {
    return { ...errorState(latencyMs, `Upstream ${res.status}: ${trim(body)}`, res.status), raw };
  }
  // 404 / others: ambiguous — treat as error
  return { ...errorState(latencyMs, `HTTP ${res.status}: ${trim(body)}`, res.status), raw };
}

export function valid(latencyMs: number, httpStatus?: number, detail = 'OK'): TestResult {
  return { state: 'valid', httpStatus, latencyMs, detail };
}
export function invalid(latencyMs: number, httpStatus: number, detail: string): TestResult {
  return { state: 'invalid', httpStatus, latencyMs, detail };
}
export function rateLimited(latencyMs: number, httpStatus: number, detail: string): TestResult {
  return { state: 'rate_limited', httpStatus, latencyMs, detail: trim(detail) };
}
export function errorState(latencyMs: number, detail: string, httpStatus?: number): TestResult {
  return { state: 'error', httpStatus, latencyMs, detail };
}

function trim(s: string, max = 240): string {
  const t = (s || '').trim().replace(/\s+/g, ' ');
  return t.length > max ? t.slice(0, max) + '…' : t;
}

const RAW_MAX = 4096;
/** Truncate raw response body for storage (keeps newlines for display). */
function truncateRaw(body: string): string {
  const t = (body || '').trim();
  if (t.length <= RAW_MAX) return t;
  return t.slice(0, RAW_MAX) + `\n…[truncated, ${t.length - RAW_MAX} more bytes]`;
}

export function safe(fn: () => Promise<TestResult>): Promise<TestResult> {
  return fn().catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('aborted') || msg.includes('timeout')) {
      return errorState(0, 'Request timed out');
    }
    return errorState(0, msg);
  });
}
