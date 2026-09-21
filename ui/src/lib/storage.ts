// Small wrapper around localStorage.
//
// The app used to be called key-tester, and its stored state (open tabs, the
// splitter position, which folders are expanded) still carries that prefix in
// existing browsers. Reads fall back to the old prefix so the rename does not
// close everyone's tabs; writes always use the new one.

const PREFIX = 'keyway.';
const LEGACY = 'key-tester.';

export function loadLocal(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key) ?? localStorage.getItem(LEGACY + key);
  } catch {
    return null;
  }
}

export function saveLocal(key: string, value: string): void {
  try {
    localStorage.setItem(PREFIX + key, value);
  } catch {
    /* private window or quota - the app works without remembering */
  }
}
