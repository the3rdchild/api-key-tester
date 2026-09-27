// Request history for realtime sessions: one entry per Connect, however many
// times it reconnected. The entry is written when the session connects (or
// fails to) and rewritten when it ends, with how long it ran, what went each
// way, how it closed, and the tail of its transcript.
//
// The bridge (realtime.ts) sees one upstream attempt at a time and reports it
// here; attempts that share a session id — the client sends the same one on
// every reconnect — fold into one session. Redaction happens where it does for
// HTTP, in req-history.ts.

import { nanoid } from 'nanoid';

import { recordRealtime, updateRealtime, type RealtimeRecord } from './req-history.ts';
import { isCleanClose } from '../../shared/collections.ts';
import type {
  RealtimeMessage,
  RealtimeMessageType,
  RealtimeServerFrame,
  RealtimeSpec,
  ReqHistoryEntry,
} from '../../shared/collections.ts';

/** The stored transcript is the latest lines, bounded by count and by size;
 *  one huge frame keeps only its head. */
const TRANSCRIPT_LINES = 500;
const TRANSCRIPT_BYTES = 256 * 1024;
const LINE_BYTES = 16 * 1024;
/** An LLM completion stitched from SSE deltas, kept up to this much. */
const STREAM_TEXT_BYTES = 256 * 1024;
/** Sessions remembered so a reconnect can find its entry again. */
const SESSIONS_KEPT = 100;

export type RealtimeHistoryEvent = { type: 'appended' | 'updated'; entry: ReqHistoryEntry };

let emit: ((event: RealtimeHistoryEvent) => void) | null = null;

/** index.ts forwards these to the /live socket, so the sidebar updates. */
export function setRealtimeHistoryEmitter(fn: (event: RealtimeHistoryEvent) => void): void {
  emit = fn;
}

interface Session {
  spec: RealtimeSpec;
  url: string;
  headers: Record<string, string>;
  startedAt: number;
  endedAt?: number;
  status?: number;
  error?: string;
  closeCode?: number;
  closeReason?: string;
  attempts: number;
  stats: { sent: number; sentBytes: number; received: number; receivedBytes: number };
  transcript: RealtimeMessage[];
  transcriptBytes: number;
  streamText: string;
  entryId?: string;
  /** one write after another, so an update never overtakes the create */
  writes: Promise<void>;
  /** its entry was deleted while it ran; stop writing */
  dropped: boolean;
}

const sessions = new Map<string, Session>();
let seq = 0;

function push(s: Session, m: Omit<RealtimeMessage, 'id'>): void {
  const data = m.data.length > LINE_BYTES ? m.data.slice(0, LINE_BYTES) : m.data;
  s.transcript.push({ ...m, id: `h${++seq}`, data, truncated: m.truncated || data.length < m.data.length || undefined });
  s.transcriptBytes += data.length;
  while (s.transcript.length > TRANSCRIPT_LINES || (s.transcriptBytes > TRANSCRIPT_BYTES && s.transcript.length > 1)) {
    s.transcriptBytes -= s.transcript.shift()!.data.length;
  }
}

function note(s: Session, type: RealtimeMessageType, text: string): void {
  push(s, { type, at: Date.now(), data: text });
}

function toRecord(s: Session): RealtimeRecord {
  return {
    spec: s.spec,
    url: s.url,
    headers: s.headers,
    startedAt: s.startedAt,
    status: s.status,
    error: s.error,
    summary: {
      durationMs: s.endedAt != null ? s.endedAt - s.startedAt : undefined,
      ...s.stats,
      closeCode: s.closeCode,
      closeReason: s.closeReason,
      attempts: s.attempts,
    },
    transcript: s.transcript.slice(),
    streamText: s.streamText || undefined,
  };
}

function persist(s: Session): void {
  s.writes = s.writes
    .then(async () => {
      if (s.dropped) return;
      if (!s.entryId) {
        const entry = await recordRealtime(toRecord(s));
        s.entryId = entry.id;
        emit?.({ type: 'appended', entry });
        return;
      }
      const entry = await updateRealtime(s.entryId, toRecord(s));
      if (!entry) s.dropped = true;
      else emit?.({ type: 'updated', entry });
    })
    .catch((e) => console.warn('[history] realtime session not recorded:', e));
}

/** What the bridge reports during one upstream attempt. */
export interface SessionAttempt {
  /** a frame the bridge sent down to the browser */
  server(f: RealtimeServerFrame): void;
  /** a frame the browser sent up, once it went out */
  client(data: string, heartbeat?: boolean): void;
  /** the attempt is over — the user disconnected, or the bridge went away */
  end(): void;
}

export function beginAttempt(
  sessionId: string | undefined,
  spec: RealtimeSpec,
  url: string,
  headers: Record<string, string>,
): SessionAttempt {
  const key = sessionId || nanoid();
  let s = sessions.get(key);
  if (s) {
    s.attempts++;
    s.url = url;
    s.headers = headers;
    s.endedAt = undefined;
    note(s, 'info', `Reconnect · attempt ${s.attempts}`);
  } else {
    s = {
      spec,
      url,
      headers,
      startedAt: Date.now(),
      attempts: 1,
      stats: { sent: 0, sentBytes: 0, received: 0, receivedBytes: 0 },
      transcript: [],
      transcriptBytes: 0,
      streamText: '',
      writes: Promise.resolve(),
      dropped: false,
    };
    sessions.set(key, s);
    if (sessions.size > SESSIONS_KEPT) sessions.delete(sessions.keys().next().value!);
    note(s, 'info', `${spec.kind === 'sse' ? 'GET' : 'WS'} ${url}`);
  }
  const session = s;

  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    session.endedAt = Date.now();
    persist(session);
  };

  return {
    server(f) {
      if (ended) return;
      if (f.t === 'message') {
        session.stats.received++;
        session.stats.receivedBytes += f.size;
        if (f.delta && session.streamText.length < STREAM_TEXT_BYTES) {
          session.streamText = (session.streamText + f.delta).slice(0, STREAM_TEXT_BYTES);
        }
        const { t: _t, heartbeat, tokens: _tokens, ...m } = f;
        push(session, { ...m, type: heartbeat ? 'heartbeat' : 'receive' });
        return;
      }
      if (f.t === 'error') {
        note(session, 'error', f.message);
        return;
      }
      if (f.t === 'retry') return;
      // status
      if (f.note) note(session, 'info', f.note);
      if (f.missing?.length) note(session, 'error', `Undefined variables: ${f.missing.map((m) => `{{${m}}}`).join(', ')}`);
      if (f.state === 'open') {
        session.status = f.code ?? (session.spec.kind === 'ws' ? 101 : 200);
        session.error = undefined;
        session.closeCode = undefined;
        session.closeReason = undefined;
        note(session, 'info', `Connected${f.protocol ? ` · ${f.protocol}` : ''}`);
        persist(session);
      } else if (f.state === 'closed') {
        session.closeCode = f.code;
        session.closeReason = f.reason;
        note(
          session,
          isCleanClose(f.code) ? 'info' : 'error',
          `Closed${f.code != null ? ` · code ${f.code}` : ''}${f.reason ? ` · ${f.reason}` : ''}`,
        );
        finish();
      } else if (f.state === 'error') {
        session.error = f.reason || 'Connection failed';
        if (f.code) session.status = f.code;
        note(session, 'error', `Error${f.reason ? `: ${f.reason}` : ''}`);
        finish();
      }
    },
    client(data, heartbeat) {
      if (ended) return;
      const size = Buffer.byteLength(data);
      session.stats.sent++;
      session.stats.sentBytes += size;
      push(session, { type: heartbeat ? 'heartbeat' : 'send', at: Date.now(), data, size });
    },
    end() {
      if (ended) return;
      note(session, 'info', 'Disconnected');
      finish();
    },
  };
}
