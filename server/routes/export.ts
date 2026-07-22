import { Hono } from 'hono';
import { getAllKeys } from '../core/store.ts';
import { writeMarkdown } from '../core/writer.ts';
import { envVarNameForProviderPath } from './_helpers.ts';

export const exportRouter = new Hono();

// GET /api/export?format=md|json|env|curl|csv
exportRouter.get('/', async (c) => {
  const format = (c.req.query('format') || 'md').toLowerCase();
  const keys = await getAllKeys();

  switch (format) {
    case 'md':
      return new Response(writeMarkdown(keys), {
        headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
      });

    case 'json':
      return new Response(JSON.stringify(keys, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });

    case 'env':
      return new Response(toEnv(keys), {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });

    case 'curl':
      return new Response(toCurl(keys), {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });

    case 'csv':
      return new Response(toCSV(keys), {
        headers: { 'Content-Type': 'text/csv; charset=utf-8' },
      });

    default:
      return c.json({ error: `unknown format "${format}"` }, 400);
  }
});

function toEnv(keys: Awaited<ReturnType<typeof getAllKeys>>): string {
  const out: string[] = ['# Exported by key-tester', '# Each block separated by a comment header is one entry.', ''];
  for (const k of keys) {
    if (!k.testable) continue;
    // group each entry under a header comment so parseEnv can re-attach label + baseURL
    out.push(`# ${k.label || k.provider} (${k.provider})`);
    const mainCredKey =
      k.credentials.apiKey != null ? 'apiKey'
      : k.credentials.apiSecret != null ? 'apiSecret'
      : k.credentials.accessKeyId != null ? 'accessKeyId'
      : null;
    const mainCredVal = mainCredKey ? k.credentials[mainCredKey] : '';
    const varName = envVarNameForProviderPath(k.provider);
    if (varName && mainCredVal) {
      out.push(`${varName}=${mainCredVal}`);
    } else if (mainCredVal) {
      // providers without a conventional API_KEY var name (zai, r2, do-spaces)
      out.push(`${k.provider.toUpperCase().replace(/-/g, '_')}_${mainCredKey!.toUpperCase()}=${mainCredVal}`);
    }
    for (const [key, val] of Object.entries(k.credentials)) {
      if (key === mainCredKey) continue;
      out.push(`${k.provider.toUpperCase().replace(/-/g, '_')}_${key.toUpperCase()}=${val}`);
    }
    out.push('');
  }
  return out.join('\n');
}

function toCurl(keys: Awaited<ReturnType<typeof getAllKeys>>): string {
  const out: string[] = ['# curl snippets - paste-ready', ''];
  for (const k of keys) {
    if (!k.testable) continue;
    if (k.provider === 'anthropic') {
      const key = k.credentials.apiKey;
      out.push(`# ${k.label || 'Anthropic'}`);
      out.push(`curl https://api.anthropic.com/v1/messages \\`);
      out.push(`  -H "x-api-key: ${key}" \\`);
      out.push(`  -H "anthropic-version: 2023-06-01" \\`);
      out.push(`  -H "Content-Type: application/json" \\`);
      out.push(`  -d '{"model":"claude-opus-4-6","max_tokens":1,"messages":[{"role":"user","content":"ping"}]}'`);
      out.push('');
      continue;
    }
    const apiKey = k.credentials.apiKey || k.credentials.apiSecret;
    const baseURL = k.credentials.baseURL;
    if (apiKey && baseURL) {
      out.push(`# ${k.label || k.provider}`);
      out.push(`curl -X POST ${baseURL}/chat/completions \\`);
      out.push(`  -H "Authorization: Bearer ${apiKey}" \\`);
      out.push(`  -H "Content-Type: application/json" \\`);
      out.push(`  -d '{"model":"${k.credentials.model || 'gpt-4o-mini'}","messages":[{"role":"user","content":"ping"}]}'`);
      out.push('');
    }
  }
  return out.join('\n');
}

function csvEscape(v: string): string {
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function toCSV(keys: Awaited<ReturnType<typeof getAllKeys>>): string {
  const rows = [
    ['id', 'provider', 'label', 'apiKey', 'apiSecret', 'accessKeyId', 'secretAccessKey', 'endpoint', 'bucket', 'baseURL', 'model', 'state', 'latencyMs', 'lastTestedAt'],
  ];
  for (const k of keys) {
    rows.push([
      k.id,
      k.provider,
      k.label || '',
      k.credentials.apiKey || '',
      k.credentials.apiSecret || '',
      k.credentials.accessKeyId || '',
      k.credentials.secretAccessKey || '',
      k.credentials.endpoint || '',
      k.credentials.bucket || '',
      k.credentials.baseURL || '',
      k.credentials.model || '',
      k.status.state,
      String(k.status.latencyMs ?? ''),
      k.status.testedAt || '',
    ]);
  }
  return rows.map((r) => r.map(csvEscape).join(',')).join('\n') + '\n';
}
