// Client side of the realtime proxy.
//
// A realtime session (the proxy socket + its running log) outlives the
// RealtimePane component: it lives in this module-level store keyed by tab id,
// so switching tabs or a remount doesn't drop the connection. The pane just
// subscribes to a snapshot via useSyncExternalStore and calls the imperative
// verbs below.

import { useCallback, useSyncExternalStore } from 'react';

import type {
  RealtimeClientFrame,
  RealtimeMessage,
  RealtimeServerFrame,
  RealtimeSpec,
} from '../../../shared/collections.ts';

export type RTState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

export interface RTSnapshot {
  state: RTState;
  /** WS subprotocol the server settled on */
  protocol?: string;
  /** latest advisory (vault note, non-SSE content-type, …) */
  note?: string;
  /** {{vars}} referenced but undefined at connect */
  missing?: string[];
  log: RealtimeMessage[];
}

/** Keep the log bounded — a chatty stream should never grow without limit. */
const LOG_CAP = 1000;
const IDLE: RTSnapshot = { state: 'idle', log: [] };

interface Session {
  socket: WebSocket | null;
  snap: RTSnapshot;
  listeners: Set<() => void>;
}

const sessions = new Map<string, Session>();

function sess(tabId: string): Session {
  let s = sessions.get(tabId);
  if (!s) {
    s = { socket: null, snap: IDLE, listeners: new Set() };
    sessions.set(tabId, s);
  }
  return s;
}

function emit(s: Session): void {
  for (const l of s.listeners) l();
}

function patch(tabId: string, p: Partial<RTSnapshot>): void {
  const s = sess(tabId);
  s.snap = { ...s.snap, ...p };
  emit(s);
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function sys(text: string): RealtimeMessage {
  return { id: uid(), dir: 'system', at: Date.now(), data: text };
}

function append(tabId: string, m: RealtimeMessage): void {
  const s = sess(tabId);
  const log = s.snap.log.length >= LOG_CAP ? s.snap.log.slice(s.snap.log.length - LOG_CAP + 1) : s.snap.log.slice();
  log.push(m);
  s.snap = { ...s.snap, log };
  emit(s);
}

function handleFrame(tabId: string, f: RealtimeServerFrame): void {
  if (f.t === 'message') {
    append(tabId, { id: uid(), dir: 'recv', at: f.at, data: f.data, binary: f.binary });
    return;
  }
  if (f.t === 'error') {
    append(tabId, sys(`⚠ ${f.message}`));
    return;
  }
  // status
  const next: Partial<RTSnapshot> = { state: f.state };
  if (f.protocol) next.protocol = f.protocol;
  if (f.note) next.note = f.note;
  if (f.missing) next.missing = f.missing;
  patch(tabId, next);
  if (f.note) append(tabId, sys(f.note));
  if (f.missing?.length) append(tabId, sys(`Undefined variables: ${f.missing.map((m) => `{{${m}}}`).join(', ')}`));
  if (f.state === 'open') append(tabId, sys(`Connected${f.protocol ? ` · ${f.protocol}` : ''}`));
  else if (f.state === 'closed') append(tabId, sys(`Closed${f.code != null ? ` · code ${f.code}` : ''}${f.reason ? ` · ${f.reason}` : ''}`));
  else if (f.state === 'error') append(tabId, sys(`Error${f.reason ? `: ${f.reason}` : ''}`));
}

export function connect(tabId: string, spec: RealtimeSpec, vars: Record<string, string>): void {
  const s = sess(tabId);
  try {
    s.socket?.close();
  } catch {
    /* already gone */
  }
  patch(tabId, { state: 'connecting', note: undefined, missing: undefined, protocol: undefined });
  append(tabId, sys(`${spec.kind === 'sse' ? 'GET' : 'WS'} ${spec.url || '(no url)'}`));

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/api/realtime`);
  s.socket = socket;

  socket.onopen = () => {
    socket.send(JSON.stringify({ t: 'open', spec, vars } satisfies RealtimeClientFrame));
  };
  socket.onmessage = (ev) => {
    try {
      handleFrame(tabId, JSON.parse(ev.data as string) as RealtimeServerFrame);
    } catch {
      /* ignore malformed */
    }
  };
  socket.onclose = () => {
    const cur = sess(tabId);
    if (cur.socket !== socket) return; // superseded by a newer connect()
    cur.socket = null;
    if (cur.snap.state === 'open' || cur.snap.state === 'connecting') {
      patch(tabId, { state: 'closed' });
      append(tabId, sys('Proxy connection lost'));
    }
  };
  socket.onerror = () => {
    if (sess(tabId).socket === socket) patch(tabId, { state: 'error' });
  };
}

export function sendMessage(tabId: string, data: string): boolean {
  const s = sess(tabId);
  if (!s.socket || s.socket.readyState !== WebSocket.OPEN) return false;
  s.socket.send(JSON.stringify({ t: 'send', data } satisfies RealtimeClientFrame));
  append(tabId, { id: uid(), dir: 'sent', at: Date.now(), data });
  return true;
}

export function disconnect(tabId: string): void {
  const s = sess(tabId);
  if (s.socket) {
    try {
      s.socket.send(JSON.stringify({ t: 'close' } satisfies RealtimeClientFrame));
    } catch {
      /* socket may be closing */
    }
    try {
      s.socket.close();
    } catch {
      /* already gone */
    }
    s.socket = null;
  }
  if (s.snap.state === 'open' || s.snap.state === 'connecting') {
    patch(tabId, { state: 'closed' });
    append(tabId, sys('Disconnected'));
  }
}

export function clearLog(tabId: string): void {
  const s = sess(tabId);
  s.snap = { ...s.snap, log: [] };
  emit(s);
}

/** Tear a session down for good — called when its tab is closed. */
export function destroySession(tabId: string): void {
  const s = sessions.get(tabId);
  if (!s) return;
  try {
    s.socket?.close();
  } catch {
    /* already gone */
  }
  sessions.delete(tabId);
}

export function useRealtime(tabId: string): RTSnapshot {
  const subscribe = useCallback(
    (cb: () => void) => {
      const s = sess(tabId);
      s.listeners.add(cb);
      return () => {
        s.listeners.delete(cb);
      };
    },
    [tabId],
  );
  const getSnapshot = useCallback(() => sess(tabId).snap, [tabId]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
