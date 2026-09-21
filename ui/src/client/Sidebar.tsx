// Collections tree, environment variables and request history.

import { useEffect, useRef, useState } from 'react';

import { ExportDialog } from './ExportDialog.tsx';
import { ImportCollectionDialog } from './ImportCollectionDialog.tsx';
import { KeyValueEditor } from './KeyValueEditor.tsx';
import { loadLocal, saveLocal } from '../lib/storage.ts';
import { clientApi } from '../lib/clientApi.ts';
import type {
  CollectionsFile,
  EnvironmentDef,
  KV,
  ReqHistoryEntry,
  TreeNode,
} from '../../../shared/collections.ts';
import type { ClientState } from './useClient.ts';

type Panel = 'collections' | 'environment' | 'history';

const EXPAND_KEY = 'client.folder.';

/** One vertical rule per nesting level, so a deep tree stays readable.
 *  `self-stretch` makes each rule span the full row height, which is what turns
 *  a stack of rows into a continuous line. */
function Guides({ depth }: { depth: number }) {
  if (depth <= 0) return null;
  return (
    <>
      {Array.from({ length: depth }).map((_, i) => (
        <span
          key={i}
          aria-hidden="true"
          className="ml-[5px] w-[7px] shrink-0 self-stretch border-l border-slate-200 dark:border-slate-800"
        />
      ))}
    </>
  );
}

/** Payload type for sidebar drags. Anything else dropped here is ignored. */
const DND_TYPE = 'application/x-keyway-node';

interface Props {
  state: ClientState;
  onToast: (msg: string) => void;
}

/** Top-level nodes: the ones no folder holds as a child. Folders can now nest,
 *  so "everything in file.tree" would render subfolders twice. */
function rootNodes(file: CollectionsFile): TreeNode[] {
  const nested = new Set<string>();
  for (const node of file.tree) for (const child of node.children ?? []) nested.add(child);
  return file.tree.filter((n) => !nested.has(n.id));
}

export function Sidebar({ state, onToast }: Props) {
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [open, setOpen] = useState<Record<Panel, boolean>>({
    collections: true,
    environment: false,
    history: true,
  });
  const file = state.collections;

  const toggle = (panel: Panel) => setOpen((prev) => ({ ...prev, [panel]: !prev[panel] }));

  // The command palette can ask for the import dialog without importing it.
  useEffect(() => {
    const openImport = () => setImportOpen(true);
    const openExport = () => setExportOpen(true);
    window.addEventListener('keyway:import-collection', openImport);
    window.addEventListener('keyway:export-collection', openExport);
    return () => {
      window.removeEventListener('keyway:import-collection', openImport);
      window.removeEventListener('keyway:export-collection', openExport);
    };
  }, []);

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
            <MiniButton
              icon="fa-file-import"
              label="Import Postman / Insomnia / OpenAPI"
              onClick={() => setImportOpen(true)}
            />
            <MiniButton
              icon="fa-file-export"
              label="Export to Postman / .http / JSON"
              onClick={() => setExportOpen(true)}
            />
          </>
        }
      />
      {open.collections && (
        <div
          className="max-h-[55%] min-h-0 overflow-auto px-1 pb-2"
          title="Drop here to move something out of its folder"
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(DND_TYPE)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
          }}
          onDrop={async (e) => {
            if (!e.dataTransfer.types.includes(DND_TYPE)) return;
            e.preventDefault();
            const id = e.dataTransfer.getData(DND_TYPE);
            if (!id) return;
            await clientApi.move(id, null);
            await state.reloadCollections();
          }}
        >
          {!file || file.tree.length === 0 ? (
            <p className="px-2 py-3 text-xs text-slate-400">
              Nothing saved yet. Hit <i className="fa-solid fa-floppy-disk" /> on a request to keep
              it — you will be asked for a name and a folder.
            </p>
          ) : (
            rootNodes(file).map((node) => (
              <TreeNodeRow key={node.id} nodeId={node.id} state={state} onToast={onToast} depth={0} />
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
            groupHistory(state.history).map((group) => (
              <HistoryGroup key={group.key} group={group} state={state} onToast={onToast} />
            ))
          )}
        </div>
      )}

      <ExportDialog
        open={exportOpen}
        folders={state.folderChoices()}
        onClose={() => setExportOpen(false)}
        onToast={onToast}
      />

      <ImportCollectionDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(msg) => {
          onToast(msg);
          void state.reloadCollections();
        }}
      />
    </aside>
  );
}

/** One node of the tree: a request, or a folder with its own children. */
function TreeNodeRow({
  nodeId,
  state,
  onToast,
  depth,
}: {
  nodeId: string;
  state: ClientState;
  onToast: (msg: string) => void;
  depth: number;
}) {
  const file = state.collections;
  if (!file) return null;

  const spec = file.requests[nodeId];
  if (spec) return <RequestRow id={nodeId} state={state} onToast={onToast} depth={depth} />;

  const folder = file.tree.find((n) => n.id === nodeId && n.type === 'folder');
  if (!folder) return null;
  return <FolderRow folder={folder} state={state} onToast={onToast} depth={depth} />;
}

function FolderRow({
  folder,
  state,
  onToast,
  depth,
}: {
  folder: TreeNode;
  state: ClientState;
  onToast: (msg: string) => void;
  depth: number;
}) {
  // Collapsed by default and remembered per folder: an imported collection can
  // be 23 requests deep, and expanding all of it on every load buries the rest
  // of the sidebar.
  const [dragOver, setDragOver] = useState(false);
  const [expanded, setExpanded] = useState(() => {
    return loadLocal(`${EXPAND_KEY}${folder.id}`) === '1';
  });
  const [renaming, setRenaming] = useState(false);

  const toggleExpanded = () =>
    setExpanded((prev) => {
      const next = !prev;
      saveLocal(`${EXPAND_KEY}${folder.id}`, next ? '1' : '0');
      return next;
    });

  const addSubfolder = async () => {
    const name = window.prompt('Name for the new folder inside ' + (folder.name ?? ''));
    if (!name) return;
    await clientApi.createFolder(name, folder.id);
    await state.reloadCollections();
    setExpanded(true);
  };

  const acceptsDrop = (e: React.DragEvent) => e.dataTransfer.types.includes(DND_TYPE);

  return (
    <div>
      <div
        className={`group flex items-stretch gap-1 rounded ${
          dragOver ? 'bg-indigo-50 ring-1 ring-indigo-400 dark:bg-indigo-950' : ''
        }`}
        onDragOver={(e) => {
          if (!acceptsDrop(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={async (e) => {
          if (!acceptsDrop(e)) return;
          e.preventDefault();
          e.stopPropagation();
          setDragOver(false);
          const id = e.dataTransfer.getData(DND_TYPE);
          if (!id || id === folder.id) return;
          await clientApi.move(id, folder.id);
          await state.reloadCollections();
          setExpanded(true);
        }}
      >
        <Guides depth={depth} />
        {renaming ? (
          <RenameInput
            initial={folder.name ?? ''}
            onCancel={() => setRenaming(false)}
            onSave={async (name) => {
              setRenaming(false);
              await clientApi.rename(folder.id, name);
              await state.reloadCollections();
            }}
          />
        ) : (
          <>
            <button
              type="button"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DND_TYPE, folder.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onClick={toggleExpanded}
              onDoubleClick={() => setRenaming(true)}
              aria-expanded={expanded}
              className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left text-xs font-medium hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-indigo-500 dark:hover:bg-slate-800"
            >
              <i
                className={`fa-solid ${expanded ? 'fa-chevron-down' : 'fa-chevron-right'} w-3 text-slate-400`}
              />
              <i className="fa-solid fa-folder text-amber-500" />
              <span className="truncate">{folder.name}</span>
              <span className="ml-auto pl-1 text-[10px] text-slate-400">
                {folder.children?.length ?? 0}
              </span>
            </button>
            <MiniButton icon="fa-pen" label={`Rename ${folder.name}`} onClick={() => setRenaming(true)} />
            <MiniButton icon="fa-folder-plus" label={`New folder inside ${folder.name}`} onClick={addSubfolder} />
            <MiniButton
              icon="fa-trash"
              label={`Delete folder ${folder.name}`}
              onClick={async () => {
                if (!window.confirm(`Delete "${folder.name}" and everything inside it?`)) return;
                await clientApi.deleteFolder(folder.id);
                await state.reloadCollections();
                onToast('Folder deleted');
              }}
            />
          </>
        )}
      </div>

      {expanded &&
        (folder.children ?? []).map((childId) => (
          <TreeNodeRow
            key={childId}
            nodeId={childId}
            state={state}
            onToast={onToast}
            depth={depth + 1}
          />
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
  const [renaming, setRenaming] = useState(false);
  const spec = state.collections?.requests[id];
  if (!spec) return null;

  return (
    <div className="group flex items-stretch gap-1">
      <Guides depth={depth} />
      {renaming ? (
        <RenameInput
          initial={spec.name}
          onCancel={() => setRenaming(false)}
          onSave={async (name) => {
            setRenaming(false);
            await clientApi.rename(id, name);
            await state.reloadCollections();
          }}
        />
      ) : (
        <>
          <button
            type="button"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DND_TYPE, id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onClick={() => state.openRequest(spec)}
            onDoubleClick={() => setRenaming(true)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-indigo-500 dark:hover:bg-slate-800"
          >
            <span className="w-10 shrink-0 font-mono font-semibold text-slate-500">{spec.method}</span>
            <span className="truncate">{spec.name}</span>
          </button>
          <MiniButton icon="fa-pen" label={`Rename ${spec.name}`} onClick={() => setRenaming(true)} />
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
        </>
      )}
    </div>
  );
}

/** Inline rename: Enter saves, Escape cancels, blur saves. */
function RenameInput({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      aria-label="New name"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (value.trim()) onSave(value.trim());
          else onCancel();
        }
        if (e.key === 'Escape') onCancel();
      }}
      onBlur={() => (value.trim() && value !== initial ? onSave(value.trim()) : onCancel())}
      className="mx-1 h-7 w-full rounded border border-indigo-400 bg-white px-2 text-xs dark:bg-slate-800"
    />
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

interface DayGroup {
  key: string;
  label: string;
  entries: ReqHistoryEntry[];
}

/** Pinned entries first as their own group, then the rest newest-first split
 *  into days. "Today"/"Yesterday" read faster than a date when that is what you
 *  actually mean. */
function groupHistory(entries: ReqHistoryEntry[]): DayGroup[] {
  const pinned = entries.filter((e) => e.pinned);
  const rest = entries.filter((e) => !e.pinned);
  return [
    ...(pinned.length ? [{ key: 'pinned', label: 'Pinned', entries: pinned }] : []),
    ...groupByDay(rest),
  ];
}

function groupByDay(entries: ReqHistoryEntry[]): DayGroup[] {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const dayKey = (d: Date) => d.toISOString().slice(0, 10);

  const groups = new Map<string, DayGroup>();
  for (const entry of entries) {
    const when = new Date(entry.ts);
    const key = dayKey(when);
    const label =
      key === dayKey(today)
        ? 'Today'
        : key === dayKey(yesterday)
          ? 'Yesterday'
          : when.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    const group = groups.get(key) ?? { key, label, entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function HistoryGroup({
  group,
  state,
  onToast,
}: {
  group: DayGroup;
  state: ClientState;
  onToast: (msg: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const pinned = group.entries.filter((e) => e.pinned).length;

  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] font-medium text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
      >
        <i className={`fa-solid ${open ? 'fa-chevron-down' : 'fa-chevron-right'} w-3 text-slate-400`} />
        {group.key === 'pinned' && <i className="fa-solid fa-thumbtack text-[9px] text-amber-500" />}
        {group.label}
        <span className="ml-auto flex items-center gap-2 text-slate-400">
          {group.key !== 'pinned' && pinned > 0 && (
            <span className="text-amber-500" title={`${pinned} pinned`}>
              <i className="fa-solid fa-thumbtack text-[9px]" /> {pinned}
            </span>
          )}
          <span>{group.entries.length}</span>
        </span>
      </button>

      {open &&
        group.entries.map((entry) => (
          <HistoryRow key={entry.id} entry={entry} state={state} onToast={onToast} />
        ))}
    </div>
  );
}

function HistoryRow({
  entry,
  state,
  onToast,
}: {
  entry: ReqHistoryEntry;
  state: ClientState;
  onToast: (msg: string) => void;
}) {
  const time = new Date(entry.ts).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="group relative flex items-center gap-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800">
      <button
        type="button"
        onClick={() => void state.openFromHistory(entry)}
        title={`${entry.method} ${entry.url}\n${new Date(entry.ts).toLocaleString()}`}
        className="min-w-0 flex-1 rounded px-2 py-1 text-left text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-indigo-500"
      >
        {/* The URL gets a line of its own: in a 288px sidebar, sharing it with
            the status and the time left room for about eight characters. */}
        <span className="flex items-baseline gap-2">
          <span className="w-10 shrink-0 font-mono font-semibold text-slate-500">
            {entry.method}
          </span>
          <span className="min-w-0 flex-1 truncate">{entry.url}</span>
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 whitespace-nowrap pl-12 text-[10px] text-slate-400">
          {entry.pinned && <i className="fa-solid fa-thumbtack text-[8px] text-amber-500" />}
          <span>{time}</span>
          {entry.latencyMs != null && <span>· {entry.latencyMs} ms</span>}
          {entry.checks && (
            <span
              className={`font-mono ${
                entry.checks.passed === entry.checks.total ? 'text-emerald-600' : 'text-red-500'
              }`}
            >
              · {entry.checks.passed}/{entry.checks.total}
            </span>
          )}
          <span
            className={`ml-auto font-mono ${
              entry.error
                ? 'text-red-500'
                : (entry.status ?? 0) >= 400
                  ? 'text-amber-600'
                  : 'text-emerald-600'
            }`}
          >
            {entry.error ? 'err' : entry.status}
          </span>
        </span>
      </button>

      {/* Actions float over the row instead of taking layout width - otherwise
          three buttons push the time and status onto a second line. */}
      <span className="invisible absolute right-1 top-1/2 flex -translate-y-1/2 rounded bg-slate-100 shadow-sm group-hover:visible dark:bg-slate-800">
        <MiniButton
          icon="fa-thumbtack"
          label={entry.pinned ? 'Unpin this entry' : 'Pin: keep it when older entries are dropped'}
          onClick={async () => {
            await clientApi.pinHistory(entry.id, !entry.pinned);
            await state.reloadHistory();
            onToast(entry.pinned ? 'Unpinned' : 'Pinned');
          }}
        />
        <MiniButton
          icon="fa-copy"
          label="Copy URL"
          onClick={() => {
            navigator.clipboard.writeText(entry.url).catch(() => {});
            onToast('URL copied');
          }}
        />
        <MiniButton
          icon="fa-trash"
          label="Delete this entry"
          onClick={async () => {
            await clientApi.deleteHistoryEntry(entry.id);
            await state.reloadHistory();
          }}
        />
      </span>
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
