// The API client screen: sidebar | request | response, with request tabs on
// top. Layout is fixed - sending never moves anything around - and the divider
// between request and response is draggable, its position remembered.

import { useCallback, useEffect, useRef, useState } from 'react';

import { ImportCurlDialog } from './ImportCurlDialog.tsx';
import { Sidebar } from './Sidebar.tsx';
import { RequestPane } from './RequestPane.tsx';
import { ResponsePane } from './ResponsePane.tsx';
import { useClient } from './useClient.ts';

const SPLIT_KEY = 'key-tester.client.split';

export function ClientView() {
  const state = useClient();
  const [toast, setToast] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [split, setSplit] = useState<number>(() => {
    const saved = Number(localStorage.getItem(SPLIT_KEY));
    return Number.isFinite(saved) && saved >= 0.2 && saved <= 0.8 ? saved : 0.5;
  });
  const splitRef = useRef<HTMLDivElement | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  }, []);

  const { active } = state;

  // ─── keyboard ─────────────────────────────────────────────────────────────
  // Alt-based shortcuts on purpose: Ctrl+T / Ctrl+W belong to the browser and
  // can't be intercepted from a page, so binding them would only look broken.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === 'Enter') {
        e.preventDefault();
        if (active) void state.send(active.id);
        return;
      }
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (active) void state.saveTab(active.id).then(() => showToast('Saved'));
        return;
      }
      if (e.altKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        state.newTab();
        return;
      }
      if (e.altKey && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        if (active) state.closeTab(active.id);
        return;
      }
      if (e.altKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        if (active) state.duplicateTab(active.id);
        return;
      }
      if (e.altKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        document.getElementById('req-url')?.focus();
        return;
      }
      if (e.altKey && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        setImportOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, state, showToast]);

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
    localStorage.setItem(SPLIT_KEY, String(split));
  }, [split]);

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
                  onClick={() => state.closeTab(tab.id)}
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
            <span title="Alt+T new · Alt+W close · Alt+D duplicate · Alt+I import cURL · Ctrl+Enter send · Ctrl+S save · Alt+L focus URL">
              <i className="fa-solid fa-keyboard" /> shortcuts
            </span>
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
                  onSave={() => void state.saveTab(active.id).then(() => showToast('Saved'))}
                  onToast={showToast}
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
                />
              </div>
            </>
          ) : (
            <p className="m-auto text-sm text-slate-400">No tab open — press Alt+T.</p>
          )}
        </div>
      </div>

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
