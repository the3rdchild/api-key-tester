// Postman collection v2.0/v2.1 and environment exports.
//
// What carries over cleanly: folders, methods, URLs (with query params split
// out), headers, every body mode Postman has, and its auth types. What does
// not: scripts. Postman scripts speak `pm.*` against Postman's own runtime, so
// the common calls are rewritten mechanically and anything left is flagged
// rather than silently shipped as code that cannot run.

import { nanoid } from 'nanoid';

import { DEFAULT_SETTINGS, emptyRequest } from '../../../shared/collections.ts';
import type {
  EnvironmentDef,
  KV,
  MultipartRow,
  RequestAuth,
  RequestSpec,
} from '../../../shared/collections.ts';
import { emptyImport, type ImportedCollection, type ImportedFolder } from './types.ts';

interface PostmanItem {
  name?: string;
  item?: PostmanItem[];
  request?: PostmanRequest | string;
  event?: { listen?: string; script?: { exec?: string[] | string } }[];
}

interface PostmanRequest {
  method?: string;
  url?: string | { raw?: string; host?: string[]; path?: string[] | string; query?: any[]; protocol?: string };
  header?: { key?: string; value?: string; disabled?: boolean }[] | string;
  body?: any;
  auth?: any;
  description?: string;
}

export function isPostmanCollection(doc: any): boolean {
  return !!doc?.info?.schema?.includes?.('getpostman.com/json/collection');
}

export function isPostmanEnvironment(doc: any): boolean {
  return doc?._postman_variable_scope === 'environment' || (!!doc?.values && !!doc?.name && !doc?.info);
}

/** Postman writes {{var}} too, so variables survive untouched. */
function urlOf(url: PostmanRequest['url']): { url: string; params: KV[] } {
  if (!url) return { url: '', params: [] };
  if (typeof url === 'string') return splitQuery(url);

  if (url.raw) {
    const split = splitQuery(url.raw);
    // Postman's structured query is richer (it keeps disabled rows), prefer it.
    if (Array.isArray(url.query) && url.query.length) {
      return {
        url: split.url,
        params: url.query.map((q: any) => ({
          key: String(q.key ?? ''),
          value: String(q.value ?? ''),
          enabled: q.disabled !== true,
        })),
      };
    }
    return split;
  }

  const host = Array.isArray(url.host) ? url.host.join('.') : (url.host ?? '');
  const path = Array.isArray(url.path) ? url.path.join('/') : (url.path ?? '');
  const proto = url.protocol ? `${url.protocol}://` : '';
  return {
    url: `${proto}${host}${path ? `/${path}` : ''}`,
    params: (url.query ?? []).map((q: any) => ({
      key: String(q.key ?? ''),
      value: String(q.value ?? ''),
      enabled: q.disabled !== true,
    })),
  };
}

function splitQuery(raw: string): { url: string; params: KV[] } {
  const i = raw.indexOf('?');
  if (i < 0) return { url: raw, params: [] };
  const params: KV[] = [];
  for (const pair of raw.slice(i + 1).split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    params.push({
      key: decodeURIComponent(eq < 0 ? pair : pair.slice(0, eq)),
      value: eq < 0 ? '' : decodeURIComponent(pair.slice(eq + 1)),
      enabled: true,
    });
  }
  return { url: raw.slice(0, i), params };
}

function headersOf(header: PostmanRequest['header']): KV[] {
  if (!header || typeof header === 'string') return [];
  return header.map((h) => ({
    key: String(h.key ?? ''),
    value: String(h.value ?? ''),
    enabled: h.disabled !== true,
  }));
}

function bodyOf(body: any, warnings: string[], name: string): RequestSpec['body'] {
  if (!body || !body.mode) return { mode: 'none' };
  switch (body.mode) {
    case 'raw': {
      const language = body.options?.raw?.language;
      const text = String(body.raw ?? '');
      const mode = language === 'xml' ? 'xml' : language === 'json' || text.trim().startsWith('{') || text.trim().startsWith('[') ? 'json' : 'text';
      return { mode, text };
    }
    case 'urlencoded':
      return {
        mode: 'form',
        form: (body.urlencoded ?? []).map((row: any) => ({
          key: String(row.key ?? ''),
          value: String(row.value ?? ''),
          enabled: row.disabled !== true,
        })),
      };
    case 'formdata': {
      const rows: MultipartRow[] = (body.formdata ?? []).map((row: any) => ({
        key: String(row.key ?? ''),
        type: row.type === 'file' ? 'file' : 'text',
        value: row.type === 'file' ? undefined : String(row.value ?? ''),
        filename: row.type === 'file' ? String(row.src ?? '') : undefined,
        enabled: row.disabled !== true,
      }));
      if (rows.some((r) => r.type === 'file')) {
        warnings.push(`"${name}": file fields kept, but the files themselves need re-picking.`);
      }
      return { mode: 'multipart', multipart: rows };
    }
    case 'graphql':
      return {
        mode: 'json',
        text: JSON.stringify(
          { query: body.graphql?.query ?? '', variables: safeParse(body.graphql?.variables) },
          null,
          2,
        ),
      };
    case 'file':
      warnings.push(`"${name}": a binary file body was dropped - re-attach it in the Body tab.`);
      return { mode: 'none' };
    default:
      return { mode: 'none' };
  }
}

function safeParse(text: unknown): unknown {
  if (typeof text !== 'string' || !text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function authOf(auth: any, warnings: string[], name: string): RequestAuth {
  if (!auth?.type || auth.type === 'noauth') return { type: 'none' };
  const list = (auth[auth.type] ?? []) as { key?: string; value?: any }[];
  const pick = (key: string): string => {
    const hit = Array.isArray(list) ? list.find((e) => e.key === key) : undefined;
    return hit?.value === undefined ? '' : String(hit.value);
  };

  switch (auth.type) {
    case 'bearer':
      return { type: 'bearer', token: pick('token') };
    case 'basic':
      return { type: 'basic', username: pick('username'), password: pick('password') };
    case 'apikey': {
      const where = pick('in') || 'header';
      if (where !== 'header') {
        warnings.push(`"${name}": API key in "${where}" became a header - move it if that is wrong.`);
      }
      return { type: 'header', headerName: pick('key') || 'x-api-key', headerValue: pick('value') };
    }
    case 'oauth2': {
      const grant = pick('grant_type');
      return {
        type: 'oauth2',
        oauth2: {
          grant:
            grant === 'password_credentials'
              ? 'password'
              : grant === 'client_credentials'
                ? 'client_credentials'
                : grant === 'implicit'
                  ? 'implicit'
                  : 'authorization_code',
          authUrl: pick('authUrl') || undefined,
          tokenUrl: pick('accessTokenUrl') || undefined,
          clientId: pick('clientId') || undefined,
          clientSecret: pick('clientSecret') || undefined,
          scope: pick('scope') || undefined,
          username: pick('username') || undefined,
          password: pick('password') || undefined,
          clientAuth: pick('client_authentication') === 'body' ? 'body' : 'basic',
          usePkce: true,
        },
      };
    }
    default:
      warnings.push(`"${name}": auth type "${auth.type}" is not supported and was left as no-auth.`);
      return { type: 'none' };
  }
}

/** Rewrite the pm.* calls that map cleanly; flag whatever is left. */
export function translateScript(code: string, name: string, warnings: string[]): string {
  if (!code.trim()) return '';
  let out = code
    .replace(/pm\.environment\.set\(/g, 'bru.setEnvVar(')
    .replace(/pm\.environment\.get\(/g, 'bru.getEnvVar(')
    .replace(/pm\.collectionVariables\.set\(/g, 'bru.setVar(')
    .replace(/pm\.collectionVariables\.get\(/g, 'bru.getVar(')
    .replace(/pm\.variables\.set\(/g, 'bru.setVar(')
    .replace(/pm\.variables\.get\(/g, 'bru.getVar(')
    .replace(/pm\.globals\.set\(/g, 'bru.setVar(')
    .replace(/pm\.globals\.get\(/g, 'bru.getVar(')
    .replace(/pm\.response\.json\(\)/g, 'res.json')
    .replace(/pm\.response\.text\(\)/g, 'res.body')
    .replace(/pm\.response\.code/g, 'res.status')
    .replace(/pm\.response\.responseTime/g, 'res.latencyMs')
    .replace(/pm\.request\.url\.toString\(\)/g, 'req.url')
    .replace(/pm\.test\(/g, 'test(')
    .replace(/pm\.expect\(/g, 'expect(');

  if (/\bpm\./.test(out)) {
    warnings.push(`"${name}": script still uses pm.* calls that have no equivalent - review it.`);
    out = `// Imported from Postman. Lines using pm.* below need a rewrite.\n${out}`;
  }
  return out;
}

function scriptsOf(
  events: PostmanItem['event'],
  name: string,
  warnings: string[],
): RequestSpec['scripts'] | undefined {
  if (!events?.length) return undefined;
  const grab = (listen: string) => {
    const hit = events.find((e) => e.listen === listen);
    const exec = hit?.script?.exec;
    return Array.isArray(exec) ? exec.join('\n') : (exec ?? '');
  };
  const pre = translateScript(grab('prerequest'), name, warnings);
  const post = translateScript(grab('test'), name, warnings);
  if (!pre && !post) return undefined;
  return { pre, post };
}

function requestOf(item: PostmanItem, warnings: string[]): RequestSpec | null {
  const req = item.request;
  if (!req) return null;
  const name = item.name || 'Imported request';

  if (typeof req === 'string') {
    const { url, params } = splitQuery(req);
    return { ...emptyRequest(nanoid(12), name), url, params };
  }

  const { url, params } = urlOf(req.url);
  const spec: RequestSpec = {
    ...emptyRequest(nanoid(12), name),
    method: (req.method || 'GET').toUpperCase(),
    url,
    params,
    headers: headersOf(req.header),
    auth: authOf(req.auth, warnings, name),
    body: bodyOf(req.body, warnings, name),
    settings: { ...DEFAULT_SETTINGS },
  };
  const scripts = scriptsOf(item.event, name, warnings);
  if (scripts) spec.scripts = scripts;
  return spec;
}

export function importPostman(doc: any): ImportedCollection {
  const out = emptyImport('postman', doc?.info?.name || 'Postman collection');

  const walk = (items: PostmanItem[], folder: ImportedFolder | null, path: string[]) => {
    for (const item of items ?? []) {
      if (Array.isArray(item.item)) {
        // Postman nests folders arbitrarily deep; our tree is one level, so
        // deeper folders keep their path in the name instead of being lost.
        const name = [...path, item.name || 'folder'].join(' / ');
        const child: ImportedFolder = { name, requests: [] };
        out.folders.push(child);
        walk(item.item, child, [...path, item.name || 'folder']);
        continue;
      }
      const spec = requestOf(item, out.warnings);
      if (!spec) continue;
      if (folder) folder.requests.push(spec);
      else out.rootRequests.push(spec);
    }
  };
  walk(doc?.item ?? [], null, []);

  // Collection-level variables become an environment of the same name.
  const vars: KV[] = (doc?.variable ?? [])
    .filter((v: any) => v?.key)
    .map((v: any) => ({ key: String(v.key), value: String(v.value ?? ''), enabled: v.disabled !== true }));
  if (vars.length) {
    out.environments.push({ id: nanoid(12), name: `${out.name} variables`, vars });
  }

  out.folders = out.folders.filter((f) => f.requests.length > 0);
  return out;
}

export function importPostmanEnvironment(doc: any): ImportedCollection {
  const out = emptyImport('postman-environment', doc?.name || 'Postman environment');
  const env: EnvironmentDef = {
    id: nanoid(12),
    name: doc?.name || 'Imported environment',
    vars: (doc?.values ?? [])
      .filter((v: any) => v?.key)
      .map((v: any) => ({
        key: String(v.key),
        value: String(v.value ?? ''),
        enabled: v.enabled !== false,
      })),
  };
  out.environments.push(env);
  const secrets = (doc?.values ?? []).filter((v: any) => v?.type === 'secret').length;
  if (secrets) {
    out.warnings.push(
      `${secrets} variable(s) were marked secret in Postman - they are stored in collections.json as plain text here.`,
    );
  }
  return out;
}
