// Comparing two responses: a structural JSON diff by path, a line diff for
// anything else, and a header diff. Plain functions — the compare dialog
// renders them, the tests pin them down.
//
// Paths use the JSON tree's own notation ($.data.0.id), so a path copied from
// the Tree view works as an ignore pattern here and as an assertion source in
// the Tests tab.

// ─── ignore patterns ──────────────────────────────────────────────────────────

/** Volatile on every call: ids and clocks a regression diff should not flag.
 *  Root-level `id`/`created` only — an `id` deeper down is usually data. */
export const DEFAULT_BODY_IGNORE = [
  '$.id',
  '$.created',
  '$.system_fingerprint',
  '**.request_id',
  '**.requestId',
  '**.timestamp',
];

export const DEFAULT_HEADER_IGNORE = [
  'date',
  'age',
  'etag',
  'set-cookie',
  'content-length',
  'cf-ray',
  'x-request-id',
  'request-id',
  'x-amzn-*',
  'x-amz-*',
  'traceparent',
  'server-timing',
  'x-ratelimit-*',
  'openai-processing-ms',
  'x-envoy-upstream-service-time',
  'alt-svc',
  'nel',
  'report-to',
];

/** Split "a, b\nc" into patterns. */
export function parsePatterns(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** `$.a.b` from the root; `*` is one segment, `**` any number of them. A
 *  pattern without the leading `$` may start at any depth: `id` is `$.**.id`. */
function segmentsOf(pattern: string): string[] {
  const p = pattern.trim();
  if (p === '$') return [];
  if (p.startsWith('$.')) return p.slice(2).split('.');
  return ['**', ...p.split('.')];
}

function matchSegments(pat: string[], path: string[]): boolean {
  if (pat.length === 0) return path.length === 0;
  const [head, ...rest] = pat;
  if (head === '**') {
    for (let i = 0; i <= path.length; i++) if (matchSegments(rest, path.slice(i))) return true;
    return false;
  }
  if (path.length === 0) return false;
  return (head === '*' || head === path[0]) && matchSegments(rest, path.slice(1));
}

export function matchesPath(pattern: string, path: string): boolean {
  const segs = path === '$' ? [] : path.replace(/^\$\./, '').split('.');
  return matchSegments(segmentsOf(pattern), segs);
}

/** Header names: case-insensitive, `*` matches anything. */
function matchesHeader(pattern: string, name: string): boolean {
  const re = new RegExp(`^${pattern.trim().toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return re.test(name.toLowerCase());
}

// ─── JSON ─────────────────────────────────────────────────────────────────────

export type ChangeKind = 'added' | 'removed' | 'changed';

export interface JsonChange {
  path: string;
  kind: ChangeKind;
  left?: unknown;
  right?: unknown;
}

export interface JsonDiff {
  changes: JsonChange[];
  /** differences that matched an ignore pattern */
  ignored: number;
}

export interface JsonDiffOptions {
  ignore?: string[];
  /** compare keys and types only — the values are bound to differ (two LLMs) */
  shape?: boolean;
}

type Kind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

function kindOf(v: unknown): Kind {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v as Kind;
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const ka = kindOf(a);
  if (ka !== kindOf(b)) return false;
  if (ka === 'array') {
    const x = a as unknown[];
    const y = b as unknown[];
    return x.length === y.length && x.every((v, i) => equal(v, y[i]));
  }
  if (ka === 'object') {
    const x = a as Record<string, unknown>;
    const y = b as Record<string, unknown>;
    const keys = Object.keys(x);
    return keys.length === Object.keys(y).length && keys.every((k) => k in y && equal(x[k], y[k]));
  }
  return false;
}

/** What a value looks like, not what it says: objects keep their keys, arrays
 *  collapse into the merged shape of their elements, the rest is a type name. */
export function shapeOf(v: unknown): unknown {
  const k = kindOf(v);
  if (k === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([key, val]) => [key, shapeOf(val)]));
  }
  if (k === 'array') {
    const items = (v as unknown[]).map(shapeOf);
    return items.length ? [items.reduce(mergeShapes)] : [];
  }
  return k;
}

function mergeShapes(a: unknown, b: unknown): unknown {
  const ka = kindOf(a);
  const kb = kindOf(b);
  if (ka === 'object' && kb === 'object') {
    const x = a as Record<string, unknown>;
    const y = b as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
      out[key] = key in x && key in y ? mergeShapes(x[key], y[key]) : (x[key] ?? y[key]);
    }
    return out;
  }
  if (ka === 'array' && kb === 'array') {
    const x = a as unknown[];
    const y = b as unknown[];
    if (!x.length) return y;
    if (!y.length) return x;
    return [mergeShapes(x[0], y[0])];
  }
  if (equal(a, b)) return a;
  // two element types in one array: "number|string"
  const names = new Set([...String(ka === 'string' ? a : ka).split('|'), ...String(kb === 'string' ? b : kb).split('|')]);
  return [...names].sort().join('|');
}

/** Where two JSON values differ, path by path. Arrays compare by index. */
export function diffJson(a: unknown, b: unknown, opts: JsonDiffOptions = {}): JsonDiff {
  const ignore = opts.ignore ?? [];
  const out: JsonDiff = { changes: [], ignored: 0 };
  const left = opts.shape ? shapeOf(a) : a;
  const right = opts.shape ? shapeOf(b) : b;

  const walk = (x: unknown, y: unknown, path: string, hasX: boolean, hasY: boolean) => {
    if (hasX && hasY && equal(x, y)) return;
    if (ignore.some((p) => matchesPath(p, path))) {
      out.ignored++;
      return;
    }
    if (!hasX) return void out.changes.push({ path, kind: 'added', right: y });
    if (!hasY) return void out.changes.push({ path, kind: 'removed', left: x });
    const kx = kindOf(x);
    if (kx !== kindOf(y) || (kx !== 'object' && kx !== 'array')) {
      return void out.changes.push({ path, kind: 'changed', left: x, right: y });
    }
    if (kx === 'object') {
      const ox = x as Record<string, unknown>;
      const oy = y as Record<string, unknown>;
      for (const key of new Set([...Object.keys(ox), ...Object.keys(oy)])) {
        walk(ox[key], oy[key], `${path}.${key}`, key in ox, key in oy);
      }
      return;
    }
    const ax = x as unknown[];
    const ay = y as unknown[];
    // in shape mode an array is one merged element: call its slot `*`
    if (opts.shape) return walk(ax[0], ay[0], `${path}.*`, ax.length > 0, ay.length > 0);
    for (let i = 0; i < Math.max(ax.length, ay.length); i++) {
      walk(ax[i], ay[i], `${path}.${i}`, i < ax.length, i < ay.length);
    }
  };

  walk(left, right, '$', true, true);
  return out;
}

/** Keys in a stable order, so a line diff of two JSON bodies shows what
 *  changed rather than what moved. */
export function canonicalJson(v: unknown): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === 'object') {
      return Object.fromEntries(
        Object.keys(x as Record<string, unknown>)
          .sort()
          .map((k) => [k, sort((x as Record<string, unknown>)[k])]),
      );
    }
    return x;
  };
  return JSON.stringify(sort(v), null, 2);
}

// ─── lines ────────────────────────────────────────────────────────────────────

export interface LineOp {
  op: 'equal' | 'add' | 'del';
  text: string;
}

/** Past this many cells (changed lines on one side × the other) the LCS table
 *  would cost more than the diff is worth in a browser tab. */
const LCS_CELL_LIMIT = 4_000_000;

/** A line diff: common head and tail trimmed, LCS on what's left. Null when
 *  what's left is too big to diff here. */
export function diffLines(a: string, b: string): LineOp[] | null {
  const x = a.split('\n');
  const y = b.split('\n');
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) head++;
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;

  const mx = x.slice(head, x.length - tail);
  const my = y.slice(head, y.length - tail);
  const n = mx.length;
  const m = my.length;
  if (n * m > LCS_CELL_LIMIT) return null;

  // lcs[i][j] = LCS length of mx[i..] and my[j..], flattened
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = mx[i] === my[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    }
  }

  const ops: LineOp[] = x.slice(0, head).map((text) => ({ op: 'equal', text }));
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (mx[i] === my[j]) {
      ops.push({ op: 'equal', text: mx[i++]! });
      j++;
    } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) ops.push({ op: 'del', text: mx[i++]! });
    else ops.push({ op: 'add', text: my[j++]! });
  }
  while (i < n) ops.push({ op: 'del', text: mx[i++]! });
  while (j < m) ops.push({ op: 'add', text: my[j++]! });
  for (const text of x.slice(x.length - tail)) ops.push({ op: 'equal', text });
  return ops;
}

export type Hunk = { kind: 'lines'; ops: LineOp[] } | { kind: 'skip'; count: number };

/** Long unchanged stretches fold away, keeping `context` lines around each change. */
export function toHunks(ops: LineOp[], context = 3): Hunk[] {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.op === 'equal') return;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true;
  });
  const hunks: Hunk[] = [];
  for (let i = 0; i < ops.length; ) {
    const start = i;
    const kept = keep[i];
    while (i < ops.length && keep[i] === kept) i++;
    hunks.push(kept ? { kind: 'lines', ops: ops.slice(start, i) } : { kind: 'skip', count: i - start });
  }
  return hunks;
}

// ─── headers ──────────────────────────────────────────────────────────────────

export interface HeaderRow {
  name: string;
  left?: string;
  right?: string;
  kind: ChangeKind | 'same';
}

export function diffHeaders(
  a: Record<string, string>,
  b: Record<string, string>,
  ignore: string[] = [],
): { rows: HeaderRow[]; ignored: number } {
  const lower = (h: Record<string, string>) =>
    Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
  const x = lower(a);
  const y = lower(b);
  const rows: HeaderRow[] = [];
  let ignored = 0;
  for (const name of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()) {
    const kind: HeaderRow['kind'] =
      !(name in x) ? 'added' : !(name in y) ? 'removed' : x[name] === y[name] ? 'same' : 'changed';
    if (kind !== 'same' && ignore.some((p) => matchesHeader(p, name))) {
      ignored++;
      continue;
    }
    rows.push({ name, left: x[name], right: y[name], kind });
  }
  return { rows, ignored };
}
