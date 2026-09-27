// How a polled response came about: a chip in the status line ("polled 7× ·
// passed") and, under Tests, every attempt with its status and checks.

import type { PollOutcome, PollSummary } from '../../../shared/collections.ts';

const OUTCOME: Record<PollOutcome, { text: string; style: string; why: string }> = {
  passed: {
    text: 'passed',
    style: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
    why: 'every check passed',
  },
  timeout: {
    text: 'timed out',
    style: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
    why: 'the time limit ran out before the checks passed',
  },
  'max-attempts': {
    text: 'gave up',
    style: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
    why: 'it ran out of tries before the checks passed',
  },
  cancelled: {
    text: 'cancelled',
    style: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
    why: 'you cancelled it',
  },
  failed: {
    text: "couldn't send",
    style: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
    why: 'the request could not be sent as it is — retrying would not change that',
  },
};

const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

export function PollChip({ poll, onClick }: { poll: PollSummary; onClick: () => void }) {
  const o = OUTCOME[poll.outcome];
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Polled ${poll.attempts} time${poll.attempts === 1 ? '' : 's'} over ${seconds(poll.elapsedMs)}: ${o.why}. This is the last attempt.`}
      className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${o.style}`}
    >
      <i className="fa-solid fa-arrows-rotate" /> polled {poll.attempts}× · {o.text}
    </button>
  );
}

export function PollLog({ poll }: { poll: PollSummary }) {
  const o = OUTCOME[poll.outcome];
  const dropped = poll.attempts - poll.log.length;
  return (
    <div className="mb-4">
      <p className="mb-1 text-slate-500">
        Polled {poll.attempts} time{poll.attempts === 1 ? '' : 's'} over {seconds(poll.elapsedMs)} — {o.why}. The
        response shown is the last attempt.
      </p>
      <table className="w-full max-w-xl font-mono text-[11px]">
        <thead>
          <tr className="text-left text-slate-400">
            <th className="py-0.5 pr-3 font-normal">#</th>
            <th className="py-0.5 pr-3 font-normal">at</th>
            <th className="py-0.5 pr-3 font-normal">status</th>
            <th className="py-0.5 pr-3 font-normal">checks</th>
            <th className="py-0.5 text-right font-normal">latency</th>
          </tr>
        </thead>
        <tbody>
          {dropped > 0 && (
            <tr>
              <td colSpan={5} className="py-0.5 font-sans text-slate-400">
                … {dropped} earlier attempt{dropped === 1 ? '' : 's'}
              </td>
            </tr>
          )}
          {poll.log.map((a) => (
            <tr key={a.attempt} className="border-t border-slate-100 dark:border-slate-800">
              <td className="py-0.5 pr-3 text-slate-400">{a.attempt}</td>
              <td className="py-0.5 pr-3">+{seconds(a.at)}</td>
              <td className={`py-0.5 pr-3 ${a.error ? 'text-red-500' : ''}`} title={a.error}>
                {a.error ? 'error' : a.status}
              </td>
              <td
                className={`py-0.5 pr-3 ${
                  a.total > 0 && a.passed === a.total ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500'
                }`}
              >
                {a.passed}/{a.total}
              </td>
              <td className="py-0.5 text-right">{a.latencyMs} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
