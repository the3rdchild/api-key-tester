// Poll: send a request again and again until every check on it passes — for
// the job that's still running, the resource that's eventually consistent,
// the service that's still starting. The checks are the request's own:
// Tests-tab assertions and test() calls from its post-response script.
//
// Deliberately a loop around an ordinary send (routes/send.ts supplies it), so
// every attempt is exactly what Send would do: vars re-read, scripts run,
// cookies kept. Only the last attempt goes into the history, carrying this
// summary — thirty identical "still 202" entries help nobody.

import type {
  PollAttempt,
  PollOutcome,
  PollSettings,
  PollSummary,
  SendResult,
} from '../../shared/collections.ts';

/** Backoff never waits longer than this between two attempts. */
const MAX_WAIT_MS = 30_000;
/** The summary keeps the latest attempts only. */
const LOG_CAP = 100;

export interface PollOptions<T extends { result: SendResult }> {
  settings: PollSettings;
  /** one attempt */
  send: () => Promise<T>;
  signal?: AbortSignal;
  onAttempt?: (attempt: PollAttempt, nextInMs: number | undefined) => void;
  /** an attempt that says retrying is pointless */
  fatal?: (outcome: T) => boolean;
  /** injectable for tests */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

function checksOf(r: SendResult): { passed: number; total: number } {
  const all = [...(r.tests ?? []), ...(r.assertions ?? [])];
  return { passed: all.filter((c) => c.passed).length, total: all.length };
}

/** A 429/503 that says how long to back off: seconds, or an HTTP date. */
export function retryAfterMs(r: SendResult, now = Date.now()): number | undefined {
  if (r.status !== 429 && r.status !== 503) return undefined;
  const raw = Object.entries(r.headers).find(([k]) => k.toLowerCase() === 'retry-after')?.[1]?.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export async function pollUntil<T extends { result: SendResult }>(
  opts: PollOptions<T>,
): Promise<{ outcome: T; poll: PollSummary }> {
  const { settings, signal } = opts;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const started = now();
  const log: PollAttempt[] = [];

  for (let n = 1; ; n++) {
    const outcome = await opts.send();
    const r = outcome.result;
    const { passed, total } = checksOf(r);
    const attempt: PollAttempt = {
      attempt: n,
      at: now() - started,
      status: r.error ? undefined : r.status,
      error: r.error,
      latencyMs: r.latencyMs,
      passed,
      total,
    };
    log.push(attempt);
    if (log.length > LOG_CAP) log.shift();

    let end: PollOutcome | undefined;
    let wait = settings.backoff ? Math.min(MAX_WAIT_MS, settings.intervalMs * 2 ** (n - 1)) : settings.intervalMs;
    wait = Math.max(wait, retryAfterMs(r, now()) ?? 0);
    if (total > 0 && passed === total) end = 'passed';
    else if (signal?.aborted) end = 'cancelled';
    else if (opts.fatal?.(outcome)) end = 'failed';
    else if (n >= settings.maxAttempts) end = 'max-attempts';
    // no point sleeping into the deadline only to stop there
    else if (now() - started + wait >= settings.timeoutMs) end = 'timeout';

    opts.onAttempt?.(attempt, end ? undefined : wait);
    if (!end) {
      await sleep(wait, signal);
      if (signal?.aborted) end = 'cancelled';
    }
    if (end) {
      return { outcome, poll: { outcome: end, attempts: n, elapsedMs: now() - started, log } };
    }
  }
}
