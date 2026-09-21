// Right half of the client: the response.
//
// Nothing here ever pushes the request pane around - the response always lands
// in this column, and its status line keeps a fixed height whether it shows a
// result, an error or nothing yet.

import { useEffect, useMemo, useState } from 'react';

import { JsonTree } from './JsonTree.tsx';
import type { SendResult } from '../../../shared/collections.ts';

type View = 'preview' | 'tree' | 'pretty' | 'raw' | 'headers' | 'cookies' | 'tests' | 'stream';

interface Props {
  result?: SendResult;
  error?: string;
  sending: boolean;
  /** text arriving right now, before the response is complete */
  liveStream?: string;
  /** set when this response was restored from history rather than just sent */
  historical?: { id: string; ts: string };
}

export function ResponsePane({ result, error, sending, liveStream, historical }: Props) {
  const [view, setView] = useState<View>('pretty');
  const streaming = !!result?.stream;
  const binary = result?.bodyEncoding === 'base64';
  const dataUrl = binary ? `data:${result?.mediaType ?? 'application/octet-stream'};base64,${result?.body}` : '';
  const [wrap, setWrap] = useState(true);

  // Parsed once and shared: the tree needs the value, pretty needs the text.
  const parsed = useMemo<{ ok: boolean; value: unknown }>(() => {
    if (!result?.body || result.bodyEncoding === 'base64') return { ok: false, value: null };
    try {
      return { ok: true, value: JSON.parse(result.body) };
    } catch {
      return { ok: false, value: null };
    }
  }, [result?.body]);

  const pretty = useMemo(
    () => (parsed.ok ? JSON.stringify(parsed.value, null, 2) : (result?.body ?? '')),
    [parsed, result?.body],
  );

  const checks = [
    ...(result?.tests ?? []).map((t) => ({ label: t.name, passed: t.passed, detail: t.error })),
    ...(result?.assertions ?? []).map((a) => ({
      label: `${a.source} ${a.op}${a.value ? ` ${a.value}` : ''}`,
      passed: a.passed,
      detail: a.error ?? (a.passed ? undefined : `actual: ${a.actual}`),
    })),
  ];
  const passed = checks.filter((c) => c.passed).length;
  const hasDiagnostics = checks.length > 0 || (result?.logs?.length ?? 0) > 0 || !!result?.scriptError;

  // A fresh response may carry no tests at all - don't leave the pane parked
  // on a tab that no longer exists.
  // Only fall back once a response actually exists: while one is still being
  // restored or sent there is nothing to judge, and flipping the view then
  // means the tab you chose never survives a reload.
  useEffect(() => {
    if (!result) return;
    if (view === 'tests' && !hasDiagnostics) setView('pretty');
    if (view === 'tree' && !parsed.ok) setView('pretty');
  }, [view, hasDiagnostics, parsed.ok, result]);

  // A stream's raw body is SSE framing; the stitched text is what you want to
  // read first.
  useEffect(() => {
    if (streaming) setView('stream');
    else if (binary) setView('preview');
  }, [streaming, binary, result?.latencyMs]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard blocked - nothing useful to do */
    }
  };

  const download = () => {
    if (!result) return;
    const type = result.mediaType ?? result.headers['content-type'] ?? 'text/plain';
    let blob: Blob;
    if (result.bodyEncoding === 'base64') {
      const bytes = Uint8Array.from(atob(result.body), (ch) => ch.charCodeAt(0));
      blob = new Blob([bytes], { type });
    } else {
      blob = new Blob([result.body], { type });
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = result.bodyEncoding === 'base64' ? guessFilename(result.mediaType) : 'response.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="flex h-full min-w-0 flex-col" aria-label="Response">
      <div className="thin-scroll flex h-[3.25rem] shrink-0 items-center gap-3 overflow-x-auto border-b border-slate-200 px-3 dark:border-slate-800">
        {sending && (
          <span className="text-sm text-slate-400">
            <i className="fa-solid fa-spinner fa-spin" />{' '}
            {liveStream ? `streaming… ${liveStream.length} chars` : 'Sending…'}
          </span>
        )}

        {!sending && !result && !error && (
          <span className="text-sm text-slate-400">
            No response yet — <kbd className="rounded border px-1 text-xs">Ctrl</kbd>+
            <kbd className="rounded border px-1 text-xs">Enter</kbd> to send
          </span>
        )}

        {!sending && error && (
          <span className="truncate text-sm font-medium text-red-600 dark:text-red-400">
            <i className="fa-solid fa-triangle-exclamation" /> {error}
          </span>
        )}

        {!sending && result && !error && (
          <>
            <StatusChip status={result.status} text={result.statusText} />
            {historical && (
              <span
                className="shrink-0 rounded bg-slate-200 px-1.5 py-0.5 text-[11px] text-slate-600 dark:bg-slate-700 dark:text-slate-200"
                title={`Stored response from ${new Date(historical.ts).toLocaleString()}`}
              >
                <i className="fa-solid fa-clock-rotate-left" /> from history
              </span>
            )}
            <Metric icon="fa-clock" value={`${result.latencyMs} ms`} title={`TTFB ${result.ttfbMs} ms`} />
            <Metric icon="fa-database" value={formatBytes(result.size)} />
            {result.stream && (
              <>
                {result.stream.ttftMs !== undefined && (
                  <Metric
                    icon="fa-bolt"
                    value={`TTFT ${result.stream.ttftMs} ms`}
                    title="Time to the first generated token"
                  />
                )}
                {result.stream.tokensPerSecond !== undefined && (
                  <Metric
                    icon="fa-gauge-high"
                    value={`${result.stream.tokensPerSecond} tok/s`}
                    title={`${result.stream.deltas} deltas over ${result.stream.chunks} chunks`}
                  />
                )}
                {!result.stream.finished && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                    stream cut short
                  </span>
                )}
              </>
            )}
            {result.redirects.length > 0 && (
              <Metric
                icon="fa-arrow-turn-down"
                value={`${result.redirects.length} redirect${result.redirects.length > 1 ? 's' : ''}`}
                title={result.redirects.map((r) => `${r.status} → ${r.to}`).join('\n')}
              />
            )}
            {checks.length > 0 && (
              <button
                type="button"
                onClick={() => setView('tests')}
                title="Show test results"
                className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                  passed === checks.length
                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'
                    : 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200'
                }`}
              >
                <i className={`fa-solid ${passed === checks.length ? 'fa-check' : 'fa-xmark'}`} />{' '}
                {passed}/{checks.length} tests
              </button>
            )}
            {result.scriptError && (
              <button
                type="button"
                onClick={() => setView('tests')}
                title={result.scriptError}
                className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-200"
              >
                <i className="fa-solid fa-triangle-exclamation" /> script
              </button>
            )}
            {result.truncated && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                truncated
              </span>
            )}
            <div className="ml-auto flex items-center gap-1">
              <IconButton icon="fa-copy" label="Copy body" onClick={() => copy(result.body)} />
              <IconButton icon="fa-download" label="Download body" onClick={download} />
              <IconButton
                icon={wrap ? 'fa-align-left' : 'fa-align-justify'}
                label={wrap ? 'Disable wrapping' : 'Enable wrapping'}
                onClick={() => setWrap((w) => !w)}
              />
            </div>
          </>
        )}
      </div>

      {result && !error && (
        <div
          role="tablist"
          aria-label="Response views"
          className="thin-scroll flex shrink-0 gap-1 overflow-x-auto border-b border-slate-200 px-2 dark:border-slate-800"
        >
          {([
            ...(streaming ? (['stream'] as View[]) : []),
            ...(binary ? (['preview'] as View[]) : []),
            ...(parsed.ok ? (['tree'] as View[]) : []),
            ...(binary ? [] : (['pretty'] as View[])),
            'raw',
            'headers',
            'cookies',
            ...(hasDiagnostics ? (['tests'] as View[]) : []),
          ] as View[]).map((id) => (
            <button
              key={id}
              role="tab"
              type="button"
              aria-selected={view === id}
              onClick={() => setView(id)}
              className={`shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-xs font-medium capitalize ${
                view === id
                  ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                  : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              {id}
              {id === 'headers' && (
                <span className="ml-1 text-[10px] text-slate-400">
                  {Object.keys(result.headers).length}
                </span>
              )}
              {id === 'tests' && checks.length > 0 && (
                <span className="ml-1 text-[10px] text-slate-400">
                  {passed}/{checks.length}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {sending && liveStream ? (
          <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed">
            {liveStream}
            <span className="animate-pulse">▌</span>
          </pre>
        ) : null}
        {result && !error && view === 'preview' && binary && (
          <BinaryPreview
            mediaType={result.mediaType ?? ''}
            dataUrl={dataUrl}
            size={result.size}
            truncated={result.truncated}
          />
        )}
        {result && !error && view === 'tree' && parsed.ok && (
          <JsonTree
            value={parsed.value}
            onCopyPath={(path) => {
              navigator.clipboard.writeText(path).catch(() => {});
            }}
          />
        )}
        {result && !error && view === 'stream' && (
          <Body text={result.streamText ?? ''} wrap={wrap} />
        )}
        {result && !error && view === 'pretty' && <Body text={pretty} wrap={wrap} />}
        {result && !error && view === 'raw' &&
          (binary ? (
            <p className="p-3 text-xs text-slate-400">
              {formatBytes(result.size)} of {result.mediaType || 'binary data'} — shown in the
              Preview tab, or use the download button.
            </p>
          ) : (
            <Body text={result.body} wrap={wrap} />
          ))}
        {result && !error && view === 'headers' && <HeaderTable headers={result.headers} />}
        {result && !error && view === 'tests' && (
          <div className="p-3 text-xs">
            {result.scriptError && (
              <p className="mb-3 whitespace-pre-wrap rounded bg-amber-50 p-2 font-mono text-[11px] text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                {result.scriptError}
              </p>
            )}

            {checks.length === 0 && !result.scriptError && (
              <p className="text-slate-400">
                No tests ran. Add assertions in the Tests tab, or call{' '}
                <code className="font-mono">test()</code> from a post-response script.
              </p>
            )}

            <ul className="grid gap-1">
              {checks.map((c, i) => (
                <li key={i} className="flex items-start gap-2">
                  <i
                    className={`fa-solid mt-0.5 ${
                      c.passed ? 'fa-circle-check text-emerald-500' : 'fa-circle-xmark text-red-500'
                    }`}
                  />
                  <span className="min-w-0">
                    <span className="font-mono">{c.label}</span>
                    {c.detail && (
                      <span className="block break-all text-[11px] text-slate-500">{c.detail}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>

            {(result.logs?.length ?? 0) > 0 && (
              <>
                <h3 className="mb-1 mt-4 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  console
                </h3>
                <pre className="whitespace-pre-wrap rounded bg-slate-100 p-2 font-mono text-[11px] dark:bg-slate-800">
                  {result.logs!.join('\n')}
                </pre>
              </>
            )}
          </div>
        )}

        {result && !error && view === 'cookies' && (
          <div className="p-3 font-mono text-xs">
            {result.setCookies.length === 0 ? (
              <p className="text-slate-400">No Set-Cookie headers.</p>
            ) : (
              result.setCookies.map((c, i) => (
                <p key={i} className="break-all py-0.5">
                  {c}
                </p>
              ))
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function Body({ text, wrap }: { text: string; wrap: boolean }) {
  if (!text) return <p className="p-3 text-xs text-slate-400">Empty body.</p>;
  return (
    <pre
      className={`p-3 font-mono text-xs leading-relaxed ${wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'}`}
    >
      {text}
    </pre>
  );
}

function HeaderTable({ headers }: { headers: Record<string, string> }) {
  return (
    <table className="w-full text-left font-mono text-xs">
      <tbody>
        {Object.entries(headers).map(([k, v]) => (
          <tr key={k} className="border-b border-slate-100 dark:border-slate-800">
            <th scope="row" className="w-1/3 py-1 pl-3 pr-2 align-top font-semibold text-slate-500">
              {k}
            </th>
            <td className="break-all py-1 pr-3">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StatusChip({ status, text }: { status: number; text: string }) {
  const tone =
    status >= 500
      ? 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200'
      : status >= 400
        ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200'
        : status >= 300
          ? 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200'
          : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200';
  return (
    <span className={`rounded px-2 py-0.5 text-sm font-semibold ${tone}`}>
      {status} {text}
    </span>
  );
}

function Metric({ icon, value, title }: { icon: string; value: string; title?: string }) {
  return (
    <span className="text-xs text-slate-500" title={title}>
      <i className={`fa-solid ${icon}`} /> {value}
    </span>
  );
}

function IconButton({
  icon,
  label,
  onClick,
}: {
  icon: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="h-8 w-8 rounded text-slate-500 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 dark:hover:bg-slate-800"
    >
      <i className={`fa-solid ${icon}`} />
    </button>
  );
}

/** Images inline, PDFs in a frame, media with controls, anything else named
 *  and offered as a download - a hex dump helps nobody. */
function BinaryPreview({
  mediaType,
  dataUrl,
  size,
  truncated,
}: {
  mediaType: string;
  dataUrl: string;
  size: number;
  truncated: boolean;
}) {
  const kind = mediaType.split('/')[0];
  return (
    <div className="grid gap-3 p-3">
      <p className="text-xs text-slate-500">
        {mediaType || 'binary'} · {formatBytes(size)}
        {truncated && ' · truncated, download for the whole thing'}
      </p>

      {kind === 'image' && (
        <img
          src={dataUrl}
          alt="Response preview"
          className="max-h-[60vh] max-w-full rounded border border-slate-200 object-contain dark:border-slate-800"
        />
      )}
      {mediaType === 'application/pdf' && (
        <iframe src={dataUrl} title="Response PDF" className="h-[60vh] w-full rounded border border-slate-200 dark:border-slate-800" />
      )}
      {kind === 'audio' && <audio src={dataUrl} controls className="w-full" />}
      {kind === 'video' && <video src={dataUrl} controls className="max-h-[60vh] w-full rounded" />}
      {kind !== 'image' && kind !== 'audio' && kind !== 'video' && mediaType !== 'application/pdf' && (
        <p className="text-xs text-slate-400">
          No inline preview for this type — use the download button above.
        </p>
      )}
    </div>
  );
}

function guessFilename(mediaType?: string): string {
  const ext = (mediaType ?? '').split('/')[1]?.split('+')[0];
  return ext ? `response.${ext}` : 'response.bin';
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
