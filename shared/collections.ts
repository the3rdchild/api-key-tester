// Shared types for the API-client half of the app (collections, requests,
// send results). Kept apart from types.ts — that file owns the key-vault
// domain — but with the same rule: no imports, so both UI and server can use
// it freely.

export type BodyMode = 'none' | 'json' | 'text' | 'xml' | 'graphql' | 'form' | 'multipart';

/** One editable row in a params/headers/form table. */
export interface KV {
  key: string;
  value: string;
  enabled: boolean;
}

/** A row in a multipart body. `file` rows carry no bytes here - the browser
 *  attaches the actual File to the send request (see routes/send.ts). */
export interface MultipartRow {
  key: string;
  type: 'text' | 'file';
  value?: string;
  /** display-only; the real bytes travel with the send call */
  filename?: string;
  enabled: boolean;
}

export interface RequestBody {
  mode: BodyMode;
  /** json | text | xml */
  text?: string;
  /** form-urlencoded rows */
  form?: KV[];
  multipart?: MultipartRow[];
  graphql?: GraphQLBody;
}

/** Sent as the GraphQL-over-HTTP JSON object — or as query params on a GET. */
export interface GraphQLBody {
  query: string;
  /** JSON text as typed, so a half-written object survives until it parses */
  variables?: string;
  /** which operation to run when the document holds several */
  operationName?: string;
}

export type AuthType = 'none' | 'bearer' | 'basic' | 'header' | 'vault' | 'oauth2';

export type OAuth2Grant =
  | 'client_credentials'
  | 'password'
  | 'authorization_code'
  | 'implicit'
  | 'refresh_token'
  | 'device_code';

/** How the client id/secret reach the token endpoint. */
export type ClientAuthStyle = 'body' | 'basic';

export interface OAuth2Config {
  grant: OAuth2Grant;
  /** authorization endpoint - authorization_code, implicit, device_code */
  authUrl?: string;
  /** token endpoint - everything except implicit */
  tokenUrl?: string;
  /** device authorization endpoint; defaults to authUrl for device_code */
  deviceUrl?: string;
  clientId?: string;
  clientSecret?: string;
  clientAuth?: ClientAuthStyle;
  scope?: string;
  audience?: string;
  /** password grant */
  username?: string;
  password?: string;
  /** authorization_code: PKCE is on unless explicitly disabled */
  usePkce?: boolean;
  redirectUri?: string;
  /** refresh_token grant, or a manually pasted refresh token */
  refreshToken?: string;
  /** extra token-request parameters some providers require */
  extraParams?: KV[];
  /** "Bearer" unless the provider insists otherwise */
  headerPrefix?: string;
  /** cache key; defaults to a hash of grant + endpoint + client + scope */
  tokenId?: string;
}

/** What the UI shows about a cached token - never the token itself. */
export interface TokenInfo {
  id: string;
  tokenType: string;
  /** first/last few characters only */
  preview: string;
  scope?: string;
  expiresAt?: number;
  hasRefreshToken: boolean;
  obtainedAt: number;
}

export interface RequestAuth {
  type: AuthType;
  /** bearer */
  token?: string;
  /** basic */
  username?: string;
  password?: string;
  /** custom header */
  headerName?: string;
  headerValue?: string;
  /** vault: id of a KeyEntry in store.json */
  keyId?: string;
  /** oauth2 */
  oauth2?: OAuth2Config;
}

export interface RequestSettings {
  timeoutMs: number;
  followRedirects: boolean;
  maxRedirects: number;
  /** send + capture cookies from the shared jar */
  useCookieJar: boolean;
}

export type AssertOp =
  | 'eq'
  | 'ne'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'contains'
  | 'notContains'
  | 'matches'
  | 'exists'
  | 'notExists';

export interface Assertion {
  /** status | statusText | latencyMs | size | body | headers.<name> | $.a.b.0 */
  source: string;
  op: AssertOp;
  value?: string;
  enabled?: boolean;
}

export interface AssertionResult {
  source: string;
  op: AssertOp;
  value?: string;
  actual: string;
  passed: boolean;
  error?: string;
}

/** One test() call from a script. */
export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface RequestSpec {
  id: string;
  name: string;
  method: string;
  url: string;
  params: KV[];
  headers: KV[];
  auth: RequestAuth;
  body: RequestBody;
  settings: RequestSettings;
  scripts?: { pre: string; post: string };
  assertions?: Assertion[];
  createdAt?: string;
  updatedAt?: string;
}

export interface EnvironmentDef {
  id: string;
  name: string;
  vars: KV[];
}

/** Flat tree: folders hold ids, requests live in `requests`. Flat keeps the
 *  JSON diffable and the move/rename operations trivial. */
export interface TreeNode {
  id: string;
  type: 'folder' | 'request';
  /** folders only */
  name?: string;
  children?: string[];
  collapsed?: boolean;
}

export interface CollectionsFile {
  version: 1;
  activeEnvId: string | null;
  environments: EnvironmentDef[];
  /** top-level order; folder nodes reference their children by id */
  tree: TreeNode[];
  requests: Record<string, RequestSpec>;
}

/** Measurements that only mean something for a streamed response. */
export interface StreamStats {
  /** transport chunks read off the socket */
  chunks: number;
  /** SSE events that carried text - NOT a token count: providers batch
   *  several tokens into one event */
  deltas: number;
  /** real completion tokens, when the stream reports usage */
  tokens?: number;
  /** whether the rate below counts tokens or merely SSE events */
  rateBasis?: 'tokens' | 'events';
  /** the stream ended cleanly (saw [DONE] or the body closed) */
  finished: boolean;
  /** time to first content token */
  ttftMs?: number;
  /** deltas per second, measured from the first delta onward */
  tokensPerSecond?: number;
}

/** What an LLM response says about itself. Read from the body (or the final
 *  SSE frame) so the pane can explain a half-finished answer instead of
 *  leaving you to wonder whether the connection dropped. */
export interface CompletionMeta {
  model?: string;
  /** "stop" = the model finished; "length" = it hit max_tokens; … */
  finishReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** provider-reported cost, when there is one (OpenRouter sends this) */
  cost?: number;
}

export interface RedirectHop {
  status: number;
  from: string;
  to: string;
  /** the method this hop went out with (a 303 turns the next one into GET) */
  method?: string;
  /** when this hop went out, in ms after the request started */
  startMs?: number;
  /** from sending this hop to its response */
  ms?: number;
  /** credentials not carried to `to`, because it is on another origin */
  dropped?: string[];
}

export interface SendResult {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** may be truncated - see `truncated` / `size` */
  body: string;
  truncated: boolean;
  /** full body size in bytes, before truncation */
  size: number;
  latencyMs: number;
  /** time until response headers arrived, redirects included */
  ttfbMs: number;
  redirects: RedirectHop[];
  /** ms spent following redirects before the final request went out */
  redirectMs?: number;
  setCookies: string[];
  /** set when the request never completed (timeout, DNS, TLS, …) */
  error?: string;
  /** test() calls from the post-response script */
  tests?: TestResult[];
  /** declarative assertions from the Tests tab */
  assertions?: AssertionResult[];
  /** console.log output from both script phases */
  logs?: string[];
  /** a script threw or timed out (distinct from a failing test) */
  scriptError?: string;
  /** parsed from an LLM response: token counts, cost, and why it stopped */
  completion?: CompletionMeta;
  /** 'base64' when the body is binary; the UI previews it instead of printing it */
  bodyEncoding?: 'utf8' | 'base64';
  /** content type without parameters, e.g. "image/png" */
  mediaType?: string;
  /** present when the response was an event stream */
  stream?: StreamStats;
  /** the generated text with SSE framing stripped */
  streamText?: string;
}

export interface RunCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface RunItemResult {
  requestId: string;
  name: string;
  method: string;
  url: string;
  status?: number;
  latencyMs?: number;
  error?: string;
  checks: RunCheck[];
  passed: boolean;
  skipped?: boolean;
  /** what went out and what came back (secrets redacted, body capped) */
  detail?: Omit<HistoryDetail, 'entry'>;
}

export interface RunSummary {
  id: string;
  startedAt: string;
  finishedAt?: string;
  /** what was run: a folder name, "whole collection", … */
  label: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  cancelled?: boolean;
  items: RunItemResult[];
}

/** One cell of a matrix run: this request, against this key/model. */
export interface MatrixTarget {
  label?: string;
  /** vault key to authenticate with */
  keyId?: string;
  /** becomes {{model}} for this cell */
  model?: string;
  /** becomes {{baseURL}} for this cell */
  baseURL?: string;
}

export interface MatrixItem {
  /** within its run; the whole response is fetched by it for a compare.
   *  Absent when the cell never got a response to keep. */
  id?: string;
  label: string;
  keyId?: string;
  model?: string;
  status?: number;
  ok: boolean;
  latencyMs?: number;
  ttftMs?: number;
  tokensPerSecond?: number;
  size?: number;
  error?: string;
  /** first part of the answer, so the table shows something readable */
  preview?: string;
}

export interface MatrixSummary {
  id: string;
  startedAt: string;
  finishedAt?: string;
  requestName: string;
  total: number;
  items: MatrixItem[];
}

export interface ReqHistoryEntry {
  id: string;
  /** the saved request this came from, when it had one */
  requestId?: string;
  ts: string;
  name?: string;
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  latencyMs?: number;
  size?: number;
  error?: string;
  /** redacted snapshot - enough to replay, never enough to leak a token */
  request: { headers: Record<string, string>; bodyPreview?: string };
  responsePreview?: string;
  /** how the tests/assertions went, when the request had any */
  checks?: { passed: number; total: number };
  /** pinned entries are never evicted when the log is trimmed */
  pinned?: boolean;
  /** set for a WebSocket / SSE session; absent for an HTTP request */
  kind?: RealtimeKind;
  realtime?: RealtimeSummary;
}

/** What a realtime session amounted to. Written when it connects (or fails
 *  to) and rewritten when it ends. */
export interface RealtimeSummary {
  /** absent while the session is still open */
  durationMs?: number;
  sent: number;
  sentBytes: number;
  received: number;
  receivedBytes: number;
  closeCode?: number;
  closeReason?: string;
  /** connects in this session — more than one means it reconnected */
  attempts: number;
}

/** A realtime history entry's stored session: the spec to reopen it with and
 *  the tail of what went back and forth. Secrets redacted, like HTTP. */
export interface RealtimeHistoryDetail {
  entry: ReqHistoryEntry;
  spec: RealtimeSpec;
  request: { url: string; headers: Record<string, string> };
  transcript: RealtimeMessage[];
  /** sse: the LLM completion stitched from its deltas */
  streamText?: string;
}

/** A history entry with the response body kept alongside it. */
export interface HistoryDetail {
  entry: ReqHistoryEntry;
  /** the request as it went out (secrets redacted) */
  request: { method: string; url: string; headers: Record<string, string>; body?: string };
  result: SendResult;
}

export const DEFAULT_SETTINGS: RequestSettings = {
  timeoutMs: 30_000,
  followRedirects: true,
  maxRedirects: 5,
  useCookieJar: true,
};

export function emptyRequest(id: string, name = 'Untitled request'): RequestSpec {
  return {
    id,
    name,
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    auth: { type: 'none' },
    body: { mode: 'none' },
    settings: { ...DEFAULT_SETTINGS },
  };
}

// ─── Realtime (WebSocket / SSE) ───────────────────────────────────────────────
// A second kind of tab: instead of one request → one response, a realtime tab
// holds a long-lived connection and a running log of frames. The connection is
// made server-side (like every send) so it reuses vault auth, {{vars}} and
// arbitrary headers — none of which the browser's own WebSocket/EventSource can
// set. `ws` sends and receives; `sse` is receive-only (an HTTP GET stream).

export type RealtimeKind = 'ws' | 'sse';

export interface RealtimeSpec {
  id: string;
  name: string;
  kind: RealtimeKind;
  url: string;
  /** Sec-WebSocket-Protocol values offered on connect; ignored for SSE. */
  protocols: string[];
  headers: KV[];
  auth: RequestAuth;
  /** the message currently typed in the composer (ws only), kept so a reload
   *  or tab switch doesn't lose it */
  draft?: string;
  /** reconnect after a close nobody asked for, backing off between tries */
  autoReconnect?: boolean;
  /** ws only: an application-level keep-alive sent while connected */
  heartbeat?: RealtimeHeartbeat;
}

export interface RealtimeHeartbeat {
  enabled: boolean;
  intervalSec: number;
  payload: string;
}

export function emptyRealtime(id: string, kind: RealtimeKind = 'ws'): RealtimeSpec {
  return {
    id,
    name: '',
    kind,
    url: '',
    protocols: [],
    headers: [],
    auth: { type: 'none' },
    draft: '',
  };
}

/**
 * What a log line is — also exactly what the log's filter chips select on.
 * `info`/`error` are keyway's own lines (connected, closed, bad URL, …);
 * `heartbeat` is keep-alive traffic (SSE `:` comments) that would otherwise
 * drown the real messages.
 */
export type RealtimeMessageType = 'send' | 'receive' | 'info' | 'error' | 'heartbeat';

/** A close that was meant — normal, going away, no status given — as opposed
 *  to 1006 abnormal, 1011 server error or an app's own 4xxx code. */
export function isCleanClose(code?: number): boolean {
  return code == null || code === 1000 || code === 1001 || code === 1005;
}

/** One line in a realtime session log. */
export interface RealtimeMessage {
  id: string;
  type: RealtimeMessageType;
  /** epoch ms */
  at: number;
  data: string;
  /** bytes on the wire, for send/receive/heartbeat — before any truncation */
  size?: number;
  /** receive only: the frame was binary and `data` is its base64 */
  binary?: boolean;
  /** receive only: the frame was larger than the proxy forwards, `data` is its head */
  truncated?: boolean;
  /** sse only: the event's `event:` name (absent means the default "message") */
  event?: string;
  /** sse only: the event's `id:` */
  eventId?: string;
  /** sse only: the LLM text this event carries, when it's a completion chunk */
  delta?: string;
}

/** Frames the browser sends up the proxy socket. */
export type RealtimeClientFrame =
  | {
      t: 'open';
      spec: RealtimeSpec;
      vars?: Record<string, string>;
      /** sse reconnect: the last event id seen, sent as Last-Event-ID */
      lastEventId?: string;
      /** one per Connect click, reused by its reconnects — history keeps one
       *  entry per session, not one per attempt */
      sessionId?: string;
    }
  | { t: 'send'; data: string; heartbeat?: boolean }
  | { t: 'close' };

/** Frames the server pushes back down the proxy socket. */
export type RealtimeServerFrame =
  | {
      t: 'status';
      state: 'connecting' | 'open' | 'closed' | 'error';
      code?: number;
      reason?: string;
      protocol?: string;
      /** advisory (vault note, unsupported auth, resolved URL, …) */
      note?: string;
      /** {{vars}} referenced but not defined, echoed once on connect */
      missing?: string[];
    }
  | {
      t: 'message';
      data: string;
      at: number;
      size: number;
      binary?: boolean;
      truncated?: boolean;
      /** sse: a `:` comment block, i.e. keep-alive rather than an event */
      heartbeat?: boolean;
      event?: string;
      eventId?: string;
      /** sse: the text this event adds to an LLM completion */
      delta?: string;
      /** sse: completion tokens the stream reported so far */
      tokens?: number;
    }
  | { t: 'error'; message: string }
  /** sse: the stream's `retry:` field — how long to wait before reconnecting */
  | { t: 'retry'; ms: number };

/** The everyday verbs — anything outside this set gets a gentle "unusual method" hint. */
export const STANDARD_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/**
 * Preset verbs offered in the method dropdown. The field itself is a free-text
 * combobox, so any custom verb still works — this list is only the suggestions.
 * Beyond the standard eight: TRACE/CONNECT (RFC 9110), QUERY (draft, safe body),
 * PURGE (cache invalidation) and the WebDAV verbs from RFC 4918.
 */
export const METHODS = [
  ...STANDARD_METHODS,
  'TRACE',
  'CONNECT',
  'QUERY',
  'PURGE',
  'PROPFIND',
  'PROPPATCH',
  'MKCOL',
  'COPY',
  'MOVE',
  'LOCK',
  'UNLOCK',
] as const;
