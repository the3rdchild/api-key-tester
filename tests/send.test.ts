// sendRequest against a local server: GraphQL bodies (POST and GET), and the
// redirect chain — per-hop timing, 303 turning into GET, and credentials that
// must not follow a redirect to another origin. Plus GraphQL through the
// importers, the .http export and the code generator, and the matrix keeping
// whole responses for a compare.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, mock, test } from 'bun:test';

import { emptyRequest } from '../shared/collections.ts';
import type { CollectionsFile, RequestSpec } from '../shared/collections.ts';

// Cookies and OAuth tokens live next to ROOT_DIR: point it at a temp dir. The
// script sandbox (quickjs) isn't needed here and may not be installed.
const DATA = mkdtempSync(join(tmpdir(), 'keyway-send-'));
mock.module('../server/core/store.ts', () => ({ ROOT_DIR: DATA, getAllKeys: async () => [] }));
mock.module('../server/core/script.ts', () => ({ runScript: async () => ({}) }));
mock.module('../server/core/collections.ts', () => ({ activeEnvVars: async () => ({}) }));
const { sendRequest, toCode } = await import('../server/core/send.ts');
const { matrixCell, runMatrix } = await import('../server/core/matrix.ts');
const { importPostman } = await import('../server/core/import/postman.ts');
const { importInsomnia } = await import('../server/core/import/insomnia.ts');
const { toHttpFile } = await import('../server/core/export-collection.ts');

// ─── servers ────────────────────────────────────────────────────────────────

let hits = 0;
async function echo(req: Request): Promise<Response> {
  hits++;
  const url = new URL(req.url);
  return Response.json({
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    contentType: req.headers.get('content-type'),
    authorization: req.headers.get('authorization'),
    custom: req.headers.get('x-custom'),
    body: await req.text(),
  });
}
const redirect = (to: string, status = 302, delay = 0) =>
  Bun.sleep(delay).then(() => new Response(null, { status, headers: { location: to } }));

// a second origin, for redirects that leave the first
const other = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: echo });

const api = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    switch (new URL(req.url).pathname) {
      case '/r1':
        return redirect('/r2', 301, 30);
      case '/r2':
        return redirect('/echo', 302, 20);
      case '/see-other':
        return redirect('/echo', 303);
      case '/away':
        return redirect(`http://127.0.0.1:${other.port}/echo`);
      default:
        return echo(req);
    }
  },
});
const base = `http://127.0.0.1:${api.port}`;

afterAll(() => {
  api.stop(true);
  other.stop(true);
  rmSync(DATA, { recursive: true, force: true });
});

function req(patch: Partial<RequestSpec>): RequestSpec {
  const spec = emptyRequest('r1');
  return { ...spec, ...patch, settings: { ...spec.settings, useCookieJar: false, ...patch.settings } };
}
const gql = (method: string, variables = '{ "id": "{{uid}}" }', operationName?: string) =>
  req({
    method,
    url: `${base}/graphql`,
    body: { mode: 'graphql', graphql: { query: 'query GetUser($id: ID!) { user(id: $id) { name } }', variables, operationName } },
  });
/** Send, and return what the echo server saw. */
async function sent(spec: RequestSpec, vars: Record<string, string> = {}) {
  const { result } = await sendRequest(spec, { vars });
  expect(result.error).toBeUndefined();
  return JSON.parse(result.body) as { method: string; query: Record<string, string>; contentType: string; body: string };
}

// ─── GraphQL ────────────────────────────────────────────────────────────────

describe('graphql', () => {
  test('POST sends the JSON request object, variables parsed and interpolated', async () => {
    const got = await sent(gql('POST', '{ "id": "{{uid}}" }', 'GetUser'), { uid: '42' });
    expect(got.contentType).toBe('application/json');
    expect(JSON.parse(got.body)).toEqual({
      query: 'query GetUser($id: ID!) { user(id: $id) { name } }',
      variables: { id: '42' },
      operationName: 'GetUser',
    });
  });

  test('no variables, no variables key', async () => {
    const got = await sent(gql('POST', '   '));
    expect(Object.keys(JSON.parse(got.body))).toEqual(['query']);
  });

  test('GET carries it as query params, with no body', async () => {
    const got = await sent(gql('GET', '{"id":"7"}', 'GetUser'));
    expect(got.method).toBe('GET');
    expect(got.body).toBe('');
    expect(got.query).toEqual({
      query: 'query GetUser($id: ID!) { user(id: $id) { name } }',
      variables: '{"id":"7"}',
      operationName: 'GetUser',
    });
  });

  test('invalid variables stop the send instead of being dropped', async () => {
    const before = hits;
    const { result } = await sendRequest(gql('POST', '{ "id": '));
    expect(result.error).toStartWith('GraphQL variables are not valid JSON');
    expect(hits).toBe(before);
  });

  test('code generation sends what a send would', async () => {
    const curl = await toCode(gql('POST', '{"id":"1"}'), 'curl');
    expect(curl).toContain('application/json');
    expect(curl).toContain(`--data '{"query":"query GetUser`);
    expect(curl).toContain('"variables":{"id":"1"}');
  });

  test('Postman and Insomnia imports keep GraphQL as GraphQL', () => {
    const postman = importPostman({
      info: { name: 'c', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [
        {
          name: 'Q',
          request: {
            method: 'POST',
            url: 'https://x/graphql',
            body: { mode: 'graphql', graphql: { query: '{ me { id } }', variables: '{"a":1}' } },
          },
        },
      ],
    });
    expect(postman.rootRequests[0]?.body).toEqual({ mode: 'graphql', graphql: { query: '{ me { id } }', variables: '{"a":1}' } });

    const insomnia = importInsomnia({
      resources: [
        { _type: 'workspace', _id: 'wrk', name: 'w' },
        {
          _type: 'request',
          _id: 'req1',
          parentId: 'wrk',
          name: 'Q',
          method: 'POST',
          url: 'https://x/graphql',
          body: { mimeType: 'application/graphql', text: '{"query":"{ me { id } }","variables":{"a":1},"operationName":"Me"}' },
        },
      ],
    });
    const spec = [...insomnia.rootRequests, ...insomnia.folders.flatMap((f) => f.requests)][0];
    expect(spec?.body).toEqual({
      mode: 'graphql',
      graphql: { query: '{ me { id } }', variables: '{\n  "a": 1\n}', operationName: 'Me' },
    });
  });

  test('.http export writes the JSON request object', () => {
    const spec = { ...gql('POST', '{"a":1}'), name: 'Q' };
    const file: CollectionsFile = {
      version: 1,
      activeEnvId: null,
      environments: [],
      tree: [{ id: spec.id, type: 'request' }],
      requests: { [spec.id]: spec },
    };
    const { body } = toHttpFile(file);
    expect(body).toContain('Content-Type: application/json');
    expect(body).toContain('"variables": {\n    "a": 1\n  }');
  });
});

// ─── redirects ──────────────────────────────────────────────────────────────

describe('redirects', () => {
  test('each hop is timed; the final request starts where the hops end', async () => {
    const { result } = await sendRequest(req({ url: `${base}/r1` }));
    expect(result.status).toBe(200);
    const [a, b] = result.redirects;
    expect(result.redirects).toHaveLength(2);
    expect(a).toMatchObject({ status: 301, method: 'GET', from: `${base}/r1`, to: `${base}/r2` });
    expect(b).toMatchObject({ status: 302, method: 'GET', from: `${base}/r2`, to: `${base}/echo` });
    expect(a!.startMs).toBe(0);
    expect(a!.ms!).toBeGreaterThanOrEqual(25);
    expect(b!.startMs!).toBeGreaterThanOrEqual(a!.startMs! + a!.ms!);
    expect(b!.ms!).toBeGreaterThanOrEqual(15);
    expect(result.redirectMs!).toBeGreaterThanOrEqual(b!.startMs! + b!.ms!);
    expect(result.ttfbMs).toBeGreaterThanOrEqual(result.redirectMs!);
    expect(result.latencyMs).toBeGreaterThanOrEqual(result.ttfbMs);
  });

  test('a 303 after a POST goes on as GET, and the hop says which method it used', async () => {
    const { result } = await sendRequest(req({ method: 'POST', url: `${base}/see-other`, body: { mode: 'text', text: 'x' } }));
    expect(result.redirects[0]).toMatchObject({ status: 303, method: 'POST' });
    expect(JSON.parse(result.body)).toMatchObject({ method: 'GET', body: '' });
  });

  test('same-origin redirects keep Authorization', async () => {
    const { result } = await sendRequest(req({ url: `${base}/r1`, auth: { type: 'bearer', token: 'tok' } }));
    expect(JSON.parse(result.body).authorization).toBe('Bearer tok');
    expect(result.redirects.every((h) => !h.dropped)).toBe(true);
  });

  test('a redirect to another origin drops the credentials, not the other headers', async () => {
    const { result } = await sendRequest(
      req({
        url: `${base}/away`,
        auth: { type: 'bearer', token: 'secret-token' },
        headers: [{ key: 'X-Custom', value: 'kept', enabled: true }],
      }),
    );
    const got = JSON.parse(result.body);
    expect(got.authorization).toBeNull();
    expect(got.custom).toBe('kept');
    expect(result.redirects[0]?.dropped).toEqual(['authorization']);
  });

  test('not following redirects returns the 3xx, with no hops', async () => {
    const { result } = await sendRequest(req({ url: `${base}/r1`, settings: { ...emptyRequest('x').settings, followRedirects: false, useCookieJar: false } }));
    expect(result.status).toBe(301);
    expect(result.redirects).toEqual([]);
    expect(result.redirectMs).toBeUndefined();
  });
});

// ─── matrix ─────────────────────────────────────────────────────────────────

describe('matrix', () => {
  test('keeps each cell\'s whole response, for the latest run only', async () => {
    const spec = req({ url: '{{baseURL}}/echo' });
    const first = await runMatrix({ spec, targets: [{ baseURL: base, label: 'one' }, { baseURL: base, label: 'two' }] });
    expect(first.items.map((i) => i.label).sort()).toEqual(['one', 'two']);
    for (const item of first.items) {
      expect(item.id).toBeString();
      const cell = matrixCell(first.id, item.id!);
      expect(cell?.status).toBe(200);
      expect(JSON.parse(cell!.body).path).toBe('/echo');
    }
    expect(matrixCell('not-a-run', first.items[0]!.id!)).toBeUndefined();

    const second = await runMatrix({ spec, targets: [{ baseURL: base, label: 'three' }] });
    expect(matrixCell(first.id, first.items[0]!.id!)).toBeUndefined();
    expect(matrixCell(second.id, second.items[0]!.id!)?.status).toBe(200);
  });
});
