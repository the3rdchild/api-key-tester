// Realtime proxy: bridges one browser control socket to one upstream
// WebSocket or SSE stream.
//
// Why server-side? The browser's own WebSocket and EventSource can't set an
// Authorization header (or any custom header), and EventSource is bound by
// CORS. Routing through the server is the same reason send.ts exists - so a
// realtime connection authenticates exactly like an HTTP send: vault key,
// {{vars}}, arbitrary headers and all. The browser only ever talks to keyway.
//
// One bridge instance is owned by one control socket. It resolves the target,
// opens the upstream, and relays frames both ways until either side closes.

import { chainLookups, fromRecord, interpolate, type VarLookup } from './vars.ts';
import { resolveVaultAuth } from './vault-auth.ts';
import { activeEnvVars } from './collections.ts';
import { extractDelta, extractTokens } from './stream.ts';
import type {
  RealtimeClientFrame,
  RealtimeServerFrame,
  RealtimeSpec,
  RequestAuth,
} from '../../shared/collections.ts';

/** Bun's global WebSocket accepts headers at runtime, but with the DOM lib
 *  loaded its *type* is the header-less browser one. This is the upstream
 *  (client) constructor, typed for what Bun actually accepts. */
type UpstreamWSOptions = { headers?: Record<string, string>; protocols?: string[] };
type UpstreamWSCtor = new (url: string, options?: UpstreamWSOptions) => WebSocket;
const UpstreamWS = WebSocket as unknown as UpstreamWSCtor;

/** Frames larger than this are truncated before being forwarded to the
 *  browser - a runaway stream should not take the tab down with it. */
const FRAME_CAP = 512 * 1024;
/** Give up if the upstream hasn't opened in this long. */
const CONNECT_TIMEOUT_MS = 20_000;

type Send = (frame: RealtimeServerFrame) => void;

export interface RealtimeConnection {
  url: string;
  headers: Record<string, string>;
  protocols: string[];
  note?: string;
  missing: string[];
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

/** bearer/basic/header auth → headers, unless the user already set that header
 *  by hand (which always wins). Vault + oauth are handled by the caller. */
function applyAuth(auth: RequestAuth, headers: Record<string, string>, lookup: VarLookup, miss: Set<string>): void {
  const fill = (raw: string): string => {
    const i = interpolate(raw, lookup);
    i.missing.forEach((m) => miss.add(m));
    return i.out;
  };
  switch (auth.type) {
    case 'bearer':
      if (auth.token && !hasHeader(headers, 'Authorization')) headers.Authorization = `Bearer ${fill(auth.token)}`;
      break;
    case 'basic': {
      if (hasHeader(headers, 'Authorization')) break;
      const raw = `${fill(auth.username ?? '')}:${fill(auth.password ?? '')}`;
      headers.Authorization = `Basic ${Buffer.from(raw).toString('base64')}`;
      break;
    }
    case 'header':
      if (auth.headerName && !hasHeader(headers, auth.headerName)) headers[fill(auth.headerName)] = fill(auth.headerValue ?? '');
      break;
    // vault: merged by the caller; oauth2: not offered for realtime in v1.
    default:
      break;
  }
}

/** Resolve a RealtimeSpec into a concrete URL + headers, applying the same auth
 *  and {{var}} rules as an HTTP send. */
export async function buildRealtimeConnection(
  spec: RealtimeSpec,
  vars: Record<string, string> | undefined,
): Promise<RealtimeConnection> {
  const vault =
    spec.auth?.type === 'vault' && spec.auth.keyId ? await resolveVaultAuth(spec.auth.keyId) : null;
  const lookup = chainLookups(fromRecord(vars ?? {}), vault ? fromRecord(vault.vars) : undefined);
  const miss = new Set<string>();

  const urlI = interpolate(spec.url, lookup);
  urlI.missing.forEach((m) => miss.add(m));
  let url = urlI.out;

  const headers: Record<string, string> = {};
  for (const h of spec.headers ?? []) {
    if (!h.enabled || !h.key.trim()) continue;
    const k = interpolate(h.key, lookup);
    const v = interpolate(h.value, lookup);
    [...k.missing, ...v.missing].forEach((m) => miss.add(m));
    headers[k.out] = v.out;
  }

  applyAuth(spec.auth ?? { type: 'none' }, headers, lookup, miss);

  // Vault: a header you typed yourself always beats the vault's; Gemini's key
  // rides in the query string, so merge that into the URL.
  let note = vault?.note;
  if (vault) {
    for (const [k, v] of Object.entries(vault.headers)) if (!hasHeader(headers, k)) headers[k] = v;
    if (Object.keys(vault.query).length) {
      try {
        const u = new URL(url);
        for (const [k, v] of Object.entries(vault.query)) if (!u.searchParams.has(k)) u.searchParams.set(k, v);
        url = u.toString();
      } catch {
        // an unresolved {{var}} left the URL unparseable; reported via `missing`
      }
    }
  }
  if (spec.auth?.type === 'oauth2') note = 'OAuth2 auth is not available on realtime connections yet — use a Bearer token or vault key.';

  return { url, headers, protocols: spec.protocols ?? [], note, missing: [...miss] };
}

/** An SSE event that looks like an LLM stream chunk (OpenAI, Anthropic, Gemini,
 *  Ollama shapes — the same extraction the HTTP stream reader uses) carries
 *  its text delta and any reported token count, for the realtime Text view.
 *  Unlike the HTTP reader, plain-text payloads are *not* deltas here: a
 *  generic event stream isn't a model talking. */
function llmDelta(data: string): { delta?: string; tokens?: number } {
  const t = data.trim();
  if (t[0] !== '{') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return {};
  }
  return { delta: extractDelta(parsed) || undefined, tokens: extractTokens(parsed) };
}

export interface RealtimeBridge {
  handle(frame: RealtimeClientFrame): void | Promise<void>;
  dispose(): void;
}

/** One bridge per browser control socket. `send` pushes a frame to that
 *  browser; the returned handle consumes frames coming up from it. */
export function createBridge(send: Send): RealtimeBridge {
  let ws: WebSocket | null = null;
  let abort: AbortController | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clearTimer = () => {
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
  };

  // `size` is always the full frame, so the byte counters stay honest even
  // when what reaches the browser is only the head of it.
  const forward = (data: string | ArrayBuffer): void => {
    if (typeof data === 'string') {
      const truncated = data.length > FRAME_CAP;
      send({
        t: 'message',
        data: truncated ? data.slice(0, FRAME_CAP) : data,
        at: Date.now(),
        size: Buffer.byteLength(data),
        truncated: truncated || undefined,
      });
    } else {
      const truncated = data.byteLength > FRAME_CAP;
      const buf = Buffer.from(truncated ? data.slice(0, FRAME_CAP) : data);
      send({
        t: 'message',
        data: buf.toString('base64'),
        binary: true,
        at: Date.now(),
        size: data.byteLength,
        truncated: truncated || undefined,
      });
    }
  };

  const teardown = () => {
    clearTimer();
    try {
      ws?.close();
    } catch {
      /* already gone */
    }
    ws = null;
    abort?.abort();
    abort = null;
  };

  const openWs = (conn: RealtimeConnection) => {
    let up: WebSocket;
    try {
      up = new UpstreamWS(conn.url, { headers: conn.headers, protocols: conn.protocols });
    } catch (e) {
      send({ t: 'status', state: 'error', reason: e instanceof Error ? e.message : String(e) });
      return;
    }
    ws = up;
    (up as unknown as { binaryType: string }).binaryType = 'arraybuffer';
    connectTimer = setTimeout(() => {
      if (ws === up && up.readyState !== up.OPEN) {
        send({ t: 'status', state: 'error', reason: `No response within ${CONNECT_TIMEOUT_MS / 1000}s` });
        teardown();
      }
    }, CONNECT_TIMEOUT_MS);

    up.onopen = () => {
      if (disposed) return;
      clearTimer();
      send({ t: 'status', state: 'open', protocol: up.protocol || undefined });
    };
    up.onmessage = (ev: MessageEvent) => {
      if (!disposed) forward(ev.data as string | ArrayBuffer);
    };
    up.onclose = (ev: CloseEvent) => {
      clearTimer();
      if (!disposed) send({ t: 'status', state: 'closed', code: ev.code, reason: ev.reason || undefined });
      ws = null;
    };
    up.onerror = () => {
      if (!disposed) send({ t: 'status', state: 'error', reason: 'WebSocket error' });
    };
  };

  const openSse = async (conn: RealtimeConnection) => {
    abort = new AbortController();
    let res: Response;
    try {
      res = await fetch(conn.url, {
        method: 'GET',
        headers: { Accept: 'text/event-stream', ...conn.headers },
        signal: abort.signal,
      });
    } catch (e) {
      if (!disposed) send({ t: 'status', state: 'error', reason: e instanceof Error ? e.message : String(e) });
      return;
    }
    clearTimer();
    const ct = res.headers.get('content-type') ?? '';
    if (!res.ok) {
      send({ t: 'status', state: 'error', code: res.status, reason: `HTTP ${res.status} ${res.statusText}` });
      return;
    }
    send({
      t: 'status',
      state: 'open',
      note: ct.includes('text/event-stream') ? undefined : `Server sent ${ct || 'no content-type'}, not text/event-stream — reading it as a stream anyway.`,
    });
    if (!res.body) {
      send({ t: 'status', state: 'closed', reason: 'empty body' });
      return;
    }

    // Minimal SSE parser: events are separated by a blank line; we forward the
    // joined `data:` payload of each, which is what a generic SSE client wants
    // (unlike the LLM stream reader, which extracts only the model's text).
    // `event:` and `id:` travel as their own fields so the log can badge and
    // filter on them; a block of only `:` comments is keep-alive, forwarded as
    // a heartbeat so it can be counted without cluttering the log.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.search(/\r\n\r\n|\n\n/)) !== -1) {
          const rawEvent = buf.slice(0, sep);
          buf = buf.slice(sep + (buf[sep] === '\r' ? 4 : 2));
          const dataLines: string[] = [];
          const comments: string[] = [];
          let eventName = '';
          let eventId: string | undefined;
          for (const line of rawEvent.split(/\r?\n/)) {
            if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
            else if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('id:')) eventId = line.slice(3).replace(/^ /, '');
            else if (line.startsWith(':')) comments.push(line.slice(1).replace(/^ /, ''));
          }
          if (disposed) continue;
          const at = Date.now();
          const size = Buffer.byteLength(rawEvent);
          if (dataLines.length) {
            const data = dataLines.join('\n');
            send({ t: 'message', data, at, size, event: eventName || undefined, eventId, ...llmDelta(data) });
          } else if (comments.length) {
            send({ t: 'message', data: comments.join('\n'), at, size, heartbeat: true });
          }
        }
      }
      if (!disposed) send({ t: 'status', state: 'closed', reason: 'stream ended' });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (!disposed && err.name !== 'AbortError') send({ t: 'status', state: 'error', reason: err.message });
    }
  };

  return {
    async handle(frame) {
      if (disposed) return;
      if (frame.t === 'open') {
        teardown();
        send({ t: 'status', state: 'connecting' });
        // Same var precedence as an HTTP send: active environment underneath,
        // caller-supplied overrides on top.
        const vars = { ...(await activeEnvVars()), ...(frame.vars ?? {}) };
        const conn = await buildRealtimeConnection(frame.spec, vars);
        if (disposed) return;
        if (conn.note || conn.missing.length) {
          send({ t: 'status', state: 'connecting', note: conn.note, missing: conn.missing.length ? conn.missing : undefined });
        }
        if (frame.spec.kind === 'sse') void openSse(conn);
        else openWs(conn);
        return;
      }
      if (frame.t === 'send') {
        if (ws && ws.readyState === ws.OPEN) ws.send(frame.data);
        else send({ t: 'error', message: 'Not connected' });
        return;
      }
      if (frame.t === 'close') teardown();
    },
    dispose() {
      disposed = true;
      teardown();
    },
  };
}
