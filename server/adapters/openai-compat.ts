import type { TestResult } from '../../shared/types.ts';
import {
  type Adapter,
  classifyResponse,
  errorState,
  safe,
  timedFetch,
  valid,
} from './types.ts';

interface OpenAICompatOpts {
  id: Adapter['id'];
  label: string;
  defaultBaseURL: string;
  defaultSection?: string;
}

/**
 * Factory for any OpenAI-compatible provider.
 * Test strategy:
 *   1. GET {base}/models - costs 0 tokens, fastest signal
 *   2. Fallback: POST {base}/chat/completions with max_tokens:1 (some proxies don't implement /models)
 */
export function makeOpenAICompat(opts: OpenAICompatOpts): Adapter {
  const { id, label, defaultBaseURL, defaultSection } = opts;
  return {
    id,
    label,
    kind: 'llm',
    defaultSection,
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'sk-…' },
      {
        key: 'baseURL',
        label: 'Base URL',
        type: 'url',
        required: true,
        placeholder: defaultBaseURL,
        help: `Default: ${defaultBaseURL}`,
      },
      { key: 'model', label: 'Model (optional)', type: 'text', placeholder: 'gpt-4o-mini' },
    ],
    test: (creds) =>
      safe(async () => {
        const apiKey = (creds.apiKey || '').trim();
        const baseURL = normalizeBase(creds.baseURL || defaultBaseURL);
        if (!apiKey) return errorState(0, 'Missing apiKey');
        if (!baseURL) return errorState(0, 'Missing baseURL');

        // 1) /models probe
        const modelsUrl = joinURL(baseURL, '/models');
        const probe = await timedFetch(modelsUrl, {
          timeoutMs: 6000,
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        let result = classifyResponse(probe.res, probe.latencyMs, await probe.res.text());

        // 2) Some proxies don't implement /models - fallback to a 1-token chat
        if (result.state !== 'valid' && probe.res.status === 404) {
          result = await chatProbe(baseURL, apiKey, creds.model);
        }
        return result;
      }),
  };
}

async function chatProbe(baseURL: string, apiKey: string, model?: string): Promise<TestResult> {
  const url = joinURL(baseURL, '/chat/completions');
  const body = JSON.stringify({
    model: model || 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
  });
  const probe = await timedFetch(url, {
    method: 'POST',
    timeoutMs: 8000,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body,
  });
  const text = await probe.res.text();
  const result = classifyResponse(probe.res, probe.latencyMs, text);
  if (result.state === 'valid') {
    return valid(probe.latencyMs, probe.res.status, 'OK (chat probe)');
  }
  return result;
}

function normalizeBase(url: string): string {
  let u = (url || '').trim();
  if (!u) return '';
  if (u.endsWith('/')) u = u.slice(0, -1);
  return u;
}

function joinURL(base: string, path: string): string {
  // base already includes /v1 typically; path starts with /
  if (base.endsWith(path)) return base;
  return base + path;
}

void valid; // satisfy import (used by chatProbe)
