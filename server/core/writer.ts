// Writer: KeyEntry[] → keys.md
//
// Round-trips with parser.ts. The generated markdown is human-editable:
//   ## --section
//   KEY=value            # env-style for openai/deepseek/...
//   ```js                # code-block style for openai-compat / z.ai
//   ...
//   ```
//
// Status info (lastTestedAt, etc.) is NOT written to keys.md - that lives in
// store.json. Only credentials + labels + notes are persisted to the md mirror.

import type { KeyEntry, Provider } from '../../shared/types.ts';
import { prettyProvider as _pp } from './parser.ts';

void _pp;

export function writeMarkdown(entries: KeyEntry[]): string {
  const lines: string[] = [
    '# Reacteev - API Keys & Secrets',
    '',
    '> Exported from Keyway. This file is an export format, not a live mirror -',
    `> Last regenerated: ${new Date().toISOString()}`,
    '',
    '---',
    '',
  ];

  // Group by section (preserve original section name if present)
  const groups = groupBySection(entries);

  for (const [section, items] of groups) {
    lines.push(`## ${section}`);
    lines.push('');
    for (const entry of items) {
      writeEntry(entry, lines);
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

function groupBySection(entries: KeyEntry[]): Array<[string, KeyEntry[]]> {
  const map = new Map<string, KeyEntry[]>();
  for (const e of entries) {
    const section = e.section || `--${e.provider}`;
    if (!map.has(section)) map.set(section, []);
    map.get(section)!.push(e);
  }
  return [...map.entries()];
}

function writeEntry(entry: KeyEntry, out: string[]): void {
  // label as a comment line above credentials
  if (entry.label) {
    out.push(`> ${entry.label}`);
  }
  switch (entry.provider) {
    case 'openai':
    case 'deepseek':
    case 'openrouter':
    case 'deepinfra':
      writeEnvStyle(entry, out);
      break;
    case 'anthropic':
      writeEnvStyle(entry, out);
      break;
    case 'gemini':
    case 'perplexity':
    case 'elevenlabs':
    case 'core':
      writeEnvStyle(entry, out);
      break;
    case 'zai':
      writeZAIShape(entry, out);
      break;
    case 'cloudflare-r2':
      writeR2(entry, out);
      break;
    case 'do-spaces':
      writeDO(entry, out);
      break;
    case 'openai-compat':
      writeOpenAICompat(entry, out);
      break;
    case 'reference':
    default:
      writeReference(entry, out);
      break;
  }
  if (entry.note) {
    out.push(`_note: ${entry.note}_`);
  }
}

function writeEnvStyle(entry: KeyEntry, out: string[]): void {
  const varName = envVarNameForProvider(entry.provider);
  if (varName && entry.credentials.apiKey) {
    out.push(`${varName}=${entry.credentials.apiKey}`);
  }
  if (entry.credentials.baseURL) {
    out.push(`BASE_URL=${entry.credentials.baseURL}`);
  }
  if (entry.credentials.model) {
    out.push(`MODEL=${entry.credentials.model}`);
  }
  // any extra credential keys
  for (const [k, v] of Object.entries(entry.credentials)) {
    if (['apiKey', 'baseURL', 'model'].includes(k)) continue;
    out.push(`${k.toUpperCase()}=${v}`);
  }
}

function envVarNameForProvider(p: Provider): string | null {
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

function writeZAIShape(entry: KeyEntry, out: string[]): void {
  out.push(`API KEY ID : ${entry.credentials.apiKeyId || ''}`);
  out.push(`API KEY : ${entry.credentials.apiSecret || ''}`);
}

function writeR2(entry: KeyEntry, out: string[]): void {
  const c = entry.credentials;
  out.push(`CDN_BUCKET_NAME=${c.bucket || ''}`);
  out.push(`CDN_ENDPOINT=${c.endpoint || ''}`);
  out.push(`CDN_ACCESS_KEY_ID=${c.accessKeyId || ''}`);
  out.push(`CDN_SECRET_ACCESS_KEY=${c.secretAccessKey || ''}`);
  if (c.region && c.region !== 'auto') out.push(`R2_REGION=${c.region}`);
}

function writeDO(entry: KeyEntry, out: string[]): void {
  const c = entry.credentials;
  out.push(`DO_SPACES_KEY=${c.accessKeyId || ''}`);
  out.push(`DO_SPACES_SECRET=${c.secretAccessKey || ''}`);
  out.push(`DO_SPACES_REGION=${c.region || ''}`);
  out.push(`DO_SPACES_BUCKET=${c.bucket || ''}`);
  out.push(`DO_SPACES_ENDPOINT=${c.endpoint || ''}`);
}

function writeOpenAICompat(entry: KeyEntry, out: string[]): void {
  const c = entry.credentials;
  if (c.baseURL && c.apiKey) {
    out.push('```bash');
    out.push(`curl -X POST ${c.baseURL}/chat/completions \\`);
    out.push(`  -H "Authorization: Bearer ${c.apiKey}" \\`);
    out.push(`  -H "Content-Type: application/json" \\`);
    out.push(`  -d '{"model":"${c.model || 'gpt-4o-mini'}","messages":[{"role":"user","content":"ping"}]}'`);
    out.push('```');
  } else if (c.apiKey) {
    out.push(`API_KEY=${c.apiKey}`);
    if (c.baseURL) out.push(`BASE_URL=${c.baseURL}`);
  }
}

function writeReference(entry: KeyEntry, out: string[]): void {
  const v = entry.credentials.value || '';
  if (v.includes('\n')) {
    out.push('```');
    out.push(v.trim());
    out.push('```');
  } else {
    out.push(v);
  }
}
