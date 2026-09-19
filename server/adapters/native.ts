import {
  type Adapter,
  classifyResponse,
  errorState,
  safe,
  timedFetch,
  valid,
} from './types.ts';

// ─── Anthropic ──────────────────────────────────────────────────────────────
// GET https://api.anthropic.com/v1/models with x-api-key + anthropic-version
export const anthropic: Adapter = {
  id: 'anthropic',
  label: 'Anthropic (Claude)',
  kind: 'llm',
  defaultSection: '--anthropic',
  fields: [
    { key: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'sk-ant-…' },
    { key: 'baseURL', label: 'Base URL', type: 'url', placeholder: 'https://api.anthropic.com/v1' },
  ],
  test: (creds) =>
    safe(async () => {
      const apiKey = (creds.apiKey || '').trim();
      if (!apiKey) return errorState(0, 'Missing apiKey');
      const base = normalizeBase(creds.baseURL || 'https://api.anthropic.com/v1');
      const probe = await timedFetch(joinURL(base, '/models'), {
        timeoutMs: 6000,
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      });
      const text = await probe.res.text();
      return classifyResponse(probe.res, probe.latencyMs, text);
    }),
};

// ─── Gemini (Google AI) ─────────────────────────────────────────────────────
// GET https://generativelanguage.googleapis.com/v1beta/models?key=…
export const gemini: Adapter = {
  id: 'gemini',
  label: 'Google Gemini',
  kind: 'llm',
  defaultSection: '--gemini',
  fields: [
    { key: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'AIza…' },
    {
      key: 'baseURL',
      label: 'Base URL',
      type: 'url',
      placeholder: 'https://generativelanguage.googleapis.com/v1beta',
    },
  ],
  test: (creds) =>
    safe(async () => {
      const apiKey = (creds.apiKey || '').trim();
      if (!apiKey) return errorState(0, 'Missing apiKey');
      const base = normalizeBase(
        creds.baseURL || 'https://generativelanguage.googleapis.com/v1beta',
      );
      const url = `${joinURL(base, '/models')}?key=${encodeURIComponent(apiKey)}`;
      const probe = await timedFetch(url, { timeoutMs: 6000 });
      const text = await probe.res.text();
      return classifyResponse(probe.res, probe.latencyMs, text);
    }),
};

// ─── Perplexity ─────────────────────────────────────────────────────────────
// GET https://api.perplexity.ai/chat/completions → use /models
export const perplexity: Adapter = {
  id: 'perplexity',
  label: 'Perplexity (Sonar)',
  kind: 'llm',
  defaultSection: '--perplexity',
  fields: [
    { key: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'pplx-…' },
    {
      key: 'baseURL',
      label: 'Base URL',
      type: 'url',
      placeholder: 'https://api.perplexity.ai',
    },
  ],
  test: (creds) =>
    safe(async () => {
      const apiKey = (creds.apiKey || '').trim();
      if (!apiKey) return errorState(0, 'Missing apiKey');
      const base = normalizeBase(creds.baseURL || 'https://api.perplexity.ai');
      const probe = await timedFetch(joinURL(base, '/chat/models'), {
        timeoutMs: 6000,
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const text = await probe.res.text();
      return classifyResponse(probe.res, probe.latencyMs, text);
    }),
};

// ─── ElevenLabs (TTS) ───────────────────────────────────────────────────────
// GET https://api.elevenlabs.io/v1/user with xi-api-key
export const elevenlabs: Adapter = {
  id: 'elevenlabs',
  label: 'ElevenLabs (TTS)',
  kind: 'tool',
  defaultSection: '--elevenlabs',
  fields: [
    { key: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'sk_…' },
    { key: 'voiceId', label: 'Voice ID', type: 'text', placeholder: 'GdyFAZdMpKMBHw5pc1Bu' },
  ],
  test: (creds) =>
    safe(async () => {
      const apiKey = (creds.apiKey || '').trim();
      if (!apiKey) return errorState(0, 'Missing apiKey');
      const probe = await timedFetch('https://api.elevenlabs.io/v1/user', {
        timeoutMs: 6000,
        headers: { 'xi-api-key': apiKey },
      });
      const text = await probe.res.text();
      const result = classifyResponse(probe.res, probe.latencyMs, text);
      // extract subscription tier for detail
      if (result.state === 'valid') {
        try {
          const data = JSON.parse(text);
          const tier = data?.subscription?.tier;
          const chars = data?.subscription?.character_count;
          const limit = data?.subscription?.character_limit;
          const detail = [
            tier ? `tier=${tier}` : null,
            chars != null && limit != null ? `chars=${chars}/${limit}` : null,
          ]
            .filter(Boolean)
            .join(', ');
          return valid(probe.latencyMs, probe.res.status, detail || 'OK');
        } catch {
          /* fallthrough */
        }
      }
      return result;
    }),
};

// ─── CORE (scientific) ──────────────────────────────────────────────────────
// GET https://api.core.ac.uk/v3/search/works?q=…&limit=1 with Bearer
export const core: Adapter = {
  id: 'core',
  label: 'CORE (scientific)',
  kind: 'tool',
  defaultSection: '--core',
  fields: [
    { key: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: '…' },
    {
      key: 'baseURL',
      label: 'Base URL',
      type: 'url',
      placeholder: 'https://api.core.ac.uk/v3',
    },
  ],
  test: (creds) =>
    safe(async () => {
      const apiKey = (creds.apiKey || '').trim();
      if (!apiKey) return errorState(0, 'Missing apiKey');
      const base = normalizeBase(creds.baseURL || 'https://api.core.ac.uk/v3');
      const url = `${joinURL(base, '/search/works')}?q=${encodeURIComponent('doi:10.0/0')}&limit=1`;
      const probe = await timedFetch(url, {
        timeoutMs: 6000,
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const text = await probe.res.text();
      return classifyResponse(probe.res, probe.latencyMs, text);
    }),
};

// ─── z.ai ───────────────────────────────────────────────────────────────────
// Generate JWT from id.secret, then GET https://api.z.ai/api/v1/models
// JWT spec: payload { api_key: id, exp: now+3600s }, alg "HS256", key = secret
export const zai: Adapter = {
  id: 'zai',
  label: 'z.ai',
  kind: 'llm',
  defaultSection: '--z.ai',
  fields: [
    { key: 'apiKeyId', label: 'API Key ID', type: 'text', required: true, placeholder: 'b6e5…' },
    { key: 'apiSecret', label: 'API Key Secret', type: 'password', required: true },
  ],
  test: (creds) =>
    safe(async () => {
      const apiKeyId = (creds.apiKeyId || '').trim();
      const apiSecret = (creds.apiSecret || '').trim();
      if (!apiKeyId || !apiSecret) return errorState(0, 'Missing apiKeyId or apiSecret');
      const token = await signZAIJWT(apiKeyId, apiSecret);
      const probe = await timedFetch('https://api.z.ai/api/v1/models', {
        timeoutMs: 8000,
        headers: { Authorization: `Bearer ${token}` },
      });
      const text = await probe.res.text();
      return classifyResponse(probe.res, probe.latencyMs, text);
    }),
};

export async function signZAIJWT(id: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const header = { alg: 'HS256', sign_type: 'SIGN' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { api_key: id, exp: now + 3600, timestamp: now };
  const h = base64url(enc.encode(JSON.stringify(header)));
  const p = base64url(enc.encode(JSON.stringify(payload)));
  const data = `${h}.${p}`;
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return `${data}.${base64url(new Uint8Array(sig))}`;
}

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function normalizeBase(url: string): string {
  let u = (url || '').trim();
  if (!u) return '';
  if (u.endsWith('/')) u = u.slice(0, -1);
  return u;
}
function joinURL(base: string, path: string): string {
  if (base.endsWith(path)) return base;
  return base + path;
}
