// Naming a request when it is first saved.
//
// Saving used to drop it into the collection as "Untitled request" and leave
// you to rename it in the sidebar afterwards - which nobody ever does, so the
// tree filled up with identical names.

import { useEffect, useState } from 'react';

export interface FolderChoice {
  id: string;
  name: string;
  depth: number;
}

interface Props {
  open: boolean;
  initialName: string;
  folders: FolderChoice[];
  onCancel: () => void;
  onSave: (name: string, parentId: string | null) => void;
}

export function SaveRequestDialog({ open, initialName, folders, onCancel, onSave }: Props) {
  const [name, setName] = useState(initialName);
  const [parentId, setParentId] = useState<string>('');

  useEffect(() => {
    if (open) setName(initialName);
  }, [open, initialName]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="save-title"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
    >
      <div className="w-full max-w-md rounded-lg bg-white p-4 shadow-xl dark:bg-slate-900">
        <h2 id="save-title" className="mb-3 text-sm font-semibold">
          <i className="fa-solid fa-floppy-disk" /> Save request
        </h2>

        <div className="grid gap-3">
          <div className="grid gap-1">
            <label htmlFor="save-name" className="text-xs font-medium text-slate-500">
              Name
            </label>
            <input
              id="save-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim()) onSave(name.trim(), parentId || null);
              }}
              className="h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-800"
            />
          </div>

          <div className="grid gap-1">
            <label htmlFor="save-folder" className="text-xs font-medium text-slate-500">
              Folder
            </label>
            <select
              id="save-folder"
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              className="h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-800"
            >
              <option value="">(top level)</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {' '.repeat(f.depth * 3)}
                  {f.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-8 rounded border border-slate-300 px-3 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => name.trim() && onSave(name.trim(), parentId || null)}
            disabled={!name.trim()}
            className="h-8 rounded bg-indigo-600 px-3 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
