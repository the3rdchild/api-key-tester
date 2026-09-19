// State for the API client: open tabs, collections tree, history.
//
// Tabs live in localStorage so a reload (or a container restart) puts you back
// where you were. Saved requests live on the server in collections.json; a tab
// is a working copy of one, with a dirty flag until you save.

import { useCallback, useEffect, useRef, useState } from 'react';

import { clientApi, type SendResponse } from '../lib/clientApi.ts';
import { emptyRequest } from '../../../shared/collections.ts';
import type {
  CollectionsFile,
  ReqHistoryEntry,
  RequestSpec,
  SendResult,
} from '../../../shared/collections.ts';

const TABS_KEY = 'key-tester.client.tabs.v1';

export interface Tab {
  id: string;
  spec: RequestSpec;
  /** id in collections.json once saved */
  savedId?: string;
  dirty: boolean;
  sending: boolean;
  result?: SendResult;
  missing?: string[];
  error?: string;
  /** multipart files live in memory only - they can't be serialised */
  files: Record<string, File[]>;
}

interface Persisted {
  tabs: { id: string; spec: RequestSpec; savedId?: string; dirty: boolean }[];
  activeId: string | null;
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function freshTab(spec?: Partial<RequestSpec>): Tab {
  return {
    id: uid(),
    spec: { ...emptyRequest(uid()), ...spec },
    dirty: false,
    sending: false,
    files: {},
  };
}

function restore(): Persisted {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (!raw) return { tabs: [], activeId: null };
    return JSON.parse(raw) as Persisted;
  } catch {
    return { tabs: [], activeId: null };
  }
}

export function useClient() {
  const [tabs, setTabs] = useState<Tab[]>(() => {
    const saved = restore();
    const list = saved.tabs.map((t) => ({ ...t, sending: false, files: {} }) as Tab);
    return list.length ? list : [freshTab()];
  });
  const [activeId, setActiveId] = useState<string | null>(() => {
    const saved = restore();
    return saved.activeId;
  });
  const [collections, setCollections] = useState<CollectionsFile | null>(null);
  const [history, setHistory] = useState<ReqHistoryEntry[]>([]);
  const [wsConnected, setWsConnected] = useState(false);

  // keep the active tab pointing at something real
  useEffect(() => {
    if (tabs.length === 0) {
      const t = freshTab();
      setTabs([t]);
      setActiveId(t.id);
      return;
    }
    if (!activeId || !tabs.some((t) => t.id === activeId)) setActiveId(tabs[0]!.id);
  }, [tabs, activeId]);

  // persist tab state (files are dropped on purpose)
  useEffect(() => {
    const payload: Persisted = {
      tabs: tabs.map(({ id, spec, savedId, dirty }) => ({ id, spec, savedId, dirty })),
      activeId,
    };
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify(payload));
    } catch {
      /* quota - not worth breaking the app over */
    }
  }, [tabs, activeId]);

  const reloadCollections = useCallback(async () => {
    setCollections(await clientApi.load());
  }, []);

  const reloadHistory = useCallback(async () => {
    setHistory(await clientApi.history(200));
  }, []);

  useEffect(() => {
    reloadCollections().catch(() => {});
    reloadHistory().catch(() => {});
  }, [reloadCollections, reloadHistory]);

  // live updates: another window (or a hand-edit of collections.json) should
  // not leave this one stale
  const wsRef = useRef<WebSocket | null>(null);
  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/live`);
      wsRef.current = ws;
      ws.onopen = () => setWsConnected(true);
      ws.onclose = () => {
        setWsConnected(false);
        if (!closed) retry = setTimeout(connect, 2000);
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as { type: string; entry?: ReqHistoryEntry };
          if (msg.type === 'collections:changed') reloadCollections().catch(() => {});
          if (msg.type === 'req-history:appended' && msg.entry) {
            setHistory((prev) => [msg.entry!, ...prev].slice(0, 200));
          }
        } catch {
          /* ignore */
        }
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, [reloadCollections]);

  const active = tabs.find((t) => t.id === activeId) ?? null;

  const patchTab = useCallback((tabId: string, patch: Partial<Tab>) => {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, ...patch } : t)));
  }, []);

  const updateSpec = useCallback(
    (tabId: string, patch: Partial<RequestSpec>) => {
      setTabs((prev) =>
        prev.map((t) => (t.id === tabId ? { ...t, spec: { ...t.spec, ...patch }, dirty: true } : t)),
      );
    },
    [],
  );

  const newTab = useCallback((spec?: Partial<RequestSpec>) => {
    const t = freshTab(spec);
    setTabs((prev) => [...prev, t]);
    setActiveId(t.id);
    return t;
  }, []);

  const closeTab = useCallback((tabId: string) => {
    setTabs((prev) => prev.filter((t) => t.id !== tabId));
  }, []);

  const duplicateTab = useCallback(
    (tabId: string) => {
      const src = tabs.find((t) => t.id === tabId);
      if (!src) return;
      const copy: Tab = {
        ...freshTab(),
        spec: { ...structuredClone(src.spec), id: uid(), name: `${src.spec.name} copy` },
        dirty: true,
      };
      setTabs((prev) => [...prev, copy]);
      setActiveId(copy.id);
    },
    [tabs],
  );

  /** Open a saved request - focus its tab if it is already open. */
  const openRequest = useCallback(
    (spec: RequestSpec) => {
      const existing = tabs.find((t) => t.savedId === spec.id);
      if (existing) {
        setActiveId(existing.id);
        return;
      }
      const t: Tab = { ...freshTab(), spec: structuredClone(spec), savedId: spec.id };
      setTabs((prev) => [...prev, t]);
      setActiveId(t.id);
    },
    [tabs],
  );

  /** Re-open a request from the history log (headers are redacted, so only the
   *  shape comes back - enough to resend after filling the secret again). */
  const openFromHistory = useCallback(
    (entry: ReqHistoryEntry) => {
      newTab({
        name: entry.name || entry.url,
        method: entry.method,
        url: entry.url,
        headers: Object.entries(entry.request.headers).map(([key, value]) => ({
          key,
          value,
          enabled: true,
        })),
        body: entry.request.bodyPreview
          ? { mode: 'json', text: entry.request.bodyPreview }
          : { mode: 'none' },
      });
    },
    [newTab],
  );

  const send = useCallback(
    async (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab) return;
      patchTab(tabId, { sending: true, error: undefined });
      try {
        const res: SendResponse = await clientApi.send(tab.spec, tab.files);
        patchTab(tabId, {
          sending: false,
          result: res.result,
          missing: res.missing,
          error: res.result.error,
        });
      } catch (e) {
        patchTab(tabId, {
          sending: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [tabs, patchTab],
  );

  const saveTab = useCallback(
    async (tabId: string, parentId?: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab) return;
      const saved = tab.savedId
        ? await clientApi.saveRequest({ ...tab.spec, id: tab.savedId })
        : await clientApi.createRequest(tab.spec, parentId);
      patchTab(tabId, { savedId: saved.id, dirty: false, spec: { ...tab.spec, id: saved.id } });
      await reloadCollections();
    },
    [tabs, patchTab, reloadCollections],
  );

  return {
    tabs,
    active,
    activeId,
    setActiveId,
    collections,
    history,
    wsConnected,
    newTab,
    closeTab,
    duplicateTab,
    openRequest,
    openFromHistory,
    updateSpec,
    patchTab,
    send,
    saveTab,
    reloadCollections,
    reloadHistory,
  };
}

export type ClientState = ReturnType<typeof useClient>;
