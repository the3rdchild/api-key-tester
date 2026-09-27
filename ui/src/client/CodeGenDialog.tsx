// "Generate code" for the current request: the same request Keyway would send,
// rendered as curl / fetch / axios / requests / HTTPie. The rendering happens
// server-side (see core/codegen.ts) so a snippet always matches an actual send —
// vault auth, {{vars}} and body serialization included.

import { useEffect, useState } from 'react';

import { clientApi } from '../lib/clientApi.ts';
import { loadLocal, saveLocal } from '../lib/storage.ts';
import type { RequestSpec } from '../../../shared/collections.ts';

const LANGS = [
  { id: 'curl', label: 'cURL', icon: 'fa-terminal' },
  { id: 'js-fetch', label: 'JavaScript · fetch', icon: 'fa-js' },
  { id: 'js-axios', label: 'JavaScript · axios', icon: 'fa-js' },
  { id: 'python-requests', label: 'Python · requests', icon: 'fa-python' },
  { id: 'httpie', label: 'HTTPie', icon: 'fa-bolt' },
] as const;

const LANG_KEY = 'client.codegen.lang';

interface Props {
  open: boolean;
  spec: RequestSpec | null;
  onClose: () => void;
  onToast: (msg: string) => void;
}

export function CodeGenDialog({ open, spec, onClose, onToast }: Props) {
  const [lang, setLang] = useState<string>(() => loadLocal(LANG_KEY) || 'js-fetch');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !spec) return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    clientApi
      .code(spec, lang)
      .then((r) => {
        if (!cancelled) setCode(r.code);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, spec, lang]);

  if (!open) return null;

  const pick = (id: string) => {
    setLang(id);
    saveLocal(LANG_KEY, id);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      onToast('Code copied');
    } catch {
      onToast('Copy failed');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="codegen-title"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="flex h-[32rem] w-full max-w-3xl flex-col rounded-lg bg-white shadow-xl dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-200 p-3 dark:border-slate-800">
          <h2 id="codegen-title" className="text-sm font-semibold">
            <i className="fa-solid fa-code" /> Generate code
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="h-7 w-7 rounded text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-700"
          >
            <i className="fa-solid fa-xmark" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* language list */}
          <div className="w-48 shrink-0 overflow-y-auto border-r border-slate-200 p-2 dark:border-slate-800">
            {LANGS.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => pick(l.id)}
                aria-current={lang === l.id ? 'true' : undefined}
                className={`mb-1 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs ${
                  lang === l.id
                    ? 'bg-indigo-50 font-medium text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                }`}
              >
                <i className={`fa-brands ${l.icon} w-4 text-center`} />
                {l.label}
              </button>
            ))}
          </div>

          {/* code */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1 overflow-auto">
              {error ? (
                <p className="m-4 text-xs text-red-600">{error}</p>
              ) : busy && !code ? (
                <p className="m-4 text-xs text-slate-400">
                  <i className="fa-solid fa-spinner fa-spin" /> Rendering…
                </p>
              ) : (
                <pre className="thin-scroll w-full overflow-auto p-3 font-mono text-xs leading-relaxed text-slate-800 dark:text-slate-200">
                  {code}
                </pre>
              )}
            </div>
            <div className="flex items-center justify-between border-t border-slate-200 p-2 dark:border-slate-800">
              <span className="pl-1 text-[11px] text-slate-400">
                Exactly what a send would put on the wire — auth and{' '}
                <code className="font-mono">{'{{vars}}'}</code> resolved.
              </span>
              <button
                type="button"
                onClick={copy}
                disabled={!code}
                className="h-8 shrink-0 rounded bg-indigo-600 px-3 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                <i className="fa-solid fa-clipboard" /> Copy
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
