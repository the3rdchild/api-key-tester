// OAuth2: the grants, the token cache, and the bits of the dance that need a
// browser.
//
// Tokens live in oauth-tokens.json next to cookies.json - runtime artifacts,
// not configuration. collections.json keeps the *configuration* (endpoints,
// client id, scope) and never the token, so a collection stays safe to share.
//
// A token is refreshed automatically when it is within REFRESH_MARGIN_MS of
// expiring: with a refresh_token if the provider gave one, otherwise by
// re-running the grant when the grant allows it (client_credentials, password).

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { nanoid } from 'nanoid';

import { ROOT_DIR } from './store.ts';
import type { KV, OAuth2Config, TokenInfo } from '../../shared/collections.ts';

export const TOKENS_PATH = resolve(ROOT_DIR, 'oauth-tokens.json');

/** Refresh this long before the provider's own expiry. */
const REFRESH_MARGIN_MS = 60_000;
/** An authorization that is never completed shouldn't linger forever. */
const PENDING_TTL_MS = 10 * 60_000;
const TOKEN_TIMEOUT_MS = 20_000;

export const DEFAULT_REDIRECT_URI = `http://127.0.0.1:${process.env.PORT ?? 8788}/oauth/callback`;

export interface StoredToken {
  id: string;
  accessToken: string;
  tokenType: string;
  refreshToken?: string;
  /** epoch ms */
  expiresAt?: number;
  scope?: string;
  obtainedAt: number;
}

type TokenFile = Record<string, StoredToken>;

let tokens: TokenFile | null = null;
let changeEmitter: ((id: string) => void) | null = null;

export function setTokenChangeEmitter(fn: (id: string) => void): void {
  changeEmitter = fn;
}

async function load(): Promise<TokenFile> {
  if (tokens) return tokens;
  if (!existsSync(TOKENS_PATH)) {
    tokens = {};
    return tokens;
  }
  try {
    tokens = JSON.parse(await readFile(TOKENS_PATH, 'utf8')) as TokenFile;
  } catch {
    tokens = {};
  }
  return tokens;
}

async function persist(): Promise<void> {
  if (!tokens) return;
  await writeFile(TOKENS_PATH, JSON.stringify(tokens, null, 2), 'utf8');
}

// ─── identity ───────────────────────────────────────────────────────────────

/** Stable cache key so two requests sharing a client share the token. */
export function tokenIdFor(cfg: OAuth2Config): string {
  if (cfg.tokenId) return cfg.tokenId;
  const parts = [
    cfg.grant,
    cfg.tokenUrl ?? cfg.authUrl ?? '',
    cfg.clientId ?? '',
    cfg.scope ?? '',
    cfg.username ?? '',
  ].join('|');
  // djb2 - short, stable, and this is a cache key, not a secret
  let hash = 5381;
  for (let i = 0; i < parts.length; i++) hash = ((hash << 5) + hash + parts.charCodeAt(i)) | 0;
  return `oauth_${(hash >>> 0).toString(36)}`;
}

export function describe(token: StoredToken): TokenInfo {
  const t = token.accessToken;
  return {
    id: token.id,
    tokenType: token.tokenType,
    // Enough to tell two tokens apart at a glance (did the refresh actually
    // happen?) without putting a usable secret on screen.
    preview: t.length > 8 ? `${t.slice(0, 4)}…${t.slice(-4)}` : '••••',
    scope: token.scope,
    expiresAt: token.expiresAt,
    hasRefreshToken: !!token.refreshToken,
    obtainedAt: token.obtainedAt,
  };
}

export async function listTokens(): Promise<TokenInfo[]> {
  const file = await load();
  return Object.values(file).map(describe);
}

export async function getStoredToken(id: string): Promise<StoredToken | undefined> {
  return (await load())[id];
}

export async function clearToken(id: string): Promise<void> {
  const file = await load();
  delete file[id];
  await persist();
  changeEmitter?.(id);
}

async function save(token: StoredToken): Promise<StoredToken> {
  const file = await load();
  file[token.id] = token;
  await persist();
  changeEmitter?.(token.id);
  return token;
}

// ─── PKCE ───────────────────────────────────────────────────────────────────

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function makeVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

// ─── token endpoint ─────────────────────────────────────────────────────────

function extra(params: KV[] | undefined, body: URLSearchParams): void {
  for (const row of params ?? []) {
    if (row.enabled !== false && row.key) body.set(row.key, row.value);
  }
}

function applyClientAuth(cfg: OAuth2Config, headers: Headers, body: URLSearchParams): void {
  const id = cfg.clientId ?? '';
  const secret = cfg.clientSecret ?? '';
  if (cfg.clientAuth === 'basic') {
    headers.set('Authorization', `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`);
    return;
  }
  if (id) body.set('client_id', id);
  if (secret) body.set('client_secret', secret);
}

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number | string;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

/** Providers are inconsistent: JSON is the norm, form-encoded still happens. */
function parseTokenBody(text: string, contentType: string | null): TokenResponse {
  if (contentType?.includes('json') || text.trim().startsWith('{')) {
    try {
      return JSON.parse(text) as TokenResponse;
    } catch {
      /* fall through to form parsing */
    }
  }
  const params = new URLSearchParams(text);
  const out: TokenResponse = {};
  for (const [k, v] of params.entries()) (out as Record<string, string>)[k] = v;
  return out;
}

async function postToken(cfg: OAuth2Config, body: URLSearchParams): Promise<StoredToken> {
  if (!cfg.tokenUrl) throw new Error('No token URL configured');
  const headers = new Headers({
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  });
  applyClientAuth(cfg, headers, body);
  extra(cfg.extraParams, body);
  if (cfg.scope) body.set('scope', cfg.scope);
  if (cfg.audience) body.set('audience', cfg.audience);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TOKEN_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers,
      body: body.toString(),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(
      ctrl.signal.aborted
        ? `Token endpoint timed out after ${TOKEN_TIMEOUT_MS} ms`
        : `Token request failed: ${e instanceof Error ? e.message : e}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  const parsed = parseTokenBody(text, res.headers.get('content-type'));
  if (!res.ok || parsed.error || !parsed.access_token) {
    const detail = parsed.error_description || parsed.error || text.slice(0, 300);
    throw new Error(`Token endpoint said ${res.status}: ${detail || res.statusText}`);
  }

  const expiresIn = Number(parsed.expires_in);
  return {
    id: tokenIdFor(cfg),
    accessToken: parsed.access_token,
    tokenType: parsed.token_type || 'Bearer',
    refreshToken: parsed.refresh_token,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
    scope: parsed.scope,
    obtainedAt: Date.now(),
  };
}

// ─── grants that need no browser ────────────────────────────────────────────

export async function runGrant(cfg: OAuth2Config): Promise<StoredToken> {
  switch (cfg.grant) {
    case 'client_credentials':
      return save(await postToken(cfg, new URLSearchParams({ grant_type: 'client_credentials' })));

    case 'password':
      return save(
        await postToken(
          cfg,
          new URLSearchParams({
            grant_type: 'password',
            username: cfg.username ?? '',
            password: cfg.password ?? '',
          }),
        ),
      );

    case 'refresh_token': {
      const seed = cfg.refreshToken || (await getStoredToken(tokenIdFor(cfg)))?.refreshToken;
      if (!seed) throw new Error('No refresh token available');
      return save(await refreshWith(cfg, seed));
    }

    default:
      throw new Error(`Grant "${cfg.grant}" needs the browser step - start it from the Auth tab`);
  }
}

async function refreshWith(cfg: OAuth2Config, refreshToken: string): Promise<StoredToken> {
  const fresh = await postToken(
    cfg,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  );
  // Providers may omit the refresh token on refresh - keep the old one.
  return { ...fresh, refreshToken: fresh.refreshToken ?? refreshToken };
}

// ─── the browser dance ──────────────────────────────────────────────────────

interface Pending {
  state: string;
  cfg: OAuth2Config;
  verifier?: string;
  createdAt: number;
}

const pending = new Map<string, Pending>();

function sweepPending(): void {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [state, p] of pending) if (p.createdAt < cutoff) pending.delete(state);
}

export async function startAuthorization(
  cfg: OAuth2Config,
): Promise<{ authorizeUrl: string; state: string }> {
  sweepPending();
  if (!cfg.authUrl) throw new Error('No authorization URL configured');
  const state = nanoid(16);
  const url = new URL(cfg.authUrl);
  const redirectUri = cfg.redirectUri || DEFAULT_REDIRECT_URI;

  url.searchParams.set('response_type', cfg.grant === 'implicit' ? 'token' : 'code');
  url.searchParams.set('client_id', cfg.clientId ?? '');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  if (cfg.scope) url.searchParams.set('scope', cfg.scope);
  if (cfg.audience) url.searchParams.set('audience', cfg.audience);
  for (const row of cfg.extraParams ?? []) {
    if (row.enabled !== false && row.key) url.searchParams.set(row.key, row.value);
  }

  let verifier: string | undefined;
  if (cfg.grant === 'authorization_code' && cfg.usePkce !== false) {
    verifier = makeVerifier();
    url.searchParams.set('code_challenge', await challengeFor(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
  }

  pending.set(state, { state, cfg, verifier, createdAt: Date.now() });
  return { authorizeUrl: url.toString(), state };
}

/** Exchange the ?code= from the redirect for a token. */
export async function completeAuthorization(
  state: string,
  code: string,
): Promise<StoredToken> {
  const p = pending.get(state);
  if (!p) throw new Error('Unknown or expired authorization state - start the flow again');
  pending.delete(state);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: p.cfg.redirectUri || DEFAULT_REDIRECT_URI,
  });
  if (p.verifier) body.set('code_verifier', p.verifier);
  return save(await postToken(p.cfg, body));
}

/** Implicit grant: the token arrives in the URL fragment, not as a code. */
export async function completeImplicit(
  state: string,
  params: Record<string, string>,
): Promise<StoredToken> {
  const p = pending.get(state);
  if (!p) throw new Error('Unknown or expired authorization state - start the flow again');
  pending.delete(state);
  if (!params.access_token) throw new Error('No access_token in the redirect fragment');

  const expiresIn = Number(params.expires_in);
  return save({
    id: tokenIdFor(p.cfg),
    accessToken: params.access_token,
    tokenType: params.token_type || 'Bearer',
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
    scope: params.scope,
    obtainedAt: Date.now(),
  });
}

// ─── device code ────────────────────────────────────────────────────────────

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  interval: number;
  expiresIn: number;
}

export async function startDeviceFlow(cfg: OAuth2Config): Promise<DeviceStart> {
  const endpoint = cfg.deviceUrl || cfg.authUrl;
  if (!endpoint) throw new Error('No device authorization URL configured');
  const body = new URLSearchParams();
  const headers = new Headers({
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  });
  applyClientAuth(cfg, headers, body);
  if (cfg.scope) body.set('scope', cfg.scope);

  const res = await fetch(endpoint, { method: 'POST', headers, body: body.toString() });
  const text = await res.text();
  const parsed = parseTokenBody(text, res.headers.get('content-type')) as TokenResponse &
    Record<string, string | number>;
  if (!res.ok || !parsed.device_code) {
    throw new Error(`Device authorization failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return {
    deviceCode: String(parsed.device_code),
    userCode: String(parsed.user_code ?? ''),
    verificationUri: String(parsed.verification_uri ?? parsed.verification_url ?? ''),
    verificationUriComplete: parsed.verification_uri_complete
      ? String(parsed.verification_uri_complete)
      : undefined,
    interval: Number(parsed.interval ?? 5),
    expiresIn: Number(parsed.expires_in ?? 600),
  };
}

/** One poll of the device token endpoint. Returns null while still pending. */
export async function pollDeviceToken(
  cfg: OAuth2Config,
  deviceCode: string,
): Promise<StoredToken | null> {
  try {
    return await save(
      await postToken(
        cfg,
        new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
        }),
      ),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/authorization_pending|slow_down/.test(msg)) return null;
    throw e;
  }
}

// ─── what the sender calls ──────────────────────────────────────────────────

export interface EnsureResult {
  token?: StoredToken;
  /** set when the caller must do something (authorize, configure) */
  problem?: string;
  /** true when a browser round-trip is the only way forward */
  needsAuthorization?: boolean;
}

export async function ensureToken(cfg: OAuth2Config): Promise<EnsureResult> {
  const id = tokenIdFor(cfg);
  const existing = await getStoredToken(id);

  const stillGood =
    existing && (!existing.expiresAt || existing.expiresAt - Date.now() > REFRESH_MARGIN_MS);
  if (stillGood) return { token: existing };

  // Expiring or expired: refresh if we can.
  const refreshToken = existing?.refreshToken || cfg.refreshToken;
  if (refreshToken && cfg.tokenUrl) {
    try {
      return { token: await save(await refreshWith(cfg, refreshToken)) };
    } catch (e) {
      // fall through - a dead refresh token means starting over
      if (cfg.grant === 'authorization_code' || cfg.grant === 'implicit') {
        return {
          problem: `Refresh failed: ${e instanceof Error ? e.message : e}`,
          needsAuthorization: true,
        };
      }
    }
  }

  if (cfg.grant === 'client_credentials' || cfg.grant === 'password' || cfg.grant === 'refresh_token') {
    try {
      return { token: await runGrant(cfg) };
    } catch (e) {
      return { problem: e instanceof Error ? e.message : String(e) };
    }
  }

  return {
    problem: existing
      ? 'The token expired and could not be refreshed - authorize again.'
      : 'No token yet - click Authorize in the Auth tab.',
    needsAuthorization: true,
  };
}
