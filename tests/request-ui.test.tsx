// Request/response UI pieces that aren't realtime: the GraphQL helpers behind
// the body editor, the timing (redirect waterfall) view, the compare dialog,
// and Poll's button and log.

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { CompareDialog, bodyOf } from '../ui/src/client/CompareDialog.tsx';
import { PollButton } from '../ui/src/client/PollButton.tsx';
import { PollChip, PollLog } from '../ui/src/client/PollLog.tsx';
import { TimingView } from '../ui/src/client/TimingView.tsx';
import { graphqlFromJson, operationNames } from '../ui/src/lib/graphql.ts';
import { emptyRequest, type PollSummary, type SendResult } from '../shared/collections.ts';

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');

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

describe('CompareDialog', () => {
  const res = (body: string, patch: Partial<SendResult> = {}): SendResult => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json', date: 'Mon' },
    body,
    truncated: false,
    size: body.length,
    latencyMs: 100,
    ttfbMs: 80,
    redirects: [],
    setCookies: [],
    ...patch,
  });
  const dialog = (a: SendResult, b: SendResult) =>
    renderToStaticMarkup(
      <CompareDialog left={{ label: 'Previous', detail: '10:00', result: a }} right={{ label: 'Now', result: b }} onClose={() => {}} />,
    );

  test('JSON: a change list by path, per-call noise ignored and counted', () => {
    const html = text(
      dialog(
        res('{"id":"a","model":"x","data":[1,2]}'),
        res('{"id":"b","model":"y","data":[1]}', { status: 201, latencyMs: 150, headers: { 'content-type': 'application/json', date: 'Tue', server: 'z' } }),
      ),
    );
    expect(html).toContain('Status 200 → 201');
    expect(html).toContain('Latency 100 ms → 150 ms (+50%)');
    expect(html).toContain('Body 2'); // $.model and $.data.1 — $.id is ignored by default
    expect(html).toContain('Headers 1'); // server; date is ignored by default
    expect(html).toContain('changed $.model');
    expect(html).toContain('"x" "y"');
    expect(html).toContain('removed $.data.1');
    expect(html).toContain('1 ignored');
    expect(html).not.toContain('$.id');
  });

  test('identical JSON says so', () => {
    expect(text(dialog(res('{"a":1}'), res('{"a":1}')))).toContain('No differences');
  });

  test('text bodies fall back to a line diff', () => {
    const html = text(dialog(res('line one\nline two', { headers: {} }), res('line one\nline 2', { headers: {} })));
    expect(html).toContain('compared line by line');
    expect(html).toContain('− line two');
    expect(html).toContain('+ line 2');
  });

  test('a streamed response is compared by its stitched text', () => {
    expect(bodyOf(res('data: {...}', { streamText: 'Hello' }))).toMatchObject({ text: 'Hello', streamed: true });
  });

  test('binary bodies: same or not, never a hex diff', () => {
    const html = text(dialog(res('AAAA', { bodyEncoding: 'base64', size: 3 }), res('AAAB', { bodyEncoding: 'base64', size: 3 })));
    expect(html).toContain('they differ');
  });
});

describe('Poll', () => {
  const noop = () => {};
  const withCheck = { ...emptyRequest('p'), assertions: [{ source: 'status', op: 'eq' as const, value: '200' }] };
  const button = (props: Partial<Parameters<typeof PollButton>[0]>) =>
    renderToStaticMarkup(
      <PollButton spec={withCheck} polling={undefined} busy={false} onSettings={noop} onStart={noop} onCancel={noop} {...props} />,
    );

  test('without a check to wait for, the button says what to add', () => {
    const html = button({ spec: emptyRequest('p') });
    expect(html).toContain('disabled=""');
    expect(html).toContain('add an assertion in the Tests tab first');
  });

  test('while polling it shows the attempt, the checks, and a way out', () => {
    const html = text(
      button({
        polling: { attempt: { attempt: 3, at: 4000, status: 202, latencyMs: 12, passed: 0, total: 1 }, nextAt: Date.now() + 1500 },
      }),
    );
    expect(html).toContain('attempt 3/30');
    expect(html).toContain('202 · 0/1 checks');
    expect(html).toMatch(/next in 1\.\d s/);
    expect(html).toContain('Cancel');
  });

  const summary: PollSummary = {
    outcome: 'passed',
    attempts: 3,
    elapsedMs: 4200,
    log: [
      { attempt: 1, at: 0, status: 202, latencyMs: 11, passed: 0, total: 1 },
      { attempt: 2, at: 2010, error: 'ECONNRESET', latencyMs: 3, passed: 0, total: 0 },
      { attempt: 3, at: 4020, status: 200, latencyMs: 9, passed: 1, total: 1 },
    ],
  };

  test('the chip says how many and how it ended', () => {
    expect(text(renderToStaticMarkup(<PollChip poll={summary} onClick={noop} />))).toContain('polled 3× · passed');
    expect(text(renderToStaticMarkup(<PollChip poll={{ ...summary, outcome: 'timeout' }} onClick={noop} />))).toContain('timed out');
  });

  test('the log lists every attempt', () => {
    const html = text(renderToStaticMarkup(<PollLog poll={summary} />));
    expect(html).toContain('Polled 3 times over 4.2 s — every check passed');
    expect(html).toContain('1 +0.0 s 202 0/1 11 ms');
    expect(html).toContain('2 +2.0 s error 0/0 3 ms');
    expect(html).toContain('3 +4.0 s 200 1/1 9 ms');
  });
});
