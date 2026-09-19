// The Tests tab: declarative assertions, one per row.
//
// Same hit-target rules as the other editors - checkbox in its own label, one
// control per cell, no row-level click handler.

import type { AssertOp, Assertion } from '../../../shared/collections.ts';

const OPS: { id: AssertOp; label: string; needsValue: boolean }[] = [
  { id: 'eq', label: 'equals', needsValue: true },
  { id: 'ne', label: 'not equals', needsValue: true },
  { id: 'lt', label: '<', needsValue: true },
  { id: 'lte', label: '≤', needsValue: true },
  { id: 'gt', label: '>', needsValue: true },
  { id: 'gte', label: '≥', needsValue: true },
  { id: 'contains', label: 'contains', needsValue: true },
  { id: 'notContains', label: 'not contains', needsValue: true },
  { id: 'matches', label: 'matches regex', needsValue: true },
  { id: 'exists', label: 'exists', needsValue: false },
  { id: 'notExists', label: 'not exists', needsValue: false },
];

const PRESETS: Assertion[] = [
  { source: 'status', op: 'eq', value: '200', enabled: true },
  { source: 'latencyMs', op: 'lt', value: '2000', enabled: true },
  { source: '$.data', op: 'exists', enabled: true },
];

interface Props {
  rows: Assertion[];
  onChange: (rows: Assertion[]) => void;
}

export function AssertionEditor({ rows, onChange }: Props) {
  const view: Assertion[] = [...rows, { source: '', op: 'eq', value: '', enabled: true }];

  const update = (index: number, patch: Partial<Assertion>) => {
    const next = [...rows];
    if (index === rows.length) next.push({ source: '', op: 'eq', value: '', enabled: true, ...patch });
    else next[index] = { ...next[index]!, ...patch };
    onChange(next.filter((r, i) => r.source || i < rows.length));
  };

  return (
    <div className="grid gap-2">
      <div className="grid grid-cols-[2rem_1.4fr_8rem_1fr_2rem] gap-2 px-1 text-[11px] uppercase tracking-wide text-slate-400">
        <span aria-hidden="true" />
        <span>Source</span>
        <span>Operator</span>
        <span>Value</span>
        <span aria-hidden="true" />
      </div>

      {view.map((row, i) => {
        const isNew = i === rows.length;
        const op = OPS.find((o) => o.id === row.op) ?? OPS[0]!;
        const checkId = `assert-on-${i}`;
        return (
          <div key={i} className="grid grid-cols-[2rem_1.4fr_8rem_1fr_2rem] items-center gap-2">
            <label htmlFor={checkId} className="flex h-8 w-8 cursor-pointer items-center justify-center">
              <input
                id={checkId}
                type="checkbox"
                checked={row.enabled !== false}
                disabled={isNew}
                onChange={(e) => update(i, { enabled: e.target.checked })}
                className="h-4 w-4 rounded border-slate-300 text-indigo-600 disabled:opacity-40 dark:border-slate-600 dark:bg-slate-800"
              />
              <span className="sr-only">Enable assertion {i + 1}</span>
            </label>

            <input
              aria-label={`Assertion source ${i + 1}`}
              value={row.source}
              placeholder="status · latencyMs · headers.content-type · $.data.0.id"
              onChange={(e) => update(i, { source: e.target.value })}
              className="h-8 w-full rounded border border-slate-300 bg-white px-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-800"
            />

            <select
              aria-label={`Assertion operator ${i + 1}`}
              value={row.op}
              onChange={(e) => update(i, { op: e.target.value as AssertOp })}
              className="h-8 rounded border border-slate-300 bg-white px-1 text-xs dark:border-slate-700 dark:bg-slate-800"
            >
              {OPS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>

            <input
              aria-label={`Assertion value ${i + 1}`}
              value={row.value ?? ''}
              disabled={!op.needsValue}
              placeholder={op.needsValue ? 'expected' : '—'}
              onChange={(e) => update(i, { value: e.target.value })}
              className="h-8 w-full rounded border border-slate-300 bg-white px-2 font-mono text-xs disabled:bg-slate-100 disabled:text-slate-400 dark:border-slate-700 dark:bg-slate-800 dark:disabled:bg-slate-900"
            />

            {isNew ? (
              <span className="h-8 w-8" />
            ) : (
              <button
                type="button"
                onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
                aria-label={`Remove assertion ${i + 1}`}
                className="h-8 w-8 rounded text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
              >
                <i className="fa-solid fa-xmark" />
              </button>
            )}
          </div>
        );
      })}

      {rows.length === 0 && (
        <button
          type="button"
          onClick={() => onChange(PRESETS)}
          className="justify-self-start rounded border border-dashed border-slate-300 px-2 py-1 text-xs text-slate-500 hover:border-indigo-400 hover:text-indigo-600 dark:border-slate-700"
        >
          <i className="fa-solid fa-wand-magic-sparkles" /> Add the usual three (200 · under 2 s ·
          data exists)
        </button>
      )}
    </div>
  );
}
