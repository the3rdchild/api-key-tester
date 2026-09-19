// Auth straight from the key vault.
//
// Picking a key in the Auth tab should do what that provider actually wants -
// Bearer for the OpenAI family, x-api-key + version for Anthropic, a query
// param for Gemini, xi-api-key for ElevenLabs, a freshly minted JWT for z.ai.
// The schemes here mirror server/adapters/* so a request sent from the client
// authenticates exactly like the vault's own test probe.

import { getAllKeys } from './store.ts';
import { signZAIJWT } from '../adapters/native.ts';
import type { KeyEntry, Provider } from '../../shared/types.ts';

export interface VaultAuth {
  headers: Record<string, string>;
  /** query params to append (Gemini puts the key in the URL) */
  query: Record<string, string>;
  /** non-secret credential fields, exposed as {{vault.<field>}} */
  vars: Record<string, string>;
  /** shown in the UI when the provider can't be used from a raw request */
  note?: string;
}

/** Credential fields never exposed as variables - they'd end up in previews. */
const SECRET_FIELDS = new Set([
  'apiKey',
  'apiSecret',
  'secret',
  'token',
  'password',
  'accessKeyId',
  'secretAccessKey',
]);

const BEARER_PROVIDERS: Provider[] = [
  'openai',
  'deepseek',
  'openrouter',
  'deepinfra',
  'openai-compat',
  'perplexity',
  'core',
];

function publicVars(entry: KeyEntry): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(entry.credentials ?? {})) {
    if (SECRET_FIELDS.has(k) || typeof v !== 'string') continue;
    out[`vault.${k}`] = v.replace(/\/+$/, '');
  }
  out['vault.provider'] = entry.provider;
  if (entry.label) out['vault.label'] = entry.label;
  return out;
}

export async function resolveVaultAuth(keyId: string): Promise<VaultAuth | null> {
  const entry = (await getAllKeys()).find((k) => k.id === keyId);
  if (!entry) return null;

  const c = entry.credentials ?? {};
  const apiKey = (c.apiKey ?? '').trim();
  const base: VaultAuth = { headers: {}, query: {}, vars: publicVars(entry) };

  if (BEARER_PROVIDERS.includes(entry.provider)) {
    if (apiKey) base.headers.Authorization = `Bearer ${apiKey}`;
    else base.note = 'This key has no apiKey saved.';
    return base;
  }

  switch (entry.provider) {
    case 'anthropic':
      base.headers['x-api-key'] = apiKey;
      base.headers['anthropic-version'] = '2023-06-01';
      return base;

    case 'gemini':
      // The adapter authenticates with ?key=… ; the header form is not
      // accepted by every endpoint, so keep them consistent.
      base.query.key = apiKey;
      return base;

    case 'elevenlabs':
      base.headers['xi-api-key'] = apiKey;
      return base;

    case 'zai': {
      const id = (c.apiKeyId ?? '').trim();
      const secret = (c.apiSecret ?? '').trim();
      if (!id || !secret) {
        base.note = 'z.ai needs both API Key ID and Secret to mint a JWT.';
        return base;
      }
      try {
        base.headers.Authorization = `Bearer ${await signZAIJWT(id, secret)}`;
        base.note = 'Signed a fresh 1-hour JWT for this send.';
      } catch (e) {
        base.note = `Failed to sign the z.ai JWT: ${e instanceof Error ? e.message : String(e)}`;
      }
      return base;
    }

    case 'cloudflare-r2':
    case 'do-spaces':
      base.note =
        'S3-compatible storage needs AWS SigV4 signing, which a raw request cannot produce. Use the vault tab’s test button instead.';
      return base;

    case 'reference':
      base.note = 'This entry is reference-only - it carries no usable API key.';
      return base;

    default:
      if (apiKey) base.headers.Authorization = `Bearer ${apiKey}`;
      return base;
  }
}
