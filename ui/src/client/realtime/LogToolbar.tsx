// Filter bar above the realtime log: one chip per message type (with counts),
// a text filter, pretty-printing, export and clear.

import type { RealtimeMessage, RealtimeMessageType } from '../../../../shared/collections.ts';

export type LogFilter = 'all' | RealtimeMessageType;

const CHIPS: { id: LogFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'send', label: 'Send' },
  { id: 'receive', label: 'Receive' },
  { id: 'info', label: 'Info' },
  { id: 'error', label: 'Error' },
  { id: 'heartbeat', label: 'Heartbeat' },
];

export function countByType(log: RealtimeMessage[]): Record<LogFilter, number> {
  const counts: Record<LogFilter, number> = { all: log.length, send: 0, receive: 0, info: 0, error: 0, heartbeat: 0 };
  for (const m of log) counts[m.type]++;
  return counts;
}

/** Type chip, then a case-insensitive match on the payload or SSE event name. */
export function filterLog(log: RealtimeMessage[], filter: LogFilter, query: string): RealtimeMessage[] {
  const q = query.trim().toLowerCase();
  if (filter === 'all' && !q) return log;
  return log.filter(
    (m) =>
      (filter === 'all' || m.type === filter) &&
      (!q || m.data.toLowerCase().includes(q) || !!m.event?.toLowerCase().includes(q)),
  );
}

interface Props {
  isWs: boolean;
  counts: Record<LogFilter, number>;
  shown: number;
  filter: LogFilter;
  onFilter: (f: LogFilter) => void;
  query: string;
  onQuery: (q: string) => void;
  pretty: boolean;
  onPretty: (v: boolean) => void;
  onExport: () => void;
  onClear: () => void;
}

export function LogToolbar({
  isWs,
  counts,
  shown,
  filter,
  onFilter,
  query,
  onQuery,
  pretty,
  onPretty,
  onExport,
  onClear,
}: Props) {
  // SSE never sends; heartbeat only appears once the stream has had some
  const chips = CHIPS.filter(
    (c) => (c.id !== 'send' || isWs) && (c.id !== 'heartbeat' || counts.heartbeat > 0 || filter === 'heartbeat'),
  );
  const narrowed = filter !== 'all' || query.trim() !== '';
  const btn =
    'h-6 shrink-0 rounded border border-slate-300 px-2 text-[11px] font-medium uppercase tracking-wide text-slate-500 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800';

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-y border-slate-200 px-2 py-1 dark:border-slate-800">
      <div role="group" aria-label="Show messages of type" className="flex flex-wrap items-center gap-0.5">
        {chips.map((c) => {
          const on = filter === c.id;
          const n = counts[c.id];
          return (
            <button
              key={c.id}
              type="button"
              aria-pressed={on}
              onClick={() => onFilter(c.id)}
              className={`h-6 rounded px-2 text-[11px] font-medium uppercase tracking-wide ${
                on
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200'
              }`}
            >
              {c.label}
              {n > 0 && (
                <span
                  className={`ml-1 tabular-nums ${
                    on ? 'text-indigo-100' : c.id === 'error' ? 'text-red-500' : 'text-slate-400'
                  }`}
                >
                  {n}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="ml-auto flex items-center gap-2">
        {narrowed && (
          <span className="text-[11px] tabular-nums text-slate-400">
            {shown}/{counts.all}
          </span>
        )}
        <label htmlFor="rt-log-filter" className="sr-only">
          Filter messages
        </label>
        <input
          id="rt-log-filter"
          type="search"
          value={query}
          placeholder="Filter…"
          onChange={(e) => onQuery(e.target.value)}
          className="h-6 w-32 rounded border border-slate-300 bg-white px-2 text-xs dark:border-slate-700 dark:bg-slate-800"
        />
        <label className="flex cursor-pointer items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">
          <input type="checkbox" checked={pretty} onChange={(e) => onPretty(e.target.checked)} className="accent-indigo-600" />
          Pretty
        </label>
        <button type="button" onClick={onExport} disabled={shown === 0} className={`${btn} disabled:opacity-40`} title="Download the shown messages as JSON Lines">
          Export
        </button>
        <button type="button" onClick={onClear} className={btn}>
          Clear
        </button>
      </div>
    </div>
  );
}
