// Parser: keys.md (or arbitrary text) → KeyEntry[]
//
// Handles the messy real-world format of keys.md:
//   - `KEY=value` env-style lines
//   - `account: …` / `password : …` colon-style
//   - ```curl -H "Authorization: Bearer xxx"``` blocks
//   - ```js / python``` code blocks with apiKey: "xxx"
//   - bare URL + bare key lines
//
// One section may yield multiple KeyEntry (e.g. openai/openrouter have several keys).

import type { KeyEntry, Provider } from '../../shared/types.ts';
import { getAdapter, listAdapters } from '../adapters/index.ts';

export interface ParsedEntry {
  provider: Provider;
  section?: string;
  label?: string;
  credentials: Record<string, string>;
  note?: string;
  testable: boolean;
  /** signal that the parser isn't fully confident (e.g. missing baseURL) */
  warn?: string;
}

// Section name → provider. Keys are matched case-insensitively against the
// raw section title (e.g. "--openai", "--gemini (Google AI)", "--z.ai").
const SECTION_PROVIDER_MAP: Array<{ match: RegExp; provider: Provider }> = [
  { match: /^--deepseek\b/i, provider: 'deepseek' },
  { match: /^--z\.ai\b/i, provider: 'zai' },
  { match: /^--claude-pro\b/i, provider: 'reference' },
  { match: /^--openai\b/i, provider: 'openai' },
  { match: /^--openrouter\b/i, provider: 'openrouter' },
  { match: /^--9router\b/i, provider: 'openai-compat' },
  { match: /^--anthropic\b/i, provider: 'anthropic' },
  { match: /^--gemini\b/i, provider: 'gemini' },
  { match: /^--perplexity\b/i, provider: 'perplexity' },
  { match: /^--deepinfra\b/i, provider: 'deepinfra' },
  { match: /^--elevenlabs\b/i, provider: 'elevenlabs' },
  { match: /^--core\b/i, provider: 'core' },
  { match: /^--cloudflare-r2\b/i, provider: 'cloudflare-r2' },
  { match: /^--digitalocean-spaces\b/i, provider: 'do-spaces' },
  // catch-alls
  { match: /^--databases\b/i, provider: 'reference' },
  { match: /^--redis\b/i, provider: 'reference' },
  { match: /^--app-secrets\b/i, provider: 'reference' },
];

function detectProviderFromSection(section: string): Provider {
  for (const { match, provider } of SECTION_PROVIDER_MAP) {
    if (match.test(section)) return provider;
  }
  // Unknown "--xxx" section with gonka-style content → treat as openai-compat
  if (/^--/.test(section)) return 'openai-compat';
  return 'reference';
}

// Heuristic: scan env var name / key patterns to detect provider when section is ambiguous.
function detectProviderFromContent(body: string): Provider | null {
  if (/ELEVENLABS_API_KEY\s*=/.test(body)) return 'elevenlabs';
  if (/CORE_API_KEY\s*=/.test(body)) return 'core';
  if (/ANTHROPIC_API_KEY\s*=/.test(body)) return 'anthropic';
  if (/GEMINI_API_KEY\s*=/.test(body)) return 'gemini';
  if (/DEEPINFRA_API_KEY\s*=/.test(body)) return 'deepinfra';
  if (/DEEPSEEK_API_KEY\s*=/.test(body)) return 'deepseek';
  if (/OPENROUTER_API_KEY\s*=/.test(body)) return 'openrouter';
  if (/OPENAI_API_KEY\s*=/.test(body)) return 'openai';
  if (/\bx-api-key\b/i.test(body) || /api\.anthropic\.com/.test(body)) return 'anthropic';
  if (/api\.perplexity\.ai/.test(body)) return 'perplexity';
  if (/r2\.cloudflarestorage\.com/.test(body)) return 'cloudflare-r2';
  if (/digitaloceanspaces\.com/.test(body)) return 'do-spaces';
  return null;
}

// Match Authorization: Bearer xxx (with or without surrounding quotes, multiline-tolerant)
const BEARER_RE = /Authorization:\s*Bearer\s+["']?([A-Za-z0-9_\-.:]+)["']?/i;
const URL_IN_CURL_RE = /\bcurl\s+(?:-X\s+\w+\s+)?(https?:\/\/[^\s'"]+)/i;
const URL_GENERIC_RE = /\bhttps?:\/\/[^\s'"<>)]+/i;
const CODE_APIKEY_RE = /(?:apiKey|api_key|API_KEY)\s*[:=]\s*["']([^"']+)["']/i;
const BASEURL_CODE_RE = /(?:baseURL|base_url|BASE_URL)\s*[:=]\s*["']([^"']+)["']/i;

interface Section {
  heading: string; // e.g. "## --openai"
  title: string; // e.g. "--openai"
  body: string;
}

function splitSections(md: string): Section[] {
  const lines = md.split(/\r?\n/);
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const line of lines) {
    const m = /^##\s+(.*)$/.exec(line);
    if (m) {
      if (current) sections.push(current);
      const title = m[1].trim();
      current = { heading: line.trim(), title, body: '' };
    } else if (current) {
      current.body += line + '\n';
    }
    // ignore preamble before first ## (the doc intro)
  }
  if (current) sections.push(current);
  return sections;
}

// Extract a "label" from the section title, e.g. "--openrouter" → "OpenRouter"
function labelFromTitle(title: string): string | undefined {
  const m = /^--\s*([^\s(]+)/.exec(title);
  if (!m) return undefined;
  const raw = m[1].replace(/^https?:\/\//, '').replace(/\.io$|\.com$|\.ai$|\.gg$|\.id$/i, '');
  if (!raw) return undefined;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export function parseMarkdown(md: string): ParsedEntry[] {
  const sections = splitSections(md);
  const out: ParsedEntry[] = [];

  for (const section of sections) {
    // Stop at "Notes" / "Source files" tail
    if (/^--notes\b/i.test(section.title)) continue;

    let provider = detectProviderFromSection(section.title);
    const contentBased = detectProviderFromContent(section.body);
    // content detection wins for ambiguous sections like gonka-* if it clearly
    // looks like another provider
    if (contentBased && provider === 'reference' && !/^--/.test(section.title)) {
      provider = contentBased;
    }

    const entries = extractForProvider(provider, section);
    if (entries.length === 0) {
      // fallback: capture whole section as a reference entry
      const body = section.body.trim();
      if (body) {
        out.push({
          provider: 'reference',
          section: section.title,
          label: labelFromTitle(section.title),
          credentials: { value: body },
          note: `Unparsed section: ${section.title}`,
          testable: false,
        });
      }
      continue;
    }
    out.push(...entries);
  }

  return out;
}

function extractForProvider(provider: Provider, section: Section): ParsedEntry[] {
  switch (provider) {
    case 'openai':
    case 'deepseek':
    case 'openrouter':
    case 'deepinfra':
      return extractOpenAIEnv(provider, section);
    case 'anthropic':
      return extractAnthropic(section);
    case 'gemini':
      return extractGemini(section);
    case 'perplexity':
      return extractPerplexity(section);
    case 'elevenlabs':
      return extractElevenLabs(section);
    case 'core':
      return extractCore(section);
    case 'zai':
      return extractZAI(section);
    case 'cloudflare-r2':
      return extractR2(section);
    case 'do-spaces':
      return extractDO(section);
    case 'openai-compat':
      return extractOpenAICompat(section);
    case 'reference':
    default:
      return extractReference(section);
  }
}

// ─── ENV-style extractors ───────────────────────────────────────────────────
function extractOpenAIEnv(
  provider: Provider,
  section: Section,
): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  const lines = section.body.split(/\r?\n/);
  const baseURL = findFirst(lines, /(?:OPENAI|OPENROUTER|DEEPINFRA|DEEPSEEK)?_?BASE_URL\s*=\s*(.+)/i);
  const modelDefault = findFirst(lines, /(?:OPENAI|DEEPSEEK)_MODEL\s*=\s*(.+)/i);

  const defaultBase: Partial<Record<Provider, string>> = {
    openai: 'https://api.openai.com/v1',
    deepseek: 'https://api.deepseek.com',
    openrouter: 'https://openrouter.ai/api/v1',
    deepinfra: 'https://api.deepinfra.com/v1/openai',
  };
  const keyVarPattern: Partial<Record<Provider, RegExp>> = {
    openai: /^OPENAI_API_KEY(?:\s*\([^)]+\))?\s*=\s*(.+)$/,
    deepseek: /^DEEPSEEK_API_KEY\s*=\s*(.+)$/,
    openrouter: /^OPENROUTER_API_KEY(?:\s*\([^)]+\))?\s*=\s*(.+)$/,
    deepinfra: /^DEEPINFRA_API_KEY\s*=\s*(.+)$/,
  };

  let keyIndex = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const pat = keyVarPattern[provider];
    if (!pat) continue;
    const m = pat.exec(line);
    if (m) {
      const apiKey = stripInlineComment(m[1]).trim();
      if (!apiKey) continue;
      keyIndex++;
      const labelMatch = /\(([^)]+)\)/.exec(raw);
      out.push({
        provider,
        section: section.title,
        label: labelMatch
          ? `${prettyProvider(provider)} (${labelMatch[1]})`
          : keyIndex > 1
            ? `${prettyProvider(provider)} #${keyIndex}`
            : prettyProvider(provider),
        credentials: {
          apiKey,
          baseURL: baseURL || defaultBase[provider] || '',
          ...(modelDefault ? { model: modelDefault } : {}),
        },
        testable: true,
      });
    }
  }
  return out;
}

function extractAnthropic(section: Section): ParsedEntry[] {
  const key = matchEnv(section.body, /ANTHROPIC_API_KEY\s*=\s*(.+)/);
  if (!key) return [];
  const model = matchEnv(section.body, /ANTHROPIC_MODEL\s*=\s*(.+)/);
  return [
    {
      provider: 'anthropic',
      section: section.title,
      label: 'Anthropic',
      credentials: { apiKey: key, ...(model ? { model } : {}) },
      testable: true,
    },
  ];
}

function extractGemini(section: Section): ParsedEntry[] {
  const key = matchEnv(section.body, /GEMINI_API_KEY\s*=\s*(.+)/);
  if (!key) return [];
  return [
    {
      provider: 'gemini',
      section: section.title,
      label: 'Google Gemini',
      credentials: { apiKey: key },
      testable: true,
    },
  ];
}

function extractPerplexity(section: Section): ParsedEntry[] {
  // Accept three forms:
  //   AI_API_KEY (perplexity)=pplx-...    (original keys.md style)
  //   AI_API_KEY=pplx-...                  (writer round-trip style)
  //   PERPLEXITY_API_KEY=pplx-...          (alternate env name)
  const key =
    matchEnv(section.body, /AI_API_KEY\s*\(perplexity\)\s*=\s*(.+)/) ||
    matchEnv(section.body, /^AI_API_KEY\s*=\s*(pplx-[A-Za-z0-9_-]+)/m) ||
    matchEnv(section.body, /PERPLEXITY_API_KEY\s*=\s*(.+)/);
  if (!key) return [];
  return [
    {
      provider: 'perplexity',
      section: section.title,
      label: 'Perplexity',
      credentials: { apiKey: key },
      testable: true,
    },
  ];
}

function extractElevenLabs(section: Section): ParsedEntry[] {
  const key = matchEnv(section.body, /ELEVENLABS_API_KEY\s*=\s*(.+)/);
  if (!key) return [];
  const voice = matchEnv(section.body, /ELEVENLABS_VOICE_ID\s*=\s*(.+)/);
  return [
    {
      provider: 'elevenlabs',
      section: section.title,
      label: 'ElevenLabs',
      credentials: { apiKey: key, ...(voice ? { voiceId: voice } : {}) },
      testable: true,
    },
  ];
}

function extractCore(section: Section): ParsedEntry[] {
  const key = matchEnv(section.body, /CORE_API_KEY\s*=\s*(.+)/);
  if (!key) return [];
  return [
    {
      provider: 'core',
      section: section.title,
      label: 'CORE',
      credentials: { apiKey: key },
      testable: true,
    },
  ];
}

function extractZAI(section: Section): ParsedEntry[] {
  // Format:
  //   API KEY ID : xxx
  //   API KEY : xxx.secret
  const idMatch = /API\s*KEY\s*ID\s*[:：]\s*([^\s]+)/i.exec(section.body);
  let secret: string | undefined;
  for (const line of section.body.split(/\r?\n/)) {
    if (/API\s*KEY\s*ID/i.test(line)) continue;
    const m = /API\s*KEY\s*[:：]\s*([^\s]+)/i.exec(line);
    if (m) {
      secret = m[1];
      break;
    }
  }
  if (!idMatch && !secret) return [];
  return [
    {
      provider: 'zai',
      section: section.title,
      label: 'z.ai',
      credentials: {
        apiKeyId: idMatch?.[1] || '',
        apiSecret: secret || '',
      },
      testable: true,
    },
  ];
}

function extractR2(section: Section): ParsedEntry[] {
  const accessKeyId = matchEnv(section.body, /(?:CDN|R2)_ACCESS_KEY_ID\s*=\s*(.+)/);
  const secretAccessKey = matchEnv(section.body, /(?:CDN|R2)_SECRET_ACCESS_KEY\s*=\s*(.+)/);
  const endpoint = matchEnv(section.body, /CDN_ENDPOINT\s*=\s*(.+)/);
  const bucket = matchEnv(section.body, /CDN_BUCKET_NAME\s*=\s*(.+)/);
  if (!accessKeyId || !secretAccessKey || !endpoint || !bucket) return [];
  return [
    {
      provider: 'cloudflare-r2',
      section: section.title,
      label: `Cloudflare R2 (${bucket})`,
      credentials: { accessKeyId, secretAccessKey, endpoint, bucket, region: 'auto' },
      testable: true,
    },
  ];
}

function extractDO(section: Section): ParsedEntry[] {
  const accessKeyId = matchEnv(section.body, /DO_SPACES_KEY\s*=\s*(.+)/);
  const secretAccessKey = matchEnv(section.body, /DO_SPACES_SECRET\s*=\s*(.+)/);
  const endpoint = matchEnv(section.body, /DO_SPACES_ENDPOINT\s*=\s*(.+)/);
  const bucket = matchEnv(section.body, /DO_SPACES_BUCKET\s*=\s*(.+)/);
  const region = matchEnv(section.body, /DO_SPACES_REGION\s*=\s*(.+)/);
  if (!accessKeyId || !secretAccessKey || !endpoint || !bucket) return [];
  return [
    {
      provider: 'do-spaces',
      section: section.title,
      label: `DigitalOcean Spaces (${bucket})`,
      credentials: { accessKeyId, secretAccessKey, endpoint, bucket, region: region || 'sgp1' },
      testable: true,
    },
  ];
}

function extractOpenAICompat(section: Section): ParsedEntry[] {
  // Candidate "blocks" to scan: fenced code blocks + the raw section body.
  // Many sections in keys.md contain curl/code WITHOUT fences, so we scan both.
  const codeBlocks = [...extractCodeBlocks(section.body), section.body];
  const out: ParsedEntry[] = [];
  const seen = new Set<string>();

  for (const block of codeBlocks) {
    const bearer = BEARER_RE.exec(block);
    const codeKey = !bearer ? CODE_APIKEY_RE.exec(block) : null;
    const apiKey = bearer?.[1] || codeKey?.[1];
    if (!apiKey) continue;
    if (seen.has(apiKey)) continue;
    seen.add(apiKey);

    const codeBase = BASEURL_CODE_RE.exec(block)?.[1];
    const curlURL = URL_IN_CURL_RE.exec(block)?.[1];
    const genericURL = !codeBase && !curlURL ? URL_GENERIC_RE.exec(block)?.[0] : null;
    // Fall back to hostname embedded in the section title (e.g. "## -- proxy.gonka.gg (1m token)")
    const titleURL = !codeBase && !curlURL && !genericURL
      ? extractTitleHostname(section.title)
      : null;
    const baseURL = codeBase || curlURL || genericURL || titleURL;
    if (!baseURL) {
      out.push({
        provider: 'openai-compat',
        section: section.title,
        label: labelFromTitle(section.title),
        credentials: { apiKey, baseURL: '' },
        testable: true,
        warn: 'No baseURL detected - please fill manually',
      });
      continue;
    }
    out.push({
      provider: 'openai-compat',
      section: section.title,
      label: labelFromTitle(section.title),
      credentials: { apiKey, baseURL: normalizeToV1(baseURL) },
      testable: true,
    });
  }

  // ENV-style fallback (e.g. 9router)
  if (out.length === 0) {
    const envKey = matchEnv(section.body, /(?:NINEROUTER|API)_API_KEY\s*=\s*(.+)/);
    const envBase = matchEnv(section.body, /(?:NINEROUTER|API)_BASE_URL\s*=\s*(.+)/);
    if (envKey && envBase) {
      out.push({
        provider: 'openai-compat',
        section: section.title,
        label: labelFromTitle(section.title),
        credentials: { apiKey: envKey, baseURL: envBase },
        testable: true,
      });
    }
  }

  // Last resort: a bare `sk-…` line in the section body (e.g. "proxy.gonka.gg", "gonkagate")
  if (out.length === 0) {
    const bareKey = /^\s*(sk-[A-Za-z0-9_-]{12,}|gp-[A-Za-z0-9_-]{12,}|jg-[A-Za-z0-9]{12,}|[A-Za-z0-9]{32,})\s*$/m.exec(
      section.body,
    )?.[1];
    if (bareKey) {
      // try to find a URL anywhere in the section body, else fall back to title hostname
      const urlInBody = URL_GENERIC_RE.exec(section.body)?.[0];
      const baseURL = urlInBody || extractTitleHostname(section.title) || '';
      out.push({
        provider: 'openai-compat',
        section: section.title,
        label: labelFromTitle(section.title),
        credentials: { apiKey: bareKey, baseURL },
        testable: Boolean(baseURL),
        warn: baseURL ? undefined : 'No baseURL detected - please fill manually',
      });
    }
  }

  return out;
}

function extractReference(section: Section): ParsedEntry[] {
  const body = section.body.trim();
  if (!body) return [];
  return [
    {
      provider: 'reference',
      section: section.title,
      label: labelFromTitle(section.title),
      credentials: { value: body },
      testable: false,
      note: 'Reference / non-testable',
    },
  ];
}

// ─── helpers ────────────────────────────────────────────────────────────────
// Extract a hostname from section titles like "-- proxy.gonka.gg (1m token)".
// Returns `https://<host>` or undefined.
function extractTitleHostname(title: string): string | undefined {
  // strip leading "-- " and surrounding parens content
  const cleaned = title.replace(/^--\s*/, '').replace(/\([^)]*\)/g, '').trim();
  // a bare hostname has at least one dot and a known TLD
  const m = /\b([a-z0-9-]+\.[a-z]{2,}(?:\.[a-z]{2,})?)\b/i.exec(cleaned);
  if (m) return `https://${m[1]}`;
  return undefined;
}

function extractCodeBlocks(body: string): string[] {
  const blocks: string[] = [];
  const re = /```[a-zA-Z]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

function findFirst(lines: string[], re: RegExp): string | undefined {
  for (const raw of lines) {
    const line = raw.trim();
    const m = re.exec(line);
    if (m) return stripInlineComment(m[1]).trim();
  }
  return undefined;
}

function matchEnv(body: string, re: RegExp): string | undefined {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    const m = re.exec(line);
    if (m) return stripInlineComment(m[1]).trim().replace(/^["']|["']$/g, '');
  }
  return undefined;
}

function stripInlineComment(v: string): string {
  // strip trailing ` # comment` or ` // comment` (only when preceded by space
  // and not inside a URL)
  return v.replace(/\s+(#|\/\/)\s.*$/, '');
}

function normalizeToV1(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  // if URL ends with /v1/chat/completions etc., strip the path
  u = u.replace(/\/(chat\/completions| completions|messages|embeddings|models)$/i, '');
  u = u.replace(/\/+$/, '');
  // if path doesn't include /v1 but the host looks like an OpenAI-compat API,
  // try appending /v1 - but only if no path is set yet
  if (!/\/v\d+(\/|$)/i.test(u) && /\/(api|v1)\b/i.test(u) === false) {
    // conservative: don't auto-append, keep what we parsed
  }
  return u;
}

function prettyProvider(p: Provider): string {
  const map: Partial<Record<Provider, string>> = {
    openai: 'OpenAI',
    deepseek: 'DeepSeek',
    openrouter: 'OpenRouter',
    deepinfra: 'DeepInfra',
    anthropic: 'Anthropic',
    gemini: 'Gemini',
    perplexity: 'Perplexity',
    elevenlabs: 'ElevenLabs',
    core: 'CORE',
    zai: 'z.ai',
    'cloudflare-r2': 'Cloudflare R2',
    'do-spaces': 'DigitalOcean Spaces',
    'openai-compat': 'OpenAI-compat',
    reference: 'Reference',
  };
  return map[p] || p;
}

// Used by routes/import.ts to apply the same parsing to pasted text.
export function parsedToEntry(p: ParsedEntry, idFn: () => string): KeyEntry {
  const adapter = getAdapter(p.provider);
  const now = new Date().toISOString();
  return {
    id: idFn(),
    provider: p.provider,
    section: p.section || adapter?.defaultSection,
    label: p.label,
    credentials: p.credentials,
    note: p.note,
    testable: p.testable,
    status: { state: 'untested' },
    createdAt: now,
    updatedAt: now,
  };
}

// ─── Multi-format parser (export → import round-trip) ───────────────────────

export type ImportFormat = 'md' | 'json' | 'env' | 'csv' | 'curl' | 'unknown';

/** Sniff the format of an arbitrary text blob. Heuristics, not exact. */
export function detectFormat(text: string): ImportFormat {
  const t = text.trim();
  if (!t) return 'unknown';

  // JSON: starts with [ or { and parses
  if (/^[[{]/.test(t)) {
    try {
      JSON.parse(t);
      return 'json';
    } catch {
      /* fall through */
    }
  }

  // CSV: first line looks like a header with provider/apiKey columns
  const firstLine = t.split(/\r?\n/)[0] || '';
  if (/provider/i.test(firstLine) && /apiKey|api_key|apikey/i.test(firstLine) && firstLine.includes(',')) {
    return 'csv';
  }

  // Markdown: at least one "## --section" heading OR our "Managed by key-tester" marker
  if (/^##\s+--?/m.test(t) || /Managed by key-tester/.test(t) || /^#\s+.+API Keys/.test(t)) {
    return 'md';
  }

  // curl snippets: at least one `curl -X POST …/chat/completions`
  if (/^curl\s+(?:-X\s+\w+\s+)?https?:\/\//m.test(t) || /# curl snippets/.test(t)) {
    return 'curl';
  }

  // .env: at least one `KEY=value` line where KEY looks like an env var
  if (/^[A-Z][A-Z0-9_]*=.+/m.test(t)) {
    return 'env';
  }

  // last-ditch: try as markdown (the most permissive)
  return 'md';
}

/**
 * Parse any supported format. Auto-detects if format is omitted.
 * Returns the detected format alongside entries for UI display.
 */
export function parseAny(
  text: string,
  format?: ImportFormat,
): { format: ImportFormat; entries: ParsedEntry[] } {
  const fmt = format && format !== 'unknown' ? format : detectFormat(text);
  switch (fmt) {
    case 'json':
      return { format: 'json', entries: parseJSON(text) };
    case 'csv':
      return { format: 'csv', entries: parseCSV(text) };
    case 'env':
      return { format: 'env', entries: parseEnv(text) };
    case 'curl':
      return { format: 'curl', entries: parseCurl(text) };
    case 'md':
    case 'unknown':
    default:
      return { format: 'md', entries: parseMarkdown(text) };
  }
}

// ─── JSON parser ────────────────────────────────────────────────────────────
// Accepts either a KeyEntry[] array (our export.json shape) or a StoreState
// object ({ version, keys }). Strips status fields on the way in.
export function parseJSON(text: string): ParsedEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const arr = Array.isArray(data)
    ? data
    : (data as { keys?: unknown[] })?.keys;
  if (!Array.isArray(arr)) return [];

  const out: ParsedEntry[] = [];
  for (const raw of arr) {
    const e = raw as Partial<KeyEntry>;
    if (!e || typeof e !== 'object' || !e.provider) continue;
    const adapter = getAdapter(e.provider);
    out.push({
      provider: e.provider,
      section: e.section || adapter?.defaultSection,
      label: e.label,
      credentials: e.credentials || {},
      note: e.note,
      testable: adapter ? adapter.kind !== 'reference' : !!e.testable,
    });
  }
  return out;
}

// ─── CSV parser ─────────────────────────────────────────────────────────────
// Matches the schema written by routes/export.ts → toCSV().
// Header: id,provider,label,apiKey,baseURL,model,state,latencyMs,lastTestedAt
export function parseCSV(text: string): ParsedEntry[] {
  const rows = parseCSVRows(text);
  if (rows.length < 2) return [];
  const header = rows[0];
  const idx = (name: string) => header.indexOf(name);
  const out: ParsedEntry[] = [];
  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i];
    if (!cols.length || (cols.length === 1 && !cols[0])) continue;
    const provider = cols[idx('provider')] as Provider;
    const apiKey = cols[idx('apiKey')] || '';
    const apiSecret = cols[idx('apiSecret')] || '';
    const accessKeyId = cols[idx('accessKeyId')] || '';
    const secretAccessKey = cols[idx('secretAccessKey')] || '';
    const endpoint = cols[idx('endpoint')] || '';
    const bucket = cols[idx('bucket')] || '';
    const baseURL = cols[idx('baseURL')] || '';
    const model = cols[idx('model')] || '';
    if (!provider) continue;
    const adapter = getAdapter(provider);
    const creds: Record<string, string> = {};
    if (apiKey) creds.apiKey = apiKey;
    if (apiSecret) creds.apiSecret = apiSecret;
    if (accessKeyId) creds.accessKeyId = accessKeyId;
    if (secretAccessKey) creds.secretAccessKey = secretAccessKey;
    if (endpoint) creds.endpoint = endpoint;
    if (bucket) creds.bucket = bucket;
    if (baseURL) creds.baseURL = baseURL;
    if (model) creds.model = model;
    out.push({
      provider,
      section: adapter?.defaultSection,
      label: cols[idx('label')] || undefined,
      credentials: creds,
      testable: adapter ? adapter.kind !== 'reference' : true,
    });
  }
  return out;
}

function parseCSVRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') {
        row.push(field);
        field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else {
        field += c;
      }
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ─── .env parser ────────────────────────────────────────────────────────────
// Accepts lines like `OPENAI_API_KEY=sk-...` plus optional provider-scoped
// companions (`OPENAI_BASE_URL=...`, `OPENAI_MODEL=...`). Also handles the
// `<PROVIDER>_FIELD=value` generic form we emit in toEnv().
const ENV_PROVIDER_PREFIXES: Array<{ p: Provider; prefixes: string[] }> = [
  { p: 'openai', prefixes: ['OPENAI'] },
  { p: 'deepseek', prefixes: ['DEEPSEEK'] },
  { p: 'openrouter', prefixes: ['OPENROUTER'] },
  { p: 'deepinfra', prefixes: ['DEEPINFRA'] },
  { p: 'anthropic', prefixes: ['ANTHROPIC'] },
  { p: 'gemini', prefixes: ['GEMINI'] },
  { p: 'elevenlabs', prefixes: ['ELEVENLABS'] },
  { p: 'core', prefixes: ['CORE'] },
  { p: 'perplexity', prefixes: ['PERPLEXITY', 'AI'] },
];

export function parseEnv(text: string): ParsedEntry[] {
  const lines = text.split(/\r?\n/);
  // bucket per (provider, instance) - instance is for OPENROUTER_API_KEY__2 etc.
  const buckets = new Map<
    string,
    { provider: Provider; creds: Record<string, string>; label?: string }
  >();
  const order: string[] = [];
  // when a `# label (provider)` header precedes a block, attach label to the
  // next bucket created within that block. Reset on blank line.
  let pendingLabel: string | undefined = undefined;
  let pendingProvider: Provider | undefined = undefined;

  const getOrCreate = (key: string, provider: Provider) => {
    if (!buckets.has(key)) {
      buckets.set(key, {
        provider,
        creds: {},
        label: provider === pendingProvider ? pendingLabel : undefined,
      });
      order.push(key);
    }
    return buckets.get(key)!;
  };

  const resetPending = () => {
    pendingLabel = undefined;
    pendingProvider = undefined;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      resetPending();
      continue;
    }
    // comment header: "# Label (provider)" - sets pending context
    const headerM = /^#\s+(.+?)\s*\(([\w-]+)\)\s*$/.exec(line);
    if (headerM) {
      pendingLabel = headerM[1];
      pendingProvider = headerM[2] as Provider;
      continue;
    }
    if (line.startsWith('#')) continue;
    const m = /^([A-Z][A-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!m) {
      resetPending();
      continue;
    }
    const varName = m[1];
    const value = m[2].replace(/^["']|["']$/g, '');
    if (!value) continue;

    // Direct `<PROVIDER>_API_KEY` matches first
    const direct = ENV_PROVIDER_PREFIXES.find((x) =>
      x.prefixes.some((pre) => varName === `${pre}_API_KEY`),
    );
    if (direct) {
      const bucketKey = `${direct.p}::${value.slice(0, 8)}`;
      getOrCreate(bucketKey, direct.p).creds.apiKey = value;
      continue;
    }

    // z.ai has id+secret pair
    if (varName === 'ZAI_API_KEY_ID') {
      const b = getOrCreate('zai::main', 'zai');
      b.creds.apiKeyId = value;
      continue;
    }
    if (varName === 'ZAI_API_KEY_SECRET') {
      const b = getOrCreate('zai::main', 'zai');
      b.creds.apiSecret = value;
      continue;
    }

    // Companion vars: `<PROVIDER>_BASE_URL`, `<PROVIDER>_MODEL`, etc.
    const companion = ENV_PROVIDER_PREFIXES.find((x) =>
      x.prefixes.some((pre) => varName.startsWith(`${pre}_`)),
    );
    if (companion) {
      const suffix = varName.slice(companion.prefixes[0].length + 1); // BASE_URL, MODEL, etc.
      // find the bucket for this provider with an existing apiKey; prefer the
      // most recently created one (matches the writer's block layout)
      const matching = [...order].reverse().map((k) => buckets.get(k)!).filter((b) => b.provider === companion.p);
      const existing = matching[0];
      if (existing) {
        if (suffix === 'BASE_URL') existing.creds.baseURL = value;
        else if (suffix === 'MODEL') existing.creds.model = value;
        else existing.creds[suffix.toLowerCase()] = value;
      }
      continue;
    }

    // R2 / DO Spaces env vars
    if (varName === 'CDN_ACCESS_KEY_ID' || varName === 'R2_ACCESS_KEY_ID') {
      getOrCreate('r2::main', 'cloudflare-r2').creds.accessKeyId = value;
      continue;
    }
    if (varName === 'CDN_SECRET_ACCESS_KEY' || varName === 'R2_SECRET_ACCESS_KEY') {
      getOrCreate('r2::main', 'cloudflare-r2').creds.secretAccessKey = value;
      continue;
    }
    if (varName === 'CDN_ENDPOINT') {
      getOrCreate('r2::main', 'cloudflare-r2').creds.endpoint = value;
      continue;
    }
    if (varName === 'CDN_BUCKET_NAME') {
      getOrCreate('r2::main', 'cloudflare-r2').creds.bucket = value;
      continue;
    }
    if (varName === 'DO_SPACES_KEY') {
      getOrCreate('do::main', 'do-spaces').creds.accessKeyId = value;
      continue;
    }
    if (varName === 'DO_SPACES_SECRET') {
      getOrCreate('do::main', 'do-spaces').creds.secretAccessKey = value;
      continue;
    }
    if (varName === 'DO_SPACES_ENDPOINT') {
      getOrCreate('do::main', 'do-spaces').creds.endpoint = value;
      continue;
    }
    if (varName === 'DO_SPACES_BUCKET') {
      getOrCreate('do::main', 'do-spaces').creds.bucket = value;
      continue;
    }

    // catch-all: `<PROVIDER>_<FIELD>=value` generic form from our own toEnv()
    const generic = /^([A-Z][A-Z0-9]+)_([A-Z_]+)$/.exec(varName);
    if (generic) {
      const provSlug = generic[1].toLowerCase().replace(/_/g, '-');
      const field = generic[2].toLowerCase();
      const adapter = listAdapters().find(
        (a) => a.id === provSlug || a.id.replace(/-/g, '_') === provSlug,
      );
      if (adapter) {
        const b = getOrCreate(`${adapter.id}::${value.slice(0, 8)}`, adapter.id);
        b.creds[field] = value;
        continue;
      }
    }
    // unrecognized - reset pending context
    resetPending();
  }

  const out: ParsedEntry[] = [];
  for (const key of order) {
    const { provider, creds, label } = buckets.get(key)!;
    // skip buckets that never got an apiKey/secret (orphan companions)
    const hasMainCred = creds.apiKey || creds.apiSecret || creds.accessKeyId;
    if (!hasMainCred) continue;
    const adapter = getAdapter(provider);
    out.push({
      provider,
      section: adapter?.defaultSection,
      label,
      credentials: creds,
      testable: adapter ? adapter.kind !== 'reference' : true,
    });
  }
  return out;
}

// ─── curl snippet parser ────────────────────────────────────────────────────
// One entry per `curl -X POST <url>/chat/completions -H "Authorization: Bearer xxx"`.
export function parseCurl(text: string): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  // split on curl commands (line starting with "curl" or "# <label>" preceded by curl block)
  const blocks = text.split(/(?=^# |^curl\s)/m);
  let pendingLabel: string | undefined;
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (/^#\s/.test(trimmed)) {
      pendingLabel = trimmed.replace(/^#\s*/, '').trim() || undefined;
      continue;
    }
    if (!/^curl\b/i.test(trimmed)) {
      pendingLabel = undefined;
      continue;
    }
    const urlM = /\bcurl\s+(?:-X\s+\w+\s+)?(https?:\/\/[^\s'"]+)/i.exec(trimmed);
    const bearerM = /Authorization:\s*Bearer\s+["']?([A-Za-z0-9_\-.:]+)["']?/i.exec(trimmed);
    const apiKeyM = /x-api-key:\s*["']?([A-Za-z0-9_\-.:]+)["']?/i.exec(trimmed);
    const modelM = /"model"\s*:\s*"([^"]+)"/.exec(trimmed);
    const apiKey = bearerM?.[1] || apiKeyM?.[1];
    const url = urlM?.[1];
    if (!apiKey || !url) {
      pendingLabel = undefined;
      continue;
    }

    let provider: Provider;
    let baseURL = url.replace(/\/chat\/completions\/?$/i, '').replace(/\/messages\/?$/i, '');
    if (/api\.anthropic\.com/.test(url)) {
      provider = 'anthropic';
    } else if (/api\.deepseek\.com/.test(url)) {
      provider = 'deepseek';
    } else if (/openrouter\.ai/.test(url)) {
      provider = 'openrouter';
    } else if (/api\.deepinfra\.com/.test(url)) {
      provider = 'deepinfra';
    } else if (/api\.perplexity\.ai/.test(url)) {
      provider = 'perplexity';
    } else if (/api\.openai\.com/.test(url)) {
      provider = 'openai';
    } else {
      provider = 'openai-compat';
    }
    const adapter = getAdapter(provider);
    out.push({
      provider,
      section: adapter?.defaultSection,
      label: pendingLabel,
      credentials: {
        apiKey,
        baseURL,
        ...(modelM ? { model: modelM[1] } : {}),
      },
      testable: true,
    });
    pendingLabel = undefined;
  }
  return out;
}

// re-export to satisfy adapter lookup in callers
export { prettyProvider, labelFromTitle };
