// The response-diff engine: JSON by path (values and shape), ignore patterns,
// the line diff and its hunks, and headers.

import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_BODY_IGNORE,
  canonicalJson,
  diffHeaders,
  diffJson,
  diffLines,
  matchesPath,
  parsePatterns,
  shapeOf,
  toHunks,
} from '../ui/src/lib/diff.ts';

describe('ignore patterns', () => {
  test('$ anchors at the root, a bare pattern matches at any depth', () => {
    expect(matchesPath('$.id', '$.id')).toBe(true);
    expect(matchesPath('$.id', '$.data.id')).toBe(false);
    expect(matchesPath('id', '$.data.0.id')).toBe(true);
    expect(matchesPath('**.request_id', '$.request_id')).toBe(true);
    expect(matchesPath('$.data.*.id', '$.data.3.id')).toBe(true);
    expect(matchesPath('$.data.*.id', '$.data.3.meta.id')).toBe(false);
    expect(matchesPath('$.data.**', '$.data.3.meta.id')).toBe(true);
    expect(matchesPath('user.name', '$.a.user.name')).toBe(true);
  });

  test('parsePatterns takes commas and newlines', () => {
    expect(parsePatterns(' $.id, **.ts\n\n date ')).toEqual(['$.id', '**.ts', 'date']);
  });
});

describe('diffJson', () => {
  const a = { id: 'chatcmpl-1', created: 1, model: 'x', data: [{ id: 1, name: 'a' }, { id: 2 }], extra: true };
  const b = { id: 'chatcmpl-2', created: 2, model: 'y', data: [{ id: 1, name: 'b' }], added: null };

  test('value changes, additions and removals by path', () => {
    expect(diffJson(a, b).changes).toEqual([
      { path: '$.id', kind: 'changed', left: 'chatcmpl-1', right: 'chatcmpl-2' },
      { path: '$.created', kind: 'changed', left: 1, right: 2 },
      { path: '$.model', kind: 'changed', left: 'x', right: 'y' },
      { path: '$.data.0.name', kind: 'changed', left: 'a', right: 'b' },
      { path: '$.data.1', kind: 'removed', left: { id: 2 } },
      { path: '$.extra', kind: 'removed', left: true },
      { path: '$.added', kind: 'added', right: null },
    ]);
  });

  test('the default ignores drop the per-call noise and count it', () => {
    const d = diffJson(a, b, { ignore: DEFAULT_BODY_IGNORE });
    expect(d.ignored).toBe(2);
    expect(d.changes.map((c) => c.path)).toEqual(['$.model', '$.data.0.name', '$.data.1', '$.extra', '$.added']);
  });

  test('an ignored subtree is one ignored difference', () => {
    const d = diffJson({ usage: { a: 1, b: 2 } }, { usage: { a: 2, b: 3 } }, { ignore: ['$.usage'] });
    expect(d).toEqual({ changes: [], ignored: 1 });
  });

  test('a type change is a change, not a walk into both', () => {
    expect(diffJson({ v: [1] }, { v: { 0: 1 } }).changes).toEqual([{ path: '$.v', kind: 'changed', left: [1], right: { 0: 1 } }]);
  });

  test('equal values: nothing to report', () => {
    expect(diffJson({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toEqual({ changes: [], ignored: 0 });
  });

  test('shape mode: two providers saying different things the same way are equal', () => {
    const one = { choices: [{ message: { content: 'Hello' } }], usage: { total_tokens: 12 } };
    const two = { choices: [{ message: { content: 'Bonjour' } }, { message: { content: 'x' } }], usage: { total_tokens: 99 } };
    expect(diffJson(one, two, { shape: true }).changes).toEqual([]);
  });

  test('shape mode reports keys and types, arrays as their merged element', () => {
    const one = { choices: [{ text: 'a' }], usage: { total_tokens: 1 } };
    const two = { choices: [{ text: 'b', logprobs: null }], usage: { total_tokens: '1' } };
    expect(diffJson(one, two, { shape: true }).changes).toEqual([
      { path: '$.choices.*.logprobs', kind: 'added', right: 'null' },
      { path: '$.usage.total_tokens', kind: 'changed', left: 'number', right: 'string' },
    ]);
  });

  test('shapeOf merges array elements', () => {
    expect(shapeOf([{ a: 1 }, { b: 'x' }, { a: 's' }])).toEqual([{ a: 'number|string', b: 'string' }]);
    expect(shapeOf([])).toEqual([]);
  });

  test('canonicalJson sorts keys so moves are not changes', () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe(canonicalJson({ a: { c: 2, d: 1 }, b: 1 }));
  });
});

describe('diffLines', () => {
  test('keeps the common head and tail, marks what changed', () => {
    expect(diffLines('a\nb\nc\nd', 'a\nx\nc\nd\ne')).toEqual([
      { op: 'equal', text: 'a' },
      { op: 'del', text: 'b' },
      { op: 'add', text: 'x' },
      { op: 'equal', text: 'c' },
      { op: 'equal', text: 'd' },
      { op: 'add', text: 'e' },
    ]);
  });

  test('identical text is all equal', () => {
    expect(diffLines('same\ntext', 'same\ntext')!.every((o) => o.op === 'equal')).toBe(true);
  });

  test('too big to diff comes back null instead of freezing the tab', () => {
    const big = (p: string) => Array.from({ length: 3000 }, (_, i) => `${p}${i}`).join('\n');
    expect(diffLines(big('a'), big('b'))).toBeNull();
  });

  test('hunks fold long unchanged runs, keeping context', () => {
    const a = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    const b = a.replace('l10', 'L10');
    const hunks = toHunks(diffLines(a, b)!, 2);
    expect(hunks.map((h) => (h.kind === 'skip' ? `skip ${h.count}` : h.ops.map((o) => o.op[0]).join('')))).toEqual([
      'skip 8', // l0–l7
      'eedaee', // l8 l9 −l10 +L10 l11 l12
      'skip 7', // l13–l19
    ]);
  });
});

describe('diffHeaders', () => {
  test('case-insensitive, sorted, ignore patterns with wildcards', () => {
    const { rows, ignored } = diffHeaders(
      { 'Content-Type': 'application/json', Date: 'x', 'X-RateLimit-Remaining': '9', Server: 'a' },
      { 'content-type': 'application/json', date: 'y', 'x-ratelimit-remaining': '8', via: '1.1' },
      ['date', 'x-ratelimit-*'],
    );
    expect(ignored).toBe(2);
    expect(rows).toEqual([
      { name: 'content-type', left: 'application/json', right: 'application/json', kind: 'same' },
      { name: 'server', left: 'a', right: undefined, kind: 'removed' },
      { name: 'via', left: undefined, right: '1.1', kind: 'added' },
    ]);
  });
});
