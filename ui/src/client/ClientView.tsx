// The API client screen: sidebar | request | response, with request tabs on
// top. Layout is fixed - sending never moves anything around - and the divider
// between request and response is draggable, its position remembered.

import { useCallback, useEffect, useRef, useState } from 'react';

import { CommandPalette, type PaletteCommand } from './CommandPalette.tsx';
import { ImportCurlDialog } from './ImportCurlDialog.tsx';
import { SaveRequestDialog } from './SaveRequestDialog.tsx';
import { Sidebar } from './Sidebar.tsx';
import { RequestPane } from './RequestPane.tsx';
import { ResponsePane } from './ResponsePane.tsx';
import { useClient } from './useClient.ts';
import type { RequestSpec } from '../../../shared/collections.ts';
import { clientApi } from '../lib/clientApi.ts';
import { loadLocal, saveLocal } from '../lib/storage.ts';

const SPLIT_KEY = 'client.split';
/** How many closed tabs Alt+Shift+T can bring back. */
const CLOSED_MAX = 20;

export function ClientView({
  pendingRequest,
  onPendingConsumed,
  onShowShortcuts,
}: {
  pendingRequest?: Partial<RequestSpec> | null;
  onPendingConsumed?: () => void;
  onShowShortcuts?: () => void;
} = {}) {
  const state = useClient();
  const [toast, setToast] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [split, setSplit] = useState<number>(() => {
    const saved = Number(loadLocal(SPLIT_KEY));
    return Number.isFinite(saved) && saved >= 0.2 && saved <= 0.8 ? saved : 0.5;
  });
  const splitRef = useRef<HTMLDivElement | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  }, []);

  const { active } = state;

  // ─── closed tabs ──────────────────────────────────────────────────────────
  // Kept in memory only: enough to undo a stray Alt+W, not a second history.
  const closedRef = useRef<{ spec: RequestSpec; savedId?: string; dirty: boolean }[]>([]);

  const closeTab = useCallback(
    (tabId: string) => {
      const tab = state.tabs.find((t) => t.id === tabId);
      if (tab) {
        closedRef.current = [
          ...closedRef.current,
          { spec: structuredClone(tab.spec), savedId: tab.savedId, dirty: tab.dirty },
        ].slice(-CLOSED_MAX);
      }
      state.closeTab(tabId);
    },
    [state],
  );

  /** A clean saved request reopens as itself (still linked for Ctrl+S); an
   *  edited one comes back as the edits, in a new unsaved tab. */
  const reopenClosed = useCallback(() => {
    const last = closedRef.current.pop();
    if (!last) {
      showToast('No closed tab to reopen');
      return;
    }
    if (last.savedId && !last.dirty) state.openRequest(last.spec);
    else state.newTab(last.spec);
  }, [state, showToast]);

  const cycleTab = useCallback(
    (step: number) => {
      const { tabs, activeId } = state;
      if (tabs.length < 2) return;
      const i = tabs.findIndex((t) => t.id === activeId);
      const next = tabs[(i + step + tabs.length) % tabs.length];
      if (next) state.setActiveId(next.id);
    },
    [state],
  );

  const copyCurl = useCallback(async () => {
    if (!active) return;
    try {
      const { curl } = await clientApi.curl(active.spec);
      await navigator.clipboard.writeText(curl);
      showToast('curl copied');
    } catch (e) {
      showToast(`curl failed: ${e instanceof Error ? e.message : e}`);
    }
  }, [active, showToast]);

  const formatBody = useCallback(() => {
    if (!active) return;
    try {
      const parsed = JSON.parse(active.spec.body.text ?? '');
      state.updateSpec(active.id, {
        body: { ...active.spec.body, text: JSON.stringify(parsed, null, 2) },
      });
    } catch {
      showToast('Body is not valid JSON');
    }
  }, [active, state, showToast]);

  /** A request that already lives in the collection saves straight away; a new
   *  one asks for a name and a folder first. */
  const requestSave = useCallback(() => {
    if (!active) return;
    if (active.savedId) {
      void state.saveTab(active.id).then(() => showToast('Saved'));
      return;
    }
    setSaveOpen(true);
  }, [active, state, showToast]);

  // ─── keyboard ─────────────────────────────────────────────────────────────
  // Alt-based shortcuts on purpose: Ctrl+T / Ctrl+W belong to the browser and
  // can't be intercepted from a page, so binding them would only look broken.
  // The full list, for the help panel, is in shortcuts.ts - keep them in step.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const run = (fn: () => void) => {
        e.preventDefault();
        fn();
      };
      if (mod && e.key === 'Enter') return run(() => active && void state.send(active.id));
      if (mod && key === 's') return run(requestSave);
      // Ctrl+K is Firefox's search bar, but a page may take it - and Alt+K is
      // there for when it doesn't.
      if ((mod || e.altKey) && key === 'k') return run(() => setPaletteOpen((v) => !v));
      if (!e.altKey || mod) return;

      // Shifted chords first, so Alt+Shift+T doesn't fall through to Alt+T.
      if (e.shiftKey) {
        if (key === 't') return run(reopenClosed);
        if (key === 'f') return run(formatBody);
        if (key === 'i')
          return run(() => window.dispatchEvent(new CustomEvent('keyway:import-collection')));
        if (key === 'e')
          return run(() => window.dispatchEvent(new CustomEvent('keyway:export-collection')));
        return;
      }
      // e.code for the brackets: their e.key moves around between layouts.
      if (e.code === 'BracketRight') return run(() => cycleTab(1));
      if (e.code === 'BracketLeft') return run(() => cycleTab(-1));
      if (key === 't') return run(() => state.newTab());
      if (key === 'w') return run(() => active && closeTab(active.id));
      if (key === 'd') return run(() => active && state.duplicateTab(active.id));
      if (key === 'l') return run(() => document.getElementById('req-url')?.focus());
      if (key === 'i') return run(() => setImportOpen(true));
      if (key === 'c') return run(() => void copyCurl());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, state, requestSave, reopenClosed, formatBody, cycleTab, closeTab, copyCurl]);

  // ─── handover from the vault ──────────────────────────────────────────────
  // The vault switches screens and hands over a request; this side has to open
  // it. (It didn't, for a while: the props existed and nothing consumed them.)
  useEffect(() => {
    if (!pendingRequest) return;
    state.newTab(pendingRequest);
    onPendingConsumed?.();
    // Only the handover itself should retrigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRequest]);

  // ─── draggable divider ────────────────────────────────────────────────────
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const container = splitRef.current;
    if (!container) return;
    const move = (ev: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const ratio = (ev.clientX - rect.left) / rect.width;
      const clamped = Math.min(0.8, Math.max(0.2, ratio));
      setSplit(clamped);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  useEffect(() => {
    saveLocal(SPLIT_KEY, String(split));
  }, [split]);

  const paletteCommands: PaletteCommand[] = [
    { id: 'new', label: 'New request', hint: 'Alt+T', icon: 'fa-file-circle-plus', run: () => state.newTab() },
    { id: 'save', label: 'Save request', hint: 'Ctrl+S', icon: 'fa-floppy-disk', run: requestSave },
    {
      id: 'send',
      label: 'Send request',
      hint: 'Ctrl+Enter',
      icon: 'fa-paper-plane',
      run: () => active && void state.send(active.id),
    },
    { id: 'curl', label: 'Import cURL', hint: 'Alt+I', icon: 'fa-terminal', run: () => setImportOpen(true) },
    { id: 'copy-curl', label: 'Copy request as cURL', hint: 'Alt+C', icon: 'fa-clipboard', run: () => void copyCurl() },
    { id: 'format', label: 'Format JSON body', hint: 'Alt+Shift+F', icon: 'fa-align-left', run: formatBody },
    {
      id: 'import',
      label: 'Import collection (Postman · Insomnia · OpenAPI)',
      hint: 'Alt+Shift+I',
      icon: 'fa-file-import',
      // The dialog lives in the sidebar; an event keeps the two from having to
      // know about each other.
      run: () => window.dispatchEvent(new CustomEvent('keyway:import-collection')),
    },
    {
      id: 'export',
      label: 'Export collection (Postman · .http · JSON)',
      hint: 'Alt+Shift+E',
      icon: 'fa-file-export',
      run: () => window.dispatchEvent(new CustomEvent('keyway:export-collection')),
    },
    {
      id: 'duplicate',
      label: 'Duplicate this tab',
      hint: 'Alt+D',
      icon: 'fa-copy',
      run: () => active && state.duplicateTab(active.id),
    },
    {
      id: 'close',
      label: 'Close this tab',
      hint: 'Alt+W',
      icon: 'fa-xmark',
      run: () => active && closeTab(active.id),
    },
    { id: 'reopen', label: 'Reopen closed tab', hint: 'Alt+Shift+T', icon: 'fa-rotate-left', run: reopenClosed },
    {
      id: 'shortcuts',
      label: 'Keyboard shortcuts',
      hint: '?',
      icon: 'fa-keyboard',
      run: () => onShowShortcuts?.(),
    },
  ];

  return (
    <div className="flex h-full min-h-0">
      <Sidebar state={state} onToast={showToast} />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* request tabs */}
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-slate-200 bg-slate-50 px-1 py-1 dark:border-slate-800 dark:bg-slate-950">
          {state.tabs.map((tab) => {
            const isActive = tab.id === state.activeId;
            return (
              <div
                key={tab.id}
                className={`flex shrink-0 items-center rounded ${
                  isActive
                    ? 'bg-white shadow-sm dark:bg-slate-900'
                    : 'hover:bg-slate-200/60 dark:hover:bg-slate-800'
                }`}
              >
                <button
                  type="button"
                  onClick={() => state.setActiveId(tab.id)}
                  aria-current={isActive ? 'true' : undefined}
                  className="flex max-w-[14rem] items-center gap-2 py-1.5 pl-3 pr-1 text-xs"
                >
                  <span className="font-mono font-semibold text-slate-500">{tab.spec.method}</span>
                  <span className="truncate">{tab.spec.name || tab.spec.url || 'Untitled'}</span>
                  {tab.dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />}
                </button>
                <button
                  type="button"
                  onClick={() => closeTab(tab.id)}
                  aria-label={`Close ${tab.spec.name || 'tab'}`}
                  className="mr-1 h-6 w-6 rounded text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-700"
                >
                  <i className="fa-solid fa-xmark text-[10px]" />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => state.newTab()}
            aria-label="New request tab (Alt+T)"
            title="New request tab (Alt+T)"
            className="h-7 w-7 shrink-0 rounded text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-800"
          >
            <i className="fa-solid fa-plus text-xs" />
          </button>

          <button
            type="button"
            onClick={() => setImportOpen(true)}
            title="Import cURL (Alt+I)"
            className="h-7 shrink-0 rounded px-2 text-xs text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-800"
          >
            <i className="fa-solid fa-terminal text-xs" /> cURL
          </button>

          <span className="ml-auto flex shrink-0 items-center gap-2 pr-2 text-[11px] text-slate-400">
            <button
              type="button"
              onClick={() => onShowShortcuts?.()}
              title="All keyboard shortcuts (?)"
              className="rounded px-1.5 py-0.5 hover:bg-slate-200 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
            >
              <i className="fa-solid fa-keyboard" /> shortcuts
            </button>
            <span
              className={state.wsConnected ? 'text-emerald-600' : 'text-slate-400'}
              title={state.wsConnected ? 'live updates connected' : 'offline'}
            >
              <i className="fa-solid fa-circle text-[6px]" /> {state.wsConnected ? 'live' : 'offline'}
            </span>
          </span>
        </div>

        {/* request | response */}
        <div ref={splitRef} className="flex min-h-0 flex-1">
          {active ? (
            <>
              <div style={{ width: `${split * 100}%` }} className="min-w-0 overflow-hidden">
                <RequestPane
                  tab={active}
                  vaultKeys={state.vaultKeys}
                  chainable={state.chainable}
                  tokenTick={state.tokenTick}
                  onSpec={(patch) => state.updateSpec(active.id, patch)}
                  onFiles={(field, files) =>
                    state.patchTab(active.id, { files: { ...active.files, [field]: files } })
                  }
                  onSend={() => void state.send(active.id)}
                  onSave={requestSave}
                  onToast={showToast}
                  onDefineVar={async (name) => {
                    const value = window.prompt(`Value for {{${name}}}`, '');
                    if (value === null) return;
                    await state.defineVar(name, value);
                    showToast(`{{${name}}} defined`);
                  }}
                />
              </div>

              <div
                role="separator"
                aria-orientation="vertical"
                onMouseDown={startDrag}
                title="Drag to resize"
                className="w-1 shrink-0 cursor-col-resize bg-slate-200 transition-colors hover:bg-indigo-400 dark:bg-slate-800"
              />

              <div style={{ width: `${(1 - split) * 100}%` }} className="min-w-0 overflow-hidden">
                <ResponsePane
                  result={active.result}
                  error={active.error}
                  sending={active.sending}
                  liveStream={active.streamText}
                  historical={active.historical}
                />
              </div>
            </>
          ) : (
            <p className="m-auto text-sm text-slate-400">No tab open — press Alt+T.</p>
          )}
        </div>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        requests={Object.values(state.collections?.requests ?? {})}
        history={state.history}
        commands={paletteCommands}
        onOpenRequest={(spec) => state.openRequest(spec)}
        onOpenHistory={(entry) => void state.openFromHistory(entry)}
      />

      <SaveRequestDialog
        open={saveOpen}
        initialName={active ? state.suggestName(active.id) : 'Request'}
        folders={state.folderChoices()}
        onCancel={() => setSaveOpen(false)}
        onSave={async (name, parentId) => {
          setSaveOpen(false);
          if (!active) return;
          await state.saveTab(active.id, { name, parentId });
          showToast(`Saved as "${name}"`);
        }}
      />

      <ImportCurlDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(spec, warnings) => {
          state.newTab(spec);
          showToast(warnings.length ? `Imported with ${warnings.length} warning(s)` : 'Imported');
          if (warnings.length) console.warn('[import-curl]', warnings);
        }}
      />

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white shadow-lg dark:bg-slate-700">
          {toast}
        </div>
      )}
    </div>
  );
}
