// Left half of the client: the request being edited.
//
// The method/URL/Send row is pinned at the top and never moves - sending does
// not reflow this pane, only the response pane next to it.

import { useState } from 'react';

import { AssertionEditor } from './AssertionEditor.tsx';
import { CodeEditor } from './CodeEditor.tsx';
import { KeyValueEditor } from './KeyValueEditor.tsx';
import { MultipartEditor } from './MultipartEditor.tsx';
import { MatrixDialog } from './MatrixDialog.tsx';
import { OAuth2Editor } from './OAuth2Editor.tsx';
import { clientApi } from '../lib/clientApi.ts';
import { METHODS } from '../../../shared/collections.ts';
import type { BodyMode, RequestSpec } from '../../../shared/collections.ts';
import type { KeyEntry } from '../../../shared/types.ts';
import type { Tab } from './useClient.ts';

type Section = 'params' | 'headers' | 'body' | 'auth' | 'scripts' | 'tests' | 'settings';

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
  vaultKeys: KeyEntry[];
  chainable: { id: string; name: string; status: number }[];
  tokenTick: number;
  onSpec: (patch: Partial<RequestSpec>) => void;
  onFiles: (field: string, files: File[]) => void;
  onSend: () => void;
  onSave: () => void;
  onToast: (msg: string) => void;
  /** define a missing {{var}} without leaving the request */
  onDefineVar: (name: string) => void;
}

export function RequestPane({
  tab,
  vaultKeys,
  chainable,
  tokenTick,
  onSpec,
  onFiles,
  onSend,
  onSave,
  onToast,
  onDefineVar,
}: Props) {
  const [section, setSection] = useState<Section>('params');
  const [matrixOpen, setMatrixOpen] = useState(false);
  const spec = tab.spec;
  const settings = spec.settings;

  const counts = {
    params: spec.params.filter((p) => p.enabled && p.key).length,
    headers: spec.headers.filter((h) => h.enabled && h.key).length,
    scripts: [spec.scripts?.pre, spec.scripts?.post].filter((c) => c?.trim()).length,
    tests: (spec.assertions ?? []).filter((a) => a.enabled !== false && a.source).length,
  };

  const setScript = (phase: 'pre' | 'post', code: string) =>
    onSpec({ scripts: { pre: spec.scripts?.pre ?? '', post: spec.scripts?.post ?? '', [phase]: code } });

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
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 p-2 dark:border-slate-800">
        <label htmlFor="req-method" className="sr-only">
          Method
        </label>
        <select
          id="req-method"
          value={spec.method}
          onChange={(e) => onSpec({ method: e.target.value })}
          className="h-9 shrink-0 rounded border border-slate-300 bg-white px-2 text-sm font-semibold dark:border-slate-700 dark:bg-slate-800"
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
          className="h-9 w-0 min-w-[10rem] flex-1 rounded border border-slate-300 bg-white px-2 font-mono text-sm dark:border-slate-700 dark:bg-slate-800"
        />

        <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onSend}
          disabled={tab.sending || !spec.url}
          className="h-9 shrink-0 rounded bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {tab.sending ? <i className="fa-solid fa-spinner fa-spin" /> : <i className="fa-solid fa-paper-plane" />} Send
        </button>
        <button
          type="button"
          onClick={onSave}
          title="Save into collections.json"
          className="h-9 shrink-0 rounded border border-slate-300 px-3 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          <i className="fa-solid fa-floppy-disk" />
          {tab.dirty && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />}
        </button>
        <button
          type="button"
          onClick={() => setMatrixOpen(true)}
          title="Run this request across several vault keys"
          className="h-9 shrink-0 rounded border border-slate-300 px-3 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          <i className="fa-solid fa-table-cells" />
        </button>
        <button
          type="button"
          onClick={copyCurl}
          title="Copy as curl"
          className="h-9 shrink-0 rounded border border-slate-300 px-3 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          <i className="fa-solid fa-terminal" />
        </button>
        </div>
      </div>

      {/* section tabs */}
      <div
        role="tablist"
        aria-label="Request sections"
        className="thin-scroll flex shrink-0 gap-1 overflow-x-auto border-b border-slate-200 px-2 dark:border-slate-800"
      >
        {(['params', 'headers', 'body', 'auth', 'scripts', 'tests', 'settings'] as Section[]).map((id) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={section === id}
            onClick={() => setSection(id)}
            className={`shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-xs font-medium capitalize ${
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
            {id === 'scripts' && counts.scripts > 0 && <Badge>{counts.scripts}</Badge>}
            {id === 'tests' && counts.tests > 0 && <Badge>{counts.tests}</Badge>}
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
              <div className="min-h-0 flex-1">
                <CodeEditor
                  ariaLabel="Request body"
                  language={spec.body.mode === 'json' ? 'json' : 'text'}
                  value={spec.body.text ?? ''}
                  onChange={(text) => onSpec({ body: { ...spec.body, text } })}
                  placeholder={spec.body.mode === 'json' ? '{\n  "key": "value"\n}' : ''}
                />
              </div>
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

        {section === 'auth' && (
          <AuthEditor
            spec={spec}
            onSpec={onSpec}
            vaultKeys={vaultKeys}
            tokenTick={tokenTick}
            onToast={onToast}
          />
        )}

        {section === 'scripts' && (
          <div className="flex h-full flex-col gap-3">
            <div className="flex min-h-0 flex-1 flex-col gap-1">
              <h3 className="text-xs font-semibold text-slate-500">
                Pre-request <span className="font-normal text-slate-400">— runs before sending</span>
              </h3>
              <div className="min-h-0 flex-1">
                <CodeEditor
                  ariaLabel="Pre-request script"
                  language="javascript"
                  value={spec.scripts?.pre ?? ''}
                  onChange={(code) => setScript('pre', code)}
                  placeholder={"req.headers['X-Trace'] = bru.getVar('traceId')\nbru.setVar('ts', Date.now())"}
                />
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-1">
              <h3 className="text-xs font-semibold text-slate-500">
                Post-response <span className="font-normal text-slate-400">— runs after the reply</span>
              </h3>
              <div className="min-h-0 flex-1">
                <CodeEditor
                  ariaLabel="Post-response script"
                  language="javascript"
                  value={spec.scripts?.post ?? ''}
                  onChange={(code) => setScript('post', code)}
                  placeholder={"bru.setVar('token', res.json.access_token)\ntest('is ok', () => expect(res.status).toBe(200))"}
                />
              </div>
            </div>

            <p className="shrink-0 text-[11px] leading-relaxed text-slate-400">
              Available: <code className="font-mono">req</code> (method/url/headers/body, mutable),{' '}
              <code className="font-mono">res</code> (status/headers/body/json/latencyMs),{' '}
              <code className="font-mono">bru.getVar/setVar/getEnvVar/setEnvVar</code>,{' '}
              <code className="font-mono">test(name, fn)</code>,{' '}
              <code className="font-mono">expect()</code>, <code className="font-mono">console.log</code>.
              Sandboxed QuickJS: no network, no filesystem, 5 s limit.
            </p>
          </div>
        )}

        {section === 'tests' && (
          <div className="flex flex-col gap-3">
            <AssertionEditor
              rows={spec.assertions ?? []}
              onChange={(assertions) => onSpec({ assertions })}
            />
            <p className="text-[11px] text-slate-400">
              Sources: <code className="font-mono">status</code>,{' '}
              <code className="font-mono">latencyMs</code>, <code className="font-mono">size</code>,{' '}
              <code className="font-mono">body</code>, <code className="font-mono">headers.&lt;name&gt;</code>,
              or a JSON path like <code className="font-mono">$.data.0.id</code>. Results appear in the
              response pane.
            </p>
          </div>
        )}

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
        <p className="flex shrink-0 flex-wrap items-center gap-2 border-t border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <span>Undefined variable{tab.missing.length > 1 ? 's' : ''}:</span>
          {tab.missing.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => onDefineVar(name)}
              title={`Define {{${name}}} in the active environment`}
              className="rounded bg-amber-200/70 px-1.5 py-0.5 font-mono hover:bg-amber-300/70 dark:bg-amber-900/60 dark:hover:bg-amber-800/60"
            >
              {name} <i className="fa-solid fa-plus text-[9px]" />
            </button>
          ))}
        </p>
      )}

      {tab.note && (
        <p className="flex shrink-0 items-center gap-2 border-t border-sky-200 bg-sky-50 px-3 py-1 text-xs text-sky-800 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200">
          <i className="fa-solid fa-circle-info" />
          <span className="min-w-0 flex-1">{tab.note}</span>
          {tab.needsAuth && (
            <button
              type="button"
              onClick={() => setSection('auth')}
              className="shrink-0 rounded bg-sky-600 px-2 py-0.5 font-medium text-white hover:bg-sky-700"
            >
              Open Auth tab
            </button>
          )}
        </p>
      )}

      {chainable.length > 0 && (
        <p
          className="shrink-0 truncate border-t border-slate-200 px-3 py-1 text-[11px] text-slate-400 dark:border-slate-800"
          title={chainable.map((c) => `{{res.${c.name}.body.…}}  (${c.status})`).join('\n')}
        >
          <i className="fa-solid fa-link" /> chain from: {chainable.map((c) => c.name).join(', ')}
        </p>
      )}
      <MatrixDialog
        open={matrixOpen}
        spec={spec}
        vaultKeys={vaultKeys}
        onClose={() => setMatrixOpen(false)}
        onToast={onToast}
      />
    </section>
  );
}

function AuthEditor({
  spec,
  onSpec,
  vaultKeys,
  tokenTick,
  onToast,
}: {
  spec: RequestSpec;
  onSpec: (patch: Partial<RequestSpec>) => void;
  vaultKeys: KeyEntry[];
  tokenTick: number;
  onToast: (msg: string) => void;
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
          <option value="vault">From key vault</option>
          <option value="oauth2">OAuth 2.0</option>
          <option value="bearer">Bearer token</option>
          <option value="basic">Basic</option>
          <option value="header">Custom header</option>
        </select>
      </Field>

      {auth.type === 'oauth2' && (
        <OAuth2Editor
          config={auth.oauth2 ?? { grant: 'client_credentials', clientAuth: 'body' }}
          onChange={(oauth2) => set({ oauth2 })}
          tokenTick={tokenTick}
          onToast={onToast}
        />
      )}

      {auth.type === 'vault' && (
        <>
          <Field label="Key" htmlFor="auth-key">
            <select
              id="auth-key"
              value={auth.keyId ?? ''}
              onChange={(e) => set({ keyId: e.target.value })}
              className="h-8 w-full rounded border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-800"
            >
              <option value="">Choose a key…</option>
              {vaultKeys
                .filter((k) => k.testable)
                .map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.provider}
                    {k.label ? ` · ${k.label}` : ''}
                  </option>
                ))}
            </select>
          </Field>
          <p className="text-xs text-slate-400">
            The key's own scheme is applied on send — Bearer for the OpenAI family,{' '}
            <code className="font-mono">x-api-key</code> for Anthropic, a query param for Gemini, a
            freshly signed JWT for z.ai. Its non-secret fields are available as variables, e.g.{' '}
            <code className="font-mono">{'{{vault.baseURL}}'}</code> and{' '}
            <code className="font-mono">{'{{vault.model}}'}</code>.
          </p>
        </>
      )}

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

      {auth.type !== 'vault' && auth.type !== 'oauth2' && (
        <p className="text-xs text-slate-400">
          Values accept variables: <code className="font-mono">{'{{token}}'}</code> from the
          environment, or <code className="font-mono">{'{{res.Login.body.access_token}}'}</code> to
          chain off an earlier response.
        </p>
      )}
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
