// OAuth2 configuration + the buttons that actually get a token.
//
// The editor shows only the fields the chosen grant uses - an OAuth2 form that
// shows all twelve fields at once is how these panels become unusable.

import { useCallback, useEffect, useRef, useState } from 'react';

import { clientApi, type DeviceStart } from '../lib/clientApi.ts';
import type { OAuth2Config, OAuth2Grant, TokenInfo } from '../../../shared/collections.ts';

const GRANTS: { id: OAuth2Grant; label: string; browser: boolean }[] = [
  { id: 'client_credentials', label: 'Client credentials', browser: false },
  { id: 'password', label: 'Password', browser: false },
  { id: 'authorization_code', label: 'Authorization code (+ PKCE)', browser: true },
  { id: 'implicit', label: 'Implicit', browser: true },
  { id: 'refresh_token', label: 'Refresh token', browser: false },
  { id: 'device_code', label: 'Device code', browser: false },
];

interface Props {
  config: OAuth2Config;
  onChange: (config: OAuth2Config) => void;
  /** bumped when a token lands from the callback tab */
  tokenTick: number;
  onToast: (msg: string) => void;
}

export function OAuth2Editor({ config, onChange, tokenTick, onToast }: Props) {
  const [token, setToken] = useState<TokenInfo | null>(null);
  const [redirectUri, setRedirectUri] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceStart | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const grant = config.grant ?? 'client_credentials';
  const meta = GRANTS.find((g) => g.id === grant)!;
  const set = (patch: Partial<OAuth2Config>) => onChange({ ...config, ...patch });

  const refreshStatus = useCallback(() => {
    clientApi.oauth
      .status(config)
      .then(({ token }) => setToken(token))
      .catch(() => setToken(null));
  }, [config]);

  useEffect(() => {
    clientApi.oauth
      .redirectUri()
      .then(({ redirectUri }) => setRedirectUri(redirectUri))
      .catch(() => {});
  }, []);

  // Re-check on every config edit (the cache key is derived from it) and
  // whenever the callback tab reports a new token.
  useEffect(() => {
    const t = setTimeout(refreshStatus, 250);
    return () => clearTimeout(t);
  }, [refreshStatus, tokenTick]);

  useEffect(() => () => void (pollRef.current && clearInterval(pollRef.current)), []);

  const getToken = async () => {
    setBusy('token');
    try {
      const { token } = await clientApi.oauth.token(config);
      setToken(token);
      onToast('Token received');
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const authorize = async () => {
    setBusy('authorize');
    try {
      const { authorizeUrl } = await clientApi.oauth.authorize(config);
      window.open(authorizeUrl, 'oauth2-authorize', 'width=620,height=760');
      onToast('Finish the login in the window that opened');
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const startDevice = async () => {
    setBusy('device');
    try {
      const start = await clientApi.oauth.deviceStart(config);
      setDevice(start);
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const res = await clientApi.oauth.devicePoll(config, start.deviceCode);
          if (res.token) {
            setToken(res.token);
            setDevice(null);
            if (pollRef.current) clearInterval(pollRef.current);
            onToast('Device authorized');
          }
        } catch (e) {
          if (pollRef.current) clearInterval(pollRef.current);
          setDevice(null);
          onToast(e instanceof Error ? e.message : String(e));
        }
      }, Math.max(1, start.interval) * 1000);
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    const { id } = await clientApi.oauth.status(config);
    await clientApi.oauth.clear(id);
    setToken(null);
    onToast('Token cleared');
  };

  const show = {
    authUrl: grant === 'authorization_code' || grant === 'implicit',
    deviceUrl: grant === 'device_code',
    tokenUrl: grant !== 'implicit',
    secret: grant !== 'implicit',
    userPass: grant === 'password',
    pkce: grant === 'authorization_code',
    redirect: grant === 'authorization_code' || grant === 'implicit',
    refresh: grant === 'refresh_token',
  };

  return (
    <div className="grid max-w-xl gap-3 text-sm">
      <Field label="Grant" htmlFor="oauth-grant">
        <select
          id="oauth-grant"
          value={grant}
          onChange={(e) => set({ grant: e.target.value as OAuth2Grant })}
          className="h-8 w-full rounded border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-800"
        >
          {GRANTS.map((g) => (
            <option key={g.id} value={g.id}>
              {g.label}
            </option>
          ))}
        </select>
      </Field>

      {show.authUrl && (
        <Text id="oauth-authurl" label="Authorization URL" value={config.authUrl ?? ''} onChange={(authUrl) => set({ authUrl })} placeholder="https://provider/oauth/authorize" />
      )}
      {show.deviceUrl && (
        <Text id="oauth-deviceurl" label="Device authorization URL" value={config.deviceUrl ?? ''} onChange={(deviceUrl) => set({ deviceUrl })} placeholder="https://provider/oauth/device/code" />
      )}
      {show.tokenUrl && (
        <Text id="oauth-tokenurl" label="Token URL" value={config.tokenUrl ?? ''} onChange={(tokenUrl) => set({ tokenUrl })} placeholder="https://provider/oauth/token" />
      )}

      <Text id="oauth-clientid" label="Client ID" value={config.clientId ?? ''} onChange={(clientId) => set({ clientId })} />
      {show.secret && (
        <Text id="oauth-secret" label="Client secret" type="password" value={config.clientSecret ?? ''} onChange={(clientSecret) => set({ clientSecret })} />
      )}

      {show.userPass && (
        <>
          <Text id="oauth-user" label="Username" value={config.username ?? ''} onChange={(username) => set({ username })} />
          <Text id="oauth-pass" label="Password" type="password" value={config.password ?? ''} onChange={(password) => set({ password })} />
        </>
      )}

      {show.refresh && (
        <Text id="oauth-refresh" label="Refresh token" type="password" value={config.refreshToken ?? ''} onChange={(refreshToken) => set({ refreshToken })} />
      )}

      <Text id="oauth-scope" label="Scope" value={config.scope ?? ''} onChange={(scope) => set({ scope })} placeholder="openid profile" />

      <div className="grid grid-cols-2 gap-3">
        <Field label="Client auth" htmlFor="oauth-clientauth">
          <select
            id="oauth-clientauth"
            value={config.clientAuth ?? 'body'}
            onChange={(e) => set({ clientAuth: e.target.value as 'body' | 'basic' })}
            className="h-8 w-full rounded border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-800"
          >
            <option value="body">In the request body</option>
            <option value="basic">Basic auth header</option>
          </select>
        </Field>

        {show.pkce && (
          <div className="flex items-end gap-2 pb-1">
            <input
              id="oauth-pkce"
              type="checkbox"
              checked={config.usePkce !== false}
              onChange={(e) => set({ usePkce: e.target.checked })}
              className="h-4 w-4 rounded border-slate-300 text-indigo-600 dark:border-slate-600 dark:bg-slate-800"
            />
            <label htmlFor="oauth-pkce" className="cursor-pointer text-sm">
              Use PKCE (S256)
            </label>
          </div>
        )}
      </div>

      {show.redirect && (
        <div className="grid gap-1">
          <label htmlFor="oauth-redirect" className="text-xs font-medium text-slate-500">
            Redirect URI <span className="font-normal">— register this with the provider</span>
          </label>
          <div className="flex gap-2">
            <input
              id="oauth-redirect"
              value={config.redirectUri ?? redirectUri}
              onChange={(e) => set({ redirectUri: e.target.value })}
              className="h-8 w-full rounded border border-slate-300 bg-white px-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-800"
            />
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(config.redirectUri || redirectUri).catch(() => {});
                onToast('Redirect URI copied');
              }}
              className="h-8 shrink-0 rounded border border-slate-300 px-2 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              <i className="fa-solid fa-copy" /> Copy
            </button>
          </div>
        </div>
      )}

      {/* ─── token state + actions ─────────────────────────────────────────── */}
      <div className="rounded border border-slate-200 p-2 dark:border-slate-800">
        {token ? (
          <div className="grid gap-1 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                <i className="fa-solid fa-key" /> {token.tokenType} {token.preview}
              </span>
              <Expiry expiresAt={token.expiresAt} />
              {token.hasRefreshToken && <span className="text-slate-400">refreshable</span>}
              {token.scope && <span className="text-slate-400">scope: {token.scope}</span>}
            </div>
            <p className="text-slate-400">
              Refreshed automatically when it is within a minute of expiring.
            </p>
          </div>
        ) : (
          <p className="text-xs text-slate-500">
            No token cached for this configuration yet.
          </p>
        )}

        <div className="mt-2 flex flex-wrap gap-2">
          {meta.browser ? (
            <button
              type="button"
              onClick={authorize}
              disabled={busy === 'authorize'}
              className="h-8 rounded bg-indigo-600 px-3 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              <i className="fa-solid fa-arrow-up-right-from-square" /> Authorize…
            </button>
          ) : grant === 'device_code' ? (
            <button
              type="button"
              onClick={startDevice}
              disabled={busy === 'device' || !!device}
              className="h-8 rounded bg-indigo-600 px-3 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              <i className="fa-solid fa-mobile-screen" /> Start device flow
            </button>
          ) : (
            <button
              type="button"
              onClick={getToken}
              disabled={busy === 'token'}
              className="h-8 rounded bg-indigo-600 px-3 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {busy === 'token' ? <i className="fa-solid fa-spinner fa-spin" /> : <i className="fa-solid fa-key" />} Get token
            </button>
          )}

          {token && (
            <button
              type="button"
              onClick={clear}
              className="h-8 rounded border border-slate-300 px-3 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              <i className="fa-solid fa-trash" /> Clear token
            </button>
          )}
        </div>

        {device && (
          <div className="mt-2 rounded bg-slate-100 p-2 text-xs dark:bg-slate-800">
            Open{' '}
            <a
              href={device.verificationUriComplete || device.verificationUri}
              target="_blank"
              rel="noreferrer"
              className="text-indigo-600 underline dark:text-indigo-400"
            >
              {device.verificationUri}
            </a>{' '}
            and enter <span className="font-mono font-semibold">{device.userCode}</span>
            <span className="ml-2 text-slate-400">
              <i className="fa-solid fa-spinner fa-spin" /> waiting…
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function Expiry({ expiresAt }: { expiresAt?: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!expiresAt) return <span className="text-slate-400">no expiry given</span>;
  const secs = Math.round((expiresAt - now) / 1000);
  if (secs <= 0) return <span className="text-amber-600">expired</span>;
  const label = secs > 90 ? `${Math.round(secs / 60)} min` : `${secs} s`;
  return <span className={secs < 60 ? 'text-amber-600' : 'text-slate-400'}>expires in {label}</span>;
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

function Text({
  id,
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <Field label={label} htmlFor={id}>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-full rounded border border-slate-300 bg-white px-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-800"
      />
    </Field>
  );
}
