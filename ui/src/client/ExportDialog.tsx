// Handing a collection to someone else.
//
// The download goes through fetch rather than a plain link so the warnings the
// server attaches ("this one used a vault key") can be shown before the file
// lands in Downloads and the point is lost.

import { useState } from 'react';

import type { FolderChoice } from './SaveRequestDialog.tsx';

type Format = 'postman' | 'http' | 'json';

const FORMATS: { id: Format; label: string; hint: string }[] = [
  { id: 'postman', label: 'Postman collection v2.1', hint: 'opens in Postman or Insomnia' },
  { id: 'http', label: '.http file', hint: 'readable, diffable, VS Code REST Client' },
  { id: 'json', label: 'Keyway collections.json', hint: 'everything, exactly as stored' },
];

interface Props {
  open: boolean;
  folders: FolderChoice[];
  onClose: () => void;
  onToast: (msg: string) => void;
}

export function ExportDialog({ open, folders, onClose, onToast }: Props) {
  const [format, setFormat] = useState<Format>('postman');
  const [folderId, setFolderId] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const run = async () => {
    setBusy(true);
    setWarnings([]);
    try {
      const params = new URLSearchParams({ format });
      if (folderId && format !== 'json') params.set('folderId', folderId);
      const res = await fetch(`/api/collections/export?${params}`);
      if (!res.ok) {
        onToast('Export failed');
        return;
      }

      const raw = res.headers.get('X-Keyway-Warnings');
      const notes: string[] = raw ? (JSON.parse(decodeURIComponent(raw)) as string[]) : [];
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'keyway-export';

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);

      onToast(`Exported ${filename}`);
      if (notes.length) setWarnings(notes);
      else onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-title"
    >
      <div className="w-full max-w-md rounded-lg bg-white p-4 shadow-xl dark:bg-slate-900">
        <h2 id="export-title" className="mb-3 text-sm font-semibold">
          <i className="fa-solid fa-file-export" /> Export collection
        </h2>

        <div className="grid gap-3">
          <div className="grid gap-1">
            <label htmlFor="export-scope" className="text-xs font-medium text-slate-500">
              What to export
            </label>
            <select
              id="export-scope"
              value={folderId}
              disabled={format === 'json'}
              onChange={(e) => setFolderId(e.target.value)}
              className="h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800"
            >
              <option value="">Everything</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {' '.repeat(f.depth * 3)}
                  {f.name}
                </option>
              ))}
            </select>
          </div>

          <fieldset className="grid gap-1">
            <legend className="mb-1 text-xs font-medium text-slate-500">Format</legend>
            {FORMATS.map((f) => (
              <label
                key={f.id}
                htmlFor={`fmt-${f.id}`}
                className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <input
                  id={`fmt-${f.id}`}
                  type="radio"
                  name="export-format"
                  checked={format === f.id}
                  onChange={() => setFormat(f.id)}
                  className="mt-1 h-4 w-4 border-slate-300 text-indigo-600"
                />
                <span>
                  {f.label}
                  <span className="block text-[11px] text-slate-400">{f.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>

          {warnings.length > 0 && (
            <ul className="grid gap-1 rounded bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
              {warnings.map((w, i) => (
                <li key={i}>
                  <i className="fa-solid fa-triangle-exclamation" /> {w}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded border border-slate-300 px-3 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Close
          </button>
          <button
            type="button"
            onClick={run}
            disabled={busy}
            className="h-8 rounded bg-indigo-600 px-3 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            <i className="fa-solid fa-download" /> Export
          </button>
        </div>
      </div>
    </div>
  );
}
