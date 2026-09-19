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
import type { RedirectHop, RequestSpec, SendResult } from '../../shared/collections.ts';

/** Body bytes kept in the response payload; the full size is still reported. */
const BODY_CAP = 1024 * 1024;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface SendOptions {
  /** multipart files, keyed by the field name the UI used */
  files?: Map<string, File[]>;
  /** variables to interpolate ({{…}}), usually the active environment */
  vars?: Record<string, string>;
}

/** env/runtime vars → chained responses → vault fields. First hit wins. */
function buildLookup(vars: Record<string, string> | undefined, vault: VaultAuth | null): VarLookup {
  return chainLookups(
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
}

function buildUrl(spec: RequestSpec): URL {
  const url = new URL(spec.url);
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

  const headers = new Headers();
  for (const row of spec.headers) {
    if (row.enabled && row.key.trim()) headers.set(row.key.trim(), row.value);
  }
  applyAuth(spec, headers);

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
  const started = Date.now();

  let method = spec.method.toUpperCase();
  let body = built.body;
  let current = url;

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
        const buf = await res.arrayBuffer();
        const size = buf.byteLength;
        const truncated = size > BODY_CAP;
        const text = new TextDecoder().decode(truncated ? buf.slice(0, BODY_CAP) : buf);
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
        };
        // Keep it around so the next request can chain off it.
        remember(rawSpec, result);
        return {
          result,
          sentHeaders: headerMap(headers),
          sentBody: built.preview,
          missing,
          note: vault?.note,
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
    };
  } finally {
    clearTimeout(timer);
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
