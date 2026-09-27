// Poll, next to Send: resend the request until every check on it passes.
// Idle, it's a button with the settings in a popover (remembered with the
// request); running, it becomes the progress — attempt, checks, countdown to
// the next try — and a Cancel.

import { useEffect, useRef, useState } from 'react';

import { DEFAULT_POLL, hasChecks, type PollSettings, type RequestSpec } from '../../../shared/collections.ts';
import type { Tab } from './useClient.ts';

interface Props {
  spec: RequestSpec;
  polling: Tab['polling'];
  /** a send or poll is already out */
  busy: boolean;
  onSettings: (poll: PollSettings) => void;
  onStart: () => void;
  onCancel: () => void;
}

function Countdown({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, (at - now) / 1000);
  return <>next in {s < 10 ? s.toFixed(1) : Math.round(s)} s</>;
}

export function PollButton({ spec, polling, busy, onSettings, onStart, onCancel }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const settings = { ...DEFAULT_POLL, ...spec.settings?.poll };
  const pollable = hasChecks(spec);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (polling) {
    const a = polling.attempt;
    return (
      <div className="flex h-9 shrink-0 items-center gap-2 rounded border border-indigo-300 px-2 text-xs dark:border-indigo-700">
        <span className="text-indigo-600 dark:text-indigo-400" role="status">
          <i className="fa-solid fa-arrows-rotate fa-spin mr-1" />
          {a ? (
            <>
              attempt {a.attempt}/{settings.maxAttempts}
              <span className="text-slate-500">
                {' '}
                · {a.error ? 'error' : a.status} · {a.passed}/{a.total} checks
              </span>
              {polling.nextAt != null && (
                <span className="text-slate-500">
                  {' '}
                  · <Countdown at={polling.nextAt} />
                </span>
              )}
            </>
          ) : (
            'polling…'
          )}
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-1.5 py-0.5 font-medium text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950"
        >
          Cancel
        </button>
      </div>
    );
  }

  const set = (patch: Partial<PollSettings>) => onSettings({ ...settings, ...patch });
  const num = 'h-7 w-20 rounded border border-slate-300 bg-white px-2 text-xs dark:border-slate-700 dark:bg-slate-800';

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy || !pollable}
        aria-expanded={open}
        title={
          pollable
            ? 'Poll: resend until every check passes (Ctrl+Shift+Enter)'
            : 'Poll resends until the checks pass — add an assertion in the Tests tab first'
        }
        className="h-9 shrink-0 rounded border border-slate-300 px-3 text-sm hover:bg-slate-100 disabled:opacity-40 dark:border-slate-700 dark:hover:bg-slate-800"
      >
        <i className="fa-solid fa-arrows-rotate" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 grid w-72 gap-2 rounded-lg border border-slate-200 bg-white p-3 text-xs shadow-lg dark:border-slate-800 dark:bg-slate-900">
          <p className="font-medium">Poll until the checks pass</p>
          <label className="flex items-center justify-between gap-2">
            Every
            <span>
              <input
                type="number"
                min={0.1}
                step={0.5}
                value={settings.intervalMs / 1000}
                onChange={(e) => set({ intervalMs: Math.max(100, Math.round(Number(e.target.value) * 1000) || 100) })}
                className={num}
              />{' '}
              s
            </span>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={settings.backoff} onChange={(e) => set({ backoff: e.target.checked })} className="accent-indigo-600" />
            Back off — double the wait each time, up to 30 s
          </label>
          <label className="flex items-center justify-between gap-2">
            Give up after
            <span>
              <input
                type="number"
                min={1}
                value={settings.timeoutMs / 1000}
                onChange={(e) => set({ timeoutMs: Math.max(1000, Math.round(Number(e.target.value) * 1000) || 1000) })}
                className={num}
              />{' '}
              s
            </span>
          </label>
          <label className="flex items-center justify-between gap-2">
            or after
            <span>
              <input
                type="number"
                min={1}
                value={settings.maxAttempts}
                onChange={(e) => set({ maxAttempts: Math.max(1, Math.round(Number(e.target.value)) || 1) })}
                className={num}
              />{' '}
              tries
            </span>
          </label>
          <p className="text-[11px] text-slate-400">
            A 429 or 503 with Retry-After waits as long as it asks. Only the last attempt goes into the history.
          </p>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onStart();
            }}
            className="h-8 rounded bg-indigo-600 font-medium text-white hover:bg-indigo-700"
          >
            <i className="fa-solid fa-arrows-rotate" /> Start polling
          </button>
        </div>
      )}
    </div>
  );
}
