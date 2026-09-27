// The realtime log's pieces, rendered to static markup: rows, toolbar,
// composer and the Text view — plus the pure log-shaping helpers.

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { Composer } from '../ui/src/client/realtime/Composer.tsx';
import { eventBadgeClass, LogRow } from '../ui/src/client/realtime/LogRow.tsx';
import { LogToolbar } from '../ui/src/client/realtime/LogToolbar.tsx';
import { compactDeltas, countByType, countEvents, filterLog, type LogEntry } from '../ui/src/client/realtime/logView.ts';
import { StreamText } from '../ui/src/client/realtime/StreamText.tsx';
import type { RTStream } from '../ui/src/client/realtime/useRealtime.ts';
import type { RealtimeMessage } from '../shared/collections.ts';

const noop = () => {};
/** visible text, roughly as a reader sees it */
const text = (html: string) =>
  html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
const isDisabled = (html: string, label: string) =>
  new RegExp(`<button[^>]*disabled=""[^>]*>(<i[^>]*></i> )?${label}`).test(html);

const AT = 1_700_000_000_123;
function row(m: Partial<LogEntry>, opts: { pretty?: boolean; prevAt?: number; onResend?: () => void } = {}) {
  const entry = { id: 'x', type: 'receive', at: AT, data: '', ...m } as LogEntry;
  return renderToStaticMarkup(
    <LogRow m={entry} pretty={opts.pretty ?? true} prevAt={opts.prevAt} onCopy={noop} onResend={opts.onResend} />,
  );
}

describe('LogRow', () => {
  test('pretty JSON is indented; raw stays as sent', () => {
    const m = { data: '{"a":1,"b":[2]}', size: 15 };
    expect(text(row(m))).toContain('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
    expect(text(row(m, { pretty: false }))).toContain('{"a":1,"b":[2]}');
  });

  test('invalid JSON falls back to raw text', () => {
    expect(text(row({ data: '{not json', size: 9 }))).toContain('{not json');
  });

  test('size, +delta and sse id', () => {
    const html = text(row({ data: 'hi', size: 2048, event: 'greet', eventId: '7' }, { prevAt: AT - 123 }));
    expect(html).toContain('2.0 KB');
    expect(html).toContain('+123 ms');
    expect(html).toContain('greet');
    expect(html).toContain('id 7');
  });

  test('event badge colour is stable per name', () => {
    expect(eventBadgeClass('content_block_delta')).toBe(eventBadgeClass('content_block_delta'));
    expect(row({ data: 'x', event: 'ping' })).toContain(eventBadgeClass('ping'));
  });

  test('long payload is clipped with a show-all button', () => {
    const html = text(row({ data: 'y'.repeat(5000), size: 5000 }, { pretty: false }));
    expect(html).toContain('show all 4.9 KB');
    expect(html.match(/y+/)![0].length).toBe(2000);
  });

  test('binary and truncated frames are labelled', () => {
    expect(text(row({ data: 'AQID', binary: true, size: 3 }))).toContain('binary · base64 AQID');
    expect(text(row({ data: 'x', truncated: true, size: 614400 }))).toContain('frame was 600.0 KB');
  });

  test('[DONE] is a divider, not a message', () => {
    const html = row({ data: '[DONE]', size: 6 });
    expect(text(html)).toContain('[DONE] · stream finished');
    expect(html).not.toContain('Copy message');
  });

  test('a folded run says how many deltas it holds', () => {
    expect(text(row({ data: 'Hello world', merged: 3, event: 'content_block_delta' }))).toContain('3 deltas');
    expect(text(row({ data: 'Hi', merged: 1 }))).toContain('1 delta');
  });

  test('resend only on sent rows, only when offered', () => {
    expect(row({ type: 'send', data: 'a', size: 1 }, { onResend: noop })).toContain('Send again');
    expect(row({ type: 'send', data: 'a', size: 1 })).not.toContain('Send again');
    expect(row({ data: 'a', size: 1 }, { onResend: noop })).not.toContain('Send again');
  });

  test('tree toggle only for JSON-looking payloads', () => {
    expect(row({ data: '[1]', size: 3 })).toContain('Show as tree');
    expect(row({ data: 'plain', size: 5 })).not.toContain('Show as tree');
  });

  test('info / error / heartbeat are quiet single lines', () => {
    expect(row({ type: 'error', data: 'boom' })).toContain('text-red-600');
    expect(text(row({ type: 'heartbeat', data: 'ping', size: 8 }))).toContain('ping');
    expect(row({ type: 'info', data: 'Connected' })).not.toContain('Copy message');
  });
});

describe('logView', () => {
  const log: RealtimeMessage[] = [
    { id: '1', type: 'info', at: 1, data: 'Connected' },
    { id: '2', type: 'send', at: 2, data: 'Hello' },
    { id: '3', type: 'receive', at: 3, data: 'hello back', event: 'greet' },
    { id: '4', type: 'receive', at: 4, data: 'plain' },
    { id: '5', type: 'error', at: 5, data: 'Closed · code 1006' },
  ];

  test('countByType', () => {
    expect(countByType(log)).toEqual({ all: 5, send: 1, receive: 2, info: 1, error: 1, heartbeat: 0 });
  });

  test('countEvents names the default event "message"', () => {
    expect(countEvents(log)).toEqual([
      ['greet', 1],
      ['message', 1],
    ]);
  });

  test('filterLog by type, text (case-insensitive) and event name', () => {
    expect(filterLog(log, 'all', '')).toBe(log);
    expect(filterLog(log, 'receive', '').map((m) => m.id)).toEqual(['3', '4']);
    expect(filterLog(log, 'all', 'HELLO').map((m) => m.id)).toEqual(['2', '3']);
    expect(filterLog(log, 'all', 'greet').map((m) => m.id)).toEqual(['3']);
    expect(filterLog(log, 'all', '', 'message').map((m) => m.id)).toEqual(['4']);
    expect(filterLog(log, 'send', 'back')).toEqual([]);
  });

  test('compactDeltas keeps non-delta rows as they are', () => {
    expect(compactDeltas(log)).toEqual(log);
  });
});

describe('LogToolbar', () => {
  const counts = { all: 4, send: 1, receive: 1, info: 1, error: 1, heartbeat: 0 };
  const bar = (props: Partial<Parameters<typeof LogToolbar>[0]> = {}) =>
    renderToStaticMarkup(
      <LogToolbar
        isWs
        counts={counts}
        shown={4}
        filter="all"
        onFilter={noop}
        query=""
        onQuery={noop}
        pretty
        onPretty={noop}
        onExport={noop}
        onClear={noop}
        {...props}
      />,
    );

  test('ws shows Send, sse hides it; heartbeat hidden until there is one', () => {
    expect(text(bar())).toContain('Send');
    expect(text(bar({ isWs: false }))).not.toContain('Send');
    expect(text(bar())).not.toContain('Heartbeat');
    expect(text(bar({ counts: { ...counts, heartbeat: 2 } }))).toContain('Heartbeat2');
  });

  test('shown/total appears only while narrowed', () => {
    expect(text(bar())).not.toContain('4/4');
    expect(text(bar({ filter: 'send', shown: 1 }))).toContain('1/4');
    expect(text(bar({ eventName: 'ping', shown: 1, onEventName: noop }))).toContain('1/4');
  });

  test('event chips need two names; compact toggle needs deltas', () => {
    const one: [string, number][] = [['message', 3]];
    const two: [string, number][] = [
      ['message_start', 1],
      ['content_block_delta', 9],
    ];
    expect(text(bar({ isWs: false, events: one, onEventName: noop }))).not.toContain('Events');
    expect(text(bar({ isWs: false, events: two, onEventName: noop }))).toContain('content_block_delta 9');
    expect(text(bar())).not.toContain('Compact');
    expect(text(bar({ compact: true, onCompact: noop }))).toContain('Compact');
  });
});

describe('Composer', () => {
  const c = (draft: string, connected = true) =>
    renderToStaticMarkup(<Composer tabId="t" draft={draft} onDraft={noop} connected={connected} onToast={noop} />);

  test('valid JSON: badge, format/minify enabled, byte size', () => {
    const html = c('{"a":"é"}');
    expect(text(html)).toContain('Valid JSON');
    expect(isDisabled(html, 'Format')).toBe(false);
    expect(text(html)).toContain('10 B');
  });

  test('invalid JSON: red badge with the parser message, format disabled', () => {
    const html = c('{"a":');
    expect(text(html)).toContain('Invalid JSON');
    expect(html).toMatch(/title="[^"]+"/);
    expect(isDisabled(html, 'Format')).toBe(true);
  });

  test('plain text gets no verdict', () => {
    const html = text(c('hello'));
    expect(html).not.toContain('Valid JSON');
    expect(html).not.toContain('Invalid JSON');
  });

  test('send disabled while disconnected or empty', () => {
    expect(isDisabled(c('x', false), 'Send')).toBe(true);
    expect(isDisabled(c('', true), 'Send')).toBe(true);
    expect(isDisabled(c('x', true), 'Send')).toBe(false);
  });
});

describe('StreamText', () => {
  const view = (stream: Partial<RTStream>, live = false) =>
    text(
      renderToStaticMarkup(
        <StreamText stream={{ text: '', deltas: 0, done: false, ...stream }} live={live} onCopy={noop} />,
      ),
    );

  test('empty state explains what fills it', () => {
    expect(view({})).toContain('No completion text yet');
  });

  test('TTFT from connect; rate in tokens when reported', () => {
    const html = view({ text: 'Hello world', deltas: 3, tokens: 11, startedAt: 1000, firstAt: 1250, lastAt: 2250, done: true });
    expect(html).toContain('TTFT 250 ms');
    expect(html).toContain('10.0 tok/s'); // (11 - 1) tokens over 1 s
    expect(html).toContain('3 deltas · 11 chars');
    expect(html).toContain('finished');
    expect(html).toContain('Hello world');
  });

  test('rate falls back to events per second', () => {
    expect(view({ text: 'abc', deltas: 3, startedAt: 0, firstAt: 100, lastAt: 1100 }, true)).toContain('2.0 ev/s');
  });

  test('status follows the connection', () => {
    expect(view({}, true)).toContain('waiting…');
    expect(view({ text: 'a', deltas: 1 }, true)).toContain('streaming…');
    expect(view({ text: 'a', deltas: 1 }, false)).toContain('ended');
  });
});
