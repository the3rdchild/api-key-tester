// Collections tree, environment variables and request history.

import { useEffect, useRef, useState } from 'react';

import { KeyValueEditor } from './KeyValueEditor.tsx';
import { clientApi } from '../lib/clientApi.ts';
import type { EnvironmentDef, KV, TreeNode } from '../../../shared/collections.ts';
import type { ClientState } from './useClient.ts';

type Panel = 'collections' | 'environment' | 'history';

interface Props {
  state: ClientState;
  onToast: (msg: string) => void;
}

export function Sidebar({ state, onToast }: Props) {
  const [open, setOpen] = useState<Record<Panel, boolean>>({
    collections: true,
    environment: false,
    history: true,
  });
  const file = state.collections;

  const toggle = (panel: Panel) => setOpen((prev) => ({ ...prev, [panel]: !prev[panel] }));

  const addFolder = async () => {
    const name = window.prompt('Folder name');
    if (!name) return;
    await clientApi.createFolder(name);
    await state.reloadCollections();
  };

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <PanelHeader
        label="Collections"
        icon="fa-folder-tree"
        open={open.collections}
        onToggle={() => toggle('collections')}
        actions={
          <>
            <MiniButton icon="fa-file-circle-plus" label="New request" onClick={() => state.newTab()} />
            <MiniButton icon="fa-folder-plus" label="New folder" onClick={addFolder} />
          </>
        }
      />
      {open.collections && (
        <div className="max-h-[40%] overflow-auto px-1 pb-2">
          {!file || file.tree.length === 0 ? (
            <p className="px-2 py-3 text-xs text-slate-400">
              Nothing saved yet. Hit <i className="fa-solid fa-floppy-disk" /> on a request to keep it.
            </p>
          ) : (
            file.tree.map((node) => (
              <TreeRow key={node.id} node={node} state={state} onToast={onToast} />
            ))
          )}
        </div>
      )}

      <PanelHeader
        label="Environment"
        icon="fa-sliders"
        open={open.environment}
        onToggle={() => toggle('environment')}
      />
      {open.environment && <EnvironmentPanel state={state} onToast={onToast} />}

      <PanelHeader
        label="History"
        icon="fa-clock-rotate-left"
        open={open.history}
        onToggle={() => toggle('history')}
        actions={
          <MiniButton
            icon="fa-trash"
            label="Clear history"
            onClick={async () => {
              if (!window.confirm('Clear request history?')) return;
              await clientApi.clearHistory();
              await state.reloadHistory();
              onToast('History cleared');
            }}
          />
        }
      />
      {open.history && (
        <div className="min-h-0 flex-1 overflow-auto px-1 pb-2">
          {state.history.length === 0 ? (
            <p className="px-2 py-3 text-xs text-slate-400">No requests sent yet.</p>
          ) : (
            state.history.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => state.openFromHistory(entry)}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-indigo-500 dark:hover:bg-slate-800"
              >
                <span className="w-10 shrink-0 font-mono font-semibold text-slate-500">
                  {entry.method}
                </span>
                <span className="min-w-0 flex-1 truncate">{entry.url}</span>
                {entry.checks && (
                  <span
                    className={`shrink-0 font-mono text-[10px] ${
                      entry.checks.passed === entry.checks.total ? 'text-emerald-600' : 'text-red-500'
                    }`}
                    title={`${entry.checks.passed} of ${entry.checks.total} checks passed`}
                  >
                    {entry.checks.passed}/{entry.checks.total}
                  </span>
                )}
                <span
                  className={`shrink-0 font-mono ${
                    entry.error
                      ? 'text-red-500'
                      : (entry.status ?? 0) >= 400
                        ? 'text-amber-600'
                        : 'text-emerald-600'
                  }`}
                >
                  {entry.error ? 'err' : entry.status}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </aside>
  );
}

function TreeRow({
  node,
  state,
  onToast,
}: {
  node: TreeNode;
  state: ClientState;
  onToast: (msg: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const file = state.collections;
  if (!file) return null;

  if (node.type === 'request') {
    const spec = file.requests[node.id];
    if (!spec) return null;
    return <RequestRow id={node.id} state={state} onToast={onToast} depth={0} />;
  }

  return (
    <div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          <i className={`fa-solid ${expanded ? 'fa-chevron-down' : 'fa-chevron-right'} w-3 text-slate-400`} />
          <i className="fa-solid fa-folder text-amber-500" />
          <span className="truncate">{node.name}</span>
        </button>
        <MiniButton
          icon="fa-trash"
          label={`Delete folder ${node.name}`}
          onClick={async () => {
            if (!window.confirm(`Delete folder "${node.name}" and its requests?`)) return;
            await clientApi.deleteFolder(node.id);
            await state.reloadCollections();
            onToast('Folder deleted');
          }}
        />
      </div>
      {expanded &&
        (node.children ?? []).map((childId) => (
          <RequestRow key={childId} id={childId} state={state} onToast={onToast} depth={1} />
        ))}
    </div>
  );
}

function RequestRow({
  id,
  state,
  onToast,
  depth,
}: {
  id: string;
  state: ClientState;
  onToast: (msg: string) => void;
  depth: number;
}) {
  const spec = state.collections?.requests[id];
  if (!spec) return null;
  return (
    <div className="group flex items-center gap-1" style={{ paddingLeft: depth * 12 }}>
      <button
        type="button"
        onClick={() => state.openRequest(spec)}
        className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-indigo-500 dark:hover:bg-slate-800"
      >
        <span className="w-10 shrink-0 font-mono font-semibold text-slate-500">{spec.method}</span>
        <span className="truncate">{spec.name}</span>
      </button>
      <MiniButton
        icon="fa-copy"
        label={`Duplicate ${spec.name}`}
        onClick={async () => {
          await clientApi.duplicateRequest(id);
          await state.reloadCollections();
        }}
      />
      <MiniButton
        icon="fa-trash"
        label={`Delete ${spec.name}`}
        onClick={async () => {
          if (!window.confirm(`Delete "${spec.name}"?`)) return;
          await clientApi.deleteRequest(id);
          await state.reloadCollections();
          onToast('Request deleted');
        }}
      />
    </div>
  );
}

function EnvironmentPanel({ state, onToast }: { state: ClientState; onToast: (m: string) => void }) {
  const file = state.collections;
  const active = file?.environments.find((e) => e.id === file.activeEnvId) ?? null;
  const [vars, setVars] = useState<KV[]>(active?.vars ?? []);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setVars(active?.vars ?? []);
  }, [active?.id, active?.vars]);

  const saveSoon = (next: KV[], env: EnvironmentDef) => {
    setVars(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      clientApi
        .saveEnvironment({ ...env, vars: next })
        .then(() => state.reloadCollections())
        .catch((e) => onToast(`Save failed: ${e.message}`));
    }, 400);
  };

  return (
    <div className="border-b border-slate-200 px-2 pb-3 dark:border-slate-800">
      <div className="flex items-center gap-1 py-1">
        <label htmlFor="env-select" className="sr-only">
          Active environment
        </label>
        <select
          id="env-select"
          value={file?.activeEnvId ?? ''}
          onChange={async (e) => {
            await clientApi.setActiveEnvironment(e.target.value || null);
            await state.reloadCollections();
          }}
          className="h-8 min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 text-xs dark:border-slate-700 dark:bg-slate-800"
        >
          <option value="">No environment</option>
          {file?.environments.map((env) => (
            <option key={env.id} value={env.id}>
              {env.name}
            </option>
          ))}
        </select>
        <MiniButton
          icon="fa-plus"
          label="New environment"
          onClick={async () => {
            const name = window.prompt('Environment name', 'Local');
            if (!name) return;
            await clientApi.createEnvironment(name);
            await state.reloadCollections();
          }}
        />
        {active && (
          <MiniButton
            icon="fa-trash"
            label={`Delete environment ${active.name}`}
            onClick={async () => {
              if (!window.confirm(`Delete environment "${active.name}"?`)) return;
              await clientApi.deleteEnvironment(active.id);
              await state.reloadCollections();
            }}
          />
        )}
      </div>

      {active ? (
        <KeyValueEditor
          idPrefix="env"
          rows={vars}
          onChange={(next) => saveSoon(next, active)}
          keyPlaceholder="baseURL"
          valuePlaceholder="http://localhost:3000"
        />
      ) : (
        <p className="px-1 py-2 text-xs text-slate-400">
          Create an environment to use <code className="font-mono">{'{{vars}}'}</code> in requests.
        </p>
      )}
    </div>
  );
}

function PanelHeader({
  label,
  icon,
  open,
  onToggle,
  actions,
}: {
  label: string;
  icon: string;
  open: boolean;
  onToggle: () => void;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-slate-200 px-2 py-1.5 dark:border-slate-800">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
      >
        <i className={`fa-solid ${open ? 'fa-chevron-down' : 'fa-chevron-right'} w-3`} />
        <i className={`fa-solid ${icon}`} />
        {label}
      </button>
      {actions}
    </div>
  );
}

function MiniButton({
  icon,
  label,
  onClick,
}: {
  icon: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="h-7 w-7 shrink-0 rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-indigo-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
    >
      <i className={`fa-solid ${icon} text-xs`} />
    </button>
  );
}
