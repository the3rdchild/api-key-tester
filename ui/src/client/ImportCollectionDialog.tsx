// Import a Postman collection or environment, an Insomnia export, or an
// OpenAPI/Swagger document.
//
// Preview first, write second: these files routinely carry a hundred requests,
// and "import and then go read the sidebar to find out what happened" is not a
// workable way to find out what you just did.

import { useState } from 'react';

interface PreviewRequest {
  method: string;
  name: string;
  url: string;
}

interface Preview {
  format: string;
  name: string;
  total: number;
  environments: { name: string; vars: number }[];
  folders: { name: string; requests: PreviewRequest[] }[];
  warnings: string[];
}

const FORMAT_LABEL: Record<string, string> = {
  postman: 'Postman collection',
  'postman-environment': 'Postman environment',
  insomnia: 'Insomnia export',
  openapi: 'OpenAPI / Swagger',
  unknown: 'Unrecognised',
};

interface Props {
  open: boolean;
  onClose: () => void;
  onImported: (msg: string) => void;
}

export function ImportCollectionDialog({ open, onClose, onImported }: Props) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  /** everything lands inside this folder unless the wrapper is switched off */
  const [folderName, setFolderName] = useState('');
  const [wrap, setWrap] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  if (!open) return null;

  const reset = () => {
    setText('');
    setPreview(null);
    setError(null);
    setExpanded(null);
    setFolderName('');
    setWrap(true);
  };

  const inspect = async (content: string) => {
    setText(content);
    setPreview(null);
    setError(null);
    if (!content.trim()) return;
    setBusy(true);
    try {
      const res = await fetch('/api/collections/import/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: content }),
      });
      const body = (await res.json()) as Preview & { error?: string };
      if (!res.ok || body.error) {
        setError(body.error ?? 'Could not read that file');
      } else {
        setPreview(body);
        setFolderName(body.name);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    await inspect(await file.text());
  };

  const doImport = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/collections/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, name: wrap ? folderName : '' }),
      });
      const body = (await res.json()) as {
        requests?: number;
        folders?: number;
        environments?: number;
        environmentsMerged?: number;
        error?: string;
      };
      if (!res.ok || body.error) {
        setError(body.error ?? 'Import failed');
        return;
      }
      const merged = body.environmentsMerged
        ? `, ${body.environmentsMerged} environment(s) merged`
        : '';
      onImported(
        `Imported ${body.requests} request(s), ${body.folders} folder(s), ${body.environments} environment(s)${merged}`,
      );
      reset();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[88vh] w-full max-w-3xl flex-col rounded-lg bg-white shadow-xl dark:bg-slate-900">
        <div className="flex items-center gap-3 border-b border-slate-200 p-3 dark:border-slate-800">
          <h2 className="text-sm font-semibold">
            <i className="fa-solid fa-file-import" /> Import collection
          </h2>
          <span className="text-xs text-slate-400">
            Postman · Insomnia · OpenAPI / Swagger (JSON or YAML)
          </span>
          <button
            type="button"
            onClick={() => {
              reset();
              onClose();
            }}
            aria-label="Close"
            className="ml-auto h-8 w-8 rounded text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <i className="fa-solid fa-xmark" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          <div className="flex items-center gap-3">
            <label className="flex h-9 cursor-pointer items-center gap-2 rounded border border-dashed border-slate-300 px-3 text-sm text-slate-600 hover:border-indigo-400 dark:border-slate-700 dark:text-slate-300">
              <input
                type="file"
                accept=".json,.yaml,.yml,application/json,text/yaml"
                className="sr-only"
                onChange={(e) => void onFile(e.target.files?.[0])}
              />
              <i className="fa-solid fa-folder-open" /> Choose a file
            </label>
            <span className="text-xs text-slate-400">or paste below</span>
            {busy && <i className="fa-solid fa-spinner fa-spin text-slate-400" />}
          </div>

          <label htmlFor="import-text" className="sr-only">
            File contents
          </label>
          <textarea
            id="import-text"
            value={text}
            spellCheck={false}
            onChange={(e) => void inspect(e.target.value)}
            placeholder='{ "info": { "schema": "…collection.json" }, "item": [ … ] }'
            className="mt-3 h-36 w-full resize-none rounded border border-slate-300 bg-white p-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
          />

          {error && (
            <p className="mt-2 rounded bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-200">
              {error}
            </p>
          )}

          {preview && (
            <div className="mt-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="rounded bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200">
                  {FORMAT_LABEL[preview.format] ?? preview.format}
                </span>
                <span className="font-medium">{preview.name}</span>
                <span className="text-xs text-slate-500">
                  {preview.total} request{preview.total === 1 ? '' : 's'} ·{' '}
                  {preview.folders.length} folder{preview.folders.length === 1 ? '' : 's'} ·{' '}
                  {preview.environments.length} environment
                  {preview.environments.length === 1 ? '' : 's'}
                </span>
              </div>

              {preview.total > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-slate-200 p-2 dark:border-slate-800">
                  <input
                    id="import-wrap"
                    type="checkbox"
                    checked={wrap}
                    onChange={(e) => setWrap(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-indigo-600 dark:border-slate-600 dark:bg-slate-800"
                  />
                  <label htmlFor="import-wrap" className="cursor-pointer text-xs text-slate-600 dark:text-slate-300">
                    Put everything in a folder called
                  </label>
                  <input
                    aria-label="Folder name for this import"
                    value={folderName}
                    disabled={!wrap}
                    onChange={(e) => setFolderName(e.target.value)}
                    className="h-8 min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 text-sm disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800"
                  />
                  <span className="w-full text-[11px] text-slate-400">
                    Its own folders become subfolders of this one, so a second import never mixes
                    with the first. You can rename it later in the sidebar.
                  </span>
                </div>
              )}

              {preview.warnings.length > 0 && (
                <ul className="mt-2 grid gap-1 rounded bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                  {preview.warnings.map((w, i) => (
                    <li key={i}>
                      <i className="fa-solid fa-triangle-exclamation" /> {w}
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-2 divide-y divide-slate-100 rounded border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
                {preview.folders.map((folder) => (
                  <div key={folder.name}>
                    <button
                      type="button"
                      onClick={() => setExpanded((prev) => (prev === folder.name ? null : folder.name))}
                      className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      <i
                        className={`fa-solid ${expanded === folder.name ? 'fa-chevron-down' : 'fa-chevron-right'} w-3 text-slate-400`}
                      />
                      <i className="fa-solid fa-folder text-amber-500" />
                      <span className="font-medium">{folder.name}</span>
                      <span className="ml-auto text-slate-400">{folder.requests.length}</span>
                    </button>
                    {expanded === folder.name && (
                      <ul className="bg-slate-50 px-2 py-1 dark:bg-slate-950">
                        {folder.requests.map((r, i) => (
                          <li key={i} className="flex gap-2 py-0.5 text-xs">
                            <span className="w-12 shrink-0 font-mono text-slate-500">{r.method}</span>
                            <span className="shrink-0">{r.name}</span>
                            <span className="min-w-0 truncate font-mono text-slate-400">{r.url}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
                {preview.environments.map((env) => (
                  <div key={env.name} className="flex items-center gap-2 px-2 py-1.5 text-xs">
                    <i className="fa-solid fa-sliders w-3 text-slate-400" />
                    <span className="font-medium">{env.name}</span>
                    <span className="ml-auto text-slate-400">{env.vars} vars</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 p-3 dark:border-slate-800">
          <button
            type="button"
            onClick={() => {
              reset();
              onClose();
            }}
            className="h-8 rounded border border-slate-300 px-3 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={doImport}
            disabled={busy || !preview || preview.format === 'unknown' || preview.total + preview.environments.length === 0}
            className="h-8 rounded bg-indigo-600 px-3 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            <i className="fa-solid fa-file-import" /> Import
          </button>
        </div>
      </div>
    </div>
  );
}
