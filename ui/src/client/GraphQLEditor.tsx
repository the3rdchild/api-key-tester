// GraphQL body: the query document, its variables as JSON, and — when the
// document holds several operations — which one to run. Sent as the
// GraphQL-over-HTTP JSON object (or as query params on a GET); see send.ts.

import { useMemo } from 'react';

import { CodeEditor } from './CodeEditor.tsx';
import { operationNames } from '../lib/graphql.ts';
import type { GraphQLBody } from '../../../shared/collections.ts';

interface Props {
  value: GraphQLBody;
  onChange: (value: GraphQLBody) => void;
}

export function GraphQLEditor({ value, onChange }: Props) {
  const ops = useMemo(() => operationNames(value.query), [value.query]);
  const varsError = useMemo(() => {
    const raw = value.variables?.trim();
    if (!raw) return undefined;
    try {
      JSON.parse(raw);
      return undefined;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, [value.variables]);

  const formatVars = () => {
    try {
      onChange({ ...value, variables: JSON.stringify(JSON.parse(value.variables ?? ''), null, 2) });
    } catch {
      /* the badge already says why */
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="min-h-0 flex-[3]">
        <CodeEditor
          ariaLabel="GraphQL query"
          language="text"
          value={value.query}
          onChange={(query) => onChange({ ...value, query })}
          placeholder={'query GetUser($id: ID!) {\n  user(id: $id) {\n    id\n    name\n  }\n}'}
        />
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-500">Variables</span>
        {varsError ? (
          <span
            title={varsError}
            className="rounded-full border border-red-500/40 px-2 py-0.5 text-[10px] font-semibold uppercase text-red-600 dark:text-red-400"
          >
            Invalid JSON
          </span>
        ) : null}
        <button
          type="button"
          onClick={formatVars}
          disabled={!value.variables?.trim() || !!varsError}
          className="h-7 rounded border border-slate-300 px-2 text-xs hover:bg-slate-100 disabled:opacity-40 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          <i className="fa-solid fa-wand-magic-sparkles" /> Format
        </button>

        {(ops.length > 1 || value.operationName) && (
          <label className="ml-auto flex items-center gap-1.5 text-xs text-slate-500">
            Operation
            <select
              value={value.operationName ?? ''}
              onChange={(e) => onChange({ ...value, operationName: e.target.value || undefined })}
              className="h-7 rounded border border-slate-300 bg-white px-1 font-mono text-xs dark:border-slate-700 dark:bg-slate-800"
            >
              <option value="">(server decides)</option>
              {[...new Set([...ops, ...(value.operationName ? [value.operationName] : [])])].map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="min-h-0 flex-1">
        <CodeEditor
          ariaLabel="GraphQL variables"
          language="json"
          value={value.variables ?? ''}
          onChange={(variables) => onChange({ ...value, variables })}
          placeholder={'{\n  "id": "{{userId}}"\n}'}
        />
      </div>
    </div>
  );
}
