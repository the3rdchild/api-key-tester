// State for the API client: open tabs, collections tree, history.
//
// Tabs live in localStorage so a reload (or a container restart) puts you back
// where you were. Saved requests live on the server in collections.json; a tab
// is a working copy of one, with a dirty flag until you save.

import { useCallback, useEffect, useRef, useState } from 'react';

import { clientApi, type SendResponse } from '../lib/clientApi.ts';
import { loadLocal, saveLocal } from '../lib/storage.ts';
import { api } from '../lib/api.ts';
import type { KeyEntry } from '../../../shared/types.ts';
import { emptyRequest } from '../../../shared/collections.ts';
import type {
  CollectionsFile,
  ReqHistoryEntry,
  RequestSpec,
  SendResult,
} from '../../../shared/collections.ts';

const TABS_KEY = 'client.tabs.v1';

export interface Tab {
  id: string;
  spec: RequestSpec;
  /** id in collections.json once saved */
  savedId?: string;
  dirty: boolean;
  sending: boolean;
  result?: SendResult;
  missing?: string[];
  /** advisory from the vault or OAuth2 for this send */
  note?: string;
  /** OAuth2 refused to send: the browser step is still pending */
  needsAuth?: boolean;
  /** text accumulated from a streamed response while it is still arriving */
  streamText?: string;
  /** the history entry this tab's response came from, if it is not a fresh send */
  historical?: { id: string; ts: string };
  /** last response for this tab, so a reload can bring it back */
  historyId?: string;
  error?: string;
  /** multipart files live in memory only - they can't be serialised */
  files: Record<string, File[]>;
}

interface Persisted {
  tabs: {
    id: string;
    spec: RequestSpec;
    savedId?: string;
    dirty: boolean;
    historyId?: string;
  }[];
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
    const raw = loadLocal(TABS_KEY);
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
  const [vaultKeys, setVaultKeys] = useState<KeyEntry[]>([]);
  const [chainable, setChainable] = useState<{ id: string; name: string; status: number }[]>([]);
  /** bumped when the OAuth callback tab stores a token, so the Auth tab refreshes */
  const [tokenTick, setTokenTick] = useState(0);
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
      tabs: tabs.map(({ id, spec, savedId, dirty, historyId }) => ({
        id,
        spec,
        savedId,
        dirty,
        historyId,
      })),
      activeId,
    };
    saveLocal(TABS_KEY, JSON.stringify(payload));
  }, [tabs, activeId]);

  const reloadCollections = useCallback(async () => {
    setCollections(await clientApi.load());
  }, []);

  const reloadHistory = useCallback(async () => {
    setHistory(await clientApi.history(200));
  }, []);

  // Responses are not kept in localStorage (they can be megabytes) - they are
  // fetched back from the history store instead, so a reload no longer wipes
  // the answer you were looking at.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const tab of tabs) {
        if (!tab.historyId || tab.result) continue;
        try {
          const detail = await clientApi.historyDetail(tab.historyId);
          if (cancelled) return;
          setTabs((prev) =>
            prev.map((t) =>
              t.id === tab.id
                ? { ...t, result: detail.result, historical: { id: detail.entry.id, ts: detail.entry.ts } }
                : t,
            ),
          );
        } catch {
          /* entry evicted - nothing to restore */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    reloadCollections().catch(() => {});
    reloadHistory().catch(() => {});
    api
      .listKeys()
      .then(({ keys }) => setVaultKeys(keys))
      .catch(() => {});
    clientApi
      .chainable()
      .then(setChainable)
      .catch(() => {});
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
          const msg = JSON.parse(ev.data as string) as {
            type: string;
            entry?: ReqHistoryEntry;
            streamId?: string;
            text?: string;
          };
          if (msg.type === 'collections:changed') reloadCollections().catch(() => {});
          if (msg.type === 'oauth:token') setTokenTick((n) => n + 1);
          if (msg.type === 'stream:chunk' && msg.streamId) {
            // The stream id is the tab id, so chunks land in the tab that asked.
            setTabs((prev) =>
              prev.map((t) =>
                t.id === msg.streamId ? { ...t, streamText: (t.streamText ?? '') + msg.text } : t,
              ),
            );
          }
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

  /** Open a history entry *with the response it produced*.
   *
   *  The request itself comes from the saved request when there is one - the
   *  stored snapshot has its secrets redacted, so replaying that copy would
   *  send "«redacted»" as the token. */
  const openFromHistory = useCallback(
    async (entry: ReqHistoryEntry) => {
      const saved = entry.requestId ? collections?.requests[entry.requestId] : undefined;
      const tab: Tab = {
        ...freshTab(),
        spec: saved
          ? structuredClone(saved)
          : {
              ...emptyRequest(uid(), entry.name || entry.url),
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
            },
        savedId: saved?.id,
        historyId: entry.id,
        historical: { id: entry.id, ts: entry.ts },
      };
      setTabs((prev) => [...prev, tab]);
      setActiveId(tab.id);

      try {
        const detail = await clientApi.historyDetail(entry.id);
        setTabs((prev) =>
          prev.map((t) => (t.id === tab.id ? { ...t, result: detail.result } : t)),
        );
      } catch {
        // Older entries were logged before responses were kept; the request
        // shape is still useful, so leave the tab open without a response.
      }
    },
    [collections],
  );

  const send = useCallback(
    async (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab) return;
      patchTab(tabId, { sending: true, error: undefined, streamText: '' });
      try {
        const res: SendResponse = await clientApi.send(tab.spec, tab.files, tabId);
        patchTab(tabId, {
          sending: false,
          result: res.result,
          missing: res.missing,
          note: res.note,
          needsAuth: res.needsAuthorization,
          error: res.result.error,
          historyId: res.historyId,
          historical: undefined,
        });
        // this response can now be referenced with {{res.<name>.…}}
        clientApi.chainable().then(setChainable).catch(() => {});
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
    vaultKeys,
    chainable,
    tokenTick,
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
