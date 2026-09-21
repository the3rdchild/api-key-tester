// Run the current request against several keys (and models) at once.
//
// The comparison Postman can't make: it doesn't know your keys. Here the body
// writes {{model}} and the URL writes {{vault.baseURL}}, and each cell fills
// them in from the key it was given.

import { useEffect, useRef, useState } from 'react';

import type { MatrixItem, RequestSpec } from '../../../shared/collections.ts';
import type { KeyEntry } from '../../../shared/types.ts';

const LLM_PROVIDERS = [
  'openai',
  'deepseek',
  'openrouter',
  'deepinfra',
  'openai-compat',
  'anthropic',
  'gemini',
  'perplexity',
  'zai',
];

interface Props {
  open: boolean;
  spec: RequestSpec;
  vaultKeys: KeyEntry[];
  onClose: () => void;
  onToast: (msg: string) => void;
}

export function MatrixDialog({ open, spec, vaultKeys, onClose, onToast }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [modelsText, setModelsText] = useState('');
  const [concurrency, setConcurrency] = useState(3);
  const [items, setItems] = useState<MatrixItem[]>([]);
  const [running, setRunning] = useState(false);
  const [total, setTotal] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);

  const candidates = vaultKeys.filter((k) => k.testable && LLM_PROVIDERS.includes(k.provider));
  const models = modelsText
    .split('\n')
    .map((m) => m.trim())
    .filter(Boolean);
  const cells = Math.max(selected.size, 1) * Math.max(models.length, 1);

  // Show the previous run when the dialog opens - comparing providers is
  // something you come back to, not a one-shot.
  useEffect(() => {
    if (!open) return;
    fetch('/api/matrix/status')
      .then((r) => r.json() as Promise<{ current: { items: MatrixItem[]; total: number } | null; last: { items: MatrixItem[]; total: number } | null }>)
      .then(({ current, last }) => {
        const run = current ?? last;
        if (!run) return;
        setItems(run.items);
        setTotal(run.total);
        setRunning(!!current);
      })
      .catch(() => {});
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/live`);
    wsRef.current = ws;
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as { type: string; item?: MatrixItem; run?: { total: number } };
        if (msg.type === 'matrix:started' && msg.run) {
          setItems([]);
          setRunning(true);
          setTotal(msg.run.total);
        }
        if (msg.type === 'matrix:item' && msg.item) setItems((prev) => [...prev, msg.item!]);
        if (msg.type === 'matrix:done') setRunning(false);
      } catch {
        /* ignore */
      }
    };
    return () => ws.close();
  }, [open]);

  if (!open) return null;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const run = async () => {
    const targets =
      models.length === 0
        ? [...selected].map((keyId) => ({ keyId }))
        : [...selected].flatMap((keyId) => models.map((model) => ({ keyId, model })));
    if (targets.length === 0) {
      onToast('Pick at least one key');
      return;
    }
    setItems([]);
    const res = await fetch('/api/matrix/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec, targets, concurrency }),
    });
    if (!res.ok) onToast(((await res.json()) as { error?: string }).error ?? 'Matrix run failed');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col rounded-lg bg-white shadow-xl dark:bg-slate-900">
        <div className="flex items-center gap-3 border-b border-slate-200 p-3 dark:border-slate-800">
          <h2 className="text-sm font-semibold">
            <i className="fa-solid fa-table-cells" /> Run across keys — {spec.name || spec.url}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto h-8 w-8 rounded text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <i className="fa-solid fa-xmark" />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[18rem_1fr] gap-0 overflow-hidden">
          {/* pickers */}
          <div className="flex min-h-0 flex-col gap-3 border-r border-slate-200 p-3 dark:border-slate-800">
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="mb-1 flex items-center gap-2">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Keys ({selected.size}/{candidates.length})
                </h3>
                <button
                  type="button"
                  onClick={() =>
                    setSelected((prev) =>
                      prev.size === candidates.length ? new Set() : new Set(candidates.map((k) => k.id)),
                    )
                  }
                  className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-slate-800"
                >
                  {selected.size === candidates.length ? 'none' : 'all'}
                </button>
              </div>
              <div className="grid min-h-0 flex-1 content-start gap-1 overflow-auto">
                {candidates.map((k) => (
                  <label
                    key={k.id}
                    htmlFor={`mx-${k.id}`}
                    className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    <input
                      id={`mx-${k.id}`}
                      type="checkbox"
                      checked={selected.has(k.id)}
                      onChange={() => toggle(k.id)}
                      className="h-4 w-4 rounded border-slate-300 text-indigo-600 dark:border-slate-600 dark:bg-slate-800"
                    />
                    <span className="min-w-0 truncate">
                      {k.provider}
                      {k.label ? ` · ${k.label}` : ''}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div className="shrink-0">
              <label htmlFor="mx-models" className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Models (optional, one per line)
              </label>
              <textarea
                id="mx-models"
                value={modelsText}
                onChange={(e) => setModelsText(e.target.value)}
                placeholder={'gpt-4o-mini\ndeepseek-chat'}
                className="mt-1 h-16 w-full resize-none rounded border border-slate-300 bg-white p-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
              />
              <p className="mt-1 text-[11px] text-slate-400">
                Each line becomes <code className="font-mono">{'{{model}}'}</code> for one cell.
              </p>
            </div>

            <div className="grid shrink-0 gap-1">
              <label htmlFor="mx-conc" className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Concurrency
              </label>
              <input
                id="mx-conc"
                type="number"
                min={1}
                max={8}
                value={concurrency}
                onChange={(e) => setConcurrency(Number(e.target.value) || 1)}
                className="h-8 w-20 rounded border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-800"
              />
            </div>

            <button
              type="button"
              onClick={run}
              disabled={running || selected.size === 0}
              className="h-9 shrink-0 rounded bg-indigo-600 px-3 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {running ? (
                <>
                  <i className="fa-solid fa-spinner fa-spin" /> {items.length}/{total}
                </>
              ) : (
                <>
                  <i className="fa-solid fa-play" /> Run {cells} cell{cells === 1 ? '' : 's'}
                </>
              )}
            </button>
          </div>

          {/* results */}
          <div className="min-h-0 overflow-auto">
            {items.length === 0 ? (
              <p className="p-4 text-sm text-slate-400">
                Pick keys on the left and run. Every cell sends this same request with that key's
                credentials — the vault's fields are available as{' '}
                <code className="font-mono">{'{{vault.baseURL}}'}</code>.
              </p>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-slate-50 dark:bg-slate-950">
                  <tr className="text-[11px] uppercase tracking-wide text-slate-400">
                    <th className="px-3 py-2">Target</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 text-right">Latency</th>
                    <th className="px-3 py-2 text-right">TTFT</th>
                    <th className="px-3 py-2 text-right">tok/s</th>
                    <th className="px-3 py-2">Answer</th>
                  </tr>
                </thead>
                <tbody>
                  {[...items]
                    .sort((a, b) => (a.latencyMs ?? 1e9) - (b.latencyMs ?? 1e9))
                    .map((item, i) => (
                      <tr key={i} className="border-t border-slate-100 dark:border-slate-800">
                        <td className="px-3 py-2">
                          <i
                            className={`fa-solid mr-2 ${
                              item.ok ? 'fa-circle-check text-emerald-500' : 'fa-circle-xmark text-red-500'
                            }`}
                          />
                          {item.label}
                        </td>
                        <td className="px-3 py-2 font-mono">{item.status ?? '—'}</td>
                        <td className="px-3 py-2 text-right font-mono">
                          {item.latencyMs != null ? `${item.latencyMs} ms` : '—'}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {item.ttftMs != null ? `${item.ttftMs} ms` : '—'}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {item.tokensPerSecond != null ? item.tokensPerSecond : '—'}
                        </td>
                        <td className="max-w-md px-3 py-2">
                          <span className={item.error ? 'text-red-600 dark:text-red-400' : 'text-slate-500'}>
                            {(item.error ?? item.preview ?? '').slice(0, 120)}
                          </span>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
