import { useEffect, useState } from 'react';
import type { FieldDef, KeyEntry, Provider } from '../../../shared/types.ts';
import type { ProviderInfo } from '../lib/api.ts';

interface Props {
  open: boolean;
  providers: ProviderInfo[];
  entry: KeyEntry | null; // null = create mode
  onClose: () => void;
  onSave: (input: {
    id?: string;
    provider: Provider;
    label?: string;
    credentials: Record<string, string>;
    note?: string;
    section?: string;
  }) => Promise<void>;
}

export function EditModal({ open, providers, entry, onClose, onSave }: Props) {
  const [provider, setProvider] = useState<Provider>('openai-compat');
  const [label, setLabel] = useState('');
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (entry) {
      setProvider(entry.provider);
      setLabel(entry.label || '');
      setCreds({ ...entry.credentials });
      setNote(entry.note || '');
    } else {
      setProvider('openai-compat');
      setLabel('');
      setCreds({});
      setNote('');
    }
    setError(null);
  }, [open, entry]);

  if (!open) return null;

  const info = providers.find((p) => p.id === provider);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave({
        id: entry?.id,
        provider,
        label: label.trim() || undefined,
        credentials: creds,
        note: note.trim() || undefined,
        section: info?.defaultSection,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl dark:bg-slate-900 dark:border dark:border-slate-800">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            {entry ? `Edit: ${entry.label || entry.provider}` : 'Add new key'}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">
            ✕
          </button>
        </div>

        <div className="space-y-4">
          <Field label="Provider">
            <select
              value={provider}
              onChange={(e) => {
                const next = e.target.value as Provider;
                setProvider(next);
                // keep only creds whose field key the new provider also supports
                const nextInfo = providers.find((p) => p.id === next);
                const allowed = new Set(nextInfo?.fields.map((f) => f.key) || []);
                setCreds((prev) => {
                  const filtered: Record<string, string> = {};
                  for (const [k, v] of Object.entries(prev)) {
                    if (allowed.has(k)) filtered[k] = v;
                  }
                  return filtered;
                });
              }}
              className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800"
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} ({p.kind})
                </option>
              ))}
            </select>
          </Field>

          <Field label="Label (optional)">
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. OpenAI (manim)"
              className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800"
            />
          </Field>

          {info?.fields.map((f) => (
            <Field key={f.key} label={f.label} help={f.help} required={f.required}>
              {f.type === 'textarea' ? (
                <textarea
                  value={creds[f.key] || ''}
                  onChange={(e) => setCreds({ ...creds, [f.key]: e.target.value })}
                  placeholder={f.placeholder}
                  rows={4}
                  className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm font-mono dark:border-slate-700 dark:bg-slate-800"
                />
              ) : (
                <CredentialInput
                  field={f}
                  value={creds[f.key] || ''}
                  onChange={(v) => setCreds({ ...creds, [f.key]: v })}
                />
              )}
            </Field>
          ))}

          <Field label="Note (optional)">
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800"
            />
          </Field>
        </div>

        {error && (
          <div className="mt-4 rounded bg-red-50 p-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  help,
  required,
  children,
}: {
  label: string;
  help?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-sm font-medium text-slate-700 dark:text-slate-300">
        {label} {required && <span className="text-red-500">*</span>}
      </div>
      {children}
      {help && <div className="mt-1 text-xs text-slate-400">{help}</div>}
    </label>
  );
}

/**
 * Input for a credential field. Renders an eye toggle for `password`-type
 * fields so the user can reveal the value while editing.
 */
function CredentialInput({
  field,
  value,
  onChange,
}: {
  field: FieldDef;
  value: string;
  onChange: (v: string) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const isSecret = field.type === 'password';
  const inputType = isSecret
    ? revealed
      ? 'text'
      : 'password'
    : field.type === 'url'
      ? 'url'
      : 'text';

  // reset reveal state when switching fields
  useEffect(() => {
    setRevealed(false);
  }, [field.key]);

  if (!isSecret) {
    return (
      <input
        type={inputType}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm font-mono dark:border-slate-700 dark:bg-slate-800"
      />
    );
  }

  return (
    <div className="relative">
      <input
        type={inputType}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        className="w-full rounded border border-slate-300 bg-white px-3 py-2 pr-9 text-sm font-mono dark:border-slate-700 dark:bg-slate-800"
      />
      <button
        type="button"
        onClick={() => setRevealed((r) => !r)}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
        title={revealed ? 'Hide' : 'Reveal'}
        aria-label={revealed ? 'Hide value' : 'Reveal value'}
        tabIndex={-1}
      >
        {revealed ? '🙈' : '👁'}
      </button>
    </div>
  );
}
