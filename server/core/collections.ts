// Collections store: load/save collections.json.
//
// collections.json is the canonical file for the API-client half of the app.
// It holds requests, folders and environments - and deliberately NO secrets:
// vault-backed auth stores a keyId that points into store.json, so the file
// stays safe to copy, diff or commit.

import { readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { nanoid } from 'nanoid';

import { ROOT_DIR } from './store.ts';
import type {
  CollectionsFile,
  EnvironmentDef,
  RequestSpec,
  TreeNode,
} from '../../shared/collections.ts';

export const COLLECTIONS_PATH = resolve(ROOT_DIR, 'collections.json');

let cache: CollectionsFile | null = null;
let changeEmitter: (() => void) | null = null;

export function setCollectionsChangeEmitter(fn: () => void): void {
  changeEmitter = fn;
}

function emptyFile(): CollectionsFile {
  return {
    version: 1,
    activeEnvId: null,
    environments: [],
    tree: [],
    requests: {},
  };
}

export async function loadCollections(): Promise<CollectionsFile> {
  if (cache) return cache;
  if (!existsSync(COLLECTIONS_PATH)) {
    cache = emptyFile();
    await persist();
    return cache;
  }
  try {
    const parsed = JSON.parse(await readFile(COLLECTIONS_PATH, 'utf8')) as CollectionsFile;
    // Tolerate hand-edits: fill in anything missing rather than throwing away
    // the file the user just wrote.
    cache = {
      version: 1,
      activeEnvId: parsed.activeEnvId ?? null,
      environments: parsed.environments ?? [],
      tree: parsed.tree ?? [],
      requests: parsed.requests ?? {},
    };
  } catch (e) {
    console.warn('[collections] collections.json unreadable, starting empty:', e);
    cache = emptyFile();
  }
  return cache;
}

/** Write via temp file + rename so a crash mid-write can't leave a half file. */
async function persist(): Promise<void> {
  if (!cache) return;
  const tmp = `${COLLECTIONS_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8');
  await rename(tmp, COLLECTIONS_PATH);
  changeEmitter?.();
}

async function mutate(fn: (file: CollectionsFile) => void): Promise<CollectionsFile> {
  const file = await loadCollections();
  fn(file);
  await persist();
  return file;
}

// ─── requests ───────────────────────────────────────────────────────────────

export async function saveRequest(spec: RequestSpec, parentId?: string): Promise<RequestSpec> {
  const now = new Date().toISOString();
  await mutate((file) => {
    const existing = file.requests[spec.id];
    file.requests[spec.id] = {
      ...spec,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (!existing) attach(file, spec.id, 'request', parentId);
  });
  return (await loadCollections()).requests[spec.id]!;
}

export async function deleteRequest(id: string): Promise<void> {
  await mutate((file) => {
    delete file.requests[id];
    detach(file, id);
  });
}

export async function duplicateRequest(id: string): Promise<RequestSpec | null> {
  const file = await loadCollections();
  const src = file.requests[id];
  if (!src) return null;
  const copy: RequestSpec = { ...structuredClone(src), id: nanoid(12), name: `${src.name} copy` };
  return saveRequest(copy, parentOf(file, id));
}

// ─── folders / tree ─────────────────────────────────────────────────────────

export async function createFolder(name: string, parentId?: string): Promise<TreeNode> {
  const node: TreeNode = { id: nanoid(12), type: 'folder', name, children: [] };
  await mutate((file) => {
    if (parentId) {
      const parent = findFolder(file, parentId);
      if (parent) {
        parent.children = [...(parent.children ?? []), node.id];
        file.tree.push(node);
        return;
      }
    }
    file.tree.push(node);
  });
  return node;
}

export async function renameNode(id: string, name: string): Promise<void> {
  await mutate((file) => {
    const folder = findFolder(file, id);
    if (folder) folder.name = name;
    const req = file.requests[id];
    if (req) req.name = name;
  });
}

export async function deleteFolder(id: string): Promise<void> {
  await mutate((file) => {
    const folder = findFolder(file, id);
    if (!folder) return;
    for (const child of folder.children ?? []) {
      delete file.requests[child];
      file.tree = file.tree.filter((n) => n.id !== child);
    }
    file.tree = file.tree.filter((n) => n.id !== id);
    detach(file, id);
  });
}

export async function moveNode(id: string, parentId: string | null, index?: number): Promise<void> {
  await mutate((file) => {
    detach(file, id);
    const type = file.requests[id] ? 'request' : 'folder';
    attach(file, id, type, parentId ?? undefined, index);
  });
}

// ─── environments ───────────────────────────────────────────────────────────

export async function saveEnvironment(env: EnvironmentDef): Promise<EnvironmentDef> {
  await mutate((file) => {
    const i = file.environments.findIndex((e) => e.id === env.id);
    if (i >= 0) file.environments[i] = env;
    else file.environments.push(env);
    if (!file.activeEnvId) file.activeEnvId = env.id;
  });
  return env;
}

export async function deleteEnvironment(id: string): Promise<void> {
  await mutate((file) => {
    file.environments = file.environments.filter((e) => e.id !== id);
    if (file.activeEnvId === id) file.activeEnvId = file.environments[0]?.id ?? null;
  });
}

export async function setActiveEnvironment(id: string | null): Promise<void> {
  await mutate((file) => {
    file.activeEnvId = id;
  });
}

/** Merge variables a script wrote with bru.setEnvVar into the active
 *  environment. Unlike bru.setVar (session-only) these are meant to stick. */
export async function applyEnvVarChanges(vars: Record<string, string>): Promise<void> {
  if (Object.keys(vars).length === 0) return;
  await mutate((file) => {
    const env = file.environments.find((e) => e.id === file.activeEnvId);
    if (!env) return;
    for (const [key, value] of Object.entries(vars)) {
      const row = env.vars.find((v) => v.key === key);
      if (row) row.value = value;
      else env.vars.push({ key, value, enabled: true });
    }
  });
}

export async function activeEnvVars(): Promise<Record<string, string>> {
  const file = await loadCollections();
  const env = file.environments.find((e) => e.id === file.activeEnvId);
  if (!env) return {};
  const out: Record<string, string> = {};
  for (const row of env.vars) if (row.enabled && row.key) out[row.key] = row.value;
  return out;
}

// ─── tree helpers ───────────────────────────────────────────────────────────

function findFolder(file: CollectionsFile, id: string): TreeNode | undefined {
  return file.tree.find((n) => n.id === id && n.type === 'folder');
}

function parentOf(file: CollectionsFile, childId: string): string | undefined {
  return file.tree.find((n) => n.type === 'folder' && n.children?.includes(childId))?.id;
}

function attach(
  file: CollectionsFile,
  id: string,
  type: 'folder' | 'request',
  parentId?: string,
  index?: number,
): void {
  const parent = parentId ? findFolder(file, parentId) : undefined;
  if (parent) {
    const children = parent.children ?? [];
    children.splice(index ?? children.length, 0, id);
    parent.children = children;
    // A node inside a folder lives only in that folder's children array - it
    // never also appears at top level.
    return;
  }
  if (!file.tree.some((n) => n.id === id)) {
    const node: TreeNode = { id, type };
    file.tree.splice(index ?? file.tree.length, 0, node);
  }
}

function detach(file: CollectionsFile, id: string): void {
  file.tree = file.tree.filter((n) => n.id !== id);
  for (const node of file.tree) {
    if (node.children?.includes(id)) node.children = node.children.filter((c) => c !== id);
  }
}
