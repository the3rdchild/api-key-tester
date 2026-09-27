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
  RealtimeMessageType,
  RealtimeServerFrame,
  RealtimeSpec,
} from '../../../../shared/collections.ts';

export type RTState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

/** Traffic since the last connect. Kept apart from the log, which is capped
 *  and can be cleared, so the counters stay true to the connection. */
export interface RTStats {
  sent: number;
  sentBytes: number;
  /** everything that came down, keep-alive included */
  received: number;
  receivedBytes: number;
}

export interface RTSnapshot {
  state: RTState;
  /** WS subprotocol the server settled on */
  protocol?: string;
  /** latest advisory (vault note, non-SSE content-type, …) */
  note?: string;
  /** {{vars}} referenced but undefined at connect */
  missing?: string[];
  /** when the upstream opened — drives the "connected for" clock */
  openedAt?: number;
  stats: RTStats;
  log: RealtimeMessage[];
}

/** Keep the log bounded — a chatty stream should never grow without limit. */
const LOG_CAP = 1000;
const NO_STATS: RTStats = { sent: 0, sentBytes: 0, received: 0, receivedBytes: 0 };
const IDLE: RTSnapshot = { state: 'idle', stats: NO_STATS, log: [] };
const encoder = new TextEncoder();

interface Session {
  socket: WebSocket | null;
  snap: RTSnapshot;
  listeners: Set<() => void>;
  /** lines and counts not yet folded into `snap` — see append() */
  pending: RealtimeMessage[];
  stats: RTStats;
  flushScheduled: boolean;
}

const sessions = new Map<string, Session>();

function sess(tabId: string): Session {
  let s = sessions.get(tabId);
  if (!s) {
    s = { socket: null, snap: IDLE, listeners: new Set(), pending: [], stats: { ...NO_STATS }, flushScheduled: false };
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

let seq = 0;
function uid(): string {
  return `m${++seq}`;
}

function line(type: RealtimeMessageType, text: string): RealtimeMessage {
  return { id: uid(), type, at: Date.now(), data: text };
}

// A fast stream can deliver hundreds of frames a second, and copying the log
// plus re-rendering for each one janks the tab. So lines are queued and folded
// in once per animation frame. rAF pauses while the browser tab is hidden;
// the queue is capped like the log, so it can't grow while nobody's looking.
function append(tabId: string, m: RealtimeMessage): void {
  const s = sess(tabId);
  if (m.type === 'send') {
    s.stats.sent++;
    s.stats.sentBytes += m.size ?? 0;
  } else if (m.type === 'receive' || m.type === 'heartbeat') {
    s.stats.received++;
    s.stats.receivedBytes += m.size ?? 0;
  }
  s.pending.push(m);
  if (s.pending.length > LOG_CAP) s.pending.splice(0, s.pending.length - LOG_CAP);
  if (s.flushScheduled) return;
  s.flushScheduled = true;
  requestAnimationFrame(() => flush(s));
}

function flush(s: Session): void {
  s.flushScheduled = false;
  if (!s.pending.length) return;
  const log = s.snap.log.concat(s.pending);
  s.pending = [];
  s.snap = { ...s.snap, stats: { ...s.stats }, log: log.length > LOG_CAP ? log.slice(log.length - LOG_CAP) : log };
  emit(s);
}

/** A close the user or server meant (normal, going away, no status) is info;
 *  anything else — 1006 abnormal, 1011 server error, 4xxx app codes — is an error. */
function cleanClose(code?: number): boolean {
  return code == null || code === 1000 || code === 1001 || code === 1005;
}

function handleFrame(tabId: string, f: RealtimeServerFrame): void {
  if (f.t === 'message') {
    append(tabId, {
      id: uid(),
      type: f.heartbeat ? 'heartbeat' : 'receive',
      at: f.at,
      data: f.data,
      size: f.size,
      binary: f.binary,
      truncated: f.truncated,
      event: f.event,
      eventId: f.eventId,
    });
    return;
  }
  if (f.t === 'error') {
    append(tabId, line('error', f.message));
    return;
  }
  // status
  const next: Partial<RTSnapshot> = { state: f.state };
  if (f.protocol) next.protocol = f.protocol;
  if (f.note) next.note = f.note;
  if (f.missing) next.missing = f.missing;
  if (f.state === 'open') next.openedAt = Date.now();
  patch(tabId, next);
  if (f.note) append(tabId, line('info', f.note));
  if (f.missing?.length) append(tabId, line('error', `Undefined variables: ${f.missing.map((m) => `{{${m}}}`).join(', ')}`));
  if (f.state === 'open') append(tabId, line('info', `Connected${f.protocol ? ` · ${f.protocol}` : ''}`));
  else if (f.state === 'closed')
    append(
      tabId,
      line(
        cleanClose(f.code) ? 'info' : 'error',
        `Closed${f.code != null ? ` · code ${f.code}` : ''}${f.reason ? ` · ${f.reason}` : ''}`,
      ),
    );
  else if (f.state === 'error') append(tabId, line('error', `Error${f.reason ? `: ${f.reason}` : ''}`));
}

export function connect(tabId: string, spec: RealtimeSpec, vars: Record<string, string>): void {
  const s = sess(tabId);
  try {
    s.socket?.close();
  } catch {
    /* already gone */
  }
  s.stats = { ...NO_STATS };
  patch(tabId, {
    state: 'connecting',
    note: undefined,
    missing: undefined,
    protocol: undefined,
    openedAt: undefined,
    stats: { ...NO_STATS },
  });
  append(tabId, line('info', `${spec.kind === 'sse' ? 'GET' : 'WS'} ${spec.url || '(no url)'}`));

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
      append(tabId, line('error', 'Proxy connection lost'));
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
  append(tabId, { id: uid(), type: 'send', at: Date.now(), data, size: encoder.encode(data).length });
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
    append(tabId, line('info', 'Disconnected'));
  }
}

/** Empties the log; the traffic counters keep counting the connection. */
export function clearLog(tabId: string): void {
  const s = sess(tabId);
  s.pending = [];
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
