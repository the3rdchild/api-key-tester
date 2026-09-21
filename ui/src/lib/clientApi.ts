// HTTP wrapper for the API-client endpoints (collections, send, history).

import type {
  CollectionsFile,
  EnvironmentDef,
  HistoryDetail,
  OAuth2Config,
  ReqHistoryEntry,
  RequestSpec,
  SendResult,
  TokenInfo,
} from '../../../shared/collections.ts';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const detail = await res
      .json()
      .then((d: { error?: string }) => d.error)
      .catch(() => null);
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

const BASE = '/api/collections';

export interface SendResponse {
  result: SendResult;
  missing: string[];
  /** advisory from the vault (unsupported provider, freshly signed JWT, …) */
  note?: string;
  /** OAuth2 stopped the send: the browser step is still needed */
  needsAuthorization?: boolean;
  historyId: string;
}

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  interval: number;
  expiresIn: number;
}

export const clientApi = {
  load: () => fetch(BASE).then((r) => json<CollectionsFile>(r)),

  createRequest: (spec: Partial<RequestSpec>, parentId?: string) =>
    fetch(`${BASE}/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec, parentId }),
    }).then((r) => json<RequestSpec>(r)),

  saveRequest: (spec: RequestSpec, parentId?: string) =>
    fetch(`${BASE}/requests/${spec.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec, parentId }),
    }).then((r) => json<RequestSpec>(r)),

  deleteRequest: (id: string) =>
    fetch(`${BASE}/requests/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: true }>(r)),

  duplicateRequest: (id: string) =>
    fetch(`${BASE}/requests/${id}/duplicate`, { method: 'POST' }).then((r) => json<RequestSpec>(r)),

  createFolder: (name: string, parentId?: string) =>
    fetch(`${BASE}/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parentId }),
    }).then((r) => json<{ id: string }>(r)),

  deleteFolder: (id: string) =>
    fetch(`${BASE}/folders/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: true }>(r)),

  rename: (id: string, name: string) =>
    fetch(`${BASE}/nodes/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then((r) => json<CollectionsFile>(r)),

  move: (id: string, parentId: string | null, index?: number) =>
    fetch(`${BASE}/nodes/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentId, index }),
    }).then((r) => json<CollectionsFile>(r)),

  createEnvironment: (name: string) =>
    fetch(`${BASE}/environments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then((r) => json<EnvironmentDef>(r)),

  saveEnvironment: (env: EnvironmentDef) =>
    fetch(`${BASE}/environments/${env.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ env }),
    }).then((r) => json<EnvironmentDef>(r)),

  deleteEnvironment: (id: string) =>
    fetch(`${BASE}/environments/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: true }>(r)),

  setActiveEnvironment: (id: string | null) =>
    fetch(`${BASE}/active-env`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }).then((r) => json<{ ok: true }>(r)),

  history: (limit = 200) =>
    fetch(`${BASE}/history?limit=${limit}`).then((r) => json<ReqHistoryEntry[]>(r)),

  historyDetail: (id: string) =>
    fetch(`${BASE}/history/${id}`).then((r) => json<HistoryDetail>(r)),

  clearHistory: () =>
    fetch(`${BASE}/history`, { method: 'DELETE' }).then((r) => json<{ ok: true }>(r)),

  cookies: () =>
    fetch(`${BASE}/cookies`).then((r) => json<{ domain: string; name: string; value: string }[]>(r)),

  clearCookies: (domain?: string) =>
    fetch(`${BASE}/cookies${domain ? `?domain=${encodeURIComponent(domain)}` : ''}`, {
      method: 'DELETE',
    }).then((r) => json<{ ok: true }>(r)),

  /** Send a request. Files (if any) travel as multipart so bytes never hit disk.
   *  `streamId` opts into live chunks over /live for streamed responses. */
  send: (spec: RequestSpec, files?: Record<string, File[]>, streamId?: string) => {
    const hasFiles = files && Object.values(files).some((list) => list.length > 0);
    if (!hasFiles) {
      return fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec, streamId }),
      }).then((r) => json<SendResponse>(r));
    }
    const form = new FormData();
    form.append('spec', JSON.stringify({ spec, streamId }));
    for (const [field, list] of Object.entries(files!)) {
      for (const file of list) form.append(`file:${field}`, file, file.name);
    }
    return fetch('/api/send', { method: 'POST', body: form }).then((r) => json<SendResponse>(r));
  },

  importCurl: (text: string) =>
    fetch(`${BASE}/import-curl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).then((r) => json<{ spec: RequestSpec; warnings: string[] }>(r)),

  chainable: () =>
    fetch(`${BASE}/chainable`).then((r) =>
      json<{ id: string; name: string; status: number }[]>(r),
    ),

  oauth: {
    redirectUri: () =>
      fetch('/api/oauth/redirect-uri').then((r) => json<{ redirectUri: string }>(r)),

    status: (config: OAuth2Config) =>
      fetch('/api/oauth/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config }),
      }).then((r) => json<{ id: string; token: TokenInfo | null }>(r)),

    /** run a grant that needs no browser (client_credentials, password, refresh) */
    token: (config: OAuth2Config) =>
      fetch('/api/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config }),
      }).then((r) => json<{ token: TokenInfo }>(r)),

    authorize: (config: OAuth2Config) =>
      fetch('/api/oauth/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config }),
      }).then((r) => json<{ authorizeUrl: string; state: string }>(r)),

    deviceStart: (config: OAuth2Config) =>
      fetch('/api/oauth/device/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config }),
      }).then((r) => json<DeviceStart>(r)),

    devicePoll: (config: OAuth2Config, deviceCode: string) =>
      fetch('/api/oauth/device/poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config, deviceCode }),
      }).then((r) => json<{ token?: TokenInfo; pending?: boolean }>(r)),

    clear: (id: string) =>
      fetch(`/api/oauth/tokens/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: true }>(r)),
  },

  curl: (spec: RequestSpec) =>
    fetch('/api/send/curl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec }),
    }).then((r) => json<{ curl: string }>(r)),
};
