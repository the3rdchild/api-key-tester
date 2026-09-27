// Shaping the realtime log for display: counts for the filter chips, the
// filter itself, and folding runs of LLM deltas into one row.

import type { RealtimeMessage, RealtimeMessageType } from '../../../../shared/collections.ts';

export type LogFilter = 'all' | RealtimeMessageType;

/** A log line as displayed — a folded run of deltas says how many it holds. */
export type LogEntry = RealtimeMessage & { merged?: number };

/** SSE's name for an event that didn't give one. */
export const DEFAULT_EVENT = 'message';

export function countByType(log: RealtimeMessage[]): Record<LogFilter, number> {
  const counts: Record<LogFilter, number> = { all: log.length, send: 0, receive: 0, info: 0, error: 0, heartbeat: 0 };
  for (const m of log) counts[m.type]++;
  return counts;
}

/** Received SSE events per name, in order of first appearance. */
export function countEvents(log: RealtimeMessage[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const m of log) {
    if (m.type !== 'receive') continue;
    const name = m.event ?? DEFAULT_EVENT;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts];
}

/** Type chip, then SSE event name (received events only), then a
 *  case-insensitive match on the payload or event name. */
export function filterLog(
  log: RealtimeMessage[],
  filter: LogFilter,
  query: string,
  eventName: string | null = null,
): RealtimeMessage[] {
  const q = query.trim().toLowerCase();
  if (filter === 'all' && !q && !eventName) return log;
  return log.filter(
    (m) =>
      (filter === 'all' || m.type === filter) &&
      (!eventName || (m.type === 'receive' && (m.event ?? DEFAULT_EVENT) === eventName)) &&
      (!q || m.data.toLowerCase().includes(q) || !!m.event?.toLowerCase().includes(q)),
  );
}

/** A completion streams as hundreds of tiny events. Consecutive deltas under
 *  the same event name fold into one row holding their stitched text; any
 *  other event (message_start, usage, [DONE]) breaks the run and stays put. */
export function compactDeltas(log: RealtimeMessage[]): LogEntry[] {
  const out: LogEntry[] = [];
  for (const m of log) {
    const prev = out[out.length - 1];
    if (m.delta != null && prev?.merged && prev.event === m.event) {
      out[out.length - 1] = {
        ...prev,
        data: prev.data + m.delta,
        size: (prev.size ?? 0) + (m.size ?? 0),
        merged: prev.merged + 1,
      };
    } else {
      out.push(m.delta != null ? { ...m, data: m.delta, merged: 1 } : m);
    }
  }
  return out;
}
