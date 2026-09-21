// "How much is left on this key?" - the question a key vault should answer and
// no generic API client can.
//
// Only providers with a cheap, documented balance endpoint are covered. The
// rest return null rather than a guess: an invented number is worse than an
// empty column.

import { timedFetch } from '../adapters/types.ts';
import type { KeyEntry, QuotaInfo } from '../../shared/types.ts';

const TIMEOUT_MS = 8000;

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function stamp(): string {
  return new Date().toISOString();
}

async function json(url: string, headers: Record<string, string>): Promise<any> {
  const { res } = await timedFetch(url, { headers, timeoutMs: TIMEOUT_MS });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
  return JSON.parse(text);
}

/** Providers this probe knows how to ask. */
export function supportsQuota(entry: KeyEntry): boolean {
  return ['openrouter', 'deepseek', 'elevenlabs'].includes(entry.provider);
}

export async function probeQuota(entry: KeyEntry): Promise<QuotaInfo | null> {
  const creds = entry.credentials ?? {};
  const apiKey = (creds.apiKey ?? '').trim();
  if (!supportsQuota(entry)) return null;
  if (!apiKey) return { summary: '—', checkedAt: stamp(), error: 'No apiKey saved' };

  try {
    switch (entry.provider) {
      case 'openrouter': {
        const body = await json('https://openrouter.ai/api/v1/key', {
          Authorization: `Bearer ${apiKey}`,
        });
        const d = body?.data ?? {};
        const used = Number(d.usage ?? 0);
        const limit = d.limit === null || d.limit === undefined ? undefined : Number(d.limit);
        const remaining =
          limit === undefined ? undefined : Number((limit - used).toFixed(4));
        return {
          summary:
            limit === undefined
              ? `${money(used)} used · no cap`
              : `${money(remaining ?? 0)} of ${money(limit)} left`,
          used,
          limit,
          remaining,
          unit: 'USD',
          detail: d.is_free_tier ? 'free tier' : undefined,
          checkedAt: stamp(),
        };
      }

      case 'deepseek': {
        const base = (creds.baseURL || 'https://api.deepseek.com').replace(/\/+$/, '');
        const body = await json(`${base}/user/balance`, { Authorization: `Bearer ${apiKey}` });
        const info = body?.balance_infos?.[0];
        const total = Number(info?.total_balance ?? 0);
        return {
          summary: info
            ? `${info.currency === 'USD' ? money(total) : `${total} ${info.currency}`} left`
            : 'no balance info',
          remaining: total,
          unit: info?.currency ?? 'USD',
          detail: body?.is_available === false ? 'not available for use' : undefined,
          checkedAt: stamp(),
        };
      }

      case 'elevenlabs': {
        const body = await json('https://api.elevenlabs.io/v1/user', { 'xi-api-key': apiKey });
        const sub = body?.subscription ?? {};
        const used = Number(sub.character_count ?? 0);
        const limit = Number(sub.character_limit ?? 0);
        return {
          summary: limit
            ? `${(limit - used).toLocaleString()} of ${limit.toLocaleString()} chars left`
            : `${used.toLocaleString()} chars used`,
          used,
          limit: limit || undefined,
          remaining: limit ? limit - used : undefined,
          unit: 'characters',
          detail: sub.tier ? `tier: ${sub.tier}` : undefined,
          checkedAt: stamp(),
        };
      }

      default:
        return null;
    }
  } catch (e) {
    return {
      summary: 'check failed',
      checkedAt: stamp(),
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
