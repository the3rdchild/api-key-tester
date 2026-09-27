// One sandbox for the whole test run. Bun runs every test file in a single
// process and module mocks are process-wide — and a mocked module's exports
// are fixed by the first mock — so files that each declared their own mocks
// and temp dir ended up fighting over them. bunfig.toml preloads this before
// any test file, so everything shares one set:
//   - ROOT_DIR is a temp dir: history, cookies and tokens never touch the real ones
//   - the vault holds one fake key, so scrubbing has something to scrub
//   - the environment is empty (reading it for real would even create
//     collections.json in a fresh clone)
//   - scripts are a no-op: the quickjs sandbox isn't needed and may not be installed

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, mock } from 'bun:test';

export const DATA = mkdtempSync(join(tmpdir(), 'keyway-test-'));
export const VAULT_SECRET = 'sk-vault-secret-0123456789abcdef';

mock.module('../../server/core/store.ts', () => ({
  ROOT_DIR: DATA,
  getAllKeys: async () => [{ id: 'k1', provider: 'openai', credentials: { apiKey: VAULT_SECRET } }],
}));
mock.module('../../server/core/collections.ts', () => ({
  activeEnvVars: async () => ({}),
  applyEnvVarChanges: async () => {},
}));
mock.module('../../server/core/script.ts', () => ({ runScript: async () => ({}) }));

// in a preload, afterAll is global: once, after the last test file
afterAll(() => rmSync(DATA, { recursive: true, force: true }));
