// Request/response UI pieces that aren't realtime: the GraphQL helpers behind
// the body editor, and the timing (redirect waterfall) view.

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { TimingView } from '../ui/src/client/TimingView.tsx';
import { graphqlFromJson, operationNames } from '../ui/src/lib/graphql.ts';
import type { SendResult } from '../shared/collections.ts';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/&amp;/g, '&');

describe('graphql helpers', () => {
  test('operationNames finds each named operation once, skipping fragments', () => {
    const doc = `
      query GetUser($id: ID!) { user(id: $id) { ...F } }
      mutation Rename { rename { id } }
      fragment F on User { name }
      query GetUser { again }
      subscription OnPing { ping }
      { anonymous }`;
    expect(operationNames(doc)).toEqual(['GetUser', 'Rename', 'OnPing']);
    expect(operationNames('{ me { id } }')).toEqual([]);
  });

  test('graphqlFromJson carries a GraphQL-shaped JSON body over, nothing else', () => {
    expect(graphqlFromJson('{"query":"{ me }","variables":{"a":1},"operationName":"Me"}')).toEqual({
      query: '{ me }',
      variables: '{\n  "a": 1\n}',
      operationName: 'Me',
    });
    expect(graphqlFromJson('{"query":"{ me }"}')).toEqual({ query: '{ me }', variables: '', operationName: undefined });
    expect(graphqlFromJson('{"name":"not graphql"}')).toBeUndefined();
    expect(graphqlFromJson('not json')).toBeUndefined();
    expect(graphqlFromJson(undefined)).toBeUndefined();
  });
});

describe('TimingView', () => {
  const base: SendResult = {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {},
    body: '',
    truncated: false,
    size: 0,
    latencyMs: 400,
    ttfbMs: 250,
    redirects: [],
    setCookies: [],
  };
  const view = (r: Partial<SendResult>) => text(renderToStaticMarkup(<TimingView result={{ ...base, ...r }} />));

  test('without redirects: waiting is the TTFB, the rest is download', () => {
    const html = view({});
    expect(html).toContain('Total 400 ms');
    expect(html).toContain('Waiting 250 ms');
    expect(html).toContain('Download 150 ms');
    expect(html).not.toContain('redirect ');
  });

  test('hops take their share; the final request waits only its own TTFB', () => {
    const html = view({
      redirects: [
        { status: 301, from: 'https://a.test/old', to: 'https://a.test/new', method: 'GET', startMs: 0, ms: 80 },
        {
          status: 302,
          from: 'https://a.test/new',
          to: 'https://b.test/final',
          method: 'GET',
          startMs: 81,
          ms: 60,
          dropped: ['authorization'],
        },
      ],
      redirectMs: 142,
    });
    expect(html).toContain('2 redirects 142 ms');
    expect(html).toContain('Waiting 108 ms'); // 250 − 142
    expect(html).toContain('301 GET a.test/old');
    expect(html).toContain('80 ms');
    expect(html).toContain('dropped authorization');
    expect(html).toContain('200 b.test/final');
    expect(html).toContain('258 ms'); // the final request: 400 − 142
  });

  test('history from before per-hop timing still lists the hops', () => {
    const html = view({ redirects: [{ status: 301, from: 'https://a.test/x', to: 'https://a.test/y' }] });
    expect(html).toContain('301 a.test/x');
    expect(html).toContain('recorded before per-hop timing existed');
  });
});
