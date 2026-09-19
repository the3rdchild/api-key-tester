// Key/value table used for params, headers and form bodies.
//
// Every control here is its own hit target - the enable checkbox sits inside
// its own <label>, the delete button is a real <button>, and the row itself has
// no click handler. That is the fix for the "you click one thing and something
// else gets selected" problem in the extension this replaces.

import type { KV } from '../../../shared/collections.ts';

interface Props {
  rows: KV[];
  onChange: (rows: KV[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  idPrefix: string;
}

export function KeyValueEditor({
  rows,
  onChange,
  keyPlaceholder = 'key',
  valuePlaceholder = 'value',
  idPrefix,
}: Props) {
  // A trailing blank row means "type here to add" - no + button to hunt for.
  const view = [...rows, { key: '', value: '', enabled: true }];

  const update = (index: number, patch: Partial<KV>) => {
    const next = [...rows];
    if (index === rows.length) next.push({ key: '', value: '', enabled: true, ...patch });
    else next[index] = { ...next[index]!, ...patch };
    onChange(next.filter((r, i) => r.key || r.value || i < rows.length));
  };

  const remove = (index: number) => onChange(rows.filter((_, i) => i !== index));

  return (
    <div className="divide-y divide-slate-200 dark:divide-slate-800">
      <div className="grid grid-cols-[2rem_1fr_1.5fr_2rem] gap-2 px-1 pb-1 text-[11px] uppercase tracking-wide text-slate-400">
        <span className="sr-only">Enabled</span>
        <span>Key</span>
        <span>Value</span>
        <span className="sr-only">Remove</span>
      </div>

      {view.map((row, i) => {
        const isNew = i === rows.length;
        const keyId = `${idPrefix}-k-${i}`;
        const valId = `${idPrefix}-v-${i}`;
        const checkId = `${idPrefix}-on-${i}`;
        return (
          <div key={i} className="grid grid-cols-[2rem_1fr_1.5fr_2rem] items-center gap-2 py-1">
            <label
              htmlFor={checkId}
              className="flex h-8 w-8 cursor-pointer items-center justify-center"
            >
              <input
                id={checkId}
                type="checkbox"
                checked={row.enabled}
                disabled={isNew}
                onChange={(e) => update(i, { enabled: e.target.checked })}
                className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:opacity-40 dark:border-slate-600 dark:bg-slate-800"
              />
              <span className="sr-only">Enable row {i + 1}</span>
            </label>

            <input
              id={keyId}
              aria-label={`Key ${i + 1}`}
              value={row.key}
              placeholder={keyPlaceholder}
              onChange={(e) => update(i, { key: e.target.value })}
              className="h-8 w-full rounded border border-transparent bg-transparent px-2 font-mono text-xs hover:border-slate-300 focus:border-indigo-500 focus:bg-white focus-visible:outline-none dark:hover:border-slate-700 dark:focus:bg-slate-900"
            />
            <input
              id={valId}
              aria-label={`Value ${i + 1}`}
              value={row.value}
              placeholder={valuePlaceholder}
              onChange={(e) => update(i, { value: e.target.value })}
              className="h-8 w-full rounded border border-transparent bg-transparent px-2 font-mono text-xs hover:border-slate-300 focus:border-indigo-500 focus:bg-white focus-visible:outline-none dark:hover:border-slate-700 dark:focus:bg-slate-900"
            />

            {isNew ? (
              <span className="h-8 w-8" />
            ) : (
              <button
                type="button"
                onClick={() => remove(i)}
                aria-label={`Remove row ${i + 1}`}
                title="Remove"
                className="h-8 w-8 rounded text-slate-400 hover:bg-red-50 hover:text-red-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 dark:hover:bg-red-950"
              >
                <i className="fa-solid fa-xmark" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
