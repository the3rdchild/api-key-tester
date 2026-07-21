// File watcher: monitors keys.md & store.json for external edits.
// On change → mergeFromMD() (debounced 300ms) → WS emit `file:changed`.
//
// Avoids feedback loops: when the server itself writes keys.md via writer.ts,
// it bumps a generation counter; the watcher ignores the immediate event
// whose size/mtime matches its own last write.

import { watch, type FSWatcher } from 'node:fs';
import { existsSync, statSync } from 'node:fs';
import { KEYS_MD_PATH, mergeFromMD } from './store.ts';

let active: FSWatcher | null = null;
let debounce: NodeJS.Timeout | null = null;
let lastSelfWriteMtime = 0;
let onExternalChange: ((path: string) => void) | null = null;

export function markSelfWrite(): void {
  try {
    lastSelfWriteMtime = statSync(KEYS_MD_PATH).mtimeMs;
  } catch {
    lastSelfWriteMtime = Date.now();
  }
}

export function setExternalChangeListener(fn: (path: string) => void): void {
  onExternalChange = fn;
}

export function startWatcher(): void {
  if (active) return;
  if (!existsSync(KEYS_MD_PATH)) {
    console.warn('[watcher] keys.md not found, skipping watch');
    return;
  }

  try {
    active = watch(KEYS_MD_PATH, (eventType) => {
      if (eventType !== 'change') return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(handleChange, 300);
    });
    active.on('error', (e) => {
      console.warn('[watcher] error:', e.message);
    });
    console.log('[watcher] watching keys.md for external changes');
  } catch (e) {
    console.warn('[watcher] failed to start:', e);
  }
}

async function handleChange(): Promise<void> {
  if (!existsSync(KEYS_MD_PATH)) return;
  let mtime = 0;
  try {
    mtime = statSync(KEYS_MD_PATH).mtimeMs;
  } catch {
    return;
  }
  // ignore if this is our own write (within 1s window of last self-write)
  if (Math.abs(mtime - lastSelfWriteMtime) < 1000) {
    return;
  }
  console.log('[watcher] external change detected in keys.md → merging');
  try {
    const result = await mergeFromMD();
    if (result.changed) {
      onExternalChange?.(KEYS_MD_PATH);
    }
  } catch (e) {
    console.error('[watcher] merge failed:', e);
  }
}

export function stopWatcher(): void {
  if (active) {
    active.close();
    active = null;
  }
  if (debounce) {
    clearTimeout(debounce);
    debounce = null;
  }
}
