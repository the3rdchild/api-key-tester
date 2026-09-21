// Shared types used by both server and UI.
// Keep this file dependency-free so it can be imported anywhere.
// (The API-client domain - collections, requests - lives in collections.ts.)

import type {
  MatrixItem,
  MatrixSummary,
  ReqHistoryEntry,
  RunItemResult,
  RunSummary,
} from './collections.ts';

export type Provider =
  // OpenAI-compatible family
  | 'openai'
  | 'deepseek'
  | 'openrouter'
  | 'deepinfra'
  | 'openai-compat' // generic gonka-style proxies
  // Native REST providers
  | 'anthropic'
  | 'gemini'
  | 'perplexity'
  | 'elevenlabs'
  | 'core'
  | 'zai'
  // Storage
  | 'cloudflare-r2'
  | 'do-spaces'
  // Non-testable (reference only)
  | 'reference';

export type ProviderKind = 'llm' | 'tool' | 'storage' | 'reference';

export type TestState =
  | 'untested'
  | 'pending'
  | 'valid'
  | 'invalid'
  | 'rate_limited'
  | 'error';

export interface TestStatus {
  state: TestState;
  httpStatus?: number;
  latencyMs?: number;
  detail?: string;
  /** ISO timestamp of the last test */
  testedAt?: string;
  /** raw response body from the provider (truncated, max ~4 KB) */
  raw?: string;
}

/** Credit / quota left on a key, when the provider exposes it cheaply. */
export interface QuotaInfo {
  /** one-line summary for the table, e.g. "$4.12 of $10 left" */
  summary: string;
  used?: number;
  limit?: number;
  remaining?: number;
  /** USD, characters, requests, … */
  unit?: string;
  /** extra context: tier name, rate limit, free-tier flag */
  detail?: string;
  checkedAt: string;
  error?: string;
}

export interface KeyEntry {
  id: string;
  provider: Provider;
  /** section heading in keys.md, e.g. "--openai" */
  section?: string;
  label?: string;
  /** free-form credentials. shape depends on provider's adapter.fields */
  credentials: Record<string, string>;
  note?: string;
  /** false for entries that are pure account/password info (claude-pro, db passwords) */
  testable: boolean;
  status: TestStatus;
  /** last quota probe, when the provider supports one */
  quota?: QuotaInfo;
  /** ISO timestamps */
  createdAt: string;
  updatedAt: string;
}

export interface TestResult {
  state: Exclude<TestState, 'untested' | 'pending'>;
  httpStatus?: number;
  latencyMs?: number;
  detail?: string;
  /** raw response body from the provider (truncated, max ~4 KB) */
  raw?: string;
}

export interface FieldDef {
  key: string;
  label: string;
  type: 'text' | 'password' | 'url' | 'textarea';
  required?: boolean;
  placeholder?: string;
  help?: string;
}

export interface ProviderDef {
  id: Provider;
  label: string;
  kind: ProviderKind;
  fields: FieldDef[];
  /** markdown section name, e.g. "--openai" */
  defaultSection?: string;
}

export interface HistoryEntry {
  id: string;
  keyId: string;
  ts: string;
  state: TestState;
  httpStatus?: number;
  latencyMs?: number;
  detail?: string;
  /** raw response body from the provider (truncated) */
  raw?: string;
}

// WebSocket event payloads
export type WSEvent =
  | { type: 'test:started'; keyId: string }
  | { type: 'test:done'; keyId: string; status: TestStatus }
  | { type: 'store:changed'; keys: KeyEntry[] }
  | { type: 'collections:changed' }
  | { type: 'benchmark:progress'; stage: string }
  | { type: 'oauth:token'; tokenId: string }
  | { type: 'run:started'; run: RunSummary }
  | { type: 'run:item'; runId: string; item: RunItemResult }
  | { type: 'run:done'; run: RunSummary }
  | { type: 'stream:chunk'; streamId: string; text: string }
  | { type: 'matrix:started'; run: MatrixSummary }
  | { type: 'matrix:item'; runId: string; item: MatrixItem }
  | { type: 'matrix:done'; run: MatrixSummary }
  | { type: 'req-history:appended'; entry: ReqHistoryEntry };

export const STATUS_META: Record<TestState, { label: string; color: string }> = {
  untested: { label: 'Untested', color: 'gray' },
  pending: { label: 'Pending', color: 'blue' },
  valid: { label: 'Valid', color: 'green' },
  invalid: { label: 'Invalid', color: 'red' },
  rate_limited: { label: 'Rate limited', color: 'amber' },
  error: { label: 'Error', color: 'red' },
};

export function maskKey(cred: string, visible = 4): string {
  if (!cred) return '';
  if (cred.length <= visible * 2) return '*'.repeat(cred.length);
  return `${cred.slice(0, visible)}…${cred.slice(-visible)}`;
}
