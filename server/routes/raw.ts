import { Hono } from 'hono';

export const rawRouter = new Hono();

interface RawRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}

const MAX_BODY = 256 * 1024; // 256 KB cap on returned body

// POST /api/raw - execute an arbitrary HTTP request server-side (proxy) and
// return the raw response. Used by the in-app "Talend-style" request tester so
// the browser is not blocked by provider CORS policies.
rawRouter.post('/', async (c) => {
  const input = (await c.req.json().catch(() => ({}))) as RawRequest;
  const method = (input.method || 'GET').toUpperCase();
  const url = (input.url || '').trim();
  if (!url) return c.json({ error: 'Missing url' }, 400);
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return c.json({ error: `Invalid url: ${url}` }, 400);
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return c.json({ error: 'Only http/https URLs are allowed' }, 400);
  }

  const headers = new Headers();
  for (const [k, v] of Object.entries(input.headers || {})) {
    if (k.trim()) headers.set(k, v);
  }

  const hasBody = method !== 'GET' && method !== 'HEAD' && input.body != null && input.body !== '';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  const start = Date.now();
  try {
    const res = await fetch(target.toString(), {
      method,
      headers,
      body: hasBody ? input.body : undefined,
      signal: ctrl.signal,
      redirect: 'follow',
    });
    const latencyMs = Date.now() - start;
    const full = await res.text();
    const truncated = full.length > MAX_BODY;
    const body = truncated ? full.slice(0, MAX_BODY) : full;
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      resHeaders[k] = v;
    });
    return c.json({
      status: res.status,
      statusText: res.statusText,
      headers: resHeaders,
      latencyMs,
      body,
      truncated,
    });
  } catch (e) {
    const latencyMs = Date.now() - start;
    const msg = e instanceof Error ? e.message : String(e);
    const timedOut = msg.includes('aborted') || msg.includes('timeout');
    return c.json({ error: timedOut ? 'Request timed out (30s)' : msg, latencyMs }, 502);
  } finally {
    clearTimeout(timer);
  }
});
