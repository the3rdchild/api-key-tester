import { useState } from 'react';

export function MaskedKey({ value, visible = 4 }: { value: string; visible?: number }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="text-slate-400 italic">-</span>;

  const masked =
    value.length <= visible * 2
      ? '•'.repeat(value.length)
      : `${value.slice(0, visible)}…${value.slice(-visible)}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked - ignore silently */
    }
  };

  return (
    <div className="flex items-center gap-2 font-mono text-xs">
      <span className="break-all select-none">{masked}</span>
      <button
        type="button"
        onClick={handleCopy}
        className={
          copied
            ? 'text-emerald-500'
            : 'text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
        }
        title={copied ? 'Copied!' : 'Copy to clipboard'}
        aria-label="Copy API key"
      >
        {copied ? '✓' : '⧉'}
      </button>
    </div>
  );
}
