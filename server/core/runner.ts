// Runner: invokes an entry's adapter and persists the result.
// Emits lifecycle hooks so the WS layer can push updates to the UI.

import { nanoid } from 'nanoid';
import { getAdapter } from '../adapters/index.ts';
import type { HistoryEntry, KeyEntry, TestStatus } from '../../shared/types.ts';
import { appendHistory, getKey, setStatus } from './store.ts';

export type RunEvents = {
  onStart?: (keyId: string) => void;
  onDone?: (keyId: string, status: TestStatus) => void;
};

export async function runOne(keyId: string, events?: RunEvents): Promise<KeyEntry | undefined> {
  const entry = await getKey(keyId);
  if (!entry) return undefined;
  if (!entry.testable) {
    const status: TestStatus = {
      state: 'error',
      detail: 'Reference entry — not testable',
      testedAt: new Date().toISOString(),
    };
    await setStatus(keyId, status);
    events?.onDone?.(keyId, status);
    return await getKey(keyId);
  }
  const adapter = getAdapter(entry.provider);
  if (!adapter) {
    const status: TestStatus = {
      state: 'error',
      detail: `No adapter for provider "${entry.provider}"`,
      testedAt: new Date().toISOString(),
    };
    await setStatus(keyId, status);
    events?.onDone?.(keyId, status);
    return await getKey(keyId);
  }

  events?.onStart?.(keyId);
  await setStatus(keyId, { state: 'pending' });

  const result = await adapter.test(entry.credentials);
  const status: TestStatus = {
    state: result.state,
    httpStatus: result.httpStatus,
    latencyMs: result.latencyMs,
    detail: result.detail,
    testedAt: new Date().toISOString(),
    raw: result.raw,
  };
  await setStatus(keyId, status);

  const history: HistoryEntry = {
    id: nanoid(12),
    keyId,
    ts: status.testedAt!,
    state: status.state,
    httpStatus: status.httpStatus,
    latencyMs: status.latencyMs,
    detail: status.detail,
    raw: status.raw,
  };
  await appendHistory(history);

  events?.onDone?.(keyId, status);
  return await getKey(keyId);
}

export interface RunAllOptions {
  concurrency?: number;
  delayMs?: number;
  /** only entries matching these provider ids */
  providers?: string[];
  /** only entries currently in these states */
  states?: string[];
}

export async function runAll(
  options: RunAllOptions = {},
  events?: RunEvents,
): Promise<{ total: number; started: number; skipped: number }> {
  const { concurrency = 4, delayMs = 200, providers, states } = options;
  const { getAllKeys } = await import('./store.ts');
  const all = await getAllKeys();
  const queue = all.filter((k) => {
    if (!k.testable) return false;
    if (providers && providers.length && !providers.includes(k.provider)) return false;
    if (states && states.length && !states.includes(k.status.state)) return false;
    return true;
  });

  let started = 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (cursor < queue.length) {
      const idx = cursor++;
      const entry = queue[idx];
      started++;
      // runOne handles its own status updates + WS events
      await runOne(entry.id, events);
      if (delayMs > 0 && cursor < queue.length) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  });
  await Promise.all(workers);
  return { total: all.length, started, skipped: all.length - started };
}
