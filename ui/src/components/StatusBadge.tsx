import type { TestState } from '../../../shared/types.ts';

const COLORS: Record<TestState, string> = {
  untested: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-300',
  pending: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 animate-pulse',
  valid: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200',
  invalid: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  rate_limited: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
  error: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
};

const LABELS: Record<TestState, string> = {
  untested: 'Untested',
  pending: 'Pending…',
  valid: 'Valid',
  invalid: 'Invalid',
  rate_limited: 'Rate-limited',
  error: 'Error',
};

export function StatusBadge({ state }: { state: TestState }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${COLORS[state]}`}
    >
      {LABELS[state]}
    </span>
  );
}
