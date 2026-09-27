// The "Text" view of an SSE tab: an LLM completion stitched back together from
// its deltas, with the numbers providers get compared on. Same measuring rules
// as the HTTP stream reader (server/core/stream.ts): TTFT from when the request
// went out, rate from the first delta on, in real tokens when reported.

import { useEffect, useRef } from 'react';

import type { RTStream } from './useRealtime.ts';

interface Props {
  stream: RTStream;
  /** the connection is still open, so more may arrive */
  live: boolean;
  onCopy: (text: string) => void;
}

export function StreamText({ stream, live, onCopy }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [stream.text]);

  const ttft = stream.firstAt != null && stream.startedAt != null ? stream.firstAt - stream.startedAt : undefined;
  const seconds =
    stream.firstAt != null && stream.lastAt != null && stream.lastAt > stream.firstAt
      ? (stream.lastAt - stream.firstAt) / 1000
      : undefined;
  const counted = stream.tokens ?? stream.deltas;
  const rate = seconds && counted > 1 ? ((counted - 1) / seconds).toFixed(1) : undefined;
  const status = stream.done ? 'finished' : live ? (stream.deltas ? 'streaming…' : 'waiting…') : stream.deltas ? 'ended' : '';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-y border-slate-200 px-3 py-1.5 text-xs text-slate-500 dark:border-slate-800">
        {ttft != null && (
          <span title="Time to first token: from connect to the first delta">
            <i className="fa-solid fa-stopwatch" /> TTFT {ttft} ms
          </span>
        )}
        {rate && (
          <span
            title={
              stream.tokens
                ? `${stream.tokens} completion tokens reported by the provider, over ${stream.deltas} SSE events`
                : `${stream.deltas} SSE events (the provider did not report a token count, and one event can carry several tokens)`
            }
          >
            <i className="fa-solid fa-gauge-high" /> {rate} {stream.tokens ? 'tok/s' : 'ev/s'}
          </span>
        )}
        <span>
          <i className="fa-solid fa-layer-group" /> {stream.deltas} delta{stream.deltas === 1 ? '' : 's'} ·{' '}
          {stream.text.length} chars
        </span>
        {status && (
          <span className={stream.done ? 'text-emerald-600 dark:text-emerald-400' : live ? 'text-amber-500' : ''}>
            {status}
          </span>
        )}
        <button
          type="button"
          onClick={() => onCopy(stream.text)}
          disabled={!stream.text}
          className="ml-auto h-6 rounded border border-slate-300 px-2 text-[11px] font-medium uppercase tracking-wide hover:bg-slate-100 disabled:opacity-40 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          Copy
        </button>
      </div>

      <div
        ref={ref}
        onScroll={() => {
          const el = ref.current;
          if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="min-h-0 flex-1 overflow-auto p-3"
      >
        {stream.text ? (
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6 text-slate-800 dark:text-slate-200">
            {stream.text}
            {live && !stream.done && <span className="ml-0.5 animate-pulse text-indigo-500">▍</span>}
          </pre>
        ) : (
          <p className="p-4 text-center text-xs text-slate-400">
            No completion text yet. This view fills in when events carry OpenAI, Anthropic, Gemini or Ollama style
            deltas; other streams stay in Events.
          </p>
        )}
      </div>
    </div>
  );
}
