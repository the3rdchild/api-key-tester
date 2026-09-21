// Insomnia v4 exports (the "Insomnia v4 (JSON)" option).
//
// Insomnia's model is a flat resource list glued together by parentId, so the
// work here is rebuilding the tree before mapping anything.

import { nanoid } from 'nanoid';

import { DEFAULT_SETTINGS, emptyRequest } from '../../../shared/collections.ts';
import type { KV, RequestAuth, RequestSpec } from '../../../shared/collections.ts';
import { emptyImport, type ImportedCollection, type ImportedFolder } from './types.ts';

interface Resource {
  _id?: string;
  _type?: string;
  parentId?: string;
  name?: string;
  method?: string;
  url?: string;
  headers?: { name?: string; value?: string; disabled?: boolean }[];
  parameters?: { name?: string; value?: string; disabled?: boolean }[];
  body?: { mimeType?: string; text?: string; params?: { name?: string; value?: string; disabled?: boolean; type?: string; fileName?: string }[] };
  authentication?: Record<string, any>;
  data?: Record<string, unknown>;
}

export function isInsomniaExport(doc: any): boolean {
  return doc?._type === 'export' && Array.isArray(doc?.resources);
}

function rows(list: Resource['headers'] | Resource['parameters']): KV[] {
  return (list ?? []).map((row) => ({
    key: String(row.name ?? ''),
    value: String(row.value ?? ''),
    enabled: row.disabled !== true,
  }));
}

function authOf(auth: Resource['authentication'], name: string, warnings: string[]): RequestAuth {
  if (!auth || !auth.type || auth.type === 'none' || auth.disabled) return { type: 'none' };
  switch (auth.type) {
    case 'bearer':
      return { type: 'bearer', token: String(auth.token ?? '') };
    case 'basic':
      return {
        type: 'basic',
        username: String(auth.username ?? ''),
        password: String(auth.password ?? ''),
      };
    case 'apikey':
      return {
        type: 'header',
        headerName: String(auth.key ?? 'x-api-key'),
        headerValue: String(auth.value ?? ''),
      };
    case 'oauth2':
      return {
        type: 'oauth2',
        oauth2: {
          grant:
            auth.grantType === 'client_credentials'
              ? 'client_credentials'
              : auth.grantType === 'password'
                ? 'password'
                : auth.grantType === 'implicit'
                  ? 'implicit'
                  : 'authorization_code',
          authUrl: auth.authorizationUrl ? String(auth.authorizationUrl) : undefined,
          tokenUrl: auth.accessTokenUrl ? String(auth.accessTokenUrl) : undefined,
          clientId: auth.clientId ? String(auth.clientId) : undefined,
          clientSecret: auth.clientSecret ? String(auth.clientSecret) : undefined,
          scope: auth.scope ? String(auth.scope) : undefined,
          username: auth.username ? String(auth.username) : undefined,
          password: auth.password ? String(auth.password) : undefined,
          usePkce: auth.usePkce !== false,
          clientAuth: 'body',
        },
      };
    default:
      warnings.push(`"${name}": auth type "${auth.type}" is not supported and was left as no-auth.`);
      return { type: 'none' };
  }
}

function bodyOf(body: Resource['body'], name: string, warnings: string[]): RequestSpec['body'] {
  if (!body || (!body.mimeType && !body.text && !body.params)) return { mode: 'none' };
  const mime = body.mimeType ?? '';

  if (mime.includes('x-www-form-urlencoded')) {
    return {
      mode: 'form',
      form: (body.params ?? []).map((p) => ({
        key: String(p.name ?? ''),
        value: String(p.value ?? ''),
        enabled: p.disabled !== true,
      })),
    };
  }

  if (mime.includes('multipart/form-data')) {
    const rowsOut = (body.params ?? []).map((p) => ({
      key: String(p.name ?? ''),
      type: (p.type === 'file' ? 'file' : 'text') as 'file' | 'text',
      value: p.type === 'file' ? undefined : String(p.value ?? ''),
      filename: p.type === 'file' ? String(p.fileName ?? '') : undefined,
      enabled: p.disabled !== true,
    }));
    if (rowsOut.some((r) => r.type === 'file')) {
      warnings.push(`"${name}": file fields kept, but the files themselves need re-picking.`);
    }
    return { mode: 'multipart', multipart: rowsOut };
  }

  const text = String(body.text ?? '');
  if (mime.includes('graphql')) return { mode: 'json', text };
  if (mime.includes('xml')) return { mode: 'xml', text };
  if (mime.includes('json') || text.trim().startsWith('{') || text.trim().startsWith('[')) {
    return { mode: 'json', text };
  }
  return text ? { mode: 'text', text } : { mode: 'none' };
}

export function importInsomnia(doc: any): ImportedCollection {
  const resources: Resource[] = doc.resources ?? [];
  const workspace = resources.find((r) => r._type === 'workspace');
  const out = emptyImport('insomnia', workspace?.name || 'Insomnia export');

  const groups = new Map<string, ImportedFolder>();
  for (const r of resources) {
    if (r._type === 'request_group' && r._id) {
      groups.set(r._id, { name: r.name || 'folder', requests: [] });
    }
  }

  for (const r of resources) {
    if (r._type === 'environment') {
      const data = r.data ?? {};
      const vars: KV[] = Object.entries(data).map(([key, value]) => ({
        key,
        value: typeof value === 'object' ? JSON.stringify(value) : String(value ?? ''),
        enabled: true,
      }));
      if (vars.length) {
        out.environments.push({ id: nanoid(12), name: r.name || 'Insomnia environment', vars });
      }
      continue;
    }
    if (r._type !== 'request') continue;

    const name = r.name || 'Imported request';
    // Insomnia writes _.var; ours is {{var}}.
    const url = String(r.url ?? '').replace(/\{\{\s*_\.([^}\s]+)\s*\}\}/g, '{{$1}}');
    const spec: RequestSpec = {
      ...emptyRequest(nanoid(12), name),
      method: (r.method || 'GET').toUpperCase(),
      url,
      params: rows(r.parameters),
      headers: rows(r.headers),
      auth: authOf(r.authentication, name, out.warnings),
      body: bodyOf(r.body, name, out.warnings),
      settings: { ...DEFAULT_SETTINGS },
    };

    const folder = r.parentId ? groups.get(r.parentId) : undefined;
    if (folder) folder.requests.push(spec);
    else out.rootRequests.push(spec);
  }

  out.folders = [...groups.values()].filter((f) => f.requests.length > 0);
  return out;
}
