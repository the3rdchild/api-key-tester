import { useEffect, useState } from 'react';
import type { KeyEntry } from '../../../shared/types.ts';
import { StatusBadge } from './StatusBadge.tsx';

interface Props {
  entry: KeyEntry | null;
  onClose: () => void;
}

export function DetailsModal({ entry, onClose }: Props) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setCopied(false);
  }, [entry]);

  if (!entry) return null;

  const status = entry.status;
  const tested = !!status.testedAt;

  const handleCopy = async () => {
    if (!status.raw) return;
    try {
      await navigator.clipboard.writeText(status.raw);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  // try to pretty-print JSON
  let prettyRaw = status.raw || '';
  if (prettyRaw) {
    try {
      const parsed = JSON.parse(prettyRaw);
      prettyRaw = JSON.stringify(parsed, null, 2);
    } catch {
      /* not JSON, keep as-is */
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-lg bg-white p-6 shadow-xl dark:bg-slate-900 dark:border dark:border-slate-800"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">
              {entry.label || entry.provider}
              <span className="ml-2 text-sm font-normal text-slate-400">{entry.provider}</span>
            </h2>
            <div className="mt-1 flex items-center gap-3 text-sm text-slate-500">
              <StatusBadge state={status.state} />
              {status.httpStatus != null && (
                <span className="font-mono">HTTP {status.httpStatus}</span>
              )}
              {status.latencyMs != null && (
                <span className="font-mono">{status.latencyMs} ms</span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
          >
            ✕
          </button>
        </div>

        {!tested ? (
          <div className="py-8 text-center text-slate-400">
            Not tested yet. Click ▶ to run a test.
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
            {/* Detail */}
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
                Result
              </div>
              <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-800 dark:bg-slate-950">
                {status.detail || <span className="italic text-slate-400">No detail message</span>}
              </div>
              <div className="mt-1 text-xs text-slate-400">
                Tested {new Date(status.testedAt!).toLocaleString()}
              </div>
            </div>

            {/* Raw response */}
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="mb-1 flex items-center justify-between">
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Raw response
                </div>
                {status.raw && (
                  <button
                    onClick={handleCopy}
                    className="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    {copied ? '✓ Copied' : 'Copy'}
                  </button>
                )}
              </div>
              {status.raw ? (
                <pre className="min-h-0 flex-1 overflow-auto rounded border border-slate-200 bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-800 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200">
                  {prettyRaw}
                </pre>
              ) : (
                <div className="rounded border border-dashed border-slate-300 p-3 text-center text-xs text-slate-400 dark:border-slate-700">
                  No raw response captured for this result.
                </div>
              )}
            </div>
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <button
            onClick={onClose}
            className="rounded px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
