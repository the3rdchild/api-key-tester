// Declarative assertions - the "Tests" tab without writing code.
//
// Deliberately not a script: source + operator + value covers the checks an
// API client actually needs (status, a field exists, latency budget), stays
// diffable in collections.json, and runs in microseconds.

import type { AssertOp, Assertion, AssertionResult } from '../../shared/collections.ts';

export interface AssertTarget {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  latencyMs: number;
  size: number;
}

const NO_VALUE = Symbol('no value');

function walk(value: unknown, path: string[]): unknown {
  let cur: unknown = value;
  for (const segment of path) {
    if (cur == null) return NO_VALUE;
    if (Array.isArray(cur)) {
      const i = Number(segment);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return NO_VALUE;
      cur = cur[i];
      continue;
    }
    if (typeof cur !== 'object') return NO_VALUE;
    const obj = cur as Record<string, unknown>;
    if (!(segment in obj)) return NO_VALUE;
    cur = obj[segment];
  }
  return cur;
}

function resolve(source: string, target: AssertTarget): unknown {
  const trimmed = source.trim();
  if (trimmed === 'status') return target.status;
  if (trimmed === 'statusText') return target.statusText;
  if (trimmed === 'latencyMs') return target.latencyMs;
  if (trimmed === 'size') return target.size;
  if (trimmed === 'body') return target.body;

  if (trimmed.toLowerCase().startsWith('headers.')) {
    const wanted = trimmed.slice('headers.'.length).toLowerCase();
    for (const [k, v] of Object.entries(target.headers)) {
      if (k.toLowerCase() === wanted) return v;
    }
    return NO_VALUE;
  }

  // Everything else walks into the JSON body: "$.data.0.id" or "body.data.0.id"
  let path = trimmed;
  if (path.startsWith('$.')) path = path.slice(2);
  else if (path.startsWith('body.')) path = path.slice('body.'.length);
  else if (path.startsWith('$')) path = path.slice(1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(target.body);
  } catch {
    return NO_VALUE;
  }
  return walk(parsed, path.split('.').filter(Boolean));
}

function asText(value: unknown): string {
  if (value === NO_VALUE || value === undefined) return '(missing)';
  if (value === null) return 'null';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function compareNumbers(actual: unknown, expected: string | undefined): [number, number] | null {
  const a = Number(actual);
  const b = Number(expected);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return [a, b];
}

export function runAssertions(list: Assertion[] | undefined, target: AssertTarget): AssertionResult[] {
  const out: AssertionResult[] = [];
  for (const a of list ?? []) {
    if (a.enabled === false || !a.source.trim()) continue;
    const actual = resolve(a.source, target);
    const result: AssertionResult = {
      source: a.source,
      op: a.op,
      value: a.value,
      actual: asText(actual),
      passed: false,
    };

    const present = actual !== NO_VALUE && actual !== undefined;
    switch (a.op) {
      case 'exists':
        result.passed = present;
        break;
      case 'notExists':
        result.passed = !present;
        break;
      case 'eq':
      case 'ne': {
        const nums = compareNumbers(actual, a.value);
        const equal = nums ? nums[0] === nums[1] : asText(actual) === (a.value ?? '');
        result.passed = a.op === 'eq' ? equal : !equal;
        break;
      }
      case 'lt':
      case 'lte':
      case 'gt':
      case 'gte': {
        const nums = compareNumbers(actual, a.value);
        if (!nums) {
          result.error = `"${asText(actual)}" and "${a.value ?? ''}" are not both numbers`;
          break;
        }
        const [x, y] = nums;
        result.passed =
          a.op === 'lt' ? x < y : a.op === 'lte' ? x <= y : a.op === 'gt' ? x > y : x >= y;
        break;
      }
      case 'contains':
      case 'notContains': {
        const hay = Array.isArray(actual) ? actual.map(asText) : asText(actual);
        const needle = a.value ?? '';
        const hit = Array.isArray(hay) ? hay.includes(needle) : hay.includes(needle);
        result.passed = a.op === 'contains' ? hit : !hit;
        break;
      }
      case 'matches': {
        try {
          result.passed = new RegExp(a.value ?? '').test(asText(actual));
        } catch (e) {
          result.error = `Invalid regex: ${e instanceof Error ? e.message : e}`;
        }
        break;
      }
    }
    out.push(result);
  }
  return out;
}
