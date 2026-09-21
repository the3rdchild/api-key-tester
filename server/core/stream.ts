// Server-sent-event streaming for LLM responses.
//
// A streamed completion is the one case where "wait for the whole body" throws
// away the interesting part: the first token usually arrives in a fraction of
// the total time, and time-to-first-token plus tokens/second is what you
// actually compare providers on. So the reader here forwards each chunk as it
// lands and measures while it does.
//
// Delta shapes differ per provider, so extraction stays tolerant: OpenAI-style
// choices[].delta.content, Anthropic-style content_block_delta, Gemini-style
// candidates[].content.parts[].text, and a plain-text fallback.

import { mergeCompletionMeta } from './llm-meta.ts';
import type { CompletionMeta, StreamStats } from '../../shared/collections.ts';

export interface StreamOptions {
  /** called for every piece of generated text, as it arrives */
  onChunk?: (text: string, raw: string) => void;
  /** hard cap on what we keep in memory */
  maxBytes?: number;
  /**
   * When the request was sent. Time-to-first-token is measured from here, not
   * from when this reader starts: Bun's fetch resolves only once the first body
   * byte lands, so measuring locally would report ~0 ms and quietly move the
   * whole wait into TTFB.
   */
  startedAt?: number;
}

export interface StreamOutcome {
  /** the raw SSE body, exactly as it came over the wire */
  body: string;
  truncated: boolean;
  size: number;
  /** the generated text, deltas stitched back together */
  text: string;
  stats: StreamStats;
  /** token counts, cost and finish reason, when the stream reports them */
  completion?: CompletionMeta;
}

const DEFAULT_MAX = 1024 * 1024;

/** Is this response worth reading as a stream? */
export function isStreaming(res: Response): boolean {
  const type = res.headers.get('content-type') ?? '';
  return type.includes('text/event-stream') || type.includes('application/x-ndjson');
}

/** OpenAI-compatible streams put usage in the final chunk; Anthropic puts
 *  output_tokens on message_delta. Either beats counting SSE events. */
function extractTokens(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const obj = payload as Record<string, any>;
  const n = obj.usage?.completion_tokens ?? obj.usage?.output_tokens;
  return typeof n === 'number' && n > 0 ? n : undefined;
}

function extractDelta(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object') return '';
  const obj = payload as Record<string, any>;

  // OpenAI-compatible: choices[0].delta.content (or .text for completions)
  const choice = obj.choices?.[0];
  if (choice) {
    if (typeof choice.delta?.content === 'string') return choice.delta.content;
    if (typeof choice.text === 'string') return choice.text;
    if (typeof choice.message?.content === 'string') return choice.message.content;
  }

  // Anthropic: {type: content_block_delta, delta: {text}}
  if (typeof obj.delta?.text === 'string') return obj.delta.text;

  // Gemini: candidates[0].content.parts[].text
  const parts = obj.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    return parts.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('');
  }

  // Ollama / plain: {response: "…"} or {message: {content}}
  if (typeof obj.response === 'string') return obj.response;
  if (typeof obj.message?.content === 'string') return obj.message.content;

  return '';
}

/** Read an SSE/NDJSON body to the end, reporting deltas as they arrive. */
export async function readStream(res: Response, opts: StreamOptions = {}): Promise<StreamOutcome> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX;
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();

  let raw = '';
  let size = 0;
  let truncated = false;
  let text = '';
  let pending = '';
  let chunks = 0;
  let deltas = 0;
  let reportedTokens: number | undefined;
  let completion: CompletionMeta | undefined;
  let finished = false;
  const startedAt = opts.startedAt ?? Date.now();
  let firstTokenAt: number | undefined;
  let lastTokenAt: number | undefined;

  const handleEvent = (payload: string) => {
    const trimmed = payload.trim();
    if (!trimmed) return;
    if (trimmed === '[DONE]') {
      finished = true;
      return;
    }
    let parsed: unknown = trimmed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      /* not JSON - treat as plain text */
    }
    reportedTokens = extractTokens(parsed) ?? reportedTokens;
    completion = mergeCompletionMeta(completion, parsed);
    const delta = extractDelta(parsed);
    if (!delta) return;
    deltas++;
    text += delta;
    firstTokenAt ??= Date.now();
    lastTokenAt = Date.now();
    opts.onChunk?.(delta, trimmed);
  };

  if (!reader) {
    const body = await res.text();
    return {
      body,
      truncated: false,
      size: body.length,
      text: body,
      stats: { chunks: 0, deltas: 0, finished: true },
    };
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    const piece = decoder.decode(value, { stream: true });
    if (!truncated) {
      if (raw.length + piece.length > maxBytes) {
        raw += piece.slice(0, Math.max(0, maxBytes - raw.length));
        truncated = true;
      } else {
        raw += piece;
      }
    }
    chunks++;
    pending += piece;

    // SSE frames are separated by a blank line; NDJSON by a newline.
    let index: number;
    while ((index = pending.search(/\r?\n\r?\n|\n/)) >= 0) {
      const separator = pending.slice(index).match(/^\r?\n\r?\n/) ? pending.slice(index).match(/^\r?\n\r?\n/)![0].length : 1;
      const frame = pending.slice(0, index);
      pending = pending.slice(index + separator);
      for (const line of frame.split(/\r?\n/)) {
        if (!line.trim()) continue;
        if (line.startsWith(':')) continue; // comment/keep-alive
        handleEvent(line.startsWith('data:') ? line.slice(5) : line);
      }
    }
  }
  if (pending.trim()) {
    for (const line of pending.split(/\r?\n/)) {
      if (!line.trim() || line.startsWith(':')) continue;
      handleEvent(line.startsWith('data:') ? line.slice(5) : line);
    }
  }

  // Generation rate is measured from the first delta - the wait before it is
  // latency, not throughput, and mixing them flatters slow providers. Counted
  // in real tokens when the stream says how many, because providers pack
  // several tokens into one SSE event (6 events for 32 tokens is normal), and
  // reporting events as "tok/s" understates the rate several-fold.
  const seconds =
    firstTokenAt && lastTokenAt && lastTokenAt > firstTokenAt
      ? (lastTokenAt - firstTokenAt) / 1000
      : undefined;
  const basis = reportedTokens ? 'tokens' : 'events';
  const counted = reportedTokens ?? deltas;

  const stats: StreamStats = {
    chunks,
    deltas,
    tokens: reportedTokens,
    rateBasis: seconds && counted > 1 ? basis : undefined,
    finished,
    ttftMs: firstTokenAt ? firstTokenAt - startedAt : undefined,
    tokensPerSecond:
      seconds && counted > 1 ? Number(((counted - 1) / seconds).toFixed(1)) : undefined,
  };

  return { body: raw, truncated, size, text, stats, completion };
}
