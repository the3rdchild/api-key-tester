// OpenAPI 3.x and Swagger 2.0, JSON or YAML.
//
// A spec describes an API; a collection is a set of requests you can actually
// send. The gap between them is filled with examples: path params become
// {{variables}} seeded in an environment, query params arrive as disabled rows
// with their example values, and a request body is generated from the schema so
// the first send is one edit away rather than a blank page.

import { nanoid } from 'nanoid';
import { parse as parseYaml } from 'yaml';

import { DEFAULT_SETTINGS, emptyRequest } from '../../../shared/collections.ts';
import type { KV, RequestSpec } from '../../../shared/collections.ts';
import { emptyImport, type ImportedCollection, type ImportedFolder } from './types.ts';

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

export function parseSpecText(text: string): any {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
  return parseYaml(trimmed);
}

export function isOpenApi(doc: any): boolean {
  return typeof doc?.openapi === 'string' || doc?.swagger === '2.0';
}

/** Follow a local $ref; anything remote is left alone. */
function deref(doc: any, node: any, seen = new Set<string>()): any {
  if (!node || typeof node !== 'object') return node;
  const ref = node.$ref;
  if (typeof ref === 'string' && ref.startsWith('#/')) {
    if (seen.has(ref)) return {};
    seen.add(ref);
    const target = ref
      .slice(2)
      .split('/')
      .reduce((acc: any, part) => acc?.[part.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
    return deref(doc, target, seen);
  }
  return node;
}

/** A small, valid-looking example so the body is editable, not empty. */
function sample(doc: any, schema: any, depth = 0): unknown {
  const s = deref(doc, schema);
  if (!s || depth > 6) return null;
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];

  const type = s.type ?? (s.properties ? 'object' : undefined);
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(s.properties ?? {})) {
        out[key] = sample(doc, value, depth + 1);
      }
      return out;
    }
    case 'array':
      return [sample(doc, s.items, depth + 1)].filter((v) => v !== null);
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'string':
      if (s.format === 'date-time') return new Date().toISOString();
      if (s.format === 'date') return new Date().toISOString().slice(0, 10);
      if (s.format === 'uuid') return '00000000-0000-0000-0000-000000000000';
      return '';
    default:
      if (s.allOf) {
        return Object.assign({}, ...s.allOf.map((part: any) => sample(doc, part, depth + 1) ?? {}));
      }
      if (s.oneOf?.[0] || s.anyOf?.[0]) return sample(doc, s.oneOf?.[0] ?? s.anyOf?.[0], depth + 1);
      return null;
  }
}

function serverUrl(doc: any): string {
  if (Array.isArray(doc.servers) && doc.servers[0]?.url) {
    let url = String(doc.servers[0].url);
    // Server variables use the same {braces} as path params.
    for (const [key, value] of Object.entries<any>(doc.servers[0].variables ?? {})) {
      url = url.replace(`{${key}}`, String(value?.default ?? `{{${key}}}`));
    }
    return url.replace(/\/+$/, '');
  }
  if (doc.swagger === '2.0' && doc.host) {
    const scheme = doc.schemes?.[0] ?? 'https';
    return `${scheme}://${doc.host}${doc.basePath ?? ''}`.replace(/\/+$/, '');
  }
  return '';
}

function authFor(doc: any, operation: any): RequestSpec['auth'] {
  const requirement = operation.security?.[0] ?? doc.security?.[0];
  if (!requirement) return { type: 'none' };
  const schemeName = Object.keys(requirement)[0];
  if (!schemeName) return { type: 'none' };
  const scheme =
    doc.components?.securitySchemes?.[schemeName] ?? doc.securityDefinitions?.[schemeName];
  if (!scheme) return { type: 'none' };

  if (scheme.type === 'http' && scheme.scheme === 'basic') {
    return { type: 'basic', username: '{{username}}', password: '{{password}}' };
  }
  if (scheme.type === 'http' || scheme.type === 'oauth2') {
    return { type: 'bearer', token: '{{token}}' };
  }
  if (scheme.type === 'apiKey') {
    if (scheme.in === 'header') {
      return { type: 'header', headerName: String(scheme.name ?? 'x-api-key'), headerValue: '{{apiKey}}' };
    }
    return { type: 'none' };
  }
  return { type: 'none' };
}

export function importOpenApi(doc: any): ImportedCollection {
  const out = emptyImport('openapi', doc?.info?.title || 'OpenAPI import');
  const base = serverUrl(doc);
  const envVars: KV[] = base ? [{ key: 'baseURL', value: base, enabled: true }] : [];
  const seenVars = new Set(envVars.map((v) => v.key));
  const folders = new Map<string, ImportedFolder>();

  for (const [path, pathItem] of Object.entries<any>(doc.paths ?? {})) {
    for (const method of METHODS) {
      const operation = pathItem?.[method];
      if (!operation) continue;

      const name = operation.summary || operation.operationId || `${method.toUpperCase()} ${path}`;
      const params: KV[] = [];
      const headers: KV[] = [];
      const allParams = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])];

      for (const raw of allParams) {
        const p = deref(doc, raw);
        if (!p?.name) continue;
        const example =
          p.example ?? p.schema?.example ?? p.schema?.default ?? sample(doc, p.schema) ?? '';
        const value = typeof example === 'object' ? JSON.stringify(example) : String(example ?? '');
        if (p.in === 'query') {
          params.push({ key: p.name, value, enabled: p.required === true });
        } else if (p.in === 'header') {
          headers.push({ key: p.name, value, enabled: p.required === true });
        } else if (p.in === 'path' && !seenVars.has(p.name)) {
          // Path params become variables so one edit fixes every request.
          envVars.push({ key: p.name, value, enabled: true });
          seenVars.add(p.name);
        }
      }

      let body: RequestSpec['body'] = { mode: 'none' };
      const content = deref(doc, operation.requestBody)?.content;
      const jsonContent = content?.['application/json'] ?? content?.['application/vnd.api+json'];
      if (jsonContent) {
        const example = jsonContent.example ?? sample(doc, jsonContent.schema);
        body = { mode: 'json', text: JSON.stringify(example ?? {}, null, 2) };
        headers.push({ key: 'Content-Type', value: 'application/json', enabled: true });
      } else if (content?.['application/x-www-form-urlencoded']) {
        const schema = deref(doc, content['application/x-www-form-urlencoded'].schema);
        body = {
          mode: 'form',
          form: Object.keys(schema?.properties ?? {}).map((key) => ({
            key,
            value: '',
            enabled: true,
          })),
        };
      } else if (content && Object.keys(content).length) {
        out.warnings.push(`"${name}": body type ${Object.keys(content)[0]} was left empty.`);
      }

      const spec: RequestSpec = {
        ...emptyRequest(nanoid(12), name),
        method: method.toUpperCase(),
        url: `${base ? '{{baseURL}}' : ''}${path.replace(/\{([^}]+)\}/g, '{{$1}}')}`,
        params,
        headers,
        auth: authFor(doc, operation),
        body,
        settings: { ...DEFAULT_SETTINGS },
        assertions: [{ source: 'status', op: 'lt', value: '400', enabled: true }],
      };

      const tag = operation.tags?.[0] || 'default';
      const folder: ImportedFolder = folders.get(tag) ?? { name: tag, requests: [] };
      folder.requests.push(spec);
      folders.set(tag, folder);
    }
  }

  out.folders = [...folders.values()];
  if (envVars.length) {
    out.environments.push({ id: nanoid(12), name: `${out.name} env`, vars: envVars });
  }
  return out;
}
