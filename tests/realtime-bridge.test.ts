// End to end through the realtime path: client store (useRealtime) → proxy
// socket (createBridge, wired like server/index.ts) → a fake upstream serving
// WebSocket and SSE, LLM-shaped streams included.

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

import type { RealtimeBridge } from '../server/core/realtime.ts';
import type { RealtimeClientFrame, RealtimeSpec } from '../shared/collections.ts';

// The bridge folds in the active environment's vars. Reading them for real
// would create collections.json in a fresh clone, so the environment is empty.
mock.module('../server/core/collections.ts', () => ({ activeEnvVars: async () => ({}) }));
const { createBridge } = await import('../server/core/realtime.ts');
const rt = await import('../ui/src/client/realtime/useRealtime.ts');
const { compactDeltas, countEvents } = await import('../ui/src/client/realtime/logView.ts');

// ─── fake upstream ──────────────────────────────────────────────────────────

const sse = (...events: string[]) => events.map((e) => `${e}\n\n`);

const STREAMS: Record<string, string[]> = {
  '/sse': [
    ': keep-alive\n\n',
    'event: greet\nid: 7\ndata: {"hi":1}\n\n',
    'data: line1\ndata: line2\n\n',
    'retry: 1000\n\n',
    'event: crlf\r\ndata: over crlf\r\n\r\n',
    'data: split ',
    'across chunks\n\n',
  ],
  '/openai': sse(
    'data: {"choices":[{"delta":{"role":"assistant"}}]}',
    'data: {"choices":[{"delta":{"content":"Hel"}}]}',
    'data: {"choices":[{"delta":{"content":"lo"}}]}',
    'data: {"choices":[{"delta":{"content":" world"}}]}',
    'data: {"choices":[],"usage":{"completion_tokens":3}}',
    'data: [DONE]',
  ),
  '/anthropic': sse(
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"output_tokens":1}}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" there"}}',
    'event: ping\ndata: {"type":"ping"}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"!"}}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
  ),
};

const enc = new TextEncoder();
function eventStream(chunks: string[]): Response {
  const body = new ReadableStream({
    async start(c) {
      for (const ch of chunks) {
        c.enqueue(enc.encode(ch));
        await Bun.sleep(5);
      }
      c.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

const upstream = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req, srv) {
    const { pathname } = new URL(req.url);
    if (pathname === '/ws') return srv.upgrade(req) ? undefined : new Response('no', { status: 400 });
    const chunks = STREAMS[pathname];
    if (chunks) return eventStream(chunks);
    // first visit sets retry: and an id; a reconnect proves it sent Last-Event-ID
    if (pathname === '/resume') {
      const last = req.headers.get('last-event-id');
      return eventStream(last ? [`data: resumed after ${last}\n\n`] : ['retry: 150\n\n', 'id: 41\ndata: first\n\n']);
    }
    if (pathname === '/plain') return new Response('data: x\n\n', { headers: { 'content-type': 'text/plain' } });
    return new Response('nope', { status: 404, statusText: 'Not Found' });
  },
  websocket: {
    message(ws, msg) {
      const s = String(msg);
      if (s === 'big') ws.send('x'.repeat(600 * 1024));
      else if (s === 'bin') ws.send(new Uint8Array([1, 2, 3, 4]));
      else if (s === 'bye') ws.close(4000, 'app says bye');
      else if (s === 'bye1000') ws.close(1000, 'done');
      else if (s === 'flood') for (let i = 0; i < 2500; i++) ws.send(`f${i}`);
      else ws.send(msg);
    },
  },
});

// ─── proxy, wired like server/index.ts ──────────────────────────────────────

const proxy = Bun.serve<{ bridge?: RealtimeBridge }>({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req, srv) {
    if (new URL(req.url).pathname === '/api/realtime' && srv.upgrade(req, { data: {} })) return undefined;
    return new Response('no', { status: 400 });
  },
  websocket: {
    open(ws) {
      ws.data.bridge = createBridge((f) => ws.send(JSON.stringify(f)));
    },
    message(ws, m) {
      void ws.data.bridge?.handle(JSON.parse(String(m)) as RealtimeClientFrame);
    },
    close(ws) {
      ws.data.bridge?.dispose();
    },
  },
});

// what the store expects of a browser
Object.assign(globalThis, {
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16),
  location: { protocol: 'http:', host: `127.0.0.1:${proxy.port}` },
});

afterAll(() => {
  upstream.stop(true);
  proxy.stop(true);
});

// ─── helpers ────────────────────────────────────────────────────────────────

const snap = (tab: string) => rt.realtimeSnapshot(tab);

async function waitFor(pred: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await Bun.sleep(10);
  }
  await Bun.sleep(40); // let the next animation-frame flush land
}

function spec(kind: 'ws' | 'sse', path: string): RealtimeSpec {
  const scheme = kind === 'ws' ? 'ws' : 'http';
  return {
    id: 's',
    name: '',
    kind,
    url: `${scheme}://127.0.0.1:${upstream.port}${path}`,
    protocols: [],
    headers: [],
    auth: { type: 'none' },
  };
}

async function streamToEnd(tab: string, path: string) {
  rt.connect(tab, spec('sse', path), {});
  await waitFor(() => snap(tab).state === 'closed');
  return snap(tab);
}

// ─── websocket ──────────────────────────────────────────────────────────────

describe('websocket', () => {
  const T = 'ws-tab';
  beforeAll(async () => {
    rt.connect(T, spec('ws', '/ws'), {});
    await waitFor(() => snap(T).state === 'open');
  });

  test('connect logs info lines and sets openedAt', () => {
    const s = snap(T);
    expect(s.openedAt).toBeNumber();
    expect(s.log.map((m) => [m.type, m.data])).toEqual([
      ['info', `WS ws://127.0.0.1:${upstream.port}/ws`],
      ['info', 'Connected'],
    ]);
  });

  test('send + echo are typed, sized in UTF-8 bytes and counted', async () => {
    rt.sendMessage(T, 'héllo');
    await waitFor(() => snap(T).log.some((m) => m.type === 'receive'));
    const s = snap(T);
    expect(s.log.slice(-2)).toMatchObject([
      { type: 'send', data: 'héllo', size: 6 },
      { type: 'receive', data: 'héllo', size: 6 },
    ]);
    expect(s.stats).toEqual({ sent: 1, sentBytes: 6, received: 1, receivedBytes: 6 });
  });

  test('oversized frame arrives truncated with its true size', async () => {
    rt.sendMessage(T, 'big');
    await waitFor(() => snap(T).log.some((m) => m.truncated));
    const m = snap(T).log.find((x) => x.truncated)!;
    expect(m.size).toBe(600 * 1024);
    expect(m.data.length).toBe(512 * 1024);
  });

  test('binary frame is base64 with its byte size', async () => {
    rt.sendMessage(T, 'bin');
    await waitFor(() => snap(T).log.some((m) => m.binary));
    expect(snap(T).log.find((x) => x.binary)).toMatchObject({ type: 'receive', data: 'AQIDBA==', size: 4 });
  });

  test('flood: log capped at 1000, counters see every frame', async () => {
    const before = snap(T).stats.received;
    rt.sendMessage(T, 'flood');
    await waitFor(() => snap(T).stats.received >= before + 2500, 8000);
    const s = snap(T);
    expect(s.log.length).toBe(1000);
    expect(s.log.at(-1)?.data).toBe('f2499');
    expect(s.stats.received).toBe(before + 2500);
  });

  test('sent history: deduped, oldest first', async () => {
    rt.sendMessage(T, 'one');
    rt.sendMessage(T, 'one');
    rt.sendMessage(T, 'two');
    expect(rt.sentHistory(T).slice(-2)).toEqual(['one', 'two']);
    expect(rt.sentHistory(T).filter((m) => m === 'one').length).toBe(1);
    await Bun.sleep(60);
  });

  test('clear empties the log but keeps counters and history', () => {
    const stats = snap(T).stats;
    const history = [...rt.sentHistory(T)];
    rt.clearLog(T);
    expect(snap(T).log).toEqual([]);
    expect(snap(T).stats).toEqual(stats);
    expect(rt.sentHistory(T)).toEqual(history);
  });

  test('server close with an app code is an error line', async () => {
    rt.sendMessage(T, 'bye');
    await waitFor(() => snap(T).state === 'closed');
    expect(snap(T).log.at(-1)).toMatchObject({ type: 'error', data: 'Closed · code 4000 · app says bye' });
  });

  test('reconnect resets counters; disconnect is an info line', async () => {
    rt.connect(T, spec('ws', '/ws'), {});
    await waitFor(() => snap(T).state === 'open');
    expect(snap(T).stats).toEqual({ sent: 0, sentBytes: 0, received: 0, receivedBytes: 0 });
    rt.disconnect(T);
    await Bun.sleep(40);
    expect(snap(T).log.at(-1)).toMatchObject({ type: 'info', data: 'Disconnected' });
  });

  test('sent history is capped at 50', async () => {
    const C = 'ws-cap';
    rt.connect(C, spec('ws', '/ws'), {});
    await waitFor(() => snap(C).state === 'open');
    for (let i = 0; i < 60; i++) rt.sendMessage(C, `m${i}`);
    expect(rt.sentHistory(C).length).toBe(50);
    expect(rt.sentHistory(C)[0]).toBe('m10');
    rt.disconnect(C);
  });
});

// ─── sse ────────────────────────────────────────────────────────────────────

describe('sse', () => {
  test('events, ids, heartbeats, multi-line, CRLF and split chunks', async () => {
    const s = await streamToEnd('sse-tab', '/sse');
    expect(s.log.map((m) => ({ type: m.type, data: m.data, event: m.event, eventId: m.eventId }))).toEqual([
      { type: 'info', data: `GET http://127.0.0.1:${upstream.port}/sse`, event: undefined, eventId: undefined },
      { type: 'info', data: 'Connected', event: undefined, eventId: undefined },
      { type: 'heartbeat', data: 'keep-alive', event: undefined, eventId: undefined },
      { type: 'receive', data: '{"hi":1}', event: 'greet', eventId: '7' },
      { type: 'receive', data: 'line1\nline2', event: undefined, eventId: undefined },
      { type: 'info', data: 'Server asks for 1 s between reconnects (retry:)', event: undefined, eventId: undefined },
      { type: 'receive', data: 'over crlf', event: 'crlf', eventId: undefined },
      { type: 'receive', data: 'split across chunks', event: undefined, eventId: undefined },
      { type: 'info', data: 'Closed · stream ended', event: undefined, eventId: undefined },
    ]);
    expect(s.stats.received).toBe(5); // the heartbeat is traffic too
    expect(s.stream.deltas).toBe(0); // JSON that isn't a completion chunk is not a delta
  });

  test('HTTP error is an error line and state', async () => {
    const T = 'sse-404';
    rt.connect(T, spec('sse', '/missing'), {});
    await waitFor(() => snap(T).state === 'error');
    expect(snap(T).log.at(-1)).toMatchObject({ type: 'error', data: 'Error: HTTP 404 Not Found' });
  });

  test('wrong content-type becomes an info note', async () => {
    const s = await streamToEnd('sse-plain', '/plain');
    expect(s.note).toContain('text/plain');
    expect(s.log.some((m) => m.type === 'info' && m.data.includes('text/plain'))).toBe(true);
    expect(s.log.some((m) => m.type === 'receive' && m.data === 'x')).toBe(true);
  });
});

// ─── LLM streams ────────────────────────────────────────────────────────────

describe('llm streams', () => {
  test('OpenAI: text stitched, tokens, [DONE], TTFT anchored at connect', async () => {
    const s = await streamToEnd('llm-openai', '/openai');
    expect(s.stream).toMatchObject({ text: 'Hello world', deltas: 3, tokens: 3, done: true });
    expect(s.stream.firstAt! >= s.stream.startedAt!).toBe(true);
    expect(s.log.filter((m) => m.delta).map((m) => m.delta)).toEqual(['Hel', 'lo', ' world']);
  });

  test('OpenAI: compact folds the run of deltas, leaves the rest', async () => {
    const received = snap('llm-openai').log.filter((m) => m.type === 'receive');
    const rows = compactDeltas(received);
    expect(rows.map((r) => [r.merged ?? 0, r.merged ? r.data : r.data.slice(0, 12)])).toEqual([
      [0, '{"choices":['],
      [3, 'Hello world'],
      [0, '{"choices":['],
      [0, '[DONE]'],
    ]);
  });

  test('Anthropic: named events, text, tokens from message_delta', async () => {
    const s = await streamToEnd('llm-anthropic', '/anthropic');
    expect(s.stream).toMatchObject({ text: 'Hi there!', deltas: 3, tokens: 3, done: false });
    expect(countEvents(s.log)).toEqual([
      ['message_start', 1],
      ['content_block_delta', 3],
      ['ping', 1],
      ['message_delta', 1],
    ]);
    // a ping between deltas breaks the run: two folded rows, not one
    const rows = compactDeltas(s.log.filter((m) => m.type === 'receive'));
    expect(rows.map((r) => r.event + (r.merged ? `×${r.merged}:${r.data}` : ''))).toEqual([
      'message_start',
      'content_block_delta×2:Hi there',
      'ping',
      'content_block_delta×1:!',
      'message_delta',
    ]);
  });

  test('reconnect starts a fresh completion', async () => {
    const T = 'llm-openai';
    rt.connect(T, spec('sse', '/anthropic'), {});
    expect(snap(T).stream).toMatchObject({ text: '', deltas: 0, done: false });
    await waitFor(() => snap(T).state === 'closed');
    expect(snap(T).stream.text).toBe('Hi there!');
  });
});

describe('undefined variables', () => {
  test('are reported as an error line', async () => {
    const T = 'vars';
    rt.connect(T, { ...spec('ws', '/ws'), url: `ws://127.0.0.1:${upstream.port}/ws?t={{nope_not_defined}}` }, {});
    await waitFor(() => snap(T).log.some((m) => m.type === 'error' && m.data.startsWith('Undefined')));
    rt.disconnect(T);
  });
});

// ─── auto-reconnect ─────────────────────────────────────────────────────────

const count = (tab: string, pred: (m: { type: string; data: string }) => boolean) => snap(tab).log.filter(pred).length;

async function openWs(tab: string, opts: Parameters<typeof rt.setOptions>[1]) {
  rt.setOptions(tab, opts);
  rt.connect(tab, spec('ws', '/ws'), {});
  await waitFor(() => snap(tab).state === 'open');
}

describe('auto-reconnect', () => {
  test('ws: an unexpected close backs off, comes back, keeps the counters', async () => {
    const T = 'rc-ws';
    await openWs(T, { autoReconnect: true });
    rt.sendMessage(T, 'bye');
    await waitFor(() => snap(T).state === 'reconnecting');
    expect(snap(T).log.at(-1)).toMatchObject({ type: 'info', data: 'Reconnecting in 1 s · attempt 1/10' });
    await waitFor(() => snap(T).state === 'open', 3000);
    expect(count(T, (m) => m.data === 'Connected')).toBe(2);
    expect(snap(T).stats.sent).toBe(1);
    rt.disconnect(T);
  });

  test('ws: a normal close (1000) is left closed', async () => {
    const T = 'rc-1000';
    await openWs(T, { autoReconnect: true });
    rt.sendMessage(T, 'bye1000');
    await waitFor(() => snap(T).state === 'closed');
    expect(snap(T).log.at(-1)).toMatchObject({ data: 'Not reconnecting: the server closed normally (1000)' });
  });

  test('disconnect cancels a pending reconnect', async () => {
    const T = 'rc-cancel';
    await openWs(T, { autoReconnect: true });
    rt.sendMessage(T, 'bye');
    await waitFor(() => snap(T).state === 'reconnecting');
    rt.disconnect(T);
    expect(snap(T).state).toBe('closed');
    await Bun.sleep(1300);
    expect(snap(T).state).toBe('closed');
    expect(count(T, (m) => m.data === 'Connected')).toBe(1);
  });

  test('turning auto-reconnect off mid-backoff stops it', async () => {
    const T = 'rc-off';
    await openWs(T, { autoReconnect: true });
    rt.sendMessage(T, 'bye');
    await waitFor(() => snap(T).state === 'reconnecting');
    rt.setOptions(T, { autoReconnect: false });
    await Bun.sleep(1300);
    expect(snap(T).state).toBe('closed');
    expect(count(T, (m) => m.data === 'Auto-reconnect turned off — stopped retrying')).toBe(1);
  });

  test('sse: waits the server retry:, resumes with Last-Event-ID', async () => {
    const T = 'rc-sse';
    rt.setOptions(T, { autoReconnect: true });
    rt.connect(T, spec('sse', '/resume'), {});
    await waitFor(() => snap(T).log.some((m) => m.data === 'resumed after 41'), 3000);
    const lines = snap(T).log.map((m) => m.data);
    expect(lines).toContain('Server asks for 150 ms between reconnects (retry:)');
    expect(lines).toContain('Reconnecting in 150 ms · attempt 1/10 · Last-Event-ID 41');
    rt.disconnect(T);
  });

  test('sse: a 4xx is not retried', async () => {
    const T = 'rc-404';
    rt.setOptions(T, { autoReconnect: true });
    rt.connect(T, spec('sse', '/missing'), {});
    await waitFor(() => snap(T).state === 'error');
    expect(snap(T).log.at(-1)).toMatchObject({ data: "Not reconnecting: HTTP 404 won't change on a retry" });
  });

  test('sse: a finished completion is not requested again', async () => {
    const T = 'rc-llm';
    rt.setOptions(T, { autoReconnect: true });
    const s = await streamToEnd(T, '/openai');
    expect(s.log.at(-1)).toMatchObject({ data: 'Not reconnecting: the stream delivered a completion' });
  });
});

// ─── heartbeat ──────────────────────────────────────────────────────────────

describe('heartbeat', () => {
  const beats = (tab: string) => count(tab, (m) => m.type === 'heartbeat');

  test('sends the payload on its interval, as heartbeat, outside the composer history', async () => {
    const T = 'hb';
    await openWs(T, { autoReconnect: false, heartbeat: { intervalMs: 50, payload: 'ping!' } });
    await waitFor(() => beats(T) >= 3);
    const s = snap(T);
    expect(s.log.find((m) => m.type === 'heartbeat')).toMatchObject({ data: 'ping!', size: 5 });
    expect(s.stats.sent).toBeGreaterThanOrEqual(3);
    expect(s.log.some((m) => m.type === 'receive' && m.data === 'ping!')).toBe(true); // the echo
    expect(rt.sentHistory(T)).toEqual([]);
  });

  test('turning it off stops it; so does disconnecting', async () => {
    const T = 'hb';
    rt.setOptions(T, { autoReconnect: false });
    await Bun.sleep(80);
    const off = beats(T);
    await Bun.sleep(200);
    expect(beats(T)).toBe(off);

    const D = 'hb-disc';
    await openWs(D, { autoReconnect: false, heartbeat: { intervalMs: 50, payload: 'p' } });
    rt.disconnect(D);
    await Bun.sleep(80);
    const after = beats(D);
    await Bun.sleep(200);
    expect(beats(D)).toBe(after);
  });
});
