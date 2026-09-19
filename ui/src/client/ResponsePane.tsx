// Right half of the client: the response.
//
// Nothing here ever pushes the request pane around - the response always lands
// in this column, and its status line keeps a fixed height whether it shows a
// result, an error or nothing yet.

import { useMemo, useState } from 'react';

import type { SendResult } from '../../../shared/collections.ts';

type View = 'pretty' | 'raw' | 'headers' | 'cookies';

interface Props {
  result?: SendResult;
  error?: string;
  sending: boolean;
}

export function ResponsePane({ result, error, sending }: Props) {
  const [view, setView] = useState<View>('pretty');
  const [wrap, setWrap] = useState(true);

  const pretty = useMemo(() => {
    if (!result?.body) return '';
    try {
      return JSON.stringify(JSON.parse(result.body), null, 2);
    } catch {
      return result.body;
    }
  }, [result?.body]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard blocked - nothing useful to do */
    }
  };

  const download = () => {
    if (!result) return;
    const blob = new Blob([result.body], { type: result.headers['content-type'] ?? 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'response.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="flex h-full min-w-0 flex-col" aria-label="Response">
      <div className="flex h-[3.25rem] shrink-0 items-center gap-3 border-b border-slate-200 px-3 dark:border-slate-800">
        {sending && <span className="text-sm text-slate-400">Sending…</span>}

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
            <Metric icon="fa-clock" value={`${result.latencyMs} ms`} title={`TTFB ${result.ttfbMs} ms`} />
            <Metric icon="fa-database" value={formatBytes(result.size)} />
            {result.redirects.length > 0 && (
              <Metric
                icon="fa-arrow-turn-down"
                value={`${result.redirects.length} redirect${result.redirects.length > 1 ? 's' : ''}`}
                title={result.redirects.map((r) => `${r.status} → ${r.to}`).join('\n')}
              />
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
          className="flex shrink-0 gap-1 border-b border-slate-200 px-2 dark:border-slate-800"
        >
          {(['pretty', 'raw', 'headers', 'cookies'] as View[]).map((id) => (
            <button
              key={id}
              role="tab"
              type="button"
              aria-selected={view === id}
              onClick={() => setView(id)}
              className={`border-b-2 px-3 py-2 text-xs font-medium capitalize ${
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
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {result && !error && view === 'pretty' && <Body text={pretty} wrap={wrap} />}
        {result && !error && view === 'raw' && <Body text={result.body} wrap={wrap} />}
        {result && !error && view === 'headers' && <HeaderTable headers={result.headers} />}
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
