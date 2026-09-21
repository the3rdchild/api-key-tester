// Collections out: Postman v2.1, or a plain .http file.
//
// Import was one-way until now, which made this app a place collections go to
// die. The rule here is the same as for import: carry over what maps, and say
// out loud what does not - an export that silently drops the auth is worse
// than one that tells you to re-add it.

import { nanoid } from 'nanoid';

import type {
  Assertion,
  CollectionsFile,
  RequestSpec,
  TreeNode,
} from '../../shared/collections.ts';

export interface ExportResult {
  filename: string;
  contentType: string;
  body: string;
  warnings: string[];
}

function childrenOf(node: TreeNode): string[] {
  return node.children ?? [];
}

function rootNodes(file: CollectionsFile): TreeNode[] {
  const nested = new Set<string>();
  for (const node of file.tree) for (const child of node.children ?? []) nested.add(child);
  return file.tree.filter((n) => !nested.has(n.id));
}

/** Turn our declarative assertions into Postman tests, so checks survive the
 *  trip instead of being dropped at the border. */
function assertionsToScript(assertions: Assertion[] | undefined): string[] {
  const lines: string[] = [];
  for (const a of assertions ?? []) {
    if (a.enabled === false || !a.source) continue;
    const label = `${a.source} ${a.op}${a.value ? ` ${a.value}` : ''}`;
    const subject =
      a.source === 'status'
        ? 'pm.response.code'
        : a.source === 'latencyMs'
          ? 'pm.response.responseTime'
          : a.source === 'size'
            ? 'pm.response.responseSize'
            : a.source === 'body'
              ? 'pm.response.text()'
              : a.source.toLowerCase().startsWith('headers.')
                ? `pm.response.headers.get(${JSON.stringify(a.source.slice(8))})`
                : `pm.response.json()${a.source.replace(/^\$\.?|^body\./, '').split('.').filter(Boolean).map((p) => (/^\d+$/.test(p) ? `[${p}]` : `[${JSON.stringify(p)}]`)).join('')}`;

    const value = a.value ?? '';
    const numeric = value !== '' && !Number.isNaN(Number(value));
    const literal = numeric ? value : JSON.stringify(value);

    const body =
      a.op === 'eq'
        ? `pm.expect(${subject}).to.eql(${literal});`
        : a.op === 'ne'
          ? `pm.expect(${subject}).to.not.eql(${literal});`
          : a.op === 'lt'
            ? `pm.expect(Number(${subject})).to.be.below(${literal});`
            : a.op === 'lte'
              ? `pm.expect(Number(${subject})).to.be.at.most(${literal});`
              : a.op === 'gt'
                ? `pm.expect(Number(${subject})).to.be.above(${literal});`
                : a.op === 'gte'
                  ? `pm.expect(Number(${subject})).to.be.at.least(${literal});`
                  : a.op === 'contains'
                    ? `pm.expect(String(${subject})).to.include(${literal});`
                    : a.op === 'notContains'
                      ? `pm.expect(String(${subject})).to.not.include(${literal});`
                      : a.op === 'matches'
                        ? `pm.expect(String(${subject})).to.match(new RegExp(${literal}));`
                        : a.op === 'notExists'
                          ? `pm.expect(${subject}).to.be.undefined;`
                          : `pm.expect(${subject}).to.exist;`;

    lines.push(`pm.test(${JSON.stringify(label)}, function () { ${body} });`);
  }
  return lines;
}

/** bru.* → pm.*: the reverse of what the importer does. */
function scriptToPostman(code: string): string[] {
  if (!code.trim()) return [];
  const out = code
    .replace(/bru\.setEnvVar\(/g, 'pm.environment.set(')
    .replace(/bru\.getEnvVar\(/g, 'pm.environment.get(')
    .replace(/bru\.setVar\(/g, 'pm.collectionVariables.set(')
    .replace(/bru\.getVar\(/g, 'pm.collectionVariables.get(')
    .replace(/\bres\.json\b/g, 'pm.response.json()')
    .replace(/\bres\.status\b/g, 'pm.response.code')
    .replace(/\bres\.latencyMs\b/g, 'pm.response.responseTime')
    .replace(/\bres\.body\b/g, 'pm.response.text()')
    .replace(/\btest\(/g, 'pm.test(')
    .replace(/\bexpect\(/g, 'pm.expect(');
  return out.split('\n');
}

function postmanAuth(spec: RequestSpec, warnings: string[]): unknown {
  const auth = spec.auth;
  switch (auth.type) {
    case 'bearer':
      return { type: 'bearer', bearer: [{ key: 'token', value: auth.token ?? '', type: 'string' }] };
    case 'basic':
      return {
        type: 'basic',
        basic: [
          { key: 'username', value: auth.username ?? '', type: 'string' },
          { key: 'password', value: auth.password ?? '', type: 'string' },
        ],
      };
    case 'header':
      return {
        type: 'apikey',
        apikey: [
          { key: 'key', value: auth.headerName ?? 'x-api-key', type: 'string' },
          { key: 'value', value: auth.headerValue ?? '', type: 'string' },
          { key: 'in', value: 'header', type: 'string' },
        ],
      };
    case 'vault': {
      // The key itself never leaves this machine; the export gets a variable
      // the recipient fills in.
      warnings.push(
        `"${spec.name}" used a vault key - exported as {{API_KEY}}, which the recipient must set.`,
      );
      return { type: 'bearer', bearer: [{ key: 'token', value: '{{API_KEY}}', type: 'string' }] };
    }
    case 'oauth2': {
      const o = auth.oauth2;
      if (o?.clientSecret) {
        warnings.push(`"${spec.name}" carries an OAuth2 client secret - the file will contain it.`);
      }
      return {
        type: 'oauth2',
        oauth2: [
          { key: 'grant_type', value: o?.grant ?? 'authorization_code', type: 'string' },
          { key: 'accessTokenUrl', value: o?.tokenUrl ?? '', type: 'string' },
          { key: 'authUrl', value: o?.authUrl ?? '', type: 'string' },
          { key: 'clientId', value: o?.clientId ?? '', type: 'string' },
          { key: 'clientSecret', value: o?.clientSecret ?? '', type: 'string' },
          { key: 'scope', value: o?.scope ?? '', type: 'string' },
        ],
      };
    }
    default:
      return { type: 'noauth' };
  }
}

function postmanBody(spec: RequestSpec, warnings: string[]): unknown {
  const body = spec.body;
  switch (body.mode) {
    case 'json':
    case 'text':
    case 'xml':
      return {
        mode: 'raw',
        raw: body.text ?? '',
        options: { raw: { language: body.mode === 'json' ? 'json' : body.mode } },
      };
    case 'form':
      return {
        mode: 'urlencoded',
        urlencoded: (body.form ?? []).map((row) => ({
          key: row.key,
          value: row.value,
          disabled: !row.enabled,
        })),
      };
    case 'multipart':
      warnings.push(`"${spec.name}" has file fields - the files themselves are not exported.`);
      return {
        mode: 'formdata',
        formdata: (body.multipart ?? []).map((row) =>
          row.type === 'file'
            ? { key: row.key, type: 'file', src: row.filename ?? '', disabled: !row.enabled }
            : { key: row.key, type: 'text', value: row.value ?? '', disabled: !row.enabled },
        ),
      };
    default:
      return undefined;
  }
}

function postmanItem(spec: RequestSpec, warnings: string[]): unknown {
  const query = spec.params.map((p) => ({ key: p.key, value: p.value, disabled: !p.enabled }));
  const raw = query.length
    ? `${spec.url}?${query.filter((q) => !q.disabled).map((q) => `${q.key}=${q.value}`).join('&')}`
    : spec.url;

  const events: unknown[] = [];
  const pre = scriptToPostman(spec.scripts?.pre ?? '');
  const post = [...scriptToPostman(spec.scripts?.post ?? ''), ...assertionsToScript(spec.assertions)];
  if (pre.length) events.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: pre } });
  if (post.length) events.push({ listen: 'test', script: { type: 'text/javascript', exec: post } });

  return {
    name: spec.name,
    ...(events.length ? { event: events } : {}),
    request: {
      method: spec.method,
      header: spec.headers.map((h) => ({ key: h.key, value: h.value, disabled: !h.enabled })),
      ...(spec.auth.type !== 'none' ? { auth: postmanAuth(spec, warnings) } : {}),
      body: postmanBody(spec, warnings),
      url: { raw, query },
    },
  };
}

export function toPostman(file: CollectionsFile, folderId?: string): ExportResult {
  const warnings: string[] = [];
  const name =
    (folderId ? file.tree.find((n) => n.id === folderId)?.name : undefined) ?? 'Keyway collection';

  const build = (nodeId: string): unknown | null => {
    const spec = file.requests[nodeId];
    if (spec) return postmanItem(spec, warnings);
    const folder = file.tree.find((n) => n.id === nodeId && n.type === 'folder');
    if (!folder) return null;
    return {
      name: folder.name ?? 'folder',
      item: childrenOf(folder).map(build).filter(Boolean),
    };
  };

  const items = folderId
    ? [build(folderId)].filter(Boolean)
    : rootNodes(file).map((n) => build(n.id)).filter(Boolean);

  const env = file.environments.find((e) => e.id === file.activeEnvId) ?? file.environments[0];

  return {
    filename: `${name.replace(/[^\w.-]+/g, '_')}.postman_collection.json`,
    contentType: 'application/json',
    warnings,
    body: JSON.stringify(
      {
        info: {
          _postman_id: nanoid(12),
          name,
          schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
          description: 'Exported from Keyway.',
        },
        item: items,
        variable: (env?.vars ?? [])
          .filter((v) => v.enabled && v.key)
          .map((v) => ({ key: v.key, value: v.value })),
      },
      null,
      2,
    ),
  };
}

/** The .http / REST Client format: readable, diffable, and every editor has a
 *  plugin for it. */
export function toHttpFile(file: CollectionsFile, folderId?: string): ExportResult {
  const warnings: string[] = [];
  const out: string[] = [];
  const env = file.environments.find((e) => e.id === file.activeEnvId) ?? file.environments[0];

  for (const row of env?.vars ?? []) {
    if (row.enabled && row.key) out.push(`@${row.key} = ${row.value}`);
  }
  if (out.length) out.push('');

  const emit = (nodeId: string, path: string[]) => {
    const spec = file.requests[nodeId];
    if (spec) {
      out.push(`### ${[...path, spec.name].join(' / ')}`);
      const query = spec.params
        .filter((p) => p.enabled && p.key)
        .map((p) => `${p.key}=${p.value}`)
        .join('&');
      out.push(`${spec.method} ${spec.url}${query ? `?${query}` : ''}`);
      for (const h of spec.headers) if (h.enabled && h.key) out.push(`${h.key}: ${h.value}`);
      if (spec.auth.type === 'bearer') out.push(`Authorization: Bearer ${spec.auth.token ?? ''}`);
      if (spec.auth.type === 'header' && spec.auth.headerName) {
        out.push(`${spec.auth.headerName}: ${spec.auth.headerValue ?? ''}`);
      }
      if (spec.auth.type === 'vault' || spec.auth.type === 'oauth2') {
        warnings.push(`"${spec.name}": ${spec.auth.type} auth has no .http equivalent.`);
      }
      if (spec.body.mode === 'json' || spec.body.mode === 'text' || spec.body.mode === 'xml') {
        out.push('', spec.body.text ?? '');
      } else if (spec.body.mode === 'form') {
        out.push(
          '',
          (spec.body.form ?? [])
            .filter((r) => r.enabled)
            .map((r) => `${r.key}=${r.value}`)
            .join('&'),
        );
      } else if (spec.body.mode === 'multipart') {
        warnings.push(`"${spec.name}": multipart bodies are not written to .http files.`);
      }
      out.push('');
      return;
    }
    const folder = file.tree.find((n) => n.id === nodeId && n.type === 'folder');
    if (!folder) return;
    for (const child of childrenOf(folder)) emit(child, [...path, folder.name ?? 'folder']);
  };

  if (folderId) emit(folderId, []);
  else for (const node of rootNodes(file)) emit(node.id, []);

  const name =
    (folderId ? file.tree.find((n) => n.id === folderId)?.name : undefined) ?? 'keyway';
  return {
    filename: `${name.replace(/[^\w.-]+/g, '_')}.http`,
    contentType: 'text/plain; charset=utf-8',
    body: out.join('\n'),
    warnings,
  };
}
