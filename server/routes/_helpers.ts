import type { Provider } from '../../shared/types.ts';

// Re-exported env var name lookup for routes that need it without importing
// the full writer (avoids circular deps).
export function envVarNameForProviderPath(p: Provider): string | null {
  switch (p) {
    case 'openai': return 'OPENAI_API_KEY';
    case 'deepseek': return 'DEEPSEEK_API_KEY';
    case 'openrouter': return 'OPENROUTER_API_KEY';
    case 'deepinfra': return 'DEEPINFRA_API_KEY';
    case 'anthropic': return 'ANTHROPIC_API_KEY';
    case 'gemini': return 'GEMINI_API_KEY';
    case 'perplexity': return 'AI_API_KEY';
    case 'elevenlabs': return 'ELEVENLABS_API_KEY';
    case 'core': return 'CORE_API_KEY';
    default: return null;
  }
}
