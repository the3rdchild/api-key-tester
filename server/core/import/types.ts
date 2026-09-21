// Shared shape every importer produces, so the merge step never needs to know
// which tool the file came from.

import type { EnvironmentDef, RequestSpec } from '../../../shared/collections.ts';

export type ImportFormat =
  | 'postman'
  | 'postman-environment'
  | 'insomnia'
  | 'openapi'
  | 'unknown';

export interface ImportedFolder {
  name: string;
  requests: RequestSpec[];
}

export interface ImportedCollection {
  format: ImportFormat;
  /** what the source called itself */
  name: string;
  folders: ImportedFolder[];
  /** requests that sat at the top level of the source */
  rootRequests: RequestSpec[];
  environments: EnvironmentDef[];
  /** things that could not be carried over faithfully */
  warnings: string[];
}

export function emptyImport(format: ImportFormat, name: string): ImportedCollection {
  return { format, name, folders: [], rootRequests: [], environments: [], warnings: [] };
}

export function countRequests(imported: ImportedCollection): number {
  return imported.rootRequests.length + imported.folders.reduce((n, f) => n + f.requests.length, 0);
}
