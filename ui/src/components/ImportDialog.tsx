import { useRef, useState } from 'react';
import { api } from '../lib/api.ts';

interface PreviewEntry {
  index: number;
  provider: string;
  label?: string;
  testable: boolean;
  warn?: string;
  apiKeyMasked: string;
  duplicate?: boolean;
}

interface PreviewResult {
  format: string;
  count: number;
  newCount: number;
  duplicateCount: number;
  entries: PreviewEntry[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}

export function ImportDialog({ open, onClose, onImported }: Props) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [mergeExisting, setMergeExisting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const reset = () => {
    setText('');
    setPreview(null);
    setError(null);
    setFileName(null);
    setMergeExisting(false);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handlePreview = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.previewImport(text);
      setPreview(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.importText(text, { mergeExisting });
      reset();
      onImported();
      onClose();
      // surface outcome via onImported toast in parent — but also return summary
      window.dispatchEvent(
        new CustomEvent('import-result', {
          detail: {
            created: result.created,
            skipped: result.skipped,
            merged: result.merged,
          },
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // ─── File handling ──────────────────────────────────────────────────────
  const readFile = async (file: File) => {
    setFileName(file.name);
    try {
      const content = await file.text();
      setText(content);
      setPreview(null);
      setError(null);
    } catch (e) {
      setError(`Failed to read ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) readFile(file);
    // reset input so same file can be picked again
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) readFile(file);
  };

  const handleBrowse = () => fileInputRef.current?.click();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-lg bg-white p-6 shadow-xl dark:bg-slate-900 dark:border dark:border-slate-800">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Import keys</h2>
          <button onClick={handleClose} className="text-2xl text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">
            <i className="fa- fa-x" />
          </button>
        </div>

        <p className="mb-3 text-sm text-slate-500">
          Upload a file or paste raw content. Supported formats:{' '}
          <code className="text-xs">.md / .json / .env / .csv / curl snippets</code>.
          Auto-detected — same parser handles everything you can Export.
        </p>

        {/* File dropzone */}
        <div
          onClick={handleBrowse}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          className={`mb-3 cursor-pointer rounded-lg border-2 border-dashed p-4 text-center text-sm transition ${
            dragOver
              ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30'
              : 'border-slate-300 hover:border-slate-400 dark:border-slate-700 dark:hover:border-slate-600'
          }`}
        >
          {fileName ? (
            <span className="text-slate-700 dark:text-slate-300">
              📄 <strong>{fileName}</strong> loaded —{' '}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleBrowse();
                }}
                className="text-emerald-600 hover:underline"
              >
                choose another
              </button>
            </span>
          ) : (
            <span className="text-slate-500">
              <strong>Click to browse</strong> or drag &amp; drop a file here
              <br />
              <span className="text-xs text-slate-400">.md, .json, .env, .csv, .txt</span>
            </span>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.markdown,.json,.env,.csv,.txt,text/*"
            onChange={handleFileChange}
            className="hidden"
          />
        </div>

        {/* Or paste directly */}
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setPreview(null);
            if (fileName) setFileName(null);
          }}
          rows={8}
          placeholder={`…or paste content here\n\n## --openai\nOPENAI_API_KEY=sk-...\n\n# OpenRouter (Citation-db)\nOPENROUTER_API_KEY=sk-or-v1-...\nOPENROUTER_BASE_URL=https://openrouter.ai/api/v1`}
          className="w-full flex-1 resize-none rounded border border-slate-300 bg-white p-3 font-mono text-xs dark:border-slate-700 dark:bg-slate-800"
        />

        {error && (
          <div className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        {preview && (
          <div className="mt-3">
            {/* Summary */}
            <div className="mb-2 flex flex-wrap items-center gap-3 text-xs">
              <span className="rounded bg-slate-200 px-2 py-0.5 font-mono dark:bg-slate-700">
                format: {preview.format}
              </span>
              <span className="text-slate-500">
                {preview.count} parsed ·{' '}
                <span className="text-emerald-600 font-medium">{preview.newCount} new</span>
                {preview.duplicateCount > 0 && (
                  <>
                    {' '}·{' '}
                    <span className="text-amber-600 font-medium">
                      {preview.duplicateCount} duplicate
                    </span>
                  </>
                )}
              </span>
            </div>

            {/* Duplicate handling options */}
            {preview.duplicateCount > 0 && (
              <label className="mb-2 flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={mergeExisting}
                  onChange={(e) => setMergeExisting(e.target.checked)}
                />
                Update existing entries with new credentials (merge instead of skip)
              </label>
            )}

            {/* Entries table */}
            <div className="max-h-48 overflow-y-auto rounded border border-slate-200 dark:border-slate-800">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 dark:bg-slate-950 sticky top-0">
                  <tr>
                    <th className="px-2 py-1 text-left">Provider</th>
                    <th className="px-2 py-1 text-left">Label</th>
                    <th className="px-2 py-1 text-left">Key</th>
                    <th className="px-2 py-1 text-left">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.entries.map((e) => (
                    <tr
                      key={e.index}
                      className={`border-t border-slate-100 dark:border-slate-800 ${
                        e.duplicate ? 'bg-amber-50/50 dark:bg-amber-950/20' : ''
                      }`}
                    >
                      <td className="px-2 py-1 font-mono">{e.provider}</td>
                      <td className="px-2 py-1">{e.label || '—'}</td>
                      <td className="px-2 py-1 font-mono">{e.apiKeyMasked || '—'}</td>
                      <td className="px-2 py-1">
                        {e.duplicate ? (
                          <span className="text-amber-600">existing</span>
                        ) : (
                          <>
                            {e.testable ? '✓ testable' : '✗ ref'}
                            {e.warn && <span className="ml-1 text-amber-600" title={e.warn}>⚠</span>}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={handleClose}
            className="rounded px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            onClick={handlePreview}
            disabled={busy || !text.trim()}
            className="rounded border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Preview
          </button>
          <button
            onClick={handleImport}
            disabled={busy || !text.trim()}
            className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {busy
              ? 'Importing…'
              : preview
                ? `Import ${preview.newCount} new${mergeExisting ? ` + ${preview.duplicateCount} merge` : ''}`
                : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}
