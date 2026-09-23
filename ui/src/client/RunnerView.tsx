// Collection runner: pick a folder, watch it run, see what failed.
//
// Progress arrives over the same /live socket the client uses, so a run
// started from the CLI (or another window) shows up here too.

import { useCallback, useEffect, useRef, useState } from 'react';

import { ResponsePane } from './ResponsePane.tsx';
import { clientApi } from '../lib/clientApi.ts';
import type {
  CollectionsFile,
  RunItemResult,
  RunSummary,
} from '../../../shared/collections.ts';

interface RunnerState {
  current: RunSummary | null;
  recent: RunSummary[];
}

export function RunnerView() {
  const [file, setFile] = useState<CollectionsFile | null>(null);
  const [folderId, setFolderId] = useState<string>('');
  const [envId, setEnvId] = useState<string>('');
  const [delayMs, setDelayMs] = useState(0);
  const [stopOnFailure, setStopOnFailure] = useState(false);
  const [running, setRunning] = useState<RunSummary | null>(null);
  const [items, setItems] = useState<RunItemResult[]>([]);
  const [last, setLast] = useState<RunSummary | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** `${requestId}-${index}` of the row shown in the detail panel */
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    clientApi.load().then(setFile).catch(() => {});
    fetch('/api/runner/status')
      .then((r) => r.json() as Promise<RunnerState>)
      .then((s) => {
        setRunning(s.current);
        setLast(s.recent[0] ?? null);
        if (s.current) setItems(s.current.items);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/live`);
      wsRef.current = ws;
      ws.onclose = () => {
        if (!closed) retry = setTimeout(connect, 2000);
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as {
            type: string;
            run?: RunSummary;
            item?: RunItemResult;
          };
          if (msg.type === 'run:started' && msg.run) {
            setRunning(msg.run);
            setItems([]);
            setSelected(null);
            setError(null);
          }
          if (msg.type === 'run:item' && msg.item) setItems((prev) => [...prev, msg.item!]);
          if (msg.type === 'run:done' && msg.run) {
            setRunning(null);
            setLast(msg.run);
            setItems(msg.run.items);
          }
        } catch {
          /* ignore */
        }
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  const start = useCallback(
    async (requestIds?: string[]) => {
      setError(null);
      const res = await fetch('/api/runner/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folderId: requestIds ? undefined : folderId || undefined,
          requestIds,
          envId: envId || undefined,
          delayMs: delayMs || undefined,
          stopOnFailure,
        }),
      });
      if (!res.ok) setError(((await res.json()) as { error?: string }).error ?? 'Run failed');
    },
    [folderId, envId, delayMs, stopOnFailure],
  );

  const cancel = () => fetch('/api/runner/cancel', { method: 'POST' });

  const folders = (file?.tree ?? []).filter((n) => n.type === 'folder');
  const shown = running ? items : (last?.items ?? items);
  const summary = running ?? last;
  const failedIds = shown.filter((i) => !i.passed && !i.skipped).map((i) => i.requestId);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectedItem = shown.find((item, i) => `${item.requestId}-${i}` === selected) ?? null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* controls */}
      <div className="flex flex-wrap items-end gap-3 border-b border-slate-200 p-3 dark:border-slate-800">
        <div className="grid gap-1">
          <label htmlFor="run-folder" className="text-xs font-medium text-slate-500">
            Folder
          </label>
          <select
            id="run-folder"
            value={folderId}
            onChange={(e) => setFolderId(e.target.value)}
            className="h-8 rounded border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-800"
          >
            <option value="">Whole collection</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} ({f.children?.length ?? 0})
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-1">
          <label htmlFor="run-env" className="text-xs font-medium text-slate-500">
            Environment
          </label>
          <select
            id="run-env"
            value={envId}
            onChange={(e) => setEnvId(e.target.value)}
            className="h-8 rounded border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-800"
          >
            <option value="">Active one</option>
            {(file?.environments ?? []).map((env) => (
              <option key={env.id} value={env.id}>
                {env.name}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-1">
          <label htmlFor="run-delay" className="text-xs font-medium text-slate-500">
            Delay (ms)
          </label>
          <input
            id="run-delay"
            type="number"
            min={0}
            step={100}
            value={delayMs}
            onChange={(e) => setDelayMs(Number(e.target.value) || 0)}
            className="h-8 w-24 rounded border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-800"
          />
        </div>

        <div className="flex h-8 items-center gap-2">
          <input
            id="run-bail"
            type="checkbox"
            checked={stopOnFailure}
            onChange={(e) => setStopOnFailure(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-indigo-600 dark:border-slate-600 dark:bg-slate-800"
          />
          <label htmlFor="run-bail" className="cursor-pointer text-sm">
            Stop at first failure
          </label>
        </div>

        {running ? (
          <button
            type="button"
            onClick={cancel}
            className="h-8 rounded bg-red-600 px-3 text-sm font-medium text-white hover:bg-red-700"
          >
            <i className="fa-solid fa-stop" /> Cancel
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void start()}
            className="h-8 rounded bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700"
          >
            <i className="fa-solid fa-play" /> Run
          </button>
        )}

        {!running && failedIds.length > 0 && (
          <button
            type="button"
            onClick={() => void start(failedIds)}
            className="h-8 rounded border border-slate-300 px-3 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            <i className="fa-solid fa-rotate-right" /> Rerun {failedIds.length} failed
          </button>
        )}

        <span className="ml-auto text-xs text-slate-400">
          Same run from a terminal:{' '}
          <code className="font-mono">bun scripts/run.ts &lt;folder&gt; --bail</code>
        </span>
      </div>

      {error && (
        <p className="border-b border-red-200 bg-red-50 px-3 py-1 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      )}

      {/* summary */}
      {summary && (
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-3 py-2 text-sm dark:border-slate-800">
          <span className="font-medium">{summary.label}</span>
          {running ? (
            <span className="text-slate-500">
              <i className="fa-solid fa-spinner fa-spin" /> {items.length}/{summary.total}
            </span>
          ) : (
            <>
              <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                {summary.passed} passed
              </span>
              {summary.failed > 0 && (
                <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-950 dark:text-red-200">
                  {summary.failed} failed
                </span>
              )}
              {summary.skipped > 0 && (
                <span className="rounded bg-slate-200 px-2 py-0.5 text-xs text-slate-700 dark:bg-slate-700 dark:text-slate-200">
                  {summary.skipped} skipped
                </span>
              )}
              <span className="text-xs text-slate-400">
                {(summary.durationMs / 1000).toFixed(1)}s
                {summary.cancelled ? ' · cancelled' : ''}
              </span>
            </>
          )}
        </div>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
        {/* results */}
        <div className="min-h-0 min-w-0 flex-1 overflow-auto md:w-1/2 md:flex-none md:border-r md:border-slate-200 md:dark:border-slate-800">
          {shown.length === 0 ? (
            <p className="p-4 text-sm text-slate-400">
              Nothing has run yet. Pick a folder and hit Run — every request goes in order, so
              variables set by one are available to the next.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {shown.map((item, i) => {
                const key = `${item.requestId}-${i}`;
                const open = expanded.has(key);
                const isSelected = selected === key;
                const failedChecks = item.checks.filter((c) => !c.passed);
                return (
                  <li
                    key={key}
                    tabIndex={0}
                    aria-current={isSelected || undefined}
                    onClick={() => setSelected(key)}
                    onKeyDown={(e) => {
                      if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault();
                        setSelected(key);
                      }
                    }}
                    className={`cursor-pointer px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 ${
                      isSelected
                        ? 'bg-indigo-50 dark:bg-indigo-950/50'
                        : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <i
                        className={`fa-solid ${
                          item.skipped
                            ? 'fa-minus text-slate-400'
                            : item.passed
                              ? 'fa-circle-check text-emerald-500'
                              : 'fa-circle-xmark text-red-500'
                        }`}
                      />
                      <span className="w-12 shrink-0 font-mono text-xs text-slate-500">
                        {item.method}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{item.name}</span>
                      {item.checks.length > 0 && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggle(key);
                          }}
                          className="shrink-0 rounded px-1.5 py-0.5 text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          {item.checks.filter((c) => c.passed).length}/{item.checks.length} checks{' '}
                          <i className={`fa-solid ${open ? 'fa-chevron-up' : 'fa-chevron-down'}`} />
                        </button>
                      )}
                      <span className="w-24 shrink-0 text-right font-mono text-xs text-slate-500">
                        {item.skipped ? '—' : item.error ? 'error' : `${item.status} · ${item.latencyMs}ms`}
                      </span>
                    </div>

                    {item.error && (
                      <p className="ml-8 mt-1 text-xs text-red-600 dark:text-red-400">{item.error}</p>
                    )}

                    {!open && failedChecks.length > 0 && (
                      <ul className="ml-8 mt-1">
                        {failedChecks.map((c, j) => (
                          <li key={j} className="text-xs text-red-600 dark:text-red-400">
                            ✗ {c.name}
                            {c.detail ? ` — ${c.detail}` : ''}
                          </li>
                        ))}
                      </ul>
                    )}

                    {open && (
                      <ul className="ml-8 mt-1">
                        {item.checks.map((c, j) => (
                          <li
                            key={j}
                            className={`text-xs ${c.passed ? 'text-slate-500' : 'text-red-600 dark:text-red-400'}`}
                          >
                            {c.passed ? '✓' : '✗'} {c.name}
                            {c.detail ? ` — ${c.detail}` : ''}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* detail */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-t border-slate-200 md:border-t-0 dark:border-slate-800">
          {selectedItem ? (
            <RunItemDetail item={selectedItem} />
          ) : (
            <p className="p-4 text-sm text-slate-400">
              {shown.length ? 'Click a result to see its request and response.' : ''}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function RunItemDetail({ item }: { item: RunItemResult }) {
  const request = item.detail?.request;
  const headers = Object.entries(request?.headers ?? {});

  if (item.skipped) {
    return <p className="p-4 text-sm text-slate-400">Skipped — this request was never sent.</p>;
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <details className="shrink-0 border-b border-slate-200 text-sm dark:border-slate-800">
        <summary className="flex cursor-pointer items-center gap-2 px-3 py-2">
          <span className="font-mono text-xs font-medium text-slate-500">
            {request?.method ?? item.method}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs" title={request?.url ?? item.url}>
            {request?.url ?? item.url}
          </span>
          <span className="shrink-0 text-xs text-slate-400">Request</span>
        </summary>
        <div className="max-h-64 overflow-auto px-3 pb-3">
          <h4 className="mb-1 text-xs font-medium text-slate-500">Headers</h4>
          {headers.length ? (
            <table className="mb-2 w-full font-mono text-xs">
              <tbody>
                {headers.map(([k, v]) => (
                  <tr key={k} className="align-top">
                    <td className="whitespace-nowrap pr-3 text-slate-500">{k}</td>
                    <td className="break-all">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mb-2 text-xs text-slate-400">None</p>
          )}
          {request?.body && (
            <>
              <h4 className="mb-1 text-xs font-medium text-slate-500">Body</h4>
              <pre className="whitespace-pre-wrap break-all rounded bg-slate-50 p-2 font-mono text-xs dark:bg-slate-800/60">
                {request.body}
              </pre>
            </>
          )}
        </div>
      </details>

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <ResponsePane
          result={item.error && !item.detail?.result.status ? undefined : item.detail?.result}
          error={item.error}
          sending={false}
        />
      </div>
    </div>
  );
}
