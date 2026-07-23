import { useEffect, useState } from 'react';
import { api, type RawResponse } from '../lib/api.ts';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface Row {
  enabled: boolean;
  key: string;
  value: string;
}

interface Persisted {
  method: string;
  url: string;
  params: Row[];
  headers: Row[];
  body: string;
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'QUERY'];
const STORAGE_KEY = 'key-tester:manual-request';

const emptyRow = (): Row => ({ enabled: true, key: '', value: '' });

const DEFAULT_STATE: Persisted = {
  method: 'GET',
  url: '',
  params: [emptyRow()],
  headers: [{ enabled: true, key: 'Content-Type', value: 'application/json' }],
  body: '',
};

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const p = JSON.parse(raw) as Partial<Persisted>;
    return {
      method: p.method || 'GET',
      url: p.url || '',
      params: p.params?.length ? p.params : [emptyRow()],
      headers: p.headers?.length ? p.headers : [emptyRow()],
      body: p.body || '',
    };
  } catch {
    return DEFAULT_STATE;
  }
}

/** Merge enabled param rows into the base URL, preserving any existing query. */
function buildURL(base: string, params: Row[]): string {
  const active = params.filter((p) => p.enabled && p.key.trim());
  if (!active.length) return base.trim();
  const [head, existing = ''] = base.trim().split('?');
  const usp = new URLSearchParams(existing);
  for (const p of active) usp.set(p.key.trim(), p.value);
  const qs = usp.toString();
  return qs ? `${head}?${qs}` : head;
}

export function ManualTesterModal({ open, onClose }: Props) {
  const [method, setMethod] = useState(DEFAULT_STATE.method);
  const [url, setUrl] = useState('');
  const [params, setParams] = useState<Row[]>(DEFAULT_STATE.params);
  const [headers, setHeaders] = useState<Row[]>(DEFAULT_STATE.headers);
  const [body, setBody] = useState('');
  const [showParams, setShowParams] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resp, setResp] = useState<RawResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reqTab, setReqTab] = useState<'body' | 'headers'>('body');
  const [respTab, setRespTab] = useState<'body' | 'headers'>('body');

  // Load persisted request the first time the popup opens.
  useEffect(() => {
    if (!open) return;
    const p = loadPersisted();
    setMethod(p.method);
    setUrl(p.url);
    setParams(p.params);
    setHeaders(p.headers);
    setBody(p.body);
    setShowParams(p.params.some((r) => r.key.trim()));
  }, [open]);

  // Persist on every change while open.
  useEffect(() => {
    if (!open) return;
    const data: Persisted = { method, url, params, headers, body };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      /* ignore quota */
    }
  }, [open, method, url, params, headers, body]);

  // Esc to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const bodyDisabled = method === 'GET' || method === 'HEAD';

  const send = async () => {
    setLoading(true);
    setError(null);
    setResp(null);
    const headerObj: Record<string, string> = {};
    for (const h of headers) {
      if (h.enabled && h.key.trim()) headerObj[h.key.trim()] = h.value;
    }
    try {
      const r = await api.sendRaw({
        method,
        url: buildURL(url, params),
        headers: headerObj,
        body: bodyDisabled ? undefined : body,
      });
      setResp(r);
      setRespTab('body');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setMethod(DEFAULT_STATE.method);
    setUrl('');
    setParams([emptyRow()]);
    setHeaders([{ enabled: true, key: 'Content-Type', value: 'application/json' }]);
    setBody('');
    setResp(null);
    setError(null);
  };

  const activeParamCount = params.filter((p) => p.enabled && p.key.trim()).length;
  const activeHeaderCount = headers.filter((h) => h.enabled && h.key.trim()).length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 sm:p-10"
      onClick={onClose}
    >
      <div
        className="flex h-full max-h-[88vh] w-full max-w-[1400px] flex-col overflow-hidden rounded-lg bg-white shadow-2xl dark:bg-slate-900 dark:border dark:border-slate-800"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title bar */}
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3 dark:border-slate-800">
          <h2 className="text-base font-semibold">
            <i className="fa-solid fa-paper-plane mr-2 text-indigo-500" />
            Manual API tester
            <span className="ml-2 text-xs font-normal text-slate-400">
              custom method · URL · headers · body · query
            </span>
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={reset}
              className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              title="Clear the request"
            >
              <i className="fa-solid fa-eraser" /> Reset
            </button>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            >
              <i className="fa-solid fa-x" />
            </button>
          </div>
        </div>

        {/* Split: request (top) / response (bottom) */}
        <div className="flex min-h-0 flex-1 flex-col">
          {/* ── Request ─────────────────────────────────────────── */}
          <div className="flex min-h-0 flex-1 flex-col overflow-auto border-b-4 border-slate-100 px-5 py-4 dark:border-slate-950">
            {/* method + url + send */}
            <div className="flex gap-2">
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                className="rounded border border-slate-300 bg-white px-2 py-2 text-sm font-mono dark:border-slate-700 dark:bg-slate-800"
              >
                {METHODS.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://api.example.com/path"
                className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-3 py-2 font-mono text-sm dark:border-slate-700 dark:bg-slate-800"
              />
              <button
                onClick={send}
                disabled={loading || !url.trim()}
                className="rounded bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {loading ? <><i className="fa-solid fa-spinner fa-spin" /> Sending</> : <><i className="fa-solid fa-paper-plane" /> Send</>}
              </button>
            </div>

            {/* query params (collapsible) */}
            <button
              onClick={() => setShowParams((s) => !s)}
              className="mt-3 flex items-center gap-1 self-start text-xs font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
            >
              <i className={`fa-solid fa-caret-right transition-transform ${showParams ? 'rotate-90' : ''}`} />
              Query parameters {activeParamCount > 0 && <span className="text-slate-400">({activeParamCount})</span>}
            </button>
            {showParams && (
              <RowEditor rows={params} setRows={setParams} keyPlaceholder="param" />
            )}

            {/* body / headers tabs */}
            <div className="mt-4 flex gap-4 border-b border-slate-200 text-sm dark:border-slate-800">
              <TabBtn active={reqTab === 'body'} onClick={() => setReqTab('body')}>Body</TabBtn>
              <TabBtn active={reqTab === 'headers'} onClick={() => setReqTab('headers')}>
                Headers {activeHeaderCount > 0 && <span className="text-slate-400">({activeHeaderCount})</span>}
              </TabBtn>
            </div>
            <div className="mt-2">
              {reqTab === 'body' ? (
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  disabled={bodyDisabled}
                  spellCheck={false}
                  placeholder={bodyDisabled ? `${method} requests have no body` : '{\n  "key": "value"\n}'}
                  className="h-44 w-full resize-y rounded border border-slate-300 bg-slate-50 p-3 font-mono text-xs leading-relaxed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-950"
                />
              ) : (
                <RowEditor rows={headers} setRows={setHeaders} keyPlaceholder="header" />
              )}
            </div>
          </div>

          {/* ── Response ────────────────────────────────────────── */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 py-4">
            <div className="mb-2 flex items-center gap-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
              Response
              {resp && (
                <span className={`rounded px-2 py-0.5 font-mono text-white ${statusBg(resp.status)}`}>
                  {resp.status} {resp.statusText}
                </span>
              )}
              {resp && <span className="font-mono text-slate-400">{resp.latencyMs} ms</span>}
              {resp?.truncated && <span className="text-amber-500">(truncated)</span>}
              {resp && (
                <span className="ml-auto flex gap-4 normal-case">
                  <TabBtn small active={respTab === 'body'} onClick={() => setRespTab('body')}>Body</TabBtn>
                  <TabBtn small active={respTab === 'headers'} onClick={() => setRespTab('headers')}>
                    Headers ({Object.keys(resp.headers).length})
                  </TabBtn>
                </span>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {error ? (
                <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                  {error}
                </div>
              ) : resp ? (
                respTab === 'body' ? (
                  <pre className="overflow-auto rounded border border-slate-200 bg-slate-50 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words dark:border-slate-800 dark:bg-slate-950">
                    {prettyBody(resp.body) || <span className="italic text-slate-400">(empty body)</span>}
                  </pre>
                ) : (
                  <div className="overflow-auto rounded border border-slate-200 bg-slate-50 p-3 font-mono text-xs dark:border-slate-800 dark:bg-slate-950">
                    {Object.entries(resp.headers).map(([k, v]) => (
                      <div key={k} className="flex gap-2 py-0.5">
                        <span className="shrink-0 text-slate-500">{k}:</span>
                        <span className="break-all text-slate-800 dark:text-slate-200">{v}</span>
                      </div>
                    ))}
                  </div>
                )
              ) : (
                <div className="flex h-full items-center justify-center rounded border border-dashed border-slate-300 text-xs text-slate-400 dark:border-slate-700">
                  {loading ? 'Waiting for response…' : 'Send a request to see the response.'}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function RowEditor({
  rows,
  setRows,
  keyPlaceholder,
}: {
  rows: Row[];
  setRows: React.Dispatch<React.SetStateAction<Row[]>>;
  keyPlaceholder: string;
}) {
  const update = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const add = () => setRows((rs) => [...rs, emptyRow()]);
  const remove = (i: number) => setRows((rs) => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : [emptyRow()]));

  return (
    <div className="mt-2 space-y-1.5">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={r.enabled}
            onChange={(e) => update(i, { enabled: e.target.checked })}
            className="h-4 w-4 accent-indigo-600"
            title="Enable/disable"
          />
          <input
            value={r.key}
            onChange={(e) => update(i, { key: e.target.value })}
            placeholder={keyPlaceholder}
            className="w-1/3 rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs dark:border-slate-700 dark:bg-slate-800"
          />
          <input
            value={r.value}
            onChange={(e) => update(i, { value: e.target.value })}
            placeholder="value"
            className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs dark:border-slate-700 dark:bg-slate-800"
          />
          <button onClick={() => remove(i)} className="px-2 text-slate-400 hover:text-red-500" title="Remove">
            <i className="fa-solid fa-trash" />
          </button>
        </div>
      ))}
      <button onClick={add} className="text-xs text-indigo-600 hover:text-indigo-800">
        <i className="fa-solid fa-plus" /> Add {keyPlaceholder}
      </button>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
  small,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  small?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`-mb-px border-b-2 font-medium ${small ? 'pb-1 text-xs' : 'pb-2 text-sm'} ${
        active
          ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
          : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
      }`}
    >
      {children}
    </button>
  );
}

function statusBg(status: number): string {
  if (status >= 200 && status < 300) return 'bg-emerald-600';
  if (status >= 400) return 'bg-red-600';
  return 'bg-amber-600';
}

function prettyBody(body: string): string {
  if (!body) return '';
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
