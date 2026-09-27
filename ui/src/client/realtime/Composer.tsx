// Message composer for WebSocket tabs: a JSON check with format/minify, the
// payload size, and Alt+↑/↓ to walk back through what was already sent.

import { useMemo, useRef } from 'react';

import { sendMessage, sentHistory } from './useRealtime.ts';
import { formatBytes } from '../../lib/format.ts';

type Check =
  | { kind: 'empty' }
  | { kind: 'text' }
  | { kind: 'json'; value: unknown }
  | { kind: 'invalid'; error: string };

/** Only a payload that opens like an object or array is held to JSON rules;
 *  anything else is plain text and gets no verdict. */
function check(draft: string): Check {
  const t = draft.trim();
  if (!t) return { kind: 'empty' };
  if (t[0] !== '{' && t[0] !== '[') return { kind: 'text' };
  try {
    return { kind: 'json', value: JSON.parse(t) };
  } catch (e) {
    return { kind: 'invalid', error: e instanceof Error ? e.message : String(e) };
  }
}

const encoder = new TextEncoder();

interface Props {
  tabId: string;
  draft: string;
  onDraft: (draft: string) => void;
  connected: boolean;
  onToast: (msg: string) => void;
}

export function Composer({ tabId, draft, onDraft, connected, onToast }: Props) {
  const verdict = useMemo(() => check(draft), [draft]);
  const size = useMemo(() => encoder.encode(draft).length, [draft]);

  // Where Alt+↑/↓ is in the history: -1 is the draft being typed, 0 the last
  // thing sent, 1 the one before... The typed draft is stashed on the way up
  // so walking back down past the newest entry restores it.
  const walk = useRef({ index: -1, stash: '' });

  const send = () => {
    if (!draft) return;
    if (!sendMessage(tabId, draft)) {
      onToast('Not connected');
      return;
    }
    walk.current = { index: -1, stash: '' };
    onDraft('');
  };

  /** +1 = older (Alt+↑), -1 = newer (Alt+↓) */
  const step = (dir: 1 | -1) => {
    const history = sentHistory(tabId);
    const w = walk.current;
    const next = w.index + dir;
    if (next < -1 || next >= history.length) return;
    if (w.index === -1) w.stash = draft;
    w.index = next;
    onDraft(next === -1 ? w.stash : history[history.length - 1 - next]!);
  };

  const reformat = (indent?: number) => {
    if (verdict.kind === 'json') onDraft(JSON.stringify(verdict.value, null, indent));
  };

  const tool =
    'h-6 rounded border border-slate-300 px-2 text-[11px] font-medium uppercase tracking-wide text-slate-500 hover:bg-slate-100 disabled:opacity-40 disabled:hover:bg-transparent dark:border-slate-700 dark:hover:bg-slate-800';

  return (
    <div className="shrink-0 border-t border-slate-200 p-2 dark:border-slate-800">
      <div className="mb-1 flex items-center gap-1.5">
        <label htmlFor="rt-composer" className="mr-auto text-[11px] font-medium uppercase tracking-wide text-slate-500">
          Message
        </label>
        {verdict.kind === 'json' && (
          <span className="rounded-full border border-emerald-500/40 px-2 py-0.5 text-[10px] font-semibold uppercase text-emerald-600 dark:text-emerald-400">
            Valid JSON
          </span>
        )}
        {verdict.kind === 'invalid' && (
          <span
            title={verdict.error}
            className="max-w-[16rem] truncate rounded-full border border-red-500/40 px-2 py-0.5 text-[10px] font-semibold uppercase text-red-600 dark:text-red-400"
          >
            Invalid JSON
          </span>
        )}
        <button type="button" onClick={() => reformat(2)} disabled={verdict.kind !== 'json'} className={tool}>
          Format
        </button>
        <button type="button" onClick={() => reformat()} disabled={verdict.kind !== 'json'} className={tool}>
          Minify
        </button>
        <span className="w-14 text-right text-[11px] tabular-nums text-slate-400">{formatBytes(size)}</span>
      </div>

      <textarea
        id="rt-composer"
        value={draft}
        placeholder={connected ? 'Message to send' : 'Connect to send messages'}
        spellCheck={false}
        onChange={(e) => {
          walk.current.index = -1;
          onDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            send();
          } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            e.preventDefault();
            step(e.key === 'ArrowUp' ? 1 : -1);
          }
        }}
        rows={3}
        className={`block min-h-[2.5rem] w-full resize-y rounded border bg-white px-2 py-1.5 font-mono text-xs dark:bg-slate-800 ${
          verdict.kind === 'invalid' ? 'border-red-400 dark:border-red-500/60' : 'border-slate-300 dark:border-slate-700'
        }`}
      />

      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="text-[11px] text-slate-400">
          <kbd className="font-mono">Ctrl+Enter</kbd> to send · <kbd className="font-mono">Alt+↑↓</kbd> history
        </span>
        <button
          type="button"
          onClick={send}
          disabled={!connected || !draft}
          className="h-8 shrink-0 rounded bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          <i className="fa-solid fa-paper-plane" /> Send
        </button>
      </div>
    </div>
  );
}
