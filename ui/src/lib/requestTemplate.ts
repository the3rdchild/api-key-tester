import type { KeyEntry } from '../../../shared/types.ts';

export interface RequestTemplate {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  /** optional advisory shown above the editor (e.g. unsupported auth schemes) */
  note?: string;
}

const OPENAI_DEFAULTS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com',
  openrouter: 'https://openrouter.ai/api/v1',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  'openai-compat': '',
};

const OPENAI_MODEL_DEFAULTS: Record<string, string> = {
  openai: 'gpt-4o-mini',
  deepseek: 'deepseek-chat',
  openrouter: 'openai/gpt-4o-mini',
  deepinfra: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
  'openai-compat': 'gpt-4o-mini',
};

function stripSlash(u: string): string {
  return u.replace(/\/+$/, '');
}

function pretty(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

/**
 * Build an editable, provider-aware default request that already carries the
 * key's own token/credentials, so the user can hit "Send" without re-entering
 * anything. Mirrors the auth scheme each server-side adapter uses.
 */
export async function buildRequestTemplate(entry: KeyEntry): Promise<RequestTemplate> {
  const c = entry.credentials || {};
  const apiKey = (c.apiKey || '').trim();
  const provider = entry.provider;

  // ─ OpenAI-compatible family ───────────────────────────────────────────────
  if (provider in OPENAI_DEFAULTS) {
    const base = stripSlash((c.baseURL || OPENAI_DEFAULTS[provider] || '').trim());
    const model = (c.model || OPENAI_MODEL_DEFAULTS[provider] || 'gpt-4o-mini').trim();
    return {
      method: 'POST',
      url: `${base || 'https://your-endpoint/v1'}/chat/completions`,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: pretty({
        model,
        messages: [{ role: 'user', content: 'Hello! Reply with a short greeting.' }],
        max_tokens: 32,
      }),
      note: base ? undefined : 'No base URL saved for this key - set the endpoint before sending.',
    };
  }

  // ─ Anthropic ──────────────────────────────────────────────────────────────
  if (provider === 'anthropic') {
    const base = stripSlash((c.baseURL || 'https://api.anthropic.com/v1').trim());
    return {
      method: 'POST',
      url: `${base}/messages`,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: pretty({
        model: (c.model || 'claude-3-5-haiku-latest').trim(),
        max_tokens: 32,
        messages: [{ role: 'user', content: 'Hello! Reply with a short greeting.' }],
      }),
    };
  }

  // ─ Gemini (key in query param) ────────────────────────────────────────────
  if (provider === 'gemini') {
    const base = stripSlash((c.baseURL || 'https://generativelanguage.googleapis.com/v1beta').trim());
    const model = (c.model || 'gemini-2.0-flash').trim();
    return {
      method: 'POST',
      url: `${base}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      headers: { 'Content-Type': 'application/json' },
      body: pretty({
        contents: [{ parts: [{ text: 'Hello! Reply with a short greeting.' }] }],
      }),
    };
  }

  // ─ Perplexity ─────────────────────────────────────────────────────────────
  if (provider === 'perplexity') {
    const base = stripSlash((c.baseURL || 'https://api.perplexity.ai').trim());
    return {
      method: 'POST',
      url: `${base}/chat/completions`,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: pretty({
        model: (c.model || 'sonar').trim(),
        messages: [{ role: 'user', content: 'Hello! Reply with a short greeting.' }],
        max_tokens: 32,
      }),
    };
  }

  // ─ ElevenLabs (TTS) ───────────────────────────────────────────────────────
  if (provider === 'elevenlabs') {
    const voiceId = (c.voiceId || 'JBFqnCBsd6RMkjVDRZzb').trim();
    return {
      method: 'POST',
      url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: pretty({
        text: 'Hello from the key tester.',
        model_id: 'eleven_multilingual_v2',
      }),
      note: 'Response is audio (binary) - the body preview may show raw bytes.',
    };
  }

  // ─ CORE (scientific search, GET) ──────────────────────────────────────────
  if (provider === 'core') {
    const base = stripSlash((c.baseURL || 'https://api.core.ac.uk/v3').trim());
    return {
      method: 'GET',
      url: `${base}/search/works?q=${encodeURIComponent('machine learning')}&limit=1`,
      headers: { Authorization: `Bearer ${apiKey}` },
      body: '',
    };
  }

  // ─ z.ai (HS256 JWT signed from id.secret) ─────────────────────────────────
  if (provider === 'zai') {
    const id = (c.apiKeyId || '').trim();
    const secret = (c.apiSecret || '').trim();
    let token = '';
    let note: string | undefined;
    try {
      if (id && secret) token = await signZAIJWT(id, secret);
      else note = 'Missing API Key ID / Secret - cannot mint a JWT.';
    } catch (e) {
      note = `Failed to sign JWT: ${e instanceof Error ? e.message : String(e)}`;
    }
    return {
      method: 'POST',
      url: 'https://api.z.ai/api/v1/chat/completions',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: pretty({
        model: (c.model || 'glm-4.6').trim(),
        messages: [{ role: 'user', content: 'Hello! Reply with a short greeting.' }],
        max_tokens: 32,
      }),
      note: note ?? 'Token is a short-lived JWT minted from your key (expires in 1h).',
    };
  }

  // ─ Storage (S3 / SigV4) - not templatable as a plain raw request ───────────
  if (provider === 'cloudflare-r2' || provider === 'do-spaces') {
    const endpoint = stripSlash((c.endpoint || '').trim());
    const bucket = (c.bucket || '').trim();
    return {
      method: 'GET',
      url: endpoint && bucket ? `${endpoint}/${bucket}` : endpoint || 'https://<endpoint>',
      headers: {},
      body: '',
      note:
        'S3-compatible storage needs AWS SigV4 request signing, which this raw tester cannot generate. ' +
        'Use the ▶ test button for a real signed check.',
    };
  }

  // ─ Fallback ────────────────────────────────────────────────────────────────
  return {
    method: 'POST',
    url: (c.baseURL || '').trim() || 'https://',
    headers: apiKey ? { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } : {},
    body: '',
    note: 'No template for this provider - edit the request manually.',
  };
}

// HS256 JWT matching server/adapters/native.ts signZAIJWT.
async function signZAIJWT(id: string, secret: string): Promise<string> {
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
