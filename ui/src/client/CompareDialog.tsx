// Two responses side by side: what moved in status, timing and size, then the
// body — path by path when both are JSON, line by line otherwise — and the
// headers. Per-call noise (ids, clocks, request ids) is ignored by default; the
// ignore lists are editable and remembered, and any change can be ignored from
// its row.

import { useMemo, useState } from 'react';

import type { CompareRequest, CompareSide } from './compare.ts';
import {
  DEFAULT_BODY_IGNORE,
  DEFAULT_HEADER_IGNORE,
  canonicalJson,
  diffHeaders,
  diffJson,
  diffLines,
  parsePatterns,
  toHunks,
  type ChangeKind,
} from '../lib/diff.ts';
import { formatBytes } from '../lib/format.ts';
import { loadLocal, saveLocal } from '../lib/storage.ts';
import type { SendResult } from '../../../shared/collections.ts';

const BODY_IGNORE_KEY = 'compare.ignore.body';
const HEADER_IGNORE_KEY = 'compare.ignore.headers';
/** Rows rendered at once; a diff of two unrelated documents can run to thousands. */
const MAX_ROWS = 500;

const KIND_STYLE: Record<ChangeKind | 'same', string> = {
  added: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  removed: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  changed: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  same: 'text-slate-400',
};

interface Body {
  text: string;
  json?: { value: unknown };
  binary: boolean;
  /** a stream's stitched text stands in for its raw SSE framing */
  streamed: boolean;
}

export function bodyOf(r: SendResult): Body {
  if (r.bodyEncoding === 'base64') return { text: r.body, binary: true, streamed: false };
  if (r.streamText) return { text: r.streamText, binary: false, streamed: true };
  const text = r.body ?? '';
  try {
    return { text, json: { value: JSON.parse(text) }, binary: false, streamed: false };
  } catch {
    return { text, binary: false, streamed: false };
  }
}

function show(v: unknown, shape: boolean): string {
  if (shape && typeof v === 'string') return v; // a type name
  const s = JSON.stringify(v);
  return s === undefined ? 'undefined' : s;
}

function Delta({ a, b, format }: { a?: number; b?: number; format: (n: number) => string }) {
  if (a == null || b == null) return <span className="text-slate-400">—</span>;
  const pct = a > 0 ? Math.round(((b - a) / a) * 100) : 0;
  return (
    <span className="font-mono">
      {format(a)} → {format(b)}
      {pct !== 0 && (
        <span className={`ml-1 ${pct > 0 ? 'text-red-500' : 'text-emerald-600'}`}>
          ({pct > 0 ? '+' : ''}
          {pct}%)
        </span>
      )}
    </span>
  );
}

function IgnoreEditor({
  value,
  defaults,
  onChange,
  hint,
}: {
  value: string;
  defaults: string[];
  onChange: (v: string) => void;
  hint: string;
}) {
  const [open, setOpen] = useState(false);
  const count = parsePatterns(value).length;
  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="rounded px-1.5 py-0.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
      >
        <i className={`fa-solid ${open ? 'fa-chevron-down' : 'fa-chevron-right'} mr-1 text-[10px]`} />
        Ignore · {count} pattern{count === 1 ? '' : 's'}
      </button>
      {open && (
        <div className="mt-1 grid gap-1">
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            rows={4}
            spellCheck={false}
            aria-label="Ignore patterns"
            className="w-full rounded border border-slate-300 bg-white p-2 font-mono text-[11px] dark:border-slate-700 dark:bg-slate-800"
          />
          <p className="flex items-center gap-2 text-[11px] text-slate-400">
            {hint}
            <button
              type="button"
              onClick={() => onChange(defaults.join('\n'))}
              className="ml-auto text-indigo-600 hover:underline dark:text-indigo-400"
            >
              reset to defaults
            </button>
          </p>
        </div>
      )}
    </div>
  );
}

export function CompareDialog({ left, right, onClose }: CompareRequest & { onClose: () => void }) {
  const [[a, b], setSides] = useState<[CompareSide, CompareSide]>([left, right]);
  const [tab, setTab] = useState<'body' | 'headers'>('body');
  const [mode, setMode] = useState<'changes' | 'lines'>('changes');
  const [shape, setShape] = useState(false);
  const [showSame, setShowSame] = useState(false);
  const [bodyIgnore, setBodyIgnoreRaw] = useState(() => loadLocal(BODY_IGNORE_KEY) ?? DEFAULT_BODY_IGNORE.join('\n'));
  const [headerIgnore, setHeaderIgnoreRaw] = useState(
    () => loadLocal(HEADER_IGNORE_KEY) ?? DEFAULT_HEADER_IGNORE.join('\n'),
  );
  const setBodyIgnore = (v: string) => {
    setBodyIgnoreRaw(v);
    saveLocal(BODY_IGNORE_KEY, v);
  };
  const setHeaderIgnore = (v: string) => {
    setHeaderIgnoreRaw(v);
    saveLocal(HEADER_IGNORE_KEY, v);
  };

  const ba = useMemo(() => bodyOf(a.result), [a]);
  const bb = useMemo(() => bodyOf(b.result), [b]);
  const binary = ba.binary || bb.binary;
  const bothJson = !!ba.json && !!bb.json;
  const view = bothJson ? mode : 'lines';

  const json = useMemo(
    () => (bothJson ? diffJson(ba.json!.value, bb.json!.value, { ignore: parsePatterns(bodyIgnore), shape }) : null),
    [bothJson, ba, bb, bodyIgnore, shape],
  );
  const lines = useMemo(() => {
    if (binary || view !== 'lines') return null;
    return diffLines(bothJson ? canonicalJson(ba.json!.value) : ba.text, bothJson ? canonicalJson(bb.json!.value) : bb.text);
  }, [binary, view, bothJson, ba, bb]);
  const headers = useMemo(
    () => diffHeaders(a.result.headers, b.result.headers, parsePatterns(headerIgnore)),
    [a, b, headerIgnore],
  );
  const headerChanges = headers.rows.filter((r) => r.kind !== 'same').length;
  const bodyCount = binary
    ? ba.text === bb.text
      ? 0
      : 1
    : json
      ? json.changes.length
      : (lines?.filter((o) => o.op !== 'equal').length ?? 0);

  const ignorePath = (path: string) => {
    const current = parsePatterns(bodyIgnore);
    if (!current.includes(path)) setBodyIgnore([...current, path].join('\n'));
  };

  const sideHead = (s: CompareSide, tag: string) => (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <span className="rounded bg-slate-200 px-1 font-mono text-[10px] font-bold dark:bg-slate-700">{tag}</span>
        <span className="truncate text-sm font-medium" title={s.label}>
          {s.label}
        </span>
      </div>
      <div className="truncate pl-6 text-[11px] text-slate-400">
        {s.detail ? `${s.detail} · ` : ''}
        {s.result.error ? `error: ${s.result.error}` : `${s.result.status} · ${s.result.latencyMs} ms · ${formatBytes(s.result.size)}`}
      </div>
    </div>
  );

  const tabBtn = (id: 'body' | 'headers', label: string, n: number) => (
    <button
      key={id}
      role="tab"
      type="button"
      aria-selected={tab === id}
      onClick={() => setTab(id)}
      className={`border-b-2 px-3 py-2 text-xs font-medium ${
        tab === id
          ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
          : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
      }`}
    >
      {label}
      <span className={`ml-1 text-[10px] ${n ? 'text-amber-600 dark:text-amber-400' : 'text-slate-400'}`}>{n}</span>
    </button>
  );

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="compare-title"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="flex h-[88vh] w-full max-w-6xl flex-col rounded-lg bg-white shadow-xl dark:bg-slate-900">
        {/* the two sides */}
        <div className="flex items-center gap-3 border-b border-slate-200 p-3 dark:border-slate-800">
          <h2 id="compare-title" className="sr-only">
            Compare responses
          </h2>
          {sideHead(a, 'A')}
          <button
            type="button"
            onClick={() => setSides([b, a])}
            title="Swap A and B"
            aria-label="Swap A and B"
            className="h-7 w-7 shrink-0 rounded text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-700"
          >
            <i className="fa-solid fa-right-left" />
          </button>
          {sideHead(b, 'B')}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            autoFocus
            className="h-7 w-7 shrink-0 rounded text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-700"
          >
            <i className="fa-solid fa-xmark" />
          </button>
        </div>

        {/* what moved */}
        <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-slate-200 px-3 py-2 text-xs dark:border-slate-800">
          <span>
            <span className="text-slate-400">Status </span>
            <span
              className={`font-mono ${a.result.status !== b.result.status ? 'font-semibold text-amber-600 dark:text-amber-400' : ''}`}
            >
              {a.result.status || 'err'} → {b.result.status || 'err'}
            </span>
          </span>
          <span>
            <span className="text-slate-400">Latency </span>
            <Delta a={a.result.latencyMs} b={b.result.latencyMs} format={(n) => `${n} ms`} />
          </span>
          <span>
            <span className="text-slate-400">TTFB </span>
            <Delta a={a.result.ttfbMs} b={b.result.ttfbMs} format={(n) => `${n} ms`} />
          </span>
          <span>
            <span className="text-slate-400">Size </span>
            <Delta a={a.result.size} b={b.result.size} format={formatBytes} />
          </span>
        </div>

        <div role="tablist" aria-label="Compare" className="flex shrink-0 gap-1 border-b border-slate-200 px-2 dark:border-slate-800">
          {tabBtn('body', 'Body', bodyCount)}
          {tabBtn('headers', 'Headers', headerChanges)}
        </div>

        {tab === 'body' && (
          <>
            <div className="flex shrink-0 flex-wrap items-start gap-3 border-b border-slate-200 px-3 py-2 text-xs dark:border-slate-800">
              {bothJson && (
                <div role="group" aria-label="Body view" className="flex gap-0.5">
                  {(['changes', 'lines'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      aria-pressed={mode === m}
                      onClick={() => setMode(m)}
                      className={`h-6 rounded px-2 font-medium capitalize ${
                        mode === m ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              )}
              {bothJson && view === 'changes' && (
                <label
                  className="flex h-6 cursor-pointer items-center gap-1 text-slate-500"
                  title="Compare keys and types only — for two providers whose answers are bound to differ"
                >
                  <input type="checkbox" checked={shape} onChange={(e) => setShape(e.target.checked)} className="accent-indigo-600" />
                  Shape only
                </label>
              )}
              {!bothJson && !binary && (
                <span className="h-6 leading-6 text-slate-400">
                  {ba.streamed || bb.streamed ? 'Comparing the streamed text, line by line.' : 'Not JSON on both sides — compared line by line.'}
                </span>
              )}
              {json && json.ignored > 0 && (
                <span className="h-6 leading-6 text-slate-400">{json.ignored} ignored</span>
              )}
              {bothJson && view === 'changes' && (
                <div className="ml-auto min-w-[16rem]">
                  <IgnoreEditor
                    value={bodyIgnore}
                    defaults={DEFAULT_BODY_IGNORE}
                    onChange={setBodyIgnore}
                    hint="$.a.b from the root · a.b at any depth · * one level · ** any"
                  />
                </div>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-auto font-mono text-xs">
              {binary ? (
                <p className="p-4 font-sans text-slate-500">
                  Binary bodies ({formatBytes(a.result.size)} and {formatBytes(b.result.size)}) —{' '}
                  {ba.text === bb.text ? 'byte for byte the same.' : 'they differ.'}
                </p>
              ) : view === 'changes' && json ? (
                json.changes.length === 0 ? (
                  <p className="p-4 font-sans text-emerald-600 dark:text-emerald-400">
                    <i className="fa-solid fa-equals mr-1" />
                    {shape ? 'Same shape.' : 'No differences'}
                    {json.ignored ? ` beyond the ${json.ignored} ignored.` : '.'}
                  </p>
                ) : (
                  <table className="w-full">
                    <tbody>
                      {json.changes.slice(0, MAX_ROWS).map((c) => (
                        <tr key={c.path} className="group border-b border-slate-100 align-top dark:border-slate-800">
                          <td className="w-20 px-3 py-1">
                            <span className={`rounded px-1 text-[10px] font-semibold uppercase ${KIND_STYLE[c.kind]}`}>{c.kind}</span>
                          </td>
                          <td className="px-2 py-1 text-slate-600 dark:text-slate-300">
                            {c.path}
                            <button
                              type="button"
                              onClick={() => ignorePath(c.path)}
                              title="Ignore this path from now on"
                              className="ml-2 font-sans text-[10px] text-slate-400 opacity-0 hover:text-indigo-600 group-hover:opacity-100"
                            >
                              ignore
                            </button>
                          </td>
                          <td className="max-w-xs truncate px-2 py-1 text-red-700 dark:text-red-300" title={c.kind === 'added' ? '' : show(c.left, shape)}>
                            {c.kind === 'added' ? '' : show(c.left, shape)}
                          </td>
                          <td className="max-w-xs truncate px-2 py-1 text-emerald-700 dark:text-emerald-300" title={c.kind === 'removed' ? '' : show(c.right, shape)}>
                            {c.kind === 'removed' ? '' : show(c.right, shape)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              ) : lines == null ? (
                <p className="p-4 font-sans text-slate-500">
                  Too large to diff line by line here{bothJson ? ' — the Changes view handles it.' : '.'}
                </p>
              ) : lines.every((o) => o.op === 'equal') ? (
                <p className="p-4 font-sans text-emerald-600 dark:text-emerald-400">
                  <i className="fa-solid fa-equals mr-1" /> Identical.
                </p>
              ) : (
                <div className="py-1">
                  {toHunks(lines).map((h, i) =>
                    h.kind === 'skip' ? (
                      <div key={i} className="bg-slate-50 px-3 py-0.5 font-sans text-[11px] text-slate-400 dark:bg-slate-950">
                        ⋯ {h.count} unchanged line{h.count === 1 ? '' : 's'}
                      </div>
                    ) : (
                      h.ops.map((o, j) => (
                        <div
                          key={`${i}-${j}`}
                          className={`whitespace-pre-wrap break-all px-3 ${
                            o.op === 'add'
                              ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                              : o.op === 'del'
                                ? 'bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300'
                                : 'text-slate-600 dark:text-slate-400'
                          }`}
                        >
                          <span className="mr-2 select-none text-slate-400">{o.op === 'add' ? '+' : o.op === 'del' ? '−' : ' '}</span>
                          {o.text}
                        </div>
                      ))
                    ),
                  )}
                </div>
              )}
              {view === 'changes' && json && json.changes.length > MAX_ROWS && (
                <p className="p-3 font-sans text-slate-400">…and {json.changes.length - MAX_ROWS} more.</p>
              )}
            </div>
          </>
        )}

        {tab === 'headers' && (
          <>
            <div className="flex shrink-0 flex-wrap items-start gap-3 border-b border-slate-200 px-3 py-2 text-xs dark:border-slate-800">
              <label className="flex h-6 cursor-pointer items-center gap-1 text-slate-500">
                <input type="checkbox" checked={showSame} onChange={(e) => setShowSame(e.target.checked)} className="accent-indigo-600" />
                Show unchanged
              </label>
              {headers.ignored > 0 && <span className="h-6 leading-6 text-slate-400">{headers.ignored} ignored</span>}
              <div className="ml-auto min-w-[16rem]">
                <IgnoreEditor
                  value={headerIgnore}
                  defaults={DEFAULT_HEADER_IGNORE}
                  onChange={setHeaderIgnore}
                  hint="header names, * as a wildcard"
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto text-xs">
              <table className="w-full">
                <tbody>
                  {headers.rows
                    .filter((r) => showSame || r.kind !== 'same')
                    .map((r) => (
                      <tr key={r.name} className="border-b border-slate-100 align-top dark:border-slate-800">
                        <td className="w-20 px-3 py-1">
                          <span className={`rounded px-1 text-[10px] font-semibold uppercase ${KIND_STYLE[r.kind]}`}>{r.kind}</span>
                        </td>
                        <td className="px-2 py-1 font-mono text-slate-600 dark:text-slate-300">{r.name}</td>
                        <td className="max-w-xs break-all px-2 py-1 font-mono">{r.left ?? ''}</td>
                        <td className="max-w-xs break-all px-2 py-1 font-mono">{r.right ?? ''}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {headerChanges === 0 && !showSame && (
                <p className="p-4 text-emerald-600 dark:text-emerald-400">
                  <i className="fa-solid fa-equals mr-1" /> No header differences
                  {headers.ignored ? ` beyond the ${headers.ignored} ignored.` : '.'}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
