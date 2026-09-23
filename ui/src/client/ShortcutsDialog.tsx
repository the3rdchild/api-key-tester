// "?" : every shortcut on one big panel, grouped, with a filter box - a hover
// tooltip was too small to read and gone the moment the mouse moved.

import { useEffect, useMemo, useState } from 'react';

import { SHORTCUT_GROUPS, type Shortcut } from './shortcuts.ts';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function ShortcutsDialog({ open, onClose }: Props) {
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SHORTCUT_GROUPS;
    const matches = (s: Shortcut) =>
      s.label.toLowerCase().includes(q) ||
      s.keys.some((chord) => chord.join('+').toLowerCase().includes(q));
    return SHORTCUT_GROUPS.map((g) => ({ ...g, items: g.items.filter(matches) })).filter(
      (g) => g.items.length > 0,
    );
  }, [query]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcuts-title"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-slate-200 px-5 py-3 dark:border-slate-800">
          <h2 id="shortcuts-title" className="flex items-center gap-2 text-base font-semibold">
            <i className="fa-solid fa-keyboard text-indigo-500" /> Keyboard shortcuts
          </h2>
          <div className="ml-auto flex items-center gap-2 rounded border border-slate-300 px-2 dark:border-slate-700">
            <i className="fa-solid fa-magnifying-glass text-xs text-slate-400" />
            <label htmlFor="shortcuts-filter" className="sr-only">
              Filter shortcuts
            </label>
            <input
              id="shortcuts-filter"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter…"
              className="h-8 w-40 bg-transparent text-sm focus:outline-none sm:w-56"
            />
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close shortcuts"
            className="h-8 w-8 rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
          >
            <i className="fa-solid fa-xmark" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto p-5">
          {groups.length === 0 ? (
            <p className="py-10 text-center text-sm text-slate-400">No shortcut matches that.</p>
          ) : (
            <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
              {groups.map((group) => (
                <section
                  key={group.title}
                  aria-label={group.title}
                  className="rounded-lg border border-slate-200 p-3 dark:border-slate-800"
                >
                  <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    <i className={`fa-solid ${group.icon}`} /> {group.title}
                  </h3>
                  <ul className="space-y-1">
                    {group.items.map((item) => (
                      <li
                        key={item.label}
                        className="flex items-center gap-3 rounded px-1 py-1.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-800/60"
                      >
                        <span className="min-w-0 flex-1">
                          {item.label}
                          {item.scope && (
                            <span className="ml-1.5 text-[10px] text-slate-400">· {item.scope}</span>
                          )}
                        </span>
                        <span className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                          {item.keys.map((chord, i) => (
                            <span key={chord.join('+')} className="flex items-center gap-1">
                              {i > 0 && <span className="text-[10px] text-slate-400">or</span>}
                              {chord.map((k) => (
                                <kbd
                                  key={k}
                                  className="min-w-[1.5rem] rounded border border-b-2 border-slate-300 bg-slate-50 px-1.5 py-0.5 text-center font-mono text-[11px] text-slate-600 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300"
                                >
                                  {k}
                                </kbd>
                              ))}
                            </span>
                          ))}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>

        <footer className="border-t border-slate-200 px-5 py-2 text-[11px] text-slate-400 dark:border-slate-800">
          Alt-based on purpose: Ctrl+T, Ctrl+W and Ctrl+1…9 belong to the browser and can't be taken
          from a page. On macOS, Ctrl also means ⌘.
        </footer>
      </div>
    </div>
  );
}
