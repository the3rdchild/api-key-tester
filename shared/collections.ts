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
  /** json | text | xml | graphql */
  text?: string;
  /** form-urlencoded rows */
  form?: KV[];
  multipart?: MultipartRow[];
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
  /** content deltas seen - a rough token count */
  deltas: number;
  /** the stream ended cleanly (saw [DONE] or the body closed) */
  finished: boolean;
  /** time to first content token */
  ttftMs?: number;
  /** deltas per second, measured from the first delta onward */
  tokensPerSecond?: number;
}

export interface RedirectHop {
  status: number;
  from: string;
  to: string;
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
  /** time until response headers arrived */
  ttfbMs: number;
  redirects: RedirectHop[];
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

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
