import type { Provider } from '../../shared/types.ts';
import { makeOpenAICompat } from './openai-compat.ts';
import { anthropic, core, elevenlabs, gemini, perplexity, zai } from './native.ts';
import { cloudflareR2, doSpaces } from './storage.ts';
import { reference } from './reference.ts';
import type { Adapter } from './types.ts';

// Build OpenAI-compatible adapters with sensible defaults.
const openai = makeOpenAICompat({
  id: 'openai',
  label: 'OpenAI',
  defaultBaseURL: 'https://api.openai.com/v1',
  defaultSection: '--openai',
});
const deepseek = makeOpenAICompat({
  id: 'deepseek',
  label: 'DeepSeek',
  defaultBaseURL: 'https://api.deepseek.com',
  defaultSection: '--deepseek',
});
const openrouter = makeOpenAICompat({
  id: 'openrouter',
  label: 'OpenRouter',
  defaultBaseURL: 'https://openrouter.ai/api/v1',
  defaultSection: '--openrouter',
});
const deepinfra = makeOpenAICompat({
  id: 'deepinfra',
  label: 'DeepInfra',
  defaultBaseURL: 'https://api.deepinfra.com/v1/openai',
  defaultSection: '--deepinfra',
});
const openaiCompat = makeOpenAICompat({
  id: 'openai-compat',
  label: 'OpenAI-compatible (generic)',
  defaultBaseURL: '',
  defaultSection: '--openai-compat',
});

const REGISTRY: Adapter[] = [
  openai,
  deepseek,
  openrouter,
  deepinfra,
  openaiCompat,
  anthropic,
  gemini,
  perplexity,
  elevenlabs,
  core,
  zai,
  cloudflareR2,
  doSpaces,
  reference,
];

const MAP = new Map<Provider, Adapter>(REGISTRY.map((a) => [a.id, a]));

export function getAdapter(provider: Provider): Adapter | undefined {
  return MAP.get(provider);
}

export function listAdapters(): Adapter[] {
  return REGISTRY;
}

export function listTestableAdapters(): Adapter[] {
  return REGISTRY.filter((a) => a.kind !== 'reference');
}

export { REGISTRY as ADAPTERS };
