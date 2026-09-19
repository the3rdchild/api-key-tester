// Multipart body rows: text fields and file fields side by side.
//
// Files are held in memory by the tab and shipped with the send call, so
// nothing is copied into the project and the container needs no extra mounts.

import type { MultipartRow } from '../../../shared/collections.ts';

interface Props {
  rows: MultipartRow[];
  files: Record<string, File[]>;
  onChange: (rows: MultipartRow[]) => void;
  onFiles: (field: string, files: File[]) => void;
  idPrefix: string;
}

export function MultipartEditor({ rows, files, onChange, onFiles, idPrefix }: Props) {
  const view: MultipartRow[] = [...rows, { key: '', type: 'text', value: '', enabled: true }];

  const update = (index: number, patch: Partial<MultipartRow>) => {
    const next = [...rows];
    if (index === rows.length) next.push({ key: '', type: 'text', value: '', enabled: true, ...patch });
    else next[index] = { ...next[index]!, ...patch };
    onChange(next.filter((r, i) => r.key || i < rows.length));
  };

  return (
    <div className="divide-y divide-slate-200 dark:divide-slate-800">
      {view.map((row, i) => {
        const isNew = i === rows.length;
        const checkId = `${idPrefix}-on-${i}`;
        const typeId = `${idPrefix}-type-${i}`;
        const picked = files[row.key] ?? [];
        return (
          <div key={i} className="grid grid-cols-[2rem_1fr_6rem_1.5fr_2rem] items-center gap-2 py-1">
            <label htmlFor={checkId} className="flex h-8 w-8 cursor-pointer items-center justify-center">
              <input
                id={checkId}
                type="checkbox"
                checked={row.enabled}
                disabled={isNew}
                onChange={(e) => update(i, { enabled: e.target.checked })}
                className="h-4 w-4 rounded border-slate-300 text-indigo-600 disabled:opacity-40 dark:border-slate-600 dark:bg-slate-800"
              />
              <span className="sr-only">Enable field {i + 1}</span>
            </label>

            <input
              aria-label={`Field name ${i + 1}`}
              value={row.key}
              placeholder="field"
              onChange={(e) => update(i, { key: e.target.value })}
              className="h-8 w-full rounded border border-transparent bg-transparent px-2 font-mono text-xs hover:border-slate-300 focus:border-indigo-500 focus:bg-white focus-visible:outline-none dark:hover:border-slate-700 dark:focus:bg-slate-900"
            />

            <select
              id={typeId}
              aria-label={`Field type ${i + 1}`}
              value={row.type}
              onChange={(e) => update(i, { type: e.target.value as MultipartRow['type'] })}
              className="h-8 rounded border border-slate-300 bg-white px-1 text-xs dark:border-slate-700 dark:bg-slate-800"
            >
              <option value="text">text</option>
              <option value="file">file</option>
            </select>

            {row.type === 'file' ? (
              <label className="flex h-8 cursor-pointer items-center gap-2 rounded border border-dashed border-slate-300 px-2 text-xs text-slate-500 hover:border-indigo-400 dark:border-slate-700">
                <input
                  type="file"
                  multiple
                  className="sr-only"
                  onChange={(e) => {
                    const list = Array.from(e.target.files ?? []);
                    onFiles(row.key, list);
                    update(i, { filename: list.map((f) => f.name).join(', ') });
                  }}
                />
                <i className="fa-solid fa-paperclip" />
                <span className="truncate">
                  {picked.length ? picked.map((f) => f.name).join(', ') : 'choose file…'}
                </span>
              </label>
            ) : (
              <input
                aria-label={`Field value ${i + 1}`}
                value={row.value ?? ''}
                placeholder="value"
                onChange={(e) => update(i, { value: e.target.value })}
                className="h-8 w-full rounded border border-transparent bg-transparent px-2 font-mono text-xs hover:border-slate-300 focus:border-indigo-500 focus:bg-white focus-visible:outline-none dark:hover:border-slate-700 dark:focus:bg-slate-900"
              />
            )}

            {isNew ? (
              <span className="h-8 w-8" />
            ) : (
              <button
                type="button"
                onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
                aria-label={`Remove field ${i + 1}`}
                className="h-8 w-8 rounded text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
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
