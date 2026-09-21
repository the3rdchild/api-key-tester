// Detect what was pasted, convert it, and (when asked) merge it in.
//
// Import is two steps on purpose: preview first, write second. A collection
// export can carry hundreds of requests, and finding out what landed by
// reading the sidebar afterwards is not a plan.

import {
  createFolder,
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
  environments: number;
}

export async function applyImport(imported: ImportedCollection): Promise<ApplyResult> {
  const result: ApplyResult = { folders: 0, requests: 0, environments: 0 };

  for (const folder of imported.folders) {
    const node = await createFolder(folder.name);
    result.folders++;
    for (const spec of folder.requests) {
      await saveRequest(spec, node.id);
      result.requests++;
    }
  }

  for (const spec of imported.rootRequests) {
    await saveRequest(spec);
    result.requests++;
  }

  for (const env of imported.environments) {
    await saveEnvironment(env);
    result.environments++;
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
