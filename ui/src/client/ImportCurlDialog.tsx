// Paste a curl command (usually straight out of devtools) and get a request.
// The parse happens server-side so the UI and the CLI can never disagree about
// what a command means.

import { useEffect, useState } from 'react';

import { clientApi } from '../lib/clientApi.ts';
import type { RequestSpec } from '../../../shared/collections.ts';

interface Props {
  open: boolean;
  onClose: () => void;
  onImported: (spec: RequestSpec, warnings: string[]) => void;
}

export function ImportCurlDialog({ open, onClose, onImported }: Props) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setText('');
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const { spec, warnings } = await clientApi.importCurl(text);
      onImported(spec, warnings);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-curl-title"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="w-full max-w-2xl rounded-lg bg-white p-4 shadow-xl dark:bg-slate-900">
        <h2 id="import-curl-title" className="mb-2 text-sm font-semibold">
          <i className="fa-solid fa-terminal" /> Import cURL
        </h2>
        <label htmlFor="curl-text" className="sr-only">
          curl command
        </label>
        <textarea
          id="curl-text"
          autoFocus
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"curl 'https://api.example.com/v1/users' \\\n  -H 'Authorization: Bearer …' \\\n  --data-raw '{\"name\":\"budi\"}'"}
          className="h-52 w-full resize-none rounded border border-slate-300 bg-white p-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
        />
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        <p className="mt-2 text-xs text-slate-400">
          Query strings become editable params; <code className="font-mono">-F file=@…</code> keeps
          the field but you re-pick the file.
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded border border-slate-300 px-3 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={run}
            disabled={busy || !text.trim()}
            className="h-8 rounded bg-indigo-600 px-3 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {busy ? 'Parsing…' : 'Open in tab'}
          </button>
        </div>
      </div>
    </div>
  );
}
