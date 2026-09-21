// Detect what was pasted, convert it, and (when asked) merge it in.
//
// Import is two steps on purpose: preview first, write second. A collection
// export can carry hundreds of requests, and finding out what landed by
// reading the sidebar afterwards is not a plan.

import {
  createFolder,
  loadCollections,
  saveEnvironment,
  saveRequest,
} from '../collections.ts';
import { importInsomnia, isInsomniaExport } from './insomnia.ts';
import { importOpenApi, isOpenApi, parseSpecText } from './openapi.ts';
import {
  importPostman,
  importPostmanEnvironment,
  isPostmanCollection,
  isPostmanEnvironment,
} from './postman.ts';
import { countRequests, emptyImport, type ImportedCollection } from './types.ts';

export type { ImportedCollection } from './types.ts';
export { countRequests } from './types.ts';

export function importAny(text: string): ImportedCollection {
  let doc: any;
  try {
    doc = parseSpecText(text);
  } catch (e) {
    throw new Error(`Could not parse this as JSON or YAML: ${e instanceof Error ? e.message : e}`);
  }

  if (isPostmanCollection(doc)) return importPostman(doc);
  if (isPostmanEnvironment(doc)) return importPostmanEnvironment(doc);
  if (isInsomniaExport(doc)) return importInsomnia(doc);
  if (isOpenApi(doc)) return importOpenApi(doc);

  const out = emptyImport('unknown', 'Unrecognised file');
  out.warnings.push(
    'Not a Postman collection or environment, an Insomnia v4 export, or an OpenAPI/Swagger document.',
  );
  return out;
}

export interface ApplyResult {
  folders: number;
  requests: number;
  /** environments created */
  environments: number;
  /** environments that already existed and gained the missing variables */
  environmentsMerged: number;
  /** the wrapper folder everything landed in, when one was used */
  parentId?: string;
}

export interface ApplyOptions {
  /**
   * Wrap the whole import in one folder with this name. Without it, a
   * collection's own folders land at top level and three imports later the
   * sidebar is a flat pile with no clue which file each folder came from.
   * Pass an empty string to opt out.
   */
  parentName?: string;
}

export async function applyImport(
  imported: ImportedCollection,
  opts: ApplyOptions = {},
): Promise<ApplyResult> {
  const result: ApplyResult = { folders: 0, requests: 0, environments: 0, environmentsMerged: 0 };

  const wrapName = opts.parentName === undefined ? imported.name : opts.parentName;
  let parentId: string | undefined;
  if (wrapName.trim() && (imported.folders.length || imported.rootRequests.length)) {
    const parent = await createFolder(wrapName.trim());
    parentId = parent.id;
    result.parentId = parent.id;
    result.folders++;
  }

  for (const folder of imported.folders) {
    const node = await createFolder(folder.name, parentId);
    result.folders++;
    for (const spec of folder.requests) {
      await saveRequest(spec, node.id);
      result.requests++;
    }
  }

  for (const spec of imported.rootRequests) {
    await saveRequest(spec, parentId);
    result.requests++;
  }

  // Re-importing a file is normal (the API changed, the export was updated).
  // Creating a second environment with the same name every time is not - merge
  // in the variables that are missing and leave existing values alone.
  const file = await loadCollections();
  for (const env of imported.environments) {
    const existing = file.environments.find(
      (e) => e.name.trim().toLowerCase() === env.name.trim().toLowerCase(),
    );
    if (!existing) {
      await saveEnvironment(env);
      result.environments++;
      continue;
    }
    const known = new Set(existing.vars.map((v) => v.key));
    const additions = env.vars.filter((v) => !known.has(v.key));
    if (additions.length) {
      await saveEnvironment({ ...existing, vars: [...existing.vars, ...additions] });
    }
    result.environmentsMerged++;
  }

  return result;
}

/** A compact shape for the preview dialog - no bodies, no scripts. */
export function summarise(imported: ImportedCollection) {
  return {
    format: imported.format,
    name: imported.name,
    total: countRequests(imported),
    environments: imported.environments.map((e) => ({ name: e.name, vars: e.vars.length })),
    folders: [
      ...imported.folders.map((f) => ({
        name: f.name,
        requests: f.requests.map((r) => ({ method: r.method, name: r.name, url: r.url })),
      })),
      ...(imported.rootRequests.length
        ? [
            {
              name: '(no folder)',
              requests: imported.rootRequests.map((r) => ({
                method: r.method,
                name: r.name,
                url: r.url,
              })),
            },
          ]
        : []),
    ],
    warnings: imported.warnings,
  };
}
