// Ctrl+K: one box that finds a saved request, a past response, or an action.
//
// The sidebar stops being a practical way to find things somewhere around the
// third imported collection - by then the tree is deeper than the panel is
// tall. Search is the answer to that, and a palette gives commands a home too.

import { useEffect, useMemo, useRef, useState } from 'react';

import type { ReqHistoryEntry, RequestSpec } from '../../../shared/collections.ts';

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  icon: string;
  run: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  requests: RequestSpec[];
  history: ReqHistoryEntry[];
  commands: PaletteCommand[];
  onOpenRequest: (spec: RequestSpec) => void;
  onOpenHistory: (entry: ReqHistoryEntry) => void;
}

type Row =
  | { kind: 'command'; key: string; score: number; command: PaletteCommand }
  | { kind: 'request'; key: string; score: number; spec: RequestSpec }
  | { kind: 'history'; key: string; score: number; entry: ReqHistoryEntry };

/** Substring beats subsequence; a hit in the name beats one in the URL. */
function score(query: string, name: string, secondary = ''): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const n = name.toLowerCase();
  const s = secondary.toLowerCase();
  if (n.startsWith(q)) return 100;
  if (n.includes(q)) return 80;
  if (s.includes(q)) return 50;
  // subsequence: "gcv" matches "Get Current Value"
  let i = 0;
  for (const ch of n) if (ch === q[i]) i++;
  if (i === q.length) return 30;
  return 0;
}

export function CommandPalette({
  open,
  onClose,
  requests,
  history,
  commands,
  onOpenRequest,
  onOpenHistory,
}: Props) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
    }
  }, [open]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];

    for (const command of commands) {
      const s = score(query, command.label);
      if (s > 0) out.push({ kind: 'command', key: `c:${command.id}`, score: s + 5, command });
    }
    for (const spec of requests) {
      const s = score(query, spec.name, spec.url);
      if (s > 0) out.push({ kind: 'request', key: `r:${spec.id}`, score: s, spec });
    }
    // Only search history when asked: it is noisy next to saved requests.
    if (query.length >= 2) {
      const seen = new Set<string>();
      for (const entry of history) {
        if (seen.has(entry.url)) continue;
        const s = score(query, entry.url, entry.name ?? '');
        if (s > 0) {
          seen.add(entry.url);
          out.push({ kind: 'history', key: `h:${entry.id}`, score: s - 10, entry });
        }
      }
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 40);
  }, [query, commands, requests, history]);

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  if (!open) return null;

  const activate = (row: Row | undefined) => {
    if (!row) return;
    onClose();
    if (row.kind === 'command') row.command.run();
    if (row.kind === 'request') onOpenRequest(row.spec);
    if (row.kind === 'history') onOpenHistory(row.entry);
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 p-4 pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onClick={onClose}
    >
      <div
        className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-slate-200 px-3 dark:border-slate-800">
          <i className="fa-solid fa-magnifying-glass text-slate-400" />
          <label htmlFor="palette-input" className="sr-only">
            Search requests, history and commands
          </label>
          <input
            id="palette-input"
            autoFocus
            value={query}
            placeholder="Search requests, history, commands…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, rows.length - 1));
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              }
              if (e.key === 'Enter') {
                e.preventDefault();
                activate(rows[cursor]);
              }
              if (e.key === 'Escape') onClose();
            }}
            className="h-11 flex-1 bg-transparent text-sm focus:outline-none"
          />
          <kbd className="rounded border border-slate-300 px-1 text-[10px] text-slate-400 dark:border-slate-700">
            esc
          </kbd>
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-auto py-1">
          {rows.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-slate-400">Nothing matches that.</p>
          ) : (
            rows.map((row, i) => (
              <button
                key={row.key}
                type="button"
                onMouseEnter={() => setCursor(i)}
                onClick={() => activate(row)}
                className={`flex w-full items-center gap-3 px-3 py-2 text-left text-xs ${
                  i === cursor ? 'bg-indigo-50 dark:bg-slate-800' : ''
                }`}
              >
                {row.kind === 'command' && (
                  <>
                    <i className={`fa-solid ${row.command.icon} w-4 text-slate-400`} />
                    <span className="flex-1">{row.command.label}</span>
                    {row.command.hint && (
                      <kbd className="rounded border border-slate-300 px-1 text-[10px] text-slate-400 dark:border-slate-700">
                        {row.command.hint}
                      </kbd>
                    )}
                  </>
                )}
                {row.kind === 'request' && (
                  <>
                    <span className="w-10 shrink-0 font-mono font-semibold text-slate-500">
                      {row.spec.method}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{row.spec.name}</span>
                      <span className="block truncate text-[10px] text-slate-400">
                        {row.spec.url}
                      </span>
                    </span>
                    <span className="shrink-0 text-[10px] text-slate-400">saved</span>
                  </>
                )}
                {row.kind === 'history' && (
                  <>
                    <span className="w-10 shrink-0 font-mono font-semibold text-slate-500">
                      {row.entry.method}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{row.entry.url}</span>
                    <span className="shrink-0 text-[10px] text-slate-400">
                      {new Date(row.entry.ts).toLocaleDateString()}
                    </span>
                  </>
                )}
              </button>
            ))
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-slate-200 px-3 py-1.5 text-[10px] text-slate-400 dark:border-slate-800">
          <span>↑↓ move</span>
          <span>⏎ open</span>
          <span className="ml-auto">history is searched from two characters</span>
        </div>
      </div>
    </div>
  );
}
