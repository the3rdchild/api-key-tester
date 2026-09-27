// pollUntil on a fake clock: when it stops (passed, out of tries, out of time,
// cancelled, pointless), how long it waits (interval, backoff, Retry-After),
// and what it reports along the way.

import { describe, expect, test } from 'bun:test';

import { pollUntil, retryAfterMs } from '../server/core/poll.ts';
import { DEFAULT_POLL, emptyRequest, hasChecks, type PollSettings, type SendResult } from '../shared/collections.ts';

type Outcome = { result: SendResult };

function result(patch: Partial<SendResult> = {}): SendResult {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {},
    body: '',
    truncated: false,
    size: 0,
    latencyMs: 10,
    ttfbMs: 5,
    redirects: [],
    setCookies: [],
    ...patch,
  };
}
const passing = (passed: boolean): Partial<SendResult> => ({
  assertions: [{ source: 'status', op: 'eq', value: '200', actual: passed ? '200' : '202', passed }],
});

/** A fake clock: sleeping just moves time on. */
function harness(results: Partial<SendResult>[], settings: Partial<PollSettings> = {}) {
  let t = 0;
  let i = 0;
  const waits: number[] = [];
  const nexts: (number | undefined)[] = [];
  const ctrl = new AbortController();
  const run = () =>
    pollUntil<Outcome>({
      settings: { ...DEFAULT_POLL, intervalMs: 1000, ...settings },
      signal: ctrl.signal,
      send: async () => {
        t += 10;
        return { result: result(results[Math.min(i++, results.length - 1)]) };
      },
      sleep: async (ms) => {
        waits.push(ms);
        t += ms;
      },
      now: () => t,
      onAttempt: (_a, next) => nexts.push(next),
    });
  return { run, waits, nexts, ctrl, sends: () => i };
}

describe('pollUntil', () => {
  test('stops as soon as every check passes, with the log of attempts', async () => {
    const h = harness([passing(false), passing(false), passing(true)]);
    const { outcome, poll } = await h.run();
    expect(poll).toMatchObject({ outcome: 'passed', attempts: 3 });
    expect(poll.log.map((a) => `${a.attempt}:${a.passed}/${a.total}`)).toEqual(['1:0/1', '2:0/1', '3:1/1']);
    expect(outcome.result.assertions?.[0]?.passed).toBe(true);
    expect(h.waits).toEqual([1000, 1000]);
    expect(h.nexts).toEqual([1000, 1000, undefined]); // the last attempt announces no next one
  });

  test('a response without checks never counts as passing', async () => {
    const h = harness([{}], { maxAttempts: 3 });
    expect((await h.run()).poll).toMatchObject({ outcome: 'max-attempts', attempts: 3 });
  });

  test('out of tries', async () => {
    const h = harness([passing(false)], { maxAttempts: 4 });
    const { poll } = await h.run();
    expect(poll).toMatchObject({ outcome: 'max-attempts', attempts: 4 });
    expect(h.waits).toHaveLength(3);
  });

  test('out of time: it stops rather than sleep into the deadline', async () => {
    const h = harness([passing(false)], { timeoutMs: 3500, maxAttempts: 100 });
    const { poll } = await h.run();
    // sends at t=10, 1020, 2030, 3040 — waiting another 1000 would pass 3500
    expect(poll).toMatchObject({ outcome: 'timeout', attempts: 4 });
    expect(poll.elapsedMs).toBeLessThan(3500);
  });

  test('backoff doubles the wait, up to 30 s', async () => {
    const h = harness([passing(false)], { backoff: true, intervalMs: 5000, maxAttempts: 6, timeoutMs: 10 ** 7 });
    await h.run();
    expect(h.waits).toEqual([5000, 10_000, 20_000, 30_000, 30_000]);
  });

  test('a 429 with Retry-After waits as long as it asks, never less than the interval', async () => {
    const h = harness(
      [
        { status: 429, headers: { 'Retry-After': '5' } },
        { status: 503, headers: { 'retry-after': '0' } },
        passing(true),
      ],
      { timeoutMs: 60_000 },
    );
    await h.run();
    expect(h.waits).toEqual([5000, 1000]);
  });

  test('cancelled while waiting: the last attempt comes back', async () => {
    let t = 0;
    const ctrl = new AbortController();
    const { poll } = await pollUntil<Outcome>({
      settings: { ...DEFAULT_POLL, intervalMs: 1000 },
      signal: ctrl.signal,
      send: async () => ({ result: result(passing(false)) }),
      sleep: async (ms) => {
        t += ms;
        ctrl.abort();
      },
      now: () => t,
    });
    expect(poll).toMatchObject({ outcome: 'cancelled', attempts: 1 });
  });

  test('an attempt that could not be sent at all stops it at once', async () => {
    const { poll } = await pollUntil<Outcome>({
      settings: DEFAULT_POLL,
      send: async () => ({ result: result({ error: 'Undefined variable: host' }) }),
      fatal: (o) => !!o.result.error,
      sleep: async () => {},
    });
    expect(poll).toMatchObject({ outcome: 'failed', attempts: 1 });
  });
});

describe('helpers', () => {
  test('retryAfterMs: seconds or an HTTP date, only on 429/503', () => {
    expect(retryAfterMs(result({ status: 429, headers: { 'retry-after': '3' } }))).toBe(3000);
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(retryAfterMs(result({ status: 503, headers: { 'Retry-After': 'Thu, 01 Jan 2026 00:00:07 GMT' } }), now)).toBe(7000);
    expect(retryAfterMs(result({ status: 500, headers: { 'retry-after': '3' } }))).toBeUndefined();
    expect(retryAfterMs(result({ status: 429 }))).toBeUndefined();
  });

  test('hasChecks: an enabled assertion, or test() in the post-response script', () => {
    const spec = emptyRequest('x');
    expect(hasChecks(spec)).toBe(false);
    expect(hasChecks({ ...spec, assertions: [{ source: 'status', op: 'eq', value: '200', enabled: false }] })).toBe(false);
    expect(hasChecks({ ...spec, assertions: [{ source: 'status', op: 'eq', value: '200' }] })).toBe(true);
    expect(hasChecks({ ...spec, scripts: { pre: '', post: "test('ok', () => {})" } })).toBe(true);
  });
});
