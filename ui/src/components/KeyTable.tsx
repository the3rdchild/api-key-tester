import { useState } from 'react';
import type { KeyEntry } from '../../../shared/types.ts';
import { MaskedKey } from './MaskedKey.tsx';
import { StatusBadge } from './StatusBadge.tsx';

interface Props {
  keys: KeyEntry[];
  onTest: (id: string) => void;
  onEdit: (entry: KeyEntry) => void;
  onDelete: (id: string) => void;
  onShowDetails: (entry: KeyEntry) => void;
  onTryInClient: (entry: KeyEntry) => void;
}

type SortKey = 'provider' | 'label' | 'state' | 'latency' | 'testedAt';

export function KeyTable({ keys, onTest, onEdit, onDelete, onShowDetails, onTryInClient }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('provider');
  const [sortAsc, setSortAsc] = useState(true);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortAsc(!sortAsc);
    else {
      setSortKey(k);
      setSortAsc(true);
    }
  };

  const sorted = [...keys].sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case 'provider': cmp = a.provider.localeCompare(b.provider); break;
      case 'label': cmp = (a.label || '').localeCompare(b.label || ''); break;
      case 'state': cmp = a.status.state.localeCompare(b.status.state); break;
      case 'latency': cmp = (a.status.latencyMs ?? 0) - (b.status.latencyMs ?? 0); break;
      case 'testedAt':
        cmp = (a.status.testedAt || '').localeCompare(b.status.testedAt || '');
        break;
    }
    return sortAsc ? cmp : -cmp;
  });

  return (
    <div className="h-full overflow-auto rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
      <table className="min-w-full table-fixed border-collapse">
        <colgroup>
          <col className="w-[26%]" />
          <col className="w-[16%]" />
          <col className="w-[10%]" />
          <col className="w-[8%]" />
          <col className="w-[8%]" />
          <col className="w-[11%]" />
          <col className="w-[11%]" />
          <col className="w-[10%]" />
        </colgroup>
        <thead className="sticky top-0 z-10 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800">
          <tr>
            <Th onClick={() => toggleSort('provider')} active={sortKey === 'provider'} asc={sortAsc}>Provider</Th>
            <Th onClick={() => toggleSort('label')} active={sortKey === 'label'} asc={sortAsc}>Label</Th>
            <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">Key</th>
            <Th onClick={() => toggleSort('state')} active={sortKey === 'state'} asc={sortAsc}>Status</Th>
            <Th onClick={() => toggleSort('latency')} active={sortKey === 'latency'} asc={sortAsc}>Latency</Th>
            <Th onClick={() => toggleSort('testedAt')} active={sortKey === 'testedAt'} asc={sortAsc}>Last tested</Th>
            <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">Quota</th>
            <th className="px-4 py-2 text-right text-xs font-semibold uppercase tracking-wider text-slate-500">Actions</th>
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr>
              <td colSpan={7} className="px-4 py-12 text-center text-slate-400">
                No keys yet. Click "Add" or "Import" to get started.
              </td>
            </tr>
          )}
          {sorted.map((k) => {
            const apiKey = k.credentials.apiKey || k.credentials.apiSecret || k.credentials.accessKeyId || '';
            return (
              <tr key={k.id} className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                <td className="px-4 py-2">
                  <div className="font-medium">{prettyProvider(k.provider)}</div>
                  {k.section && (
                    <div className="text-xs text-slate-400 font-mono">{k.section}</div>
                  )}
                </td>
                <td className="px-4 py-2 text-sm">{k.label || '-'}</td>
                <td className="px-4 py-2">
                  <MaskedKey value={apiKey} />
                </td>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-1">
                    <StatusBadge state={k.status.state} />
                    {k.status.testedAt && (
                      <button
                        onClick={() => onShowDetails(k)}
                        className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                        title={k.status.detail ? `${k.status.detail}\n-\nClick for full details & raw response` : 'View test details & raw response'}
                      >
                        <i className="fa-solid fa-circle-info" />
                      </button>
                    )}
                  </div>
                </td>
                <td className="px-4 py-2 text-sm font-mono">
                  {k.status.latencyMs != null ? `${k.status.latencyMs}ms` : '-'}
                </td>
                <td className="px-4 py-2 text-xs text-slate-500">
                  {k.status.testedAt ? new Date(k.status.testedAt).toLocaleString() : '-'}
                </td>
                <td className="px-4 py-2 text-xs">
                  {k.quota ? (
                    <span
                      className={k.quota.error ? 'text-amber-600' : 'text-slate-600 dark:text-slate-300'}
                      title={
                        k.quota.error
                          ? k.quota.error
                          : `${k.quota.detail ? k.quota.detail + ' · ' : ''}checked ${new Date(k.quota.checkedAt).toLocaleString()}`
                      }
                    >
                      {k.quota.summary}
                    </span>
                  ) : (
                    <span className="text-slate-400">-</span>
                  )}
                </td>
                <td className="px-4 py-2 text-right whitespace-nowrap">
                  {k.testable && (
                    <button
                      onClick={() => onTest(k.id)}
                      disabled={k.status.state === 'pending'}
                      className="mr-2 text-emerald-600 hover:text-emerald-800 disabled:opacity-40 disabled:cursor-not-allowed"
                      title="Test now"
                    >
                      <i className="fa-solid fa-play" />
                    </button>
                  )}
                  {k.testable && (
                    <button
                      onClick={() => onTryInClient(k)}
                      className="mr-2 text-indigo-600 hover:text-indigo-800"
                      title="Send a test request (editable)"
                    >
                      <i className="fa-solid fa-paper-plane" />
                    </button>
                  )}
                  <button
                    onClick={() => onEdit(k)}
                    className="mr-2 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                    title="Edit"
                  >
                    <i className="fa-solid fa-pen" />
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`Delete "${k.label || k.provider}"?`)) onDelete(k.id);
                    }}
                    className="text-red-500 hover:text-red-700"
                    title="Delete"
                  >
                    <i className="fa-solid fa-trash" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Th({
  children,
  onClick,
  active,
  asc,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active: boolean;
  asc: boolean;
}) {
  return (
    <th
      onClick={onClick}
      className="cursor-pointer select-none px-4 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
    >
      {children} {active && (asc ? <i className="fa-solid fa-arrow-up" /> : <i className="fa-solid fa-arrow-down" />)}
    </th>
  );
}

function prettyProvider(p: string): string {
  const map: Record<string, string> = {
    'openai-compat': 'OpenAI-compat',
    'cloudflare-r2': 'Cloudflare R2',
    'do-spaces': 'DigitalOcean Spaces',
  };
  return map[p] || p.charAt(0).toUpperCase() + p.slice(1);
}
