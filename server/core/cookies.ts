// Cookie jar shared by the request sender.
//
// Deliberately small: enough to keep a login session alive across requests
// (the thing an API client actually needs), not a full RFC 6265 implementation.
// Persisted so a container restart doesn't log you out of whatever you were
// testing.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { ROOT_DIR } from './store.ts';

export const COOKIES_PATH = resolve(ROOT_DIR, 'cookies.json');

interface Cookie {
  value: string;
  path: string;
  /** epoch ms; undefined = session cookie */
  expires?: number;
  secure?: boolean;
}

/** domain → name → cookie */
type Jar = Record<string, Record<string, Cookie>>;

let jar: Jar | null = null;

async function load(): Promise<Jar> {
  if (jar) return jar;
  if (!existsSync(COOKIES_PATH)) {
    jar = {};
    return jar;
  }
  try {
    jar = JSON.parse(await readFile(COOKIES_PATH, 'utf8')) as Jar;
  } catch {
    jar = {};
  }
  return jar;
}

async function persist(): Promise<void> {
  if (!jar) return;
  await writeFile(COOKIES_PATH, JSON.stringify(jar, null, 2), 'utf8');
}

function domainMatch(host: string, domain: string): boolean {
  if (host === domain) return true;
  return host.endsWith(`.${domain}`);
}

function pathMatch(reqPath: string, cookiePath: string): boolean {
  if (cookiePath === '/') return true;
  return reqPath === cookiePath || reqPath.startsWith(`${cookiePath}/`);
}

/** Build the Cookie header for a URL, dropping anything expired. */
export async function cookieHeaderFor(url: URL): Promise<string> {
  const j = await load();
  const now = Date.now();
  const parts: string[] = [];
  let dirty = false;
  for (const [domain, cookies] of Object.entries(j)) {
    if (!domainMatch(url.hostname, domain)) continue;
    for (const [name, c] of Object.entries(cookies)) {
      if (c.expires && c.expires < now) {
        delete cookies[name];
        dirty = true;
        continue;
      }
      if (c.secure && url.protocol !== 'https:') continue;
      if (!pathMatch(url.pathname, c.path)) continue;
      parts.push(`${name}=${c.value}`);
    }
  }
  if (dirty) await persist();
  return parts.join('; ');
}

/** Store the Set-Cookie headers of a response. */
export async function captureSetCookies(url: URL, setCookies: string[]): Promise<void> {
  if (setCookies.length === 0) return;
  const j = await load();
  for (const raw of setCookies) {
    const [pair, ...attrs] = raw.split(';');
    const eq = pair!.indexOf('=');
    if (eq < 0) continue;
    const name = pair!.slice(0, eq).trim();
    const value = pair!.slice(eq + 1).trim();

    let domain = url.hostname;
    let path = '/';
    let expires: number | undefined;
    let secure = false;
    for (const attr of attrs) {
      const [k, v = ''] = attr.split('=');
      switch (k!.trim().toLowerCase()) {
        case 'domain':
          domain = v.trim().replace(/^\./, '') || domain;
          break;
        case 'path':
          path = v.trim() || '/';
          break;
        case 'max-age': {
          const secs = Number(v.trim());
          if (Number.isFinite(secs)) expires = Date.now() + secs * 1000;
          break;
        }
        case 'expires': {
          const t = Date.parse(v.trim());
          if (!Number.isNaN(t) && expires === undefined) expires = t;
          break;
        }
        case 'secure':
          secure = true;
          break;
      }
    }
    j[domain] ??= {};
    // Max-Age=0 / past expiry is the standard way to delete a cookie.
    if (expires !== undefined && expires <= Date.now()) delete j[domain]![name];
    else j[domain]![name] = { value, path, expires, secure };
  }
  await persist();
}

export async function listCookies(): Promise<{ domain: string; name: string; value: string }[]> {
  const j = await load();
  const out: { domain: string; name: string; value: string }[] = [];
  for (const [domain, cookies] of Object.entries(j)) {
    for (const [name, c] of Object.entries(cookies)) out.push({ domain, name, value: c.value });
  }
  return out;
}

export async function clearCookies(domain?: string): Promise<void> {
  const j = await load();
  if (domain) delete j[domain];
  else jar = {};
  await persist();
}
