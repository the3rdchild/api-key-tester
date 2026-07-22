import { useEffect, useMemo, useState } from 'react';
import type { KeyEntry, Provider } from '../../shared/types.ts';
import { api, type ProviderInfo } from './lib/api.ts';
import { useStore } from './lib/useStore.ts';
import { KeyTable } from './components/KeyTable.tsx';
import { EditModal } from './components/EditModal.tsx';
import { ImportDialog } from './components/ImportDialog.tsx';
import { ExportMenu } from './components/ExportMenu.tsx';
import { DetailsModal } from './components/DetailsModal.tsx';

export default function App() {
  const { keys, loading, error, refresh, wsConnected, lastFileChange } = useStore();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [editing, setEditing] = useState<KeyEntry | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [detailsEntry, setDetailsEntry] = useState<KeyEntry | null>(null);
  const [testingAll, setTestingAll] = useState(false);
  const [filterProvider, setFilterProvider] = useState<string>('');
  const [filterState, setFilterState] = useState<string>('');
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    api.listProviders().then(({ providers }) => setProviders(providers)).catch(() => {});
  }, []);

  // listen for import summary from ImportDialog
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { created: number; skipped: number; merged: number }
        | undefined;
      if (!detail) return;
      const parts: string[] = [];
      if (detail.created) parts.push(`${detail.created} created`);
      if (detail.merged) parts.push(`${detail.merged} merged`);
      if (detail.skipped) parts.push(`${detail.skipped} skipped (duplicate)`);
      showToast(parts.length ? `Import: ${parts.join(', ')}` : 'Nothing imported');
    };
    window.addEventListener('import-result', handler);
    return () => window.removeEventListener('import-result', handler);
  }, []);

  const filtered = useMemo(() => {
    return keys.filter((k) => {
      if (filterProvider && k.provider !== filterProvider) return false;
      if (filterState && k.status.state !== filterState) return false;
      if (search) {
        const q = search.toLowerCase();
        const hay = `${k.provider} ${k.label || ''} ${k.section || ''} ${k.note || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [keys, filterProvider, filterState, search]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  const handleTest = async (id: string) => {
    try {
      await api.testOne(id);
    } catch (e) {
      showToast(`Test failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleTestAll = async () => {
    setTestingAll(true);
    try {
      const r = await api.testAll(
        filterProvider ? { providers: [filterProvider] } : undefined,
      );
      showToast(`Started ${r.started} of ${r.total} tests`);
    } catch (e) {
      showToast(`Batch failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTestingAll(false);
    }
  };

  const handleSave = async (input: {
    id?: string;
    provider: Provider;
    label?: string;
    credentials: Record<string, string>;
    note?: string;
    section?: string;
  }) => {
    if (input.id) {
      await api.updateKey(input.id, {
        provider: input.provider,
        label: input.label,
        credentials: input.credentials,
        note: input.note,
        section: input.section,
      });
      showToast('Updated');
    } else {
      await api.createKey({
        provider: input.provider,
        label: input.label,
        credentials: input.credentials,
        note: input.note,
        section: input.section,
      });
      showToast('Created');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.deleteKey(id);
      showToast('Deleted');
    } catch (e) {
      showToast(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleAdd = () => {
    setEditing(null);
    setModalOpen(true);
  };
  const handleEdit = (entry: KeyEntry) => {
    setEditing(entry);
    setModalOpen(true);
  };

  const stats = useMemo(() => {
    const c = { valid: 0, invalid: 0, rate_limited: 0, error: 0, untested: 0, pending: 0 };
    for (const k of keys) c[k.status.state]++;
    return c;
  }, [keys]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-slate-400">
        Loading…
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-7xl flex-col px-4 py-4">
      {/* Topbar */}
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold"><i className="fa-solid fa-key" /> Key Tester</h1>
          <span
            className={`inline-flex items-center gap-1 text-xs ${wsConnected ? 'text-emerald-600' : 'text-slate-400'}`}
            title={wsConnected ? 'WebSocket connected - live updates' : 'WebSocket disconnected'}
          >
            <span className={`inline-block h-2 w-2 rounded-full ${wsConnected ? 'bg-emerald-500' : 'bg-slate-400'}`} />
            {wsConnected ? 'live' : 'offline'}
          </span>
          {lastFileChange && (
            <span className="text-xs text-amber-600" title={`keys.md changed externally at ${lastFileChange}`}>
              <i className="fa-solid fa-file-pen" /> file synced
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleAdd}
            className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
          >
            <i className="fa-solid fa-plus" /> Add
          </button>
          <button
            onClick={() => setImportOpen(true)}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <i className="fa-solid fa-file-import" /> Import
          </button>
          <ExportMenu />
          <button
            onClick={handleTestAll}
            disabled={testingAll}
            className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {testingAll ? <><i className="fa-solid fa-spinner fa-spin" /> Testing…</> : <><i className="fa-solid fa-play" /> Test all</>}
          </button>
          <button
            onClick={refresh}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            title="Refresh"
          >
            <i className="fa-solid fa-rotate-right" />
          </button>
        </div>
      </header>

      {/* Stats + filters */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <Stat label="Valid" value={stats.valid} color="text-emerald-600" />
          <Stat label="Invalid" value={stats.invalid} color="text-red-600" />
          <Stat label="Rate-limited" value={stats.rate_limited} color="text-amber-600" />
          <Stat label="Error" value={stats.error} color="text-red-600" />
          <Stat label="Untested" value={stats.untested} color="text-slate-500" />
          <span className="text-slate-400">·</span>
          <span className="text-slate-500">{keys.length} total</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-800"
          />
          <select
            value={filterProvider}
            onChange={(e) => setFilterProvider(e.target.value)}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-800"
          >
            <option value="">All providers</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <select
            value={filterState}
            onChange={(e) => setFilterState(e.target.value)}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-800"
          >
            <option value="">All states</option>
            <option value="untested">Untested</option>
            <option value="valid">Valid</option>
            <option value="invalid">Invalid</option>
            <option value="rate_limited">Rate-limited</option>
            <option value="error">Error</option>
          </select>
        </div>
      </div>

      {error && (
        <div className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="min-h-0 flex-1">
        <KeyTable
          keys={filtered}
          onTest={handleTest}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onShowDetails={setDetailsEntry}
        />
      </div>

      {/* Modals */}
      <EditModal
        open={modalOpen}
        providers={providers}
        entry={editing}
        onClose={() => setModalOpen(false)}
        onSave={handleSave}
      />
      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => showToast('Imported')}
      />
      <DetailsModal
        // keep entry in sync with latest test results so the modal updates live
        entry={detailsEntry ? keys.find((k) => k.id === detailsEntry.id) ?? null : null}
        onClose={() => setDetailsEntry(null)}
      />

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white shadow-lg dark:bg-slate-700">
          {toast}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`font-semibold ${color}`}>{value}</span>
      <span className="text-slate-500">{label}</span>
    </span>
  );
}
