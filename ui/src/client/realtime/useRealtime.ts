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

export type RTState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error';

/** Traffic since the last connect. Kept apart from the log, which is capped
 *  and can be cleared, so the counters stay true to the connection. */
export interface RTStats {
  sent: number;
  sentBytes: number;
  /** everything that came down, keep-alive included */
  received: number;
  receivedBytes: number;
}

/** An LLM completion stitched back together from SSE deltas, per connection.
 *  Kept whole even after the capped log has dropped its head. */
export interface RTStream {
  text: string;
  deltas: number;
  /** completion tokens, when the stream reports them */
  tokens?: number;
  /** connect time — TTFT is measured from here, like an HTTP send */
  startedAt?: number;
  firstAt?: number;
  lastAt?: number;
  /** a `[DONE]` sentinel arrived */
  done: boolean;
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
  stream: RTStream;
  log: RealtimeMessage[];
}

/** What the pane configures. Applied as it changes, not only at connect. */
export interface RTOptions {
  autoReconnect: boolean;
  /** ws: sent every `intervalMs` while open */
  heartbeat?: { intervalMs: number; payload: string };
}

/** Keep the log bounded — a chatty stream should never grow without limit. */
const LOG_CAP = 1000;
/** Sent messages remembered for the composer's Alt+↑/↓. */
const HISTORY_CAP = 50;
/** Reconnect backoff: 1 s, 2 s, 4 s … capped at 30 s, and 10 tries in a row. */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const MAX_ATTEMPTS = 10;

const NO_STATS: RTStats = { sent: 0, sentBytes: 0, received: 0, receivedBytes: 0 };
const NO_STREAM: RTStream = { text: '', deltas: 0, done: false };
const IDLE: RTSnapshot = { state: 'idle', stats: NO_STATS, stream: NO_STREAM, log: [] };
const encoder = new TextEncoder();

interface Session {
  socket: WebSocket | null;
  snap: RTSnapshot;
  listeners: Set<() => void>;
  /** lines and counts not yet folded into `snap` — see append() */
  pending: RealtimeMessage[];
  stats: RTStats;
  stream: RTStream;
  flushScheduled: boolean;
  /** what was sent, oldest first — apart from the log, so Clear keeps it */
  history: string[];
  opts: RTOptions;
  /** what the last connect() asked for; a reconnect repeats it */
  target?: { spec: RealtimeSpec; vars: Record<string, string> };
  /** reconnects in a row that haven't reached open yet */
  attempt: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  /** sse: where to resume, and the server's own reconnect delay */
  lastEventId?: string;
  retryMs?: number;
}

const sessions = new Map<string, Session>();

function sess(tabId: string): Session {
  let s = sessions.get(tabId);
  if (!s) {
    s = {
      socket: null,
      snap: IDLE,
      listeners: new Set(),
      pending: [],
      stats: { ...NO_STATS },
      stream: { ...NO_STREAM },
      flushScheduled: false,
      history: [],
      opts: { autoReconnect: false },
      attempt: 0,
    };
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

function formatDelay(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${Math.round(ms / 100) / 10} s`;
}

// A fast stream can deliver hundreds of frames a second, and copying the log
// plus re-rendering for each one janks the tab. So lines are queued and folded
// in once per animation frame. rAF pauses while the browser tab is hidden;
// the queue is capped like the log, so it can't grow while nobody's looking.
function append(tabId: string, m: RealtimeMessage, traffic?: 'sent' | 'received'): void {
  const s = sess(tabId);
  if (traffic === 'sent') {
    s.stats.sent++;
    s.stats.sentBytes += m.size ?? 0;
  } else if (traffic === 'received') {
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
  s.snap = {
    ...s.snap,
    stats: { ...s.stats },
    stream: { ...s.stream },
    log: log.length > LOG_CAP ? log.slice(log.length - LOG_CAP) : log,
  };
  emit(s);
}

/** A close the user or server meant (normal, going away, no status) is info;
 *  anything else — 1006 abnormal, 1011 server error, 4xxx app codes — is an error. */
function cleanClose(code?: number): boolean {
  return code == null || code === 1000 || code === 1001 || code === 1005;
}

// ─── timers ───────────────────────────────────────────────────────────────────

function stopHeartbeat(s: Session): void {
  if (s.heartbeatTimer) clearInterval(s.heartbeatTimer);
  s.heartbeatTimer = undefined;
}

function cancelReconnect(s: Session): void {
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  s.reconnectTimer = undefined;
}

/** (Re)start the keep-alive to match the options — WS only, only while open. */
function startHeartbeat(tabId: string, s: Session): void {
  stopHeartbeat(s);
  const hb = s.opts.heartbeat;
  if (!hb || hb.intervalMs <= 0 || s.target?.spec.kind !== 'ws' || s.snap.state !== 'open') return;
  s.heartbeatTimer = setInterval(() => transmit(tabId, hb.payload, 'heartbeat'), hb.intervalMs);
}

/** Why a close shouldn't be retried, or undefined when it should. `code` is
 *  the WS close code, or the HTTP status of a failed SSE request. */
function noRetryReason(s: Session, code?: number): string | undefined {
  if (s.target?.spec.kind === 'sse') {
    if (code != null && code >= 400 && code < 500) return `HTTP ${code} won't change on a retry`;
    // EventSource would re-request, but for an LLM stream that means paying
    // for the same completion again and again
    if (s.stream.deltas > 0 || s.stream.done) return 'the stream delivered a completion';
    return undefined;
  }
  if (code === 1000) return 'the server closed normally (1000)';
  return undefined;
}

function scheduleReconnect(tabId: string, code?: number): void {
  const s = sess(tabId);
  if (!s.opts.autoReconnect || !s.target || s.reconnectTimer) return;
  const why = noRetryReason(s, code);
  if (why) {
    append(tabId, line('info', `Not reconnecting: ${why}`));
    return;
  }
  if (s.attempt >= MAX_ATTEMPTS) {
    append(tabId, line('error', `Gave up reconnecting after ${MAX_ATTEMPTS} attempts`));
    return;
  }
  const sse = s.target.spec.kind === 'sse';
  const delay = sse && s.retryMs != null ? s.retryMs : Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** s.attempt);
  s.attempt++;
  patch(tabId, { state: 'reconnecting' });
  append(
    tabId,
    line(
      'info',
      `Reconnecting in ${formatDelay(delay)} · attempt ${s.attempt}/${MAX_ATTEMPTS}` +
        (sse && s.lastEventId ? ` · Last-Event-ID ${s.lastEventId}` : ''),
    ),
  );
  s.reconnectTimer = setTimeout(() => {
    s.reconnectTimer = undefined;
    patch(tabId, { state: 'connecting' });
    openProxy(tabId, s);
  }, delay);
}

// ─── frames from the proxy ────────────────────────────────────────────────────

function handleFrame(tabId: string, f: RealtimeServerFrame): void {
  const s = sess(tabId);
  if (f.t === 'message') {
    const st = s.stream;
    if (f.delta) {
      const now = Date.now();
      st.text += f.delta;
      st.deltas++;
      st.firstAt ??= now;
      st.lastAt = now;
    }
    if (f.tokens) st.tokens = f.tokens;
    if (!f.heartbeat && f.data.trim() === '[DONE]') st.done = true;
    if (f.eventId !== undefined) s.lastEventId = f.eventId || undefined;
    append(
      tabId,
      {
        id: uid(),
        type: f.heartbeat ? 'heartbeat' : 'receive',
        at: f.at,
        data: f.data,
        size: f.size,
        binary: f.binary,
        truncated: f.truncated,
        event: f.event,
        eventId: f.eventId,
        delta: f.delta,
      },
      'received',
    );
    return;
  }
  if (f.t === 'error') {
    append(tabId, line('error', f.message));
    return;
  }
  if (f.t === 'retry') {
    if (s.retryMs !== f.ms) append(tabId, line('info', `Server asks for ${formatDelay(f.ms)} between reconnects (retry:)`));
    s.retryMs = f.ms;
    return;
  }
  // status
  const next: Partial<RTSnapshot> = { state: f.state };
  if (f.protocol) next.protocol = f.protocol;
  if (f.note) next.note = f.note;
  if (f.missing) next.missing = f.missing;
  if (f.state === 'open') {
    next.openedAt = Date.now();
    s.attempt = 0;
  }
  patch(tabId, next);
  if (f.note) append(tabId, line('info', f.note));
  if (f.missing?.length) append(tabId, line('error', `Undefined variables: ${f.missing.map((m) => `{{${m}}}`).join(', ')}`));
  if (f.state === 'open') {
    append(tabId, line('info', `Connected${f.protocol ? ` · ${f.protocol}` : ''}`));
    startHeartbeat(tabId, s);
    return;
  }
  if (f.state === 'closed')
    append(
      tabId,
      line(
        cleanClose(f.code) ? 'info' : 'error',
        `Closed${f.code != null ? ` · code ${f.code}` : ''}${f.reason ? ` · ${f.reason}` : ''}`,
      ),
    );
  else if (f.state === 'error') append(tabId, line('error', `Error${f.reason ? `: ${f.reason}` : ''}`));
  if (f.state === 'closed' || f.state === 'error') {
    stopHeartbeat(s);
    // A WS error is always followed by its close (with the code), so WS waits
    // for that; an SSE error is the end of the line.
    if (f.state === 'closed' || s.target?.spec.kind === 'sse') scheduleReconnect(tabId, f.code);
  }
}

// ─── the proxy socket ─────────────────────────────────────────────────────────

/** Let go of the session's socket *before* closing it, so its onclose sees
 *  it's been superseded — some runtimes (Bun) fire close synchronously. */
function dropSocket(s: Session): WebSocket | null {
  const socket = s.socket;
  s.socket = null;
  return socket;
}

/** One proxy socket per attempt: it asks the server to open the upstream and
 *  relays frames until either side closes. */
function openProxy(tabId: string, s: Session): void {
  try {
    dropSocket(s)?.close();
  } catch {
    /* already gone */
  }
  const { spec, vars } = s.target!;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/api/realtime`);
  s.socket = socket;

  socket.onopen = () => {
    const lastEventId = spec.kind === 'sse' ? s.lastEventId : undefined;
    socket.send(JSON.stringify({ t: 'open', spec, vars, lastEventId } satisfies RealtimeClientFrame));
  };
  socket.onmessage = (ev) => {
    if (sess(tabId).socket !== socket) return; // a superseded attempt
    try {
      handleFrame(tabId, JSON.parse(ev.data as string) as RealtimeServerFrame);
    } catch {
      /* ignore malformed */
    }
  };
  // No onerror: a failed socket always goes on to close, and that's handled here.
  socket.onclose = () => {
    const cur = sess(tabId);
    if (cur.socket !== socket) return; // superseded by a newer attempt
    cur.socket = null;
    if (cur.snap.state === 'open' || cur.snap.state === 'connecting') {
      stopHeartbeat(cur);
      patch(tabId, { state: 'closed' });
      append(tabId, line('error', 'Proxy connection lost'));
      scheduleReconnect(tabId);
    }
  };
}

// ─── verbs ────────────────────────────────────────────────────────────────────

export function connect(tabId: string, spec: RealtimeSpec, vars: Record<string, string>): void {
  const s = sess(tabId);
  cancelReconnect(s);
  stopHeartbeat(s);
  s.target = { spec, vars };
  s.attempt = 0;
  // a fresh connect is a fresh stream, as with a new EventSource
  s.lastEventId = undefined;
  s.retryMs = undefined;
  s.stats = { ...NO_STATS };
  s.stream = { ...NO_STREAM, startedAt: Date.now() };
  patch(tabId, {
    state: 'connecting',
    note: undefined,
    missing: undefined,
    protocol: undefined,
    openedAt: undefined,
    stats: { ...s.stats },
    stream: { ...s.stream },
  });
  append(tabId, line('info', `${spec.kind === 'sse' ? 'GET' : 'WS'} ${spec.url || '(no url)'}`));
  openProxy(tabId, s);
}

export function setOptions(tabId: string, opts: RTOptions): void {
  const s = sess(tabId);
  const prev = s.opts;
  s.opts = opts;
  if (!opts.autoReconnect && s.reconnectTimer) {
    cancelReconnect(s);
    patch(tabId, { state: 'closed' });
    append(tabId, line('info', 'Auto-reconnect turned off — stopped retrying'));
  }
  if (prev.heartbeat?.intervalMs !== opts.heartbeat?.intervalMs || prev.heartbeat?.payload !== opts.heartbeat?.payload) {
    startHeartbeat(tabId, s);
  }
}

/** Put a frame on the upstream and log it. */
function transmit(tabId: string, data: string, type: 'send' | 'heartbeat'): boolean {
  const s = sess(tabId);
  if (!s.socket || s.socket.readyState !== WebSocket.OPEN) return false;
  s.socket.send(JSON.stringify({ t: 'send', data } satisfies RealtimeClientFrame));
  append(tabId, { id: uid(), type, at: Date.now(), data, size: encoder.encode(data).length }, 'sent');
  return true;
}

export function sendMessage(tabId: string, data: string): boolean {
  if (!transmit(tabId, data, 'send')) return false;
  const s = sess(tabId);
  if (s.history[s.history.length - 1] !== data) {
    s.history.push(data);
    if (s.history.length > HISTORY_CAP) s.history.shift();
  }
  return true;
}

/** Sent messages for this tab, oldest first. Memory only: survives tab
 *  switches and Clear, not a reload. */
export function sentHistory(tabId: string): readonly string[] {
  return sess(tabId).history;
}

export function disconnect(tabId: string): void {
  const s = sess(tabId);
  cancelReconnect(s);
  stopHeartbeat(s);
  s.attempt = 0;
  const socket = dropSocket(s);
  if (socket) {
    try {
      socket.send(JSON.stringify({ t: 'close' } satisfies RealtimeClientFrame));
    } catch {
      /* socket may be closing */
    }
    try {
      socket.close();
    } catch {
      /* already gone */
    }
  }
  const { state } = s.snap;
  if (state === 'open' || state === 'connecting' || state === 'reconnecting') {
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
  cancelReconnect(s);
  stopHeartbeat(s);
  try {
    dropSocket(s)?.close();
  } catch {
    /* already gone */
  }
  sessions.delete(tabId);
}

/** The current snapshot, outside React. */
export function realtimeSnapshot(tabId: string): RTSnapshot {
  return sess(tabId).snap;
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
  const getSnapshot = useCallback(() => realtimeSnapshot(tabId), [tabId]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
