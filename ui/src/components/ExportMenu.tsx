import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.ts';

const FORMATS = [
  { id: 'md', label: 'Markdown (.md)', desc: 'Same format as keys.md' },
  { id: 'json', label: 'JSON (.json)', desc: 'Full store.json structure' },
  { id: 'env', label: '.env', desc: 'KEY=value flat' },
  { id: 'curl', label: 'curl snippets', desc: 'Paste-ready bash' },
  { id: 'csv', label: 'CSV', desc: 'Table snapshot' },
] as const;

export function ExportMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const handleDownload = async (format: (typeof FORMATS)[number]['id']) => {
    const url = api.exportURL(format);
    const res = await fetch(url);
    const blob = await res.blob();
    const ext = format === 'curl' ? 'txt' : format === 'env' ? 'env' : format;
    const filename = `keys-export.${ext}`;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
    setOpen(false);
  };

  const handleCopy = async (format: (typeof FORMATS)[number]['id']) => {
    const res = await fetch(api.exportURL(format));
    const text = await res.text();
    await navigator.clipboard.writeText(text);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        Export ▾
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-72 rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-800 dark:bg-slate-900">
          {FORMATS.map((f) => (
            <div
              key={f.id}
              className="flex items-center justify-between px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              <div>
                <div className="text-sm font-medium">{f.label}</div>
                <div className="text-xs text-slate-400">{f.desc}</div>
              </div>
              <div className="flex gap-1">
                <button
                  onClick={() => handleCopy(f.id)}
                  className="rounded px-2 py-0.5 text-xs text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700"
                  title="Copy to clipboard"
                >
                  Copy
                </button>
                <button
                  onClick={() => handleDownload(f.id)}
                  className="rounded px-2 py-0.5 text-xs text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/30"
                  title="Download file"
                >
                  ↓
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
