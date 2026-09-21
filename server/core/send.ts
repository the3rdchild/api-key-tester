// The send pipeline: RequestSpec → HTTP request → SendResult.
//
// This is the replacement for routes/raw.ts. It runs server-side for the same
// reason that file did - the browser can't set arbitrary headers or escape
// CORS - but it adds what an actual API client needs: per-request timeout and
// redirect policy, form/multipart bodies, a cookie jar, redirect chain and
// response metrics.

import { chainLookups, fromRecord, interpolateSpec, type VarLookup } from './vars.ts';
import { cookieHeaderFor, captureSetCookies } from './cookies.ts';
import { remember, responseLookup } from './responses.ts';
import { resolveVaultAuth, type VaultAuth } from './vault-auth.ts';
import { ensureToken } from './oauth2.ts';
import { isStreaming, readStream } from './stream.ts';
import { completionMetaFromBody } from './llm-meta.ts';
import { runScript, type ScriptOutcome } from './script.ts';
import { runAssertions } from './assert.ts';
import { allRuntimeVars, runtimeLookup, setRuntimeVars } from './runtime-vars.ts';
import type {
  CompletionMeta,
  RedirectHop,
  RequestSpec,
  SendResult,
  StreamStats,
  TestResult,
} from '../../shared/collections.ts';

/** Body bytes kept in the response payload; the full size is still reported. */
const BODY_CAP = 1024 * 1024;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Types that are not text. Decoding these as UTF-8 produces line noise, and
 *  the interesting thing about a PNG is what it looks like. */
const BINARY_TYPES = /^(image|audio|video|font)\/|^application\/(pdf|octet-stream|zip|gzip|wasm)/;

function isBinary(contentType: string | null): boolean {
  if (!contentType) return false;
  return BINARY_TYPES.test(contentType.split(';')[0]!.trim().toLowerCase());
}

function toBase64(buf: ArrayBuffer): string {
  return Buffer.from(buf).toString('base64');
}

export interface SendOptions {
  /** multipart files, keyed by the field name the UI used */
  files?: Map<string, File[]>;
  /** variables to interpolate ({{…}}), usually the active environment */
  vars?: Record<string, string>;
  /** called with each piece of generated text when the response is a stream */
  onStreamChunk?: (text: string) => void;
}

/** Script-set vars → environment → chained responses → vault fields.
 *  First hit wins; a value a script just set beats a stale one in the
 *  environment, which is the whole point of writing the script. */
function buildLookup(vars: Record<string, string> | undefined, vault: VaultAuth | null): VarLookup {
  return chainLookups(
    runtimeLookup(),
    fromRecord(vars ?? {}),
    responseLookup(),
    vault ? fromRecord(vault.vars) : undefined,
  );
}

export interface SendOutcome {
  result: SendResult;
  /** exactly what went out, for the history log */
  sentHeaders: Record<string, string>;
  sentBody?: string;
  /** {{names}} that had no value */
  missing: string[];
  /** advisory from the vault (unsupported provider, freshly signed JWT, …) */
  note?: string;
  /** bru.setEnvVar writes - the caller persists them into collections.json */
  envVars?: Record<string, string>;
  /** the request never went out: OAuth2 needs a browser round-trip first */
  needsAuthorization?: boolean;
  /** the URL after interpolation and query params - what the history should show */
  sentUrl?: string;
}

/** Local names get http://, everything else https:// - typing "localhost:3000"
 *  and getting an https failure is a worse default than either guess. */
function withScheme(raw: string): string {
  const trimmed = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.startsWith('{{')) return trimmed;
  const host = trimmed.split(/[/?#]/)[0] ?? '';
  const local =
    /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(:\d+)?$/i.test(host) ||
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
    /\.local(:\d+)?$/i.test(host);
  return `${local ? 'http' : 'https'}://${trimmed}`;
}

function buildUrl(spec: RequestSpec): URL {
  const url = new URL(withScheme(spec.url));
  for (const row of spec.params) {
    if (!row.enabled || !row.key) continue;
    url.searchParams.append(row.key, row.value);
  }
  return url;
}

function applyAuth(spec: RequestSpec, headers: Headers): void {
  const auth = spec.auth;
  switch (auth.type) {
    case 'bearer':
      if (auth.token) headers.set('Authorization', `Bearer ${auth.token}`);
      break;
    case 'basic': {
      const raw = `${auth.username ?? ''}:${auth.password ?? ''}`;
      headers.set('Authorization', `Basic ${Buffer.from(raw).toString('base64')}`);
      break;
    }
    case 'header':
      if (auth.headerName) headers.set(auth.headerName, auth.headerValue ?? '');
      break;
    case 'vault':
      // Wired up in M2 together with the environment/keyRef resolution.
      break;
    case 'none':
      break;
  }
}

interface BuiltBody {
  body?: BodyInit;
  contentType?: string;
  /** what to show in history; multipart is summarised, not dumped */
  preview?: string;
  /** a body that can't be replayed on a redirect (streams/FormData) */
  replayable: boolean;
}

function buildBody(spec: RequestSpec, files?: Map<string, File[]>): BuiltBody {
  const { mode } = spec.body;
  if (mode === 'none' || spec.method === 'GET' || spec.method === 'HEAD') {
    return { replayable: true };
  }

  if (mode === 'form') {
    const params = new URLSearchParams();
    for (const row of spec.body.form ?? []) {
      if (row.enabled && row.key) params.append(row.key, row.value);
    }
    const text = params.toString();
    return {
      body: text,
      contentType: 'application/x-www-form-urlencoded',
      preview: text,
      replayable: true,
    };
  }

  if (mode === 'multipart') {
    const form = new FormData();
    const summary: string[] = [];
    for (const row of spec.body.multipart ?? []) {
      if (!row.enabled || !row.key) continue;
      if (row.type === 'text') {
        form.append(row.key, row.value ?? '');
        summary.push(`${row.key}=${row.value ?? ''}`);
      } else {
        for (const file of files?.get(row.key) ?? []) {
          form.append(row.key, file, file.name);
          summary.push(`${row.key}=@${file.name} (${file.size} B)`);
        }
      }
    }
    // Content-Type is left unset on purpose: fetch adds the multipart boundary.
    return { body: form, preview: summary.join('\n'), replayable: false };
  }

  const text = spec.body.text ?? '';
  const contentType =
    mode === 'json' ? 'application/json' : mode === 'xml' ? 'application/xml' : 'text/plain';
  return { body: text, contentType, preview: text, replayable: true };
}

export async function sendRequest(
  rawSpec: RequestSpec,
  opts: SendOptions = {},
): Promise<SendOutcome> {
  // Resolve the vault first: its non-secret fields ({{vault.baseURL}} and
  // friends) have to exist before the spec is interpolated.
  const vault =
    rawSpec.auth?.type === 'vault' && rawSpec.auth.keyId
      ? await resolveVaultAuth(rawSpec.auth.keyId)
      : null;
  const lookup = buildLookup(opts.vars, vault);
  const { spec, missing } = interpolateSpec(rawSpec, lookup);

  let url: URL;
  try {
    url = buildUrl(spec);
  } catch {
    // An unresolved {{var}} usually lands here as an invalid URL - say that
    // instead of making the user decode "Invalid URL: {{baseURL}}/auth/login".
    const why = missing.length
      ? `Undefined variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')} — set ${missing.length > 1 ? 'them' : 'it'} in the Environment panel, or chain from an earlier response.`
      : `Invalid URL: ${spec.url || '(empty)'}`;
    return { result: errorResult(why, 0), sentHeaders: {}, missing, note: vault?.note };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { result: errorResult('Only http/https URLs are allowed', 0), sentHeaders: {}, missing };
  }

  // ─── OAuth2 ───────────────────────────────────────────────────────────────
  // Resolved before anything is sent: an expired token is refreshed here, and
  // a flow that still needs the browser stops the send instead of firing off a
  // request that can only come back 401.
  let oauthHeader: string | undefined;
  if (spec.auth?.type === 'oauth2') {
    if (!spec.auth.oauth2) {
      return {
        result: errorResult('OAuth2 selected but not configured', 0),
        sentHeaders: {},
        missing,
      };
    }
    const outcome = await ensureToken(spec.auth.oauth2);
    if (outcome.problem || !outcome.token) {
      return {
        result: errorResult(`OAuth2: ${outcome.problem ?? 'no token'}`, 0),
        sentHeaders: {},
        missing,
        note: outcome.problem,
        needsAuthorization: outcome.needsAuthorization,
      };
    }
    const prefix = spec.auth.oauth2.headerPrefix || outcome.token.tokenType || 'Bearer';
    oauthHeader = `${prefix} ${outcome.token.accessToken}`;
  }

  const headers = new Headers();
  for (const row of spec.headers) {
    if (row.enabled && row.key.trim()) headers.set(row.key.trim(), row.value);
  }
  applyAuth(spec, headers);
  // Same rule as the vault: a header you wrote yourself wins.
  if (oauthHeader && !headers.has('Authorization')) headers.set('Authorization', oauthHeader);

  // Vault credentials fill in what the request didn't set explicitly - an
  // Authorization header you typed yourself always wins over the vault's.
  if (vault) {
    for (const [k, v] of Object.entries(vault.headers)) if (!headers.has(k)) headers.set(k, v);
    for (const [k, v] of Object.entries(vault.query)) {
      if (!url.searchParams.has(k)) url.searchParams.set(k, v);
    }
  }

  const built = buildBody(spec, opts.files);
  if (built.contentType && !headers.has('Content-Type')) {
    headers.set('Content-Type', built.contentType);
  }

  const settings = spec.settings ?? { timeoutMs: 30_000, followRedirects: true, maxRedirects: 5, useCookieJar: true };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), settings.timeoutMs);

  const redirects: RedirectHop[] = [];
  const setCookies: string[] = [];

  let method = spec.method.toUpperCase();
  let body = built.body;
  let current = url;

  // ─── pre-request script ───────────────────────────────────────────────────
  const logs: string[] = [];
  const tests: TestResult[] = [];
  const envWrites: Record<string, string> = {};
  let scriptError: string | undefined;

  if (spec.scripts?.pre?.trim()) {
    const pre = await runScript(spec.scripts.pre, {
      phase: 'pre',
      req: {
        method,
        url: current.toString(),
        headers: headerMap(headers),
        body: typeof body === 'string' ? body : undefined,
      },
      vars: { ...(opts.vars ?? {}), ...allRuntimeVars() },
      envVars: { ...(opts.vars ?? {}) },
    });
    collect(pre, logs, tests, envWrites);
    if (pre.error) scriptError = `pre-request: ${pre.error}`;

    // Apply what the script changed. A multipart body is not replaceable -
    // its bytes were already assembled - so req.body is ignored for it.
    if (pre.req) {
      method = (pre.req.method || method).toUpperCase();
      if (pre.req.url && pre.req.url !== current.toString()) {
        try {
          current = new URL(pre.req.url);
        } catch {
          scriptError = `pre-request: script set an invalid url (${pre.req.url})`;
        }
      }
      if (pre.req.headers) {
        for (const key of [...headers.keys()]) headers.delete(key);
        for (const [k, v] of Object.entries(pre.req.headers)) if (k) headers.set(k, v);
      }
      if (typeof pre.req.body === 'string' && typeof body === 'string') body = pre.req.body;
    }
  }

  const started = Date.now();

  try {
    for (let hop = 0; ; hop++) {
      if (settings.useCookieJar) {
        const cookie = await cookieHeaderFor(current);
        if (cookie) headers.set('Cookie', cookie);
        else headers.delete('Cookie');
      }

      const res = await fetch(current.toString(), {
        method,
        headers,
        body,
        signal: ctrl.signal,
        redirect: 'manual',
      });

      const hopCookies = readSetCookies(res.headers);
      if (hopCookies.length) {
        setCookies.push(...hopCookies);
        if (settings.useCookieJar) await captureSetCookies(current, hopCookies);
      }

      const location = res.headers.get('location');
      const isRedirect = REDIRECT_STATUSES.has(res.status) && !!location;
      if (!isRedirect || !settings.followRedirects || hop >= settings.maxRedirects) {
        const ttfbMs = Date.now() - started;

        let text: string;
        let size: number;
        let truncated: boolean;
        let stream: StreamStats | undefined;
        let streamText: string | undefined;
        let encoding: 'utf8' | 'base64' = 'utf8';
        let completion: CompletionMeta | undefined;

        if (isStreaming(res)) {
          // Read it as it arrives: the interesting numbers (TTFT, tokens/s)
          // only exist while the stream is open.
          const streamed = await readStream(res, {
            onChunk: opts.onStreamChunk,
            maxBytes: BODY_CAP,
            startedAt: started,
          });
          text = streamed.body;
          size = streamed.size;
          truncated = streamed.truncated;
          stream = streamed.stats;
          streamText = streamed.text;
          completion = streamed.completion;
        } else {
          const buf = await res.arrayBuffer();
          size = buf.byteLength;
          truncated = size > BODY_CAP;
          const kept = truncated ? buf.slice(0, BODY_CAP) : buf;
          if (isBinary(res.headers.get('content-type'))) {
            text = toBase64(kept);
            encoding = 'base64';
          } else {
            text = new TextDecoder().decode(kept);
            completion = completionMetaFromBody(text);
          }
        }

        const result: SendResult = {
          ok: res.ok,
          status: res.status,
          statusText: res.statusText,
          headers: headerMap(res.headers),
          body: text,
          truncated,
          size,
          latencyMs: Date.now() - started,
          ttfbMs,
          redirects,
          setCookies,
          stream,
          streamText,
          completion,
          bodyEncoding: encoding,
          mediaType: (res.headers.get('content-type') ?? '').split(';')[0]?.trim() || undefined,
        };
        // ─── post-response script + assertions ───────────────────────────
        if (spec.scripts?.post?.trim()) {
          const post = await runScript(spec.scripts.post, {
            phase: 'post',
            req: {
              method,
              url: current.toString(),
              headers: headerMap(headers),
              body: typeof body === 'string' ? body : undefined,
            },
            res: {
              status: result.status,
              statusText: result.statusText,
              headers: result.headers,
              body: result.body,
              json: safeJson(result.body),
              latencyMs: result.latencyMs,
              size: result.size,
              streamText: result.streamText,
              stream: result.stream,
            },
            vars: { ...(opts.vars ?? {}), ...allRuntimeVars() },
            envVars: { ...(opts.vars ?? {}) },
          });
          collect(post, logs, tests, envWrites);
          if (post.error) scriptError = `post-response: ${post.error}`;
        }

        result.tests = tests;
        result.assertions = runAssertions(spec.assertions, {
          status: result.status,
          statusText: result.statusText,
          headers: result.headers,
          body: result.body,
          latencyMs: result.latencyMs,
          size: result.size,
        });
        result.logs = logs;
        result.scriptError = scriptError;

        // Keep it around so the next request can chain off it.
        remember(rawSpec, result);
        return {
          result,
          sentHeaders: headerMap(headers),
          sentBody: built.preview,
          missing,
          note: vault?.note,
          envVars: envWrites,
          sentUrl: url.toString(),
        };
      }

      const next = new URL(location, current);
      redirects.push({ status: res.status, from: current.toString(), to: next.toString() });

      // 303, and 301/302 after a POST, turn into GET without a body - the
      // behaviour every browser implements. 307/308 keep method and body.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        headers.delete('Content-Type');
      } else if (body !== undefined && !built.replayable) {
        // FormData can't be re-sent (it was already consumed); stop here rather
        // than send a body-less request the user didn't ask for.
        throw new Error(
          `Redirect ${res.status} to ${next} needs the body re-sent, which multipart can't do. Turn off "follow redirects" and handle it manually.`,
        );
      }
      current = next;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const timedOut = ctrl.signal.aborted;
    return {
      result: errorResult(
        timedOut ? `Request timed out after ${settings.timeoutMs} ms` : msg,
        Date.now() - started,
        redirects,
      ),
      sentHeaders: headerMap(headers),
      sentBody: built.preview,
      missing,
      note: vault?.note,
      envVars: envWrites,
      sentUrl: url.toString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Fold one script run into the accumulated logs/tests/env writes. */
function collect(
  outcome: ScriptOutcome,
  logs: string[],
  tests: TestResult[],
  envWrites: Record<string, string>,
): void {
  logs.push(...outcome.logs);
  tests.push(...outcome.tests);
  Object.assign(envWrites, outcome.envVars);
  // bru.setVar values stay available to later requests in this session
  setRuntimeVars(outcome.vars);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function readSetCookies(headers: Headers): string[] {
  const anyHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === 'function') return anyHeaders.getSetCookie();
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

function headerMap(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

function errorResult(error: string, latencyMs: number, redirects: RedirectHop[] = []): SendResult {
  return {
    ok: false,
    status: 0,
    statusText: '',
    headers: {},
    body: '',
    truncated: false,
    size: 0,
    latencyMs,
    ttfbMs: latencyMs,
    redirects,
    setCookies: [],
    error,
  };
}

/** Render a request as a copy-pasteable curl command (same interpolation and
 *  auth handling as an actual send, so what you copy is what was sent). */
export async function toCurl(
  rawSpec: RequestSpec,
  vars: Record<string, string> = {},
): Promise<string> {
  const vault =
    rawSpec.auth?.type === 'vault' && rawSpec.auth.keyId
      ? await resolveVaultAuth(rawSpec.auth.keyId)
      : null;
  const { spec } = interpolateSpec(rawSpec, buildLookup(vars, vault));
  let url: string;
  try {
    url = buildUrl(spec).toString();
  } catch {
    url = spec.url;
  }
  const headers = new Headers();
  for (const row of spec.headers) {
    if (row.enabled && row.key.trim()) headers.set(row.key.trim(), row.value);
  }
  applyAuth(spec, headers);
  const built = buildBody(spec);
  if (built.contentType && !headers.has('Content-Type')) headers.set('Content-Type', built.contentType);
  if (vault) {
    for (const [k, v] of Object.entries(vault.headers)) if (!headers.has(k)) headers.set(k, v);
    if (Object.keys(vault.query).length) {
      const withQuery = new URL(url);
      for (const [k, v] of Object.entries(vault.query)) {
        if (!withQuery.searchParams.has(k)) withQuery.searchParams.set(k, v);
      }
      url = withQuery.toString();
    }
  }

  const parts = [`curl -X ${spec.method.toUpperCase()} ${quote(url)}`];
  headers.forEach((v, k) => parts.push(`  -H ${quote(`${k}: ${v}`)}`));
  if (spec.body.mode === 'multipart') {
    for (const row of spec.body.multipart ?? []) {
      if (!row.enabled || !row.key) continue;
      parts.push(
        row.type === 'file'
          ? `  -F ${quote(`${row.key}=@${row.filename ?? 'file'}`)}`
          : `  -F ${quote(`${row.key}=${row.value ?? ''}`)}`,
      );
    }
  } else if (typeof built.body === 'string' && built.body) {
    parts.push(`  --data ${quote(built.body)}`);
  }
  if (!spec.settings?.followRedirects) parts.push('  --max-redirs 0');
  else parts.push('  -L');
  return parts.join(' \\\n');
}

function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
