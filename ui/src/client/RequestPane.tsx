// Left half of the client: the request being edited.
//
// The method/URL/Send row is pinned at the top and never moves - sending does
// not reflow this pane, only the response pane next to it.

import { useState } from 'react';

import { KeyValueEditor } from './KeyValueEditor.tsx';
import { MultipartEditor } from './MultipartEditor.tsx';
import { clientApi } from '../lib/clientApi.ts';
import { METHODS } from '../../../shared/collections.ts';
import type { BodyMode, RequestSpec } from '../../../shared/collections.ts';
import type { Tab } from './useClient.ts';

type Section = 'params' | 'headers' | 'body' | 'auth' | 'settings';

const BODY_MODES: { id: BodyMode; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'json', label: 'JSON' },
  { id: 'text', label: 'Text' },
  { id: 'xml', label: 'XML' },
  { id: 'form', label: 'Form URL-encoded' },
  { id: 'multipart', label: 'Multipart / file' },
];

interface Props {
  tab: Tab;
  onSpec: (patch: Partial<RequestSpec>) => void;
  onFiles: (field: string, files: File[]) => void;
  onSend: () => void;
  onSave: () => void;
  onToast: (msg: string) => void;
}

export function RequestPane({ tab, onSpec, onFiles, onSend, onSave, onToast }: Props) {
  const [section, setSection] = useState<Section>('params');
  const spec = tab.spec;
  const settings = spec.settings;

  const counts = {
    params: spec.params.filter((p) => p.enabled && p.key).length,
    headers: spec.headers.filter((h) => h.enabled && h.key).length,
  };

  const copyCurl = async () => {
    try {
      const { curl } = await clientApi.curl(spec);
      await navigator.clipboard.writeText(curl);
      onToast('curl copied');
    } catch (e) {
      onToast(`curl failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  const formatJson = () => {
    try {
      const parsed = JSON.parse(spec.body.text ?? '');
      onSpec({ body: { ...spec.body, text: JSON.stringify(parsed, null, 2) } });
    } catch {
      onToast('Body is not valid JSON');
    }
  };

  return (
    <section className="flex h-full min-w-0 flex-col" aria-label="Request">
      {/* pinned URL bar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 p-2 dark:border-slate-800">
        <label htmlFor="req-method" className="sr-only">
          Method
        </label>
        <select
          id="req-method"
          value={spec.method}
          onChange={(e) => onSpec({ method: e.target.value })}
          className="h-9 rounded border border-slate-300 bg-white px-2 text-sm font-semibold dark:border-slate-700 dark:bg-slate-800"
        >
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>

        <label htmlFor="req-url" className="sr-only">
          URL
        </label>
        <input
          id="req-url"
          value={spec.url}
          placeholder="http://localhost:3000/api/users   ·   {{baseURL}} works too"
          onChange={(e) => onSpec({ url: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSend();
          }}
          className="h-9 min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 font-mono text-sm dark:border-slate-700 dark:bg-slate-800"
        />

        <button
          type="button"
          onClick={onSend}
          disabled={tab.sending || !spec.url}
          className="h-9 rounded bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {tab.sending ? <i className="fa-solid fa-spinner fa-spin" /> : <i className="fa-solid fa-paper-plane" />} Send
        </button>
        <button
          type="button"
          onClick={onSave}
          title="Save into collections.json"
          className="h-9 rounded border border-slate-300 px-3 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          <i className="fa-solid fa-floppy-disk" />
          {tab.dirty && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />}
        </button>
        <button
          type="button"
          onClick={copyCurl}
          title="Copy as curl"
          className="h-9 rounded border border-slate-300 px-3 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          <i className="fa-solid fa-terminal" />
        </button>
      </div>

      {/* section tabs */}
      <div
        role="tablist"
        aria-label="Request sections"
        className="flex shrink-0 gap-1 border-b border-slate-200 px-2 dark:border-slate-800"
      >
        {(['params', 'headers', 'body', 'auth', 'settings'] as Section[]).map((id) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={section === id}
            onClick={() => setSection(id)}
            className={`border-b-2 px-3 py-2 text-xs font-medium capitalize ${
              section === id
                ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >
            {id}
            {id === 'params' && counts.params > 0 && <Badge>{counts.params}</Badge>}
            {id === 'headers' && counts.headers > 0 && <Badge>{counts.headers}</Badge>}
            {id === 'body' && spec.body.mode !== 'none' && <Badge>{spec.body.mode}</Badge>}
            {id === 'auth' && spec.auth.type !== 'none' && <Badge>{spec.auth.type}</Badge>}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {section === 'params' && (
          <KeyValueEditor
            idPrefix="params"
            rows={spec.params}
            onChange={(params) => onSpec({ params })}
            keyPlaceholder="param"
          />
        )}

        {section === 'headers' && (
          <KeyValueEditor
            idPrefix="headers"
            rows={spec.headers}
            onChange={(headers) => onSpec({ headers })}
            keyPlaceholder="Header-Name"
          />
        )}

        {section === 'body' && (
          <div className="flex h-full flex-col gap-2">
            <div className="flex items-center gap-2">
              <label htmlFor="body-mode" className="text-xs text-slate-500">
                Body
              </label>
              <select
                id="body-mode"
                value={spec.body.mode}
                onChange={(e) => onSpec({ body: { ...spec.body, mode: e.target.value as BodyMode } })}
                className="h-8 rounded border border-slate-300 bg-white px-2 text-xs dark:border-slate-700 dark:bg-slate-800"
              >
                {BODY_MODES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              {spec.body.mode === 'json' && (
                <button
                  type="button"
                  onClick={formatJson}
                  className="h-8 rounded border border-slate-300 px-2 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
                >
                  <i className="fa-solid fa-wand-magic-sparkles" /> Format
                </button>
              )}
            </div>

            {spec.body.mode === 'none' && (
              <p className="text-xs text-slate-400">This request sends no body.</p>
            )}

            {(spec.body.mode === 'json' || spec.body.mode === 'text' || spec.body.mode === 'xml') && (
              <>
                <label htmlFor="body-text" className="sr-only">
                  Request body
                </label>
                <textarea
                  id="body-text"
                  value={spec.body.text ?? ''}
                  spellCheck={false}
                  onChange={(e) => onSpec({ body: { ...spec.body, text: e.target.value } })}
                  className="min-h-0 flex-1 resize-none rounded border border-slate-300 bg-white p-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
                />
              </>
            )}

            {spec.body.mode === 'form' && (
              <KeyValueEditor
                idPrefix="form"
                rows={spec.body.form ?? []}
                onChange={(form) => onSpec({ body: { ...spec.body, form } })}
                keyPlaceholder="field"
              />
            )}

            {spec.body.mode === 'multipart' && (
              <MultipartEditor
                idPrefix="multipart"
                rows={spec.body.multipart ?? []}
                files={tab.files}
                onChange={(multipart) => onSpec({ body: { ...spec.body, multipart } })}
                onFiles={onFiles}
              />
            )}
          </div>
        )}

        {section === 'auth' && <AuthEditor spec={spec} onSpec={onSpec} />}

        {section === 'settings' && (
          <div className="grid max-w-md gap-3 text-sm">
            <Field label="Timeout (ms)" htmlFor="set-timeout">
              <input
                id="set-timeout"
                type="number"
                min={100}
                step={500}
                value={settings.timeoutMs}
                onChange={(e) =>
                  onSpec({ settings: { ...settings, timeoutMs: Number(e.target.value) || 1000 } })
                }
                className="h-8 w-32 rounded border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-800"
              />
            </Field>
            <Field label="Max redirects" htmlFor="set-redirects">
              <input
                id="set-redirects"
                type="number"
                min={0}
                max={20}
                value={settings.maxRedirects}
                onChange={(e) =>
                  onSpec({ settings: { ...settings, maxRedirects: Number(e.target.value) || 0 } })
                }
                className="h-8 w-32 rounded border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-800"
              />
            </Field>
            <Toggle
              id="set-follow"
              checked={settings.followRedirects}
              onChange={(followRedirects) => onSpec({ settings: { ...settings, followRedirects } })}
              label="Follow redirects"
            />
            <Toggle
              id="set-jar"
              checked={settings.useCookieJar}
              onChange={(useCookieJar) => onSpec({ settings: { ...settings, useCookieJar } })}
              label="Use cookie jar (send + store cookies)"
            />
          </div>
        )}
      </div>

      {tab.missing && tab.missing.length > 0 && (
        <p className="shrink-0 border-t border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Undefined variable{tab.missing.length > 1 ? 's' : ''}: {tab.missing.join(', ')}
        </p>
      )}
    </section>
  );
}

function AuthEditor({
  spec,
  onSpec,
}: {
  spec: RequestSpec;
  onSpec: (patch: Partial<RequestSpec>) => void;
}) {
  const auth = spec.auth;
  const set = (patch: Partial<RequestSpec['auth']>) => onSpec({ auth: { ...auth, ...patch } });

  return (
    <div className="grid max-w-md gap-3 text-sm">
      <Field label="Type" htmlFor="auth-type">
        <select
          id="auth-type"
          value={auth.type}
          onChange={(e) => set({ type: e.target.value as RequestSpec['auth']['type'] })}
          className="h-8 rounded border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-800"
        >
          <option value="none">No auth</option>
          <option value="bearer">Bearer token</option>
          <option value="basic">Basic</option>
          <option value="header">Custom header</option>
        </select>
      </Field>

      {auth.type === 'bearer' && (
        <Field label="Token" htmlFor="auth-token">
          <input
            id="auth-token"
            value={auth.token ?? ''}
            placeholder="{{token}}"
            onChange={(e) => set({ token: e.target.value })}
            className="h-8 w-full rounded border border-slate-300 bg-white px-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-800"
          />
        </Field>
      )}

      {auth.type === 'basic' && (
        <>
          <Field label="Username" htmlFor="auth-user">
            <input
              id="auth-user"
              value={auth.username ?? ''}
              onChange={(e) => set({ username: e.target.value })}
              className="h-8 w-full rounded border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-800"
            />
          </Field>
          <Field label="Password" htmlFor="auth-pass">
            <input
              id="auth-pass"
              type="password"
              value={auth.password ?? ''}
              onChange={(e) => set({ password: e.target.value })}
              className="h-8 w-full rounded border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-800"
            />
          </Field>
        </>
      )}

      {auth.type === 'header' && (
        <>
          <Field label="Header name" htmlFor="auth-hname">
            <input
              id="auth-hname"
              value={auth.headerName ?? ''}
              placeholder="x-api-key"
              onChange={(e) => set({ headerName: e.target.value })}
              className="h-8 w-full rounded border border-slate-300 bg-white px-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-800"
            />
          </Field>
          <Field label="Header value" htmlFor="auth-hval">
            <input
              id="auth-hval"
              value={auth.headerValue ?? ''}
              onChange={(e) => set({ headerValue: e.target.value })}
              className="h-8 w-full rounded border border-slate-300 bg-white px-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-800"
            />
          </Field>
        </>
      )}

      <p className="text-xs text-slate-400">
        Auth straight from the key vault lands in M2 — for now reference a variable, e.g.{' '}
        <code className="font-mono">{'{{token}}'}</code>.
      </p>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1">
      <label htmlFor={htmlFor} className="text-xs font-medium text-slate-500">
        {label}
      </label>
      {children}
    </div>
  );
}

function Toggle({
  id,
  checked,
  onChange,
  label,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-slate-300 text-indigo-600 dark:border-slate-600 dark:bg-slate-800"
      />
      <label htmlFor={id} className="cursor-pointer text-sm">
        {label}
      </label>
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="ml-1 rounded bg-slate-200 px-1 text-[10px] font-normal text-slate-600 dark:bg-slate-700 dark:text-slate-300">
      {children}
    </span>
  );
}
