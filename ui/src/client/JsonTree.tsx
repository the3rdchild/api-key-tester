// Collapsible JSON viewer for the response pane.
//
// Pretty-printing answers "what came back"; a tree answers "where is the thing
// I need". The two are different jobs, which is why clicking a key here copies
// its path (`$.data.0.id`) - that string is exactly what the Tests tab wants as
// an assertion source.

import { useState } from 'react';

interface Props {
  value: unknown;
  onCopyPath?: (path: string) => void;
}

/** Arrays in API responses can be huge; render a window and let the reader ask
 *  for more rather than freezing the pane on a 10k-item list. */
const PAGE = 100;

export function JsonTree({ value, onCopyPath }: Props) {
  return (
    <div className="p-2 font-mono text-xs leading-5">
      <Node name="$" value={value} path="$" depth={0} defaultOpen onCopyPath={onCopyPath} />
    </div>
  );
}

function Node({
  name,
  value,
  path,
  depth,
  defaultOpen,
  onCopyPath,
}: {
  name: string;
  value: unknown;
  path: string;
  depth: number;
  defaultOpen?: boolean;
  onCopyPath?: (path: string) => void;
}) {
  // Deep structures start folded: the first two levels are usually the shape
  // you are looking for, everything below is detail.
  const [open, setOpen] = useState(defaultOpen ?? depth < 2);
  const [shown, setShown] = useState(PAGE);

  const isArray = Array.isArray(value);
  const isObject = !isArray && typeof value === 'object' && value !== null;
  const entries: [string, unknown][] = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v])
    : isObject
      ? Object.entries(value as Record<string, unknown>)
      : [];

  const label = (
    <button
      type="button"
      onClick={() => {
        if (onCopyPath) onCopyPath(path);
      }}
      title={`Copy path: ${path}`}
      className="text-slate-500 hover:text-indigo-600 hover:underline dark:hover:text-indigo-400"
    >
      {name}
    </button>
  );

  if (!isArray && !isObject) {
    return (
      <div className="flex items-start gap-2" style={{ paddingLeft: depth * 14 }}>
        <span className="w-3 shrink-0" />
        {label}
        <span className="text-slate-400">:</span>
        <Leaf value={value} />
      </div>
    );
  }

  const summary = isArray
    ? `[] ${entries.length} item${entries.length === 1 ? '' : 's'}`
    : `{} ${entries.length} key${entries.length === 1 ? '' : 's'}`;

  return (
    <div>
      <div className="flex items-start gap-2" style={{ paddingLeft: depth * 14 }}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? `Collapse ${path}` : `Expand ${path}`}
          className="w-3 shrink-0 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
        >
          <i className={`fa-solid ${open ? 'fa-caret-down' : 'fa-caret-right'}`} />
        </button>
        {label}
        <span className="text-slate-400">:</span>
        <span className="text-slate-400">{summary}</span>
      </div>

      {open &&
        entries.slice(0, shown).map(([key, child]) => (
          <Node
            key={key}
            name={key}
            value={child}
            path={`${path}.${key}`}
            depth={depth + 1}
            onCopyPath={onCopyPath}
          />
        ))}

      {open && entries.length > shown && (
        <button
          type="button"
          onClick={() => setShown((n) => n + PAGE)}
          style={{ marginLeft: (depth + 1) * 14 }}
          className="mt-0.5 rounded px-1 text-[11px] text-indigo-600 hover:underline dark:text-indigo-400"
        >
          show {Math.min(PAGE, entries.length - shown)} more of {entries.length}
        </button>
      )}
    </div>
  );
}

function Leaf({ value }: { value: unknown }) {
  if (value === null) return <span className="text-amber-600 dark:text-amber-400">null</span>;
  switch (typeof value) {
    case 'string':
      return (
        <span className="break-all text-emerald-700 dark:text-emerald-400">
          "{value.length > 400 ? `${value.slice(0, 400)}…` : value}"
        </span>
      );
    case 'number':
      return <span className="text-indigo-600 dark:text-indigo-400">{String(value)}</span>;
    case 'boolean':
      return <span className="text-amber-600 dark:text-amber-400">{String(value)}</span>;
    default:
      return <span className="text-slate-500">{String(value)}</span>;
  }
}
