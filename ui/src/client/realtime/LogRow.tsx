// One line of the realtime log.
//
// Rows are immutable once logged, so the row is memoised and only re-renders
// when the view around it changes (pretty on/off, the row above it filtered
// away). JSON is parsed lazily: only when pretty printing or the tree needs it.

import { memo, useMemo, useState } from 'react';

import { JsonTree } from '../JsonTree.tsx';
import { formatBytes } from '../../lib/format.ts';
import type { RealtimeMessage, RealtimeMessageType } from '../../../../shared/collections.ts';

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
  m: RealtimeMessage;
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
        {(m.event || m.eventId) && (
          <div className="mb-0.5 flex gap-1.5 text-[10px]">
            {m.event && (
              <span className="rounded bg-slate-200 px-1 font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                {m.event}
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
