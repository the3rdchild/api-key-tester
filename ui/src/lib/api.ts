import type { FieldDef, KeyEntry, Provider, ProviderKind } from '../../../shared/types.ts';

export interface ProviderInfo {
  id: Provider;
  label: string;
  kind: ProviderKind;
  fields: FieldDef[];
  defaultSection?: string;
}

const API_BASE = '';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = await res.json();
      detail = j.error || detail;
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status}: ${detail}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listKeys: () => req<{ keys: KeyEntry[] }>('/api/keys'),
  listProviders: () => req<{ providers: ProviderInfo[] }>('/api/keys/providers'),
  getKey: (id: string) => req<{ key: KeyEntry }>(`/api/keys/${id}`),
  createKey: (input: Partial<KeyEntry>) =>
    req<{ key: KeyEntry }>('/api/keys', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateKey: (id: string, patch: Partial<KeyEntry>) =>
    req<{ key: KeyEntry }>(`/api/keys/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteKey: (id: string) => req<{ ok: boolean }>(`/api/keys/${id}`, { method: 'DELETE' }),
  testOne: (id: string) => req<{ key: KeyEntry }>(`/api/test/${id}`, { method: 'POST' }),
  testAll: (opts?: { providers?: string[]; states?: string[] }) =>
    req<{ total: number; started: number; skipped: number }>('/api/test-all', {
      method: 'POST',
      body: JSON.stringify(opts || {}),
    }),
  previewImport: (text: string, format?: string) =>
    req<{
      format: string;
      count: number;
      newCount: number;
      duplicateCount: number;
      entries: Array<{
        index: number;
        provider: Provider;
        label?: string;
        testable: boolean;
        warn?: string;
        apiKeyMasked: string;
        duplicate?: boolean;
      }>;
    }>('/api/preview-import', {
      method: 'POST',
      body: JSON.stringify({ text, format }),
    }),
  importText: (
    text: string,
    opts?: { format?: string; mergeExisting?: boolean; allowDuplicates?: boolean },
  ) =>
    req<{
      format: string;
      parsed: number;
      created: number;
      skipped: number;
      merged: number;
      keys: KeyEntry[];
    }>('/api/import', {
      method: 'POST',
      body: JSON.stringify({ text, ...(opts || {}) }),
    }),
  exportURL: (format: 'md' | 'json' | 'env' | 'curl' | 'csv') => `/api/export?format=${format}`,
};
