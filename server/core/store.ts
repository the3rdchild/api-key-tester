// Store: load/save store.json (canonical) + history.jsonl
// Handles two-way merge with keys.md via parser/writer.

import { nanoid } from 'nanoid';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HistoryEntry, KeyEntry } from '../../shared/types.ts';
import { parseMarkdown, parsedToEntry, type ParsedEntry } from './parser.ts';
import { writeMarkdown } from './writer.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = resolve(__dirname, '../..');
export const STORE_PATH = resolve(ROOT_DIR, 'store.json');
export const KEYS_MD_PATH = resolve(ROOT_DIR, 'keys.md');
export const HISTORY_PATH = resolve(ROOT_DIR, 'history.jsonl');

const HISTORY_MAX_PER_KEY = 50;

export interface StoreState {
  version: 1;
  keys: KeyEntry[];
  /** checksum of last keys.md we parsed, to skip re-parsing if unchanged */
  mdChecksum?: string;
}

let memKeys: KeyEntry[] | null = null;
let emitChange: (() => void) | null = null;

export function setChangeEmitter(fn: () => void): void {
  emitChange = fn;
}

function changed(): void {
  emitChange?.();
}

// ─── Load ───────────────────────────────────────────────────────────────────
export async function loadStore(): Promise<KeyEntry[]> {
  if (memKeys) return memKeys;

  if (existsSync(STORE_PATH)) {
    try {
      const raw = await readFile(STORE_PATH, 'utf8');
      const data = JSON.parse(raw) as StoreState;
      if (Array.isArray(data.keys)) {
        memKeys = data.keys;
        return memKeys;
      }
    } catch (e) {
      console.warn('[store] store.json corrupt, re-parsing keys.md:', e);
    }
  }

  // First-run bootstrap: parse keys.md
  memKeys = await bootstrapFromKeysMD();
  await persist();
  return memKeys;
}

async function bootstrapFromKeysMD(): Promise<KeyEntry[]> {
  if (!existsSync(KEYS_MD_PATH)) return [];
  const md = await readFile(KEYS_MD_PATH, 'utf8');
  const parsed = parseMarkdown(md);
  return parsed.map((p) => parsedToEntry(p, () => nanoid(12)));
}

// ─── Save ───────────────────────────────────────────────────────────────────
export async function persist(): Promise<void> {
  if (!memKeys) return;
  const state: StoreState = { version: 1, keys: memKeys };
  await writeFile(STORE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

// ─── CRUD ───────────────────────────────────────────────────────────────────
export async function getAllKeys(): Promise<KeyEntry[]> {
  return loadStore();
}

export async function getKey(id: string): Promise<KeyEntry | undefined> {
  return (await loadStore()).find((k) => k.id === id);
}

export async function createKey(
  input: Omit<KeyEntry, 'id' | 'status' | 'createdAt' | 'updatedAt'>,
): Promise<KeyEntry> {
  const keys = await loadStore();
  const now = new Date().toISOString();
  const entry: KeyEntry = {
    ...input,
    id: nanoid(12),
    status: { state: 'untested' },
    createdAt: now,
    updatedAt: now,
  };
  keys.push(entry);
  await persist();
  await writeMDMirror();
  changed();
  return entry;
}

export async function updateKey(
  id: string,
  patch: Partial<Omit<KeyEntry, 'id' | 'createdAt'>>,
): Promise<KeyEntry | undefined> {
  const keys = await loadStore();
  const idx = keys.findIndex((k) => k.id === id);
  if (idx === -1) return undefined;
  const before = keys[idx];
  const next: KeyEntry = {
    ...before,
    ...patch,
    credentials: patch.credentials ?? before.credentials,
    status: patch.status ?? before.status,
    updatedAt: new Date().toISOString(),
  };
  keys[idx] = next;
  await persist();
  await writeMDMirror();
  changed();
  return next;
}

export async function deleteKey(id: string): Promise<boolean> {
  const keys = await loadStore();
  const idx = keys.findIndex((k) => k.id === id);
  if (idx === -1) return false;
  keys.splice(idx, 1);
  await persist();
  await writeMDMirror();
  changed();
  return true;
}

export interface ImportResult {
  created: KeyEntry[];
  /** indices into the input array that were skipped as duplicates */
  skippedIndices: number[];
  /** indices that were merged into an existing entry (updated creds) */
  mergedIndices: number[];
}

/**
 * Append parsed entries. By default skips duplicates: an entry is considered
 * a duplicate if (provider + main-credential-prefix-8) already exists in the store.
 * Set `dedup: false` to force-append (legacy behavior).
 * Set `mergeExisting: true` to update credentials of existing matching entries
 * instead of skipping them.
 */
export async function appendParsed(
  parsed: ParsedEntry[],
  opts: { dedup?: boolean; mergeExisting?: boolean } = {},
): Promise<ImportResult> {
  const { dedup = true, mergeExisting = false } = opts;
  const keys = await loadStore();

  // build existence index
  // - for entries with a main credential (apiKey/secret/accessKeyId): match by provider + prefix8
  // - for reference entries (no main cred): match by provider + label (label is
  //   unique enough for reference entries, and section isn't always preserved
  //   through CSV round-trips)
  const existingByPrefix = new Map<string, number>();
  const existingByLabel = new Map<string, number>();
  keys.forEach((k, i) => {
    const main = mainCred(k.credentials);
    if (main) {
      existingByPrefix.set(`${k.provider}::${main.slice(0, 8)}`, i);
    } else {
      existingByLabel.set(`${k.provider}::${k.label || ''}`, i);
    }
  });

  const created: KeyEntry[] = [];
  const skippedIndices: number[] = [];
  const mergedIndices: number[] = [];

  parsed.forEach((p, idx) => {
    const main = mainCred(p.credentials);
    const key = main ? `${p.provider}::${main.slice(0, 8)}` : '';
    const labelKey = !main ? `${p.provider}::${p.label || ''}` : '';
    const existingIdx = key
      ? existingByPrefix.get(key)
      : labelKey
        ? existingByLabel.get(labelKey)
        : undefined;
    if (existingIdx !== undefined) {
      if (mergeExisting) {
        // overwrite creds/label, preserve id + status + history
        const before = keys[existingIdx];
        keys[existingIdx] = {
          ...before,
          credentials: { ...p.credentials },
          label: p.label ?? before.label,
          note: p.note ?? before.note,
          section: p.section ?? before.section,
          testable: p.testable,
          updatedAt: new Date().toISOString(),
        };
        mergedIndices.push(idx);
      } else {
        skippedIndices.push(idx);
      }
      return;
    }
    const entry = parsedToEntry(p, () => nanoid(12));
    keys.push(entry);
    if (key) existingByPrefix.set(key, keys.length - 1);
    else if (labelKey) existingByLabel.set(labelKey, keys.length - 1);
    created.push(entry);
  });

  await persist();
  if (created.length > 0 || mergedIndices.length > 0) {
    await writeMDMirror();
  }
  changed();
  return { created, skippedIndices, mergedIndices };
}

function mainCred(creds: Record<string, string>): string | undefined {
  return creds.apiKey || creds.apiSecret || creds.accessKeyId;
}

// ─── Status update (called by runner) ───────────────────────────────────────
export async function setStatus(
  id: string,
  status: KeyEntry['status'],
): Promise<void> {
  const keys = await loadStore();
  const idx = keys.findIndex((k) => k.id === id);
  if (idx === -1) return;
  keys[idx].status = status;
  keys[idx].updatedAt = new Date().toISOString();
  // status lives in store.json only — do NOT touch keys.md here
  await persist();
  changed();
}

// ─── keys.md mirror ────────────────────────────────────────────────────────
// Mirror is OFF by default to prevent the writer from destroying unparsed
// content (account info, example code, free-form notes) in keys.md. Enable
// via env var KEYTESTER_MIRROR_MD=1 if you want UI edits to rewrite the file.
const MIRROR_TO_MD = process.env.KEYTESTER_MIRROR_MD === '1' ||
  process.env.KEYTESTER_MIRROR_MD === 'true';

export async function writeMDMirror(): Promise<void> {
  if (!MIRROR_TO_MD) return;
  const keys = await loadStore();
  const md = writeMarkdown(keys);
  await writeFile(KEYS_MD_PATH, md, 'utf8');
  // notify the watcher this was our own write (avoid feedback loop)
  markSelfWriteHook?.();
}

export function isMirrorEnabled(): boolean {
  return MIRROR_TO_MD;
}

let markSelfWriteHook: (() => void) | null = null;
export function setMarkSelfWriteHook(fn: () => void): void {
  markSelfWriteHook = fn;
}

// ─── External file watcher merge ────────────────────────────────────────────
// Called when keys.md changes on disk (not from our own write).
export async function mergeFromMD(): Promise<{ changed: boolean; keys: KeyEntry[] }> {
  if (!existsSync(KEYS_MD_PATH)) return { changed: false, keys: memKeys || [] };
  const md = await readFile(KEYS_MD_PATH, 'utf8');
  const parsed = parseMarkdown(md);
  const keys = await loadStore();

  // Build match index: by (provider + apiKeyPrefix8) when possible, else by label+section.
  const matchKey = (p: ParsedEntry): string => {
    const k = p.credentials.apiKey || p.credentials.apiSecret || p.credentials.accessKeyId || '';
    const prefix = k.slice(0, 8);
    return `${p.provider}::${prefix}::${p.section || ''}`;
  };

  const existingIndex = new Map<string, number>();
  keys.forEach((k, i) => {
    const kk = k.credentials.apiKey || k.credentials.apiSecret || k.credentials.accessKeyId || '';
    existingIndex.set(`${k.provider}::${kk.slice(0, 8)}::${k.section || ''}`, i);
  });

  let didChange = false;
  const usedExisting = new Set<number>();
  const nextKeys: KeyEntry[] = [];

  for (const p of parsed) {
    const key = matchKey(p);
    const idx = existingIndex.get(key);
    if (idx !== undefined && !usedExisting.has(idx)) {
      usedExisting.add(idx);
      const before = keys[idx];
      // update creds/label/note from md; preserve id + status + timestamps
      const merged: KeyEntry = {
        ...before,
        credentials: p.credentials,
        label: p.label ?? before.label,
        note: p.note ?? before.note,
        section: p.section ?? before.section,
        testable: p.testable,
        updatedAt: new Date().toISOString(),
      };
      if (JSON.stringify(merged.credentials) !== JSON.stringify(before.credentials)) {
        didChange = true;
      }
      nextKeys.push(merged);
    } else {
      // brand new entry from md
      nextKeys.push(parsedToEntry(p, () => nanoid(12)));
      didChange = true;
    }
  }

  // Entries deleted from md: drop them (md is source of truth for creds presence)
  if (nextKeys.length !== keys.length) didChange = true;

  if (didChange) {
    memKeys = nextKeys;
    await persist();
    changed();
  }
  return { changed: didChange, keys: memKeys ?? [] };
}

// ─── History ────────────────────────────────────────────────────────────────
export async function appendHistory(entry: HistoryEntry): Promise<void> {
  try {
    await appendFile(HISTORY_PATH, JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
    console.warn('[history] append failed:', e);
  }
  await trimHistory();
}

async function trimHistory(): Promise<void> {
  if (!existsSync(HISTORY_PATH)) return;
  try {
    const raw = await readFile(HISTORY_PATH, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const all = lines.map((l) => JSON.parse(l) as HistoryEntry);
    const byKey = new Map<string, HistoryEntry[]>();
    for (const h of all) {
      if (!byKey.has(h.keyId)) byKey.set(h.keyId, []);
      byKey.get(h.keyId)!.push(h);
    }
    const trimmed: HistoryEntry[] = [];
    for (const arr of byKey.values()) {
      const recent = arr.slice(-HISTORY_MAX_PER_KEY);
      trimmed.push(...recent);
    }
    if (trimmed.length !== all.length) {
      const out = trimmed.map((h) => JSON.stringify(h)).join('\n') + '\n';
      await writeFile(HISTORY_PATH, out, 'utf8');
    }
  } catch (e) {
    console.warn('[history] trim failed:', e);
  }
}

export async function getHistory(keyId?: string): Promise<HistoryEntry[]> {
  if (!existsSync(HISTORY_PATH)) return [];
  const raw = await readFile(HISTORY_PATH, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const all: HistoryEntry[] = [];
  for (const l of lines) {
    try {
      const h = JSON.parse(l) as HistoryEntry;
      if (!keyId || h.keyId === keyId) all.push(h);
    } catch {
      /* skip malformed */
    }
  }
  return all;
}

// Reset in-memory cache (for watcher tests / reload)
export function _resetCacheForTests(): void {
  memKeys = null;
}

// Ensure data dir exists (no-op here, files live in root)
export async function ensureDataDir(): Promise<void> {
  await mkdir(ROOT_DIR, { recursive: true });
}
