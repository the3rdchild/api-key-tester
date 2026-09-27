// Realtime tab: one long-lived WebSocket or SSE connection and its running log.
//
// It replaces the request|response split entirely. The URL + auth + headers are
// resolved and connected server-side (see core/realtime.ts), so the same vault
// keys, {{vars}} and custom headers an HTTP request gets apply here too — things
// the browser's own WebSocket/EventSource can't do.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { KeyValueEditor } from '../KeyValueEditor.tsx';
import { LogRow } from './LogRow.tsx';
import { countByType, filterLog, LogToolbar, type LogFilter } from './LogToolbar.tsx';
import { clearLog, connect, disconnect, sendMessage, useRealtime, type RTSnapshot } from './useRealtime.ts';
import { formatBytes } from '../../lib/format.ts';
import { loadLocal, saveLocal } from '../../lib/storage.ts';
import type { RealtimeSpec } from '../../../../shared/collections.ts';
import type { KeyEntry } from '../../../../shared/types.ts';
import type { Tab } from '../useClient.ts';

type Section = 'headers' | 'auth' | 'protocols';

interface Props {
  tab: Tab;
  vaultKeys: KeyEntry[];
  onRt: (patch: Partial<RealtimeSpec>) => void;
  onToast: (msg: string) => void;
}

const STATE_STYLE: Record<string, string> = {
  idle: 'text-slate-400',
  connecting: 'text-amber-500',
  open: 'text-emerald-600 dark:text-emerald-400',
  closed: 'text-slate-500',
  error: 'text-red-600 dark:text-red-400',
};

const PRETTY_KEY = 'realtime.pretty';

export function RealtimePane({ tab, vaultKeys, onRt, onToast }: Props) {
  const rt = tab.rt!;
  const isWs = rt.kind === 'ws';
  const snap = useRealtime(tab.id);
  const [section, setSection] = useState<Section>('headers');

  const busy = snap.state === 'open' || snap.state === 'connecting';

  const toggle = () => {
    if (busy) {
      disconnect(tab.id);
      return;
    }
    if (!rt.url.trim()) {
      onToast('Enter a URL first');
      return;
    }
    connect(tab.id, rt, {});
  };

  const send = () => {
    const data = rt.draft ?? '';
    if (!data) return;
    if (!sendMessage(tab.id, data)) onToast('Not connected');
    else onRt({ draft: '' });
  };

  // ─── log view ─────────────────────────────────────────────────────────────
  const [filter, setFilter] = useState<LogFilter>('all');
  const [query, setQuery] = useState('');
  const [pretty, setPretty] = useState(() => loadLocal(PRETTY_KEY) !== '0');
  const counts = useMemo(() => countByType(snap.log), [snap.log]);
  const visible = useMemo(() => filterLog(snap.log, filter, query), [snap.log, filter, query]);

  const onCopy = useCallback(
    (text: string) => {
      void navigator.clipboard.writeText(text).then(
        () => onToast('Copied'),
        () => onToast('Copy failed'),
      );
    },
    [onToast],
  );
  const onResend = useCallback(
    (text: string) => {
      if (!sendMessage(tab.id, text)) onToast('Not connected');
    },
    [tab.id, onToast],
  );

  const exportLog = () => {
    const lines = visible.map((m) =>
      JSON.stringify({
        type: m.type,
        at: new Date(m.at).toISOString(),
        data: m.data,
        size: m.size,
        binary: m.binary,
        truncated: m.truncated,
        event: m.event,
        eventId: m.eventId,
      }),
    );
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'application/x-ndjson' }));
    link.download = `keyway-${rt.kind}-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  // Auto-scroll the log unless the user has scrolled up to read history; while
  // they're up there, count what arrives below instead of yanking them down.
  const logRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const lastIdRef = useRef<string | undefined>(undefined);
  const [unseen, setUnseen] = useState(0);
  useEffect(() => {
    const el = logRef.current;
    const last = visible[visible.length - 1]?.id;
    if (pinnedRef.current) {
      if (el) el.scrollTop = el.scrollHeight;
    } else if (last !== lastIdRef.current) {
      const i = visible.findIndex((m) => m.id === lastIdRef.current);
      setUnseen((n) => n + (i === -1 ? visible.length : visible.length - 1 - i));
    }
    lastIdRef.current = last;
  }, [visible]);

  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (pinnedRef.current) setUnseen(0);
  };

  const toBottom = () => {
    pinnedRef.current = true;
    setUnseen(0);
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  // a new filter is a new view: start it at the newest line
  const narrow = (apply: () => void) => {
    pinnedRef.current = true;
    setUnseen(0);
    apply();
  };

  const sections: Section[] = isWs ? ['headers', 'auth', 'protocols'] : ['headers', 'auth'];

  return (
    <section className="flex h-full min-w-0 flex-col" aria-label="Realtime connection">
      {/* connection bar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 p-2 dark:border-slate-800">
        <span className="flex h-9 shrink-0 items-center rounded bg-slate-100 px-2 text-xs font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          {isWs ? 'WS' : 'SSE'}
        </span>
        <label htmlFor="rt-url" className="sr-only">
          URL
        </label>
        <input
          id="rt-url"
          value={rt.url}
          placeholder={isWs ? 'wss://echo.websocket.org   ·   {{baseURL}} works too' : 'https://api.example.com/events   ·   {{vars}} work too'}
          onChange={(e) => onRt({ url: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') toggle();
          }}
          className="h-9 w-0 min-w-[10rem] flex-1 rounded border border-slate-300 bg-white px-2 font-mono text-sm dark:border-slate-700 dark:bg-slate-800"
        />
        <button
          type="button"
          onClick={toggle}
          disabled={!busy && !rt.url}
          className={`h-9 shrink-0 rounded px-4 text-sm font-medium text-white disabled:opacity-50 ${
            busy ? 'bg-rose-600 hover:bg-rose-700' : 'bg-emerald-600 hover:bg-emerald-700'
          }`}
        >
          {snap.state === 'connecting' ? (
            <>
              <i className="fa-solid fa-spinner fa-spin" /> Connecting
            </>
          ) : busy ? (
            <>
              <i className="fa-solid fa-plug-circle-xmark" /> Disconnect
            </>
          ) : (
            <>
              <i className="fa-solid fa-plug" /> Connect
            </>
          )}
        </button>
        <span className={`shrink-0 text-xs font-medium ${STATE_STYLE[snap.state] ?? 'text-slate-400'}`}>
          <i className="fa-solid fa-circle text-[6px]" /> {snap.state}
          {snap.protocol ? ` · ${snap.protocol}` : ''}
        </span>
        <TrafficStats snap={snap} isWs={isWs} />

        {snap.note && (
          <p className="w-full text-xs text-amber-600 dark:text-amber-400">
            <i className="fa-solid fa-circle-info mr-1" />
            {snap.note}
          </p>
        )}
      </div>

      {/* config tabs */}
      <div
        role="tablist"
        aria-label="Connection settings"
        className="flex shrink-0 gap-1 border-b border-slate-200 px-2 dark:border-slate-800"
      >
        {sections.map((id) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={section === id}
            onClick={() => setSection(id)}
            className={`shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-xs font-medium capitalize ${
              section === id
                ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >
            {id}
            {id === 'headers' && rt.headers.filter((h) => h.enabled && h.key).length > 0 && (
              <span className="ml-1 rounded bg-slate-200 px-1 text-[10px] dark:bg-slate-700">
                {rt.headers.filter((h) => h.enabled && h.key).length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* config body */}
      <div className="max-h-[38%] shrink-0 overflow-auto p-2">
        {section === 'headers' && (
          <KeyValueEditor
            idPrefix="rt-headers"
            rows={rt.headers}
            onChange={(headers) => onRt({ headers })}
            keyPlaceholder="Header-Name"
            valuePlaceholder="value"
          />
        )}
        {section === 'auth' && <AuthPanel rt={rt} vaultKeys={vaultKeys} onRt={onRt} />}
        {section === 'protocols' && isWs && (
          <div className="grid max-w-md gap-2 text-sm">
            <label htmlFor="rt-protocols" className="text-xs font-medium text-slate-500">
              Subprotocols (Sec-WebSocket-Protocol)
            </label>
            <input
              id="rt-protocols"
              value={rt.protocols.join(', ')}
              placeholder="graphql-ws, json"
              onChange={(e) =>
                onRt({ protocols: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })
              }
              className="h-8 w-full rounded border border-slate-300 bg-white px-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-800"
            />
            <p className="text-xs text-slate-400">Comma-separated. Offered to the server on connect.</p>
          </div>
        )}
      </div>

      {/* log */}
      <LogToolbar
        isWs={isWs}
        counts={counts}
        shown={visible.length}
        filter={filter}
        onFilter={(f) => narrow(() => setFilter(f))}
        query={query}
        onQuery={(q) => narrow(() => setQuery(q))}
        pretty={pretty}
        onPretty={(v) => {
          setPretty(v);
          saveLocal(PRETTY_KEY, v ? '1' : '0');
        }}
        onExport={exportLog}
        onClear={() => clearLog(tab.id)}
      />
      <div className="relative min-h-0 flex-1">
        <div ref={logRef} onScroll={onScroll} className="h-full overflow-auto p-2 font-mono text-xs">
          {visible.length === 0 ? (
            <p className="p-4 text-center text-slate-400">
              {snap.log.length > 0
                ? 'No messages match this filter.'
                : isWs
                  ? 'Connect, then send a frame to see it here.'
                  : 'Connect to start receiving events.'}
            </p>
          ) : (
            visible.map((m, i) => (
              <LogRow
                key={m.id}
                m={m}
                prevAt={visible[i - 1]?.at}
                pretty={pretty}
                onCopy={onCopy}
                onResend={isWs && snap.state === 'open' ? onResend : undefined}
              />
            ))
          )}
        </div>
        {unseen > 0 && (
          <button
            type="button"
            onClick={toBottom}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-indigo-600 px-3 py-1 text-xs font-medium text-white shadow-lg hover:bg-indigo-700"
          >
            {unseen} new <i className="fa-solid fa-arrow-down ml-1" />
          </button>
        )}
      </div>

      {/* composer (ws only) */}
      {isWs && (
        <div className="flex shrink-0 items-end gap-2 border-t border-slate-200 p-2 dark:border-slate-800">
          <textarea
            value={rt.draft ?? ''}
            placeholder={snap.state === 'open' ? 'Message to send · Ctrl+Enter' : 'Connect to send messages'}
            onChange={(e) => onRt({ draft: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            className="min-h-[2.5rem] flex-1 resize-y rounded border border-slate-300 bg-white px-2 py-1.5 font-mono text-xs dark:border-slate-700 dark:bg-slate-800"
          />
          <button
            type="button"
            onClick={send}
            disabled={snap.state !== 'open' || !(rt.draft ?? '').length}
            className="h-9 shrink-0 rounded bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            <i className="fa-solid fa-paper-plane" /> Send
          </button>
        </div>
      )}
    </section>
  );
}

/** ↑/↓ counters and, while open, how long the connection has been up. Its own
 *  component so the once-a-second clock doesn't re-render the whole pane. */
function TrafficStats({ snap, isWs }: { snap: RTSnapshot; isWs: boolean }) {
  const open = snap.state === 'open' && snap.openedAt != null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open]);

  const { stats } = snap;
  const secs = open ? Math.max(0, Math.floor((now - snap.openedAt!) / 1000)) : 0;
  const up = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
  const pill = 'rounded border border-slate-200 px-1.5 py-0.5 font-mono tabular-nums dark:border-slate-700';

  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-slate-500">
      {open && (
        <span className="tabular-nums" title="Connected for">
          <i className="fa-regular fa-clock mr-1" />
          {up}
        </span>
      )}
      {isWs && (
        <span className={pill} title="Sent since connect">
          ↑ {stats.sent} · {formatBytes(stats.sentBytes)}
        </span>
      )}
      <span className={`${pill} text-emerald-600 dark:text-emerald-400`} title="Received since connect, keep-alive included">
        ↓ {stats.received} · {formatBytes(stats.receivedBytes)}
      </span>
    </span>
  );
}

function AuthPanel({
  rt,
  vaultKeys,
  onRt,
}: {
  rt: RealtimeSpec;
  vaultKeys: KeyEntry[];
  onRt: (patch: Partial<RealtimeSpec>) => void;
}) {
  const auth = rt.auth;
  const set = (patch: Partial<RealtimeSpec['auth']>) => onRt({ auth: { ...auth, ...patch } });
  const input = 'h-8 w-full rounded border border-slate-300 bg-white px-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-800';

  return (
    <div className="grid max-w-md gap-3 text-sm">
      <label className="grid gap-1">
        <span className="text-xs font-medium text-slate-500">Type</span>
        <select
          value={auth.type}
          onChange={(e) => onRt({ auth: { type: e.target.value as RealtimeSpec['auth']['type'] } })}
          className="h-8 rounded border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-800"
        >
          <option value="none">No auth</option>
          <option value="vault">From key vault</option>
          <option value="bearer">Bearer token</option>
          <option value="header">Custom header</option>
        </select>
      </label>

      {auth.type === 'vault' && (
        <>
          <label className="grid gap-1">
            <span className="text-xs font-medium text-slate-500">Key</span>
            <select
              value={auth.keyId ?? ''}
              onChange={(e) => set({ keyId: e.target.value })}
              className="h-8 w-full rounded border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-800"
            >
              <option value="">Choose a key…</option>
              {vaultKeys
                .filter((k) => k.testable)
                .map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.provider}
                    {k.label ? ` · ${k.label}` : ''}
                  </option>
                ))}
            </select>
          </label>
          <p className="text-xs text-slate-400">
            The key's own scheme is applied — Bearer for the OpenAI family,{' '}
            <code className="font-mono">x-api-key</code> for Anthropic, a query param for Gemini, a freshly
            signed JWT for z.ai. Its non-secret fields are available as{' '}
            <code className="font-mono">{'{{vault.baseURL}}'}</code>.
          </p>
        </>
      )}

      {auth.type === 'bearer' && (
        <label className="grid gap-1">
          <span className="text-xs font-medium text-slate-500">Token</span>
          <input value={auth.token ?? ''} placeholder="{{token}}" onChange={(e) => set({ token: e.target.value })} className={input} />
        </label>
      )}

      {auth.type === 'header' && (
        <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-1">
            <span className="text-xs font-medium text-slate-500">Header</span>
            <input value={auth.headerName ?? ''} placeholder="Authorization" onChange={(e) => set({ headerName: e.target.value })} className={input} />
          </label>
          <label className="grid gap-1">
            <span className="text-xs font-medium text-slate-500">Value</span>
            <input value={auth.headerValue ?? ''} placeholder="Bearer …" onChange={(e) => set({ headerValue: e.target.value })} className={input} />
          </label>
        </div>
      )}
    </div>
  );
}
