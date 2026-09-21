// Reading an LLM response's own account of itself.
//
// "Why did the answer stop mid-sentence?" is the most common question a person
// asks an API client about an LLM, and the response already answers it:
// finish_reason "length" means the model hit max_tokens, not that anything
// went wrong with the transport. Surfacing that turns a support question into
// a glance.

import type { CompletionMeta } from '../../shared/collections.ts';

/** Merge whatever a frame or body reveals into what we already know. */
export function mergeCompletionMeta(
  into: CompletionMeta | undefined,
  payload: unknown,
): CompletionMeta | undefined {
  if (!payload || typeof payload !== 'object') return into;
  const obj = payload as Record<string, any>;

  const choice = obj.choices?.[0];
  const finishReason: string | undefined =
    choice?.finish_reason ??
    choice?.native_finish_reason ??
    // Anthropic
    obj.delta?.stop_reason ??
    obj.stop_reason ??
    undefined;

  const usage = obj.usage ?? {};
  const completionTokens: number | undefined = usage.completion_tokens ?? usage.output_tokens;
  const promptTokens: number | undefined = usage.prompt_tokens ?? usage.input_tokens;

  const next: CompletionMeta = {
    ...into,
    model: obj.model ?? into?.model,
    finishReason: finishReason ?? into?.finishReason,
    promptTokens: typeof promptTokens === 'number' ? promptTokens : into?.promptTokens,
    completionTokens:
      typeof completionTokens === 'number' ? completionTokens : into?.completionTokens,
    totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : into?.totalTokens,
    cost: typeof usage.cost === 'number' ? usage.cost : into?.cost,
  };

  // Nothing worth reporting: keep it undefined so the UI shows no chips.
  return Object.values(next).some((v) => v !== undefined) ? next : into;
}

/** For a non-streamed JSON body. */
export function completionMetaFromBody(text: string): CompletionMeta | undefined {
  if (!text || (text[0] !== '{' && !text.trimStart().startsWith('{'))) return undefined;
  try {
    return mergeCompletionMeta(undefined, JSON.parse(text));
  } catch {
    return undefined;
  }
}
