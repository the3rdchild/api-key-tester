// One line of the realtime log.
//
// Rows are immutable once logged, so the row is memoised and only re-renders
// when the view around it changes (pretty on/off, the row above it filtered
// away). JSON is parsed lazily: only when pretty printing or the tree needs it.

import { memo, useMemo, useState } from 'react';

import { JsonTree } from '../JsonTree.tsx';
import { formatBytes } from '../../lib/format.ts';
import type { LogEntry } from './logView.ts';
import type { RealtimeMessageType } from '../../../../shared/collections.ts';

/** Past this, a row shows its head and a "show all" — a few 500 KB frames
 *  rendered in full would stall the log. */
const PREVIEW_CHARS = 2000;

const TYPE_STYLE: Record<RealtimeMessageType, { icon: string; color: string; label: string }> = {
  send: { icon: 'fa-arrow-up', color: 'text-indigo-500', label: 'sent' },
  receive: { icon: 'fa-arrow-down', color: 'text-emerald-500', label: 'received' },
  info: { icon: 'fa-circle-info', color: 'text-slate-400', label: 'info' },
  error: { icon: 'fa-triangle-exclamation', color: 'text-red-500', label: 'error' },
  heartbeat: { icon: 'fa-heart-pulse', color: 'text-pink-400', label: 'heartbeat' },
};

// Literal class strings, so Tailwind sees every one of them.
const EVENT_PALETTE = [
  'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
  'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
  'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/40 dark:text-fuchsia-300',
  'bg-lime-100 text-lime-700 dark:bg-lime-900/40 dark:text-lime-300',
];

/** The same event name always gets the same colour, in the log and its chips. */
export function eventBadgeClass(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return EVENT_PALETTE[Math.abs(h) % EVENT_PALETTE.length]!;
}

function clock(at: number): string {
  const d = new Date(at);
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function delta(ms: number): string {
  if (ms < 1000) return `+${ms} ms`;
  if (ms < 60_000) return `+${(ms / 1000).toFixed(1)} s`;
  return `+${Math.round(ms / 60_000)} min`;
}

/** Cheap pre-check so plain-text frames never pay for a JSON.parse attempt. */
function looksLikeJson(text: string): boolean {
  const c = text.trimStart()[0];
  return c === '{' || c === '[';
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

interface Props {
  m: LogEntry;
  /** time of the row above, for the +Δ column */
  prevAt?: number;
  pretty: boolean;
  onCopy: (text: string) => void;
  /** present only while a resend is possible (ws, connected) */
  onResend?: (text: string) => void;
}

export const LogRow = memo(function LogRow({ m, prevAt, pretty, onCopy, onResend }: Props) {
  const [tree, setTree] = useState(false);
  const [full, setFull] = useState(false);
  const style = TYPE_STYLE[m.type];
  const jsonish = !m.binary && looksLikeJson(m.data);
  const json = useMemo(() => (jsonish && (pretty || tree) ? parseJson(m.data) : undefined), [jsonish, pretty, tree, m.data]);

  const meta = (
    <>
      <span className={`mt-0.5 w-3 shrink-0 text-center ${style.color}`} title={style.label}>
        <i className={`fa-solid ${style.icon}`} />
      </span>
      <span className="mt-0.5 shrink-0 tabular-nums text-slate-400">{clock(m.at)}</span>
      <span className="mt-0.5 w-14 shrink-0 text-right tabular-nums text-slate-300 dark:text-slate-600">
        {prevAt != null ? delta(Math.max(0, m.at - prevAt)) : ''}
      </span>
    </>
  );

  // keyway's own lines: one quiet line, no actions
  if (m.type === 'info' || m.type === 'error' || m.type === 'heartbeat') {
    return (
      <div
        className={`flex gap-2 px-1 py-0.5 ${
          m.type === 'error' ? 'text-red-600 dark:text-red-400' : 'italic text-slate-400'
        }`}
      >
        {meta}
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{m.data || '(empty)'}</span>
        {m.size != null && <span className="mt-0.5 shrink-0 tabular-nums text-slate-400">{formatBytes(m.size)}</span>}
      </div>
    );
  }

  // OpenAI-style end of stream: a divider, not a message
  if (m.type === 'receive' && m.data.trim() === '[DONE]') {
    return (
      <div className="flex items-center gap-2 px-1 py-0.5 text-slate-400">
        {meta}
        <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
        <span className="text-[10px] font-semibold uppercase tracking-wide">[DONE] · stream finished</span>
        <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
      </div>
    );
  }

  const text = m.binary
    ? `⬡ binary · base64 ${m.data}`
    : pretty && json?.ok
      ? JSON.stringify(json.value, null, 2)
      : m.data;
  const clipped = !full && text.length > PREVIEW_CHARS;

  return (
    <div className="group flex gap-2 rounded px-1 py-0.5 hover:bg-slate-50 dark:hover:bg-slate-900">
      {meta}
      <div className="min-w-0 flex-1">
        {(m.event || m.eventId || m.merged) && (
          <div className="mb-0.5 flex gap-1.5 text-[10px]">
            {m.event && <span className={`rounded px-1 font-semibold ${eventBadgeClass(m.event)}`}>{m.event}</span>}
            {m.merged && (
              <span className="rounded border border-slate-300 px-1 text-slate-500 dark:border-slate-600" title="Consecutive LLM deltas, folded into their text">
                {m.merged} delta{m.merged === 1 ? '' : 's'}
              </span>
            )}
            {m.eventId && <span className="text-slate-400">id {m.eventId}</span>}
          </div>
        )}
        {tree && json?.ok ? (
          <div className="-m-2">
            <JsonTree value={json.value} />
          </div>
        ) : (
          <pre
            className={`whitespace-pre-wrap break-words ${
              m.type === 'send' ? 'text-slate-800 dark:text-slate-200' : 'text-slate-700 dark:text-slate-300'
            }`}
          >
            {clipped ? text.slice(0, PREVIEW_CHARS) : text || <span className="italic text-slate-400">(empty)</span>}
          </pre>
        )}
        {clipped && (
          <button
            type="button"
            onClick={() => setFull(true)}
            className="mt-0.5 text-[11px] text-indigo-600 hover:underline dark:text-indigo-400"
          >
            show all {formatBytes(m.size ?? text.length)}
          </button>
        )}
        {m.truncated && (
          <p className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">
            <i className="fa-solid fa-scissors mr-1" />
            frame was {formatBytes(m.size ?? 0)} — only its head is shown
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-start gap-0.5">
        <span className="mt-0.5 tabular-nums text-slate-400">{m.size != null ? formatBytes(m.size) : ''}</span>
        <div className="flex gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
          {jsonish && (
            <RowButton
              icon={tree ? 'fa-align-left' : 'fa-folder-tree'}
              label={tree ? 'Show as text' : 'Show as tree'}
              onClick={() => setTree((v) => !v)}
            />
          )}
          <RowButton icon="fa-copy" label="Copy message" onClick={() => onCopy(m.data)} />
          {m.type === 'send' && onResend && (
            <RowButton icon="fa-rotate-right" label="Send again" onClick={() => onResend(m.data)} />
          )}
        </div>
      </div>
    </div>
  );
});

function RowButton({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="h-5 w-5 rounded text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-700 dark:hover:text-slate-200"
    >
      <i className={`fa-solid ${icon} text-[10px]`} />
    </button>
  );
}
