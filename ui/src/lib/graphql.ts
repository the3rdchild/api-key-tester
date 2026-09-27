// GraphQL helpers the editor and the body-mode switch share — plain functions,
// so they don't drag the code editor along wherever they're used.

import type { GraphQLBody } from '../../../shared/collections.ts';

/** Named operations in a document. A light scan, not a parser: enough to
 *  offer a picker, which only matters once there are two. */
export function operationNames(query: string): string[] {
  const names: string[] = [];
  for (const m of query.matchAll(/\b(?:query|mutation|subscription)\s+([_A-Za-z][_0-9A-Za-z]*)/g)) {
    if (!names.includes(m[1]!)) names.push(m[1]!);
  }
  return names;
}

/** A JSON body shaped like a GraphQL request, as pasted or imported before
 *  there was a GraphQL mode — worth carrying over when switching to it. */
export function graphqlFromJson(text: string | undefined): GraphQLBody | undefined {
  try {
    const obj = JSON.parse(text ?? '') as { query?: unknown; variables?: unknown; operationName?: unknown };
    if (typeof obj?.query !== 'string') return undefined;
    return {
      query: obj.query,
      variables: obj.variables ? JSON.stringify(obj.variables, null, 2) : '',
      operationName: typeof obj.operationName === 'string' ? obj.operationName : undefined,
    };
  } catch {
    return undefined;
  }
}
