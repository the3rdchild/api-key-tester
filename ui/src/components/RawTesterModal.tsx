import { useEffect, useState } from 'react';
import type { KeyEntry } from '../../../shared/types.ts';
import { api, type RawResponse } from '../lib/api.ts';
import { buildRequestTemplate } from '../lib/requestTemplate.ts';

interface Props {
  entry: KeyEntry | null;
  onClose: () => void;
}

interface HeaderRow {
  key: string;
  value: string;
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];

function toRows(h: Record<string, string>): HeaderRow[] {
  const rows = Object.entries(h).map(([key, value]) => ({ key, value }));
  return rows.length ? rows : [{ key: '', value: '' }];
}

export function RawTesterModal({ entry, onClose }: Props) {
  const [method, setMethod] = useState('POST');
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState<HeaderRow[]>([{ key: '', value: '' }]);
  const [body, setBody] = useState('');
  const [note, setNote] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [prepping, setPrepping] = useState(false);
  const [resp, setResp] = useState<RawResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'body' | 'headers'>('body');

  // (Re)build the template whenever a new entry opens the modal.
  useEffect(() => {
    if (!entry) return;
    let cancelled = false;
    setPrepping(true);
    setResp(null);
    setError(null);
    setTab('body');
    buildRequestTemplate(entry)
      .then((t) => {
        if (cancelled) return;
        setMethod(t.method);
        setUrl(t.url);
        setHeaders(toRows(t.headers));
        setBody(t.body);
        setNote(t.note);
      })
      .finally(() => !cancelled && setPrepping(false));
    return () => {
      cancelled = true;
    };
  }, [entry]);

  if (!entry) return null;

  const updateHeader = (i: number, patch: Partial<HeaderRow>) => {
    setHeaders((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };
  const addHeader = () => setHeaders((rows) => [...rows, { key: '', value: '' }]);
  const removeHeader = (i: number) => setHeaders((rows) => rows.filter((_, idx) => idx !== i));

  const send = async () => {
    setLoading(true);
    setError(null);
    setResp(null);
    const headerObj: Record<string, string> = {};
    for (const { key, value } of headers) {
      if (key.trim()) headerObj[key.trim()] = value;
    }
    try {
      const r = await api.sendRaw({ method, url: url.trim(), headers: headerObj, body });
      setResp(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const bodyDisabled = method === 'GET' || method === 'HEAD';
  const prettyResp = resp ? prettyBody(resp.body) : '';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-3xl flex-col rounded-lg bg-white p-6 shadow-xl dark:bg-slate-900 dark:border dark:border-slate-800"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">
              <i className="fa-solid fa-paper-plane mr-2 text-indigo-500" />
              API request tester
              <span className="ml-2 text-sm font-normal text-slate-400">
                {entry.label || entry.provider}
              </span>
            </h2>
            <p className="mt-0.5 text-xs text-slate-400">
              Pre-filled with this key's token - edit and Send. Sent through the local server (no CORS).
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
          >
            <i className="fa-solid fa-x" />
          </button>
        </div>

        {note && (
          <div className="mb-3 rounded bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-200">
            <i className="fa-solid fa-circle-info mr-1" />
            {note}
          </div>
        )}

        {/* Request line */}
        <div className="mb-3 flex gap-2">
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            disabled={prepping}
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
            placeholder="https://…"
            disabled={prepping}
            className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-3 py-2 font-mono text-sm dark:border-slate-700 dark:bg-slate-800"
          />
          <button
            onClick={send}
            disabled={loading || prepping || !url.trim()}
            className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {loading ? <><i className="fa-solid fa-spinner fa-spin" /> Sending</> : <><i className="fa-solid fa-paper-plane" /> Send</>}
          </button>
        </div>

        {/* Tabs: Body / Headers */}
        <div className="mb-2 flex gap-4 border-b border-slate-200 text-sm dark:border-slate-800">
          <TabBtn active={tab === 'body'} onClick={() => setTab('body')}>
            Body
          </TabBtn>
          <TabBtn active={tab === 'headers'} onClick={() => setTab('headers')}>
            Headers <span className="text-slate-400">({headers.filter((h) => h.key.trim()).length})</span>
          </TabBtn>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {tab === 'body' ? (
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={bodyDisabled}
              spellCheck={false}
              placeholder={bodyDisabled ? `${method} requests have no body` : '{ }'}
              className="h-40 w-full resize-y rounded border border-slate-300 bg-slate-50 p-3 font-mono text-xs leading-relaxed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-950"
            />
          ) : (
            <div className="space-y-2">
              {headers.map((h, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    value={h.key}
                    onChange={(e) => updateHeader(i, { key: e.target.value })}
                    placeholder="Header"
                    className="w-1/3 rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs dark:border-slate-700 dark:bg-slate-800"
                  />
                  <input
                    value={h.value}
                    onChange={(e) => updateHeader(i, { value: e.target.value })}
                    placeholder="Value"
                    className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs dark:border-slate-700 dark:bg-slate-800"
                  />
                  <button
                    onClick={() => removeHeader(i)}
                    className="px-2 text-slate-400 hover:text-red-500"
                    title="Remove"
                  >
                    <i className="fa-solid fa-trash" />
                  </button>
                </div>
              ))}
              <button
                onClick={addHeader}
                className="text-xs text-indigo-600 hover:text-indigo-800"
              >
                <i className="fa-solid fa-plus" /> Add header
              </button>
            </div>
          )}
        </div>

        {/* Response */}
        <div className="mt-4 min-h-0 flex-1 overflow-hidden">
          <div className="mb-1 flex items-center gap-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Response
            {resp && (
              <span className={`font-mono ${statusColor(resp.status)}`}>
                {resp.status} {resp.statusText}
              </span>
            )}
            {resp && <span className="font-mono text-slate-400">{resp.latencyMs} ms</span>}
            {resp?.truncated && <span className="text-amber-500">(truncated)</span>}
          </div>
          {error ? (
            <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
              {error}
            </div>
          ) : resp ? (
            <pre className="max-h-56 overflow-auto rounded border border-slate-200 bg-slate-50 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words dark:border-slate-800 dark:bg-slate-950">
              {prettyResp || <span className="italic text-slate-400">(empty body)</span>}
            </pre>
          ) : (
            <div className="rounded border border-dashed border-slate-300 p-3 text-center text-xs text-slate-400 dark:border-slate-700">
              {loading ? 'Waiting for response…' : 'Send the request to see the response here.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`-mb-px border-b-2 pb-2 font-medium ${
        active
          ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
          : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
      }`}
    >
      {children}
    </button>
  );
}

function statusColor(status: number): string {
  if (status >= 200 && status < 300) return 'text-emerald-600';
  if (status >= 400) return 'text-red-600';
  return 'text-amber-600';
}

function prettyBody(body: string): string {
  if (!body) return '';
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
