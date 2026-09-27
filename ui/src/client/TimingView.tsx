// The "timing" view: where a response's time went. One row per redirect hop,
// then the final request split into waiting (its own time to first byte) and
// download. `ttfbMs` on the result counts from the very first request, so on a
// redirected response most of it can be hops — this is where that shows.

import type { SendResult } from '../../../shared/collections.ts';

const pct = (ms: number, total: number) => `${total > 0 ? Math.min(100, (ms / total) * 100) : 0}%`;

function Bar({ from, ms, total, color }: { from: number; ms: number; total: number; color: string }) {
  return (
    <span
      className={`absolute inset-y-0 rounded-sm ${color}`}
      style={{ left: pct(from, total), width: pct(ms, total), minWidth: 2 }}
    />
  );
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

export function TimingView({ result }: { result: SendResult }) {
  const total = result.latencyMs;
  const hops = result.redirects;
  const timed = hops.every((h) => h.startMs != null && h.ms != null);
  const finalStart = result.redirectMs ?? 0;
  const wait = Math.max(0, result.ttfbMs - finalStart);
  const download = Math.max(0, total - result.ttfbMs);
  const finalUrl = hops.length ? hops[hops.length - 1]!.to : undefined;

  const track = 'relative h-3 flex-1 overflow-hidden rounded-sm bg-slate-100 dark:bg-slate-800';
  const label = 'flex w-2/5 min-w-0 shrink-0 items-baseline gap-1.5';

  return (
    <div className="grid gap-3 p-3 text-xs">
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-slate-500">
        <span>
          Total <span className="font-mono text-slate-700 dark:text-slate-200">{total} ms</span>
        </span>
        {hops.length > 0 && result.redirectMs != null && (
          <span>
            {hops.length} redirect{hops.length > 1 ? 's' : ''}{' '}
            <span className="font-mono text-amber-600 dark:text-amber-400">{result.redirectMs} ms</span>
          </span>
        )}
        <span title="Final request: from sending it to the first byte back">
          Waiting <span className="font-mono text-indigo-600 dark:text-indigo-400">{wait} ms</span>
        </span>
        <span>
          Download <span className="font-mono text-emerald-600 dark:text-emerald-400">{download} ms</span>
        </span>
      </p>

      <div className="grid gap-1.5">
        {hops.map((hop, i) => (
          <div key={i} className="flex items-center gap-3">
            <span className={label} title={`${hop.method ?? ''} ${hop.from}\n→ ${hop.to}`}>
              <span className="shrink-0 font-mono font-semibold text-amber-600 dark:text-amber-400">{hop.status}</span>
              {hop.method && <span className="shrink-0 font-mono text-slate-400">{hop.method}</span>}
              <span className="truncate font-mono">{shortUrl(hop.from)}</span>
            </span>
            <span className={track}>
              {timed && <Bar from={hop.startMs!} ms={hop.ms!} total={total} color="bg-amber-400" />}
            </span>
            <span className="w-16 shrink-0 text-right font-mono text-slate-500">
              {hop.ms != null ? `${hop.ms} ms` : '—'}
            </span>
            {hop.dropped && (
              <span
                className="shrink-0 rounded bg-slate-200 px-1 text-[10px] text-slate-600 dark:bg-slate-700 dark:text-slate-300"
                title={`Redirected to another origin, so ${hop.dropped.join(', ')} ${hop.dropped.length > 1 ? 'were' : 'was'} not sent there — as browsers and curl -L do.`}
              >
                <i className="fa-solid fa-shield-halved" /> dropped {hop.dropped.join(', ')}
              </span>
            )}
          </div>
        ))}

        <div className="flex items-center gap-3">
          <span className={label} title={finalUrl}>
            <span className="shrink-0 font-mono font-semibold text-slate-700 dark:text-slate-200">{result.status}</span>
            <span className="truncate font-mono">{finalUrl ? shortUrl(finalUrl) : 'response'}</span>
          </span>
          <span className={track}>
            <Bar from={finalStart} ms={wait} total={total} color="bg-indigo-400" />
            <Bar from={result.ttfbMs} ms={download} total={total} color="bg-emerald-500" />
          </span>
          <span className="w-16 shrink-0 text-right font-mono text-slate-500">{total - finalStart} ms</span>
        </div>
      </div>

      {!timed && (
        <p className="text-slate-400">This response was recorded before per-hop timing existed; only the hops are known.</p>
      )}
      <p className="flex gap-3 text-[11px] text-slate-400">
        {hops.length > 0 && (
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-amber-400" />
            redirect
          </span>
        )}
        <span>
          <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-indigo-400" />
          waiting
        </span>
        <span>
          <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-emerald-500" />
          download
        </span>
      </p>
    </div>
  );
}
