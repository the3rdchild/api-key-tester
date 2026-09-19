// Paste a curl command, get a request back.
//
// Copying "Copy as cURL" out of browser devtools is how most requests start
// life, so this covers the flags those commands actually use. Anything it
// can't express becomes a warning instead of a silent drop - a request that
// pretends to be complete is worse than one that tells you what it lost.

import { nanoid } from 'nanoid';

import { DEFAULT_SETTINGS, emptyRequest } from '../../shared/collections.ts';
import type { BodyMode, KV, MultipartRow, RequestSpec } from '../../shared/collections.ts';

export interface CurlImport {
  spec: RequestSpec;
  warnings: string[];
}

/** Split a shell-ish command into tokens, honouring quotes and continuations. */
function tokenize(input: string): string[] {
  const text = input
    .replace(/\\\r?\n/g, ' ') // POSIX line continuation
    .replace(/\^\r?\n/g, ' ') // cmd.exe continuation
    .replace(/`\r?\n/g, ' ') // PowerShell continuation
    .trim();

  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < text.length) {
        cur += text[++i];
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur || started) tokens.push(cur);
      cur = '';
      started = false;
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) {
      cur += text[++i];
      continue;
    }
    cur += ch;
  }
  if (cur || started) tokens.push(cur);
  return tokens;
}

function splitHeader(raw: string): KV | null {
  const i = raw.indexOf(':');
  if (i < 0) return null;
  return { key: raw.slice(0, i).trim(), value: raw.slice(i + 1).trim(), enabled: true };
}

function detectBodyMode(body: string, contentType: string | undefined): BodyMode {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('json')) return 'json';
  if (ct.includes('xml')) return 'xml';
  if (ct.includes('x-www-form-urlencoded')) return 'form';
  if (ct) return 'text';
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  if (/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(trimmed)) return 'form';
  return 'text';
}

function formRows(body: string): KV[] {
  return body
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf('=');
      const key = i < 0 ? pair : pair.slice(0, i);
      const value = i < 0 ? '' : pair.slice(i + 1);
      return { key: decodeURIComponent(key), value: decodeURIComponent(value), enabled: true };
    });
}

export function importCurl(command: string): CurlImport {
  const tokens = tokenize(command);
  const warnings: string[] = [];
  const spec = emptyRequest(nanoid(12), 'Imported request');
  spec.settings = { ...DEFAULT_SETTINGS, followRedirects: false };

  let url = '';
  let method = '';
  let bodyParts: string[] = [];
  const multipart: MultipartRow[] = [];
  const urlencoded: KV[] = [];
  let asGet = false;

  if (tokens[0] && tokens[0].toLowerCase() !== 'curl') {
    warnings.push('Command does not start with "curl" - parsed it anyway.');
  }

  for (let i = tokens[0]?.toLowerCase() === 'curl' ? 1 : 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const next = () => tokens[++i] ?? '';

    switch (true) {
      case t === '-X' || t === '--request':
        method = next().toUpperCase();
        break;

      case t === '-H' || t === '--header': {
        const header = splitHeader(next());
        if (header) spec.headers.push(header);
        break;
      }

      case t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary' || t === '--data-ascii':
        bodyParts.push(next());
        break;

      case t === '--data-urlencode': {
        const raw = next();
        const eq = raw.indexOf('=');
        urlencoded.push(
          eq < 0
            ? { key: raw, value: '', enabled: true }
            : { key: raw.slice(0, eq), value: raw.slice(eq + 1), enabled: true },
        );
        break;
      }

      case t === '-F' || t === '--form': {
        const raw = next();
        const eq = raw.indexOf('=');
        if (eq < 0) break;
        const key = raw.slice(0, eq);
        const value = raw.slice(eq + 1);
        if (value.startsWith('@') || value.startsWith('<')) {
          multipart.push({ key, type: 'file', filename: value.slice(1), enabled: true });
          warnings.push(`Field "${key}" expects a file - pick it again in the Body tab.`);
        } else {
          multipart.push({ key, type: 'text', value, enabled: true });
        }
        break;
      }

      case t === '-u' || t === '--user': {
        const raw = next();
        const sep = raw.indexOf(':');
        spec.auth = {
          type: 'basic',
          username: sep < 0 ? raw : raw.slice(0, sep),
          password: sep < 0 ? '' : raw.slice(sep + 1),
        };
        break;
      }

      case t === '-b' || t === '--cookie':
        spec.headers.push({ key: 'Cookie', value: next(), enabled: true });
        break;

      case t === '-A' || t === '--user-agent':
        spec.headers.push({ key: 'User-Agent', value: next(), enabled: true });
        break;

      case t === '-e' || t === '--referer':
        spec.headers.push({ key: 'Referer', value: next(), enabled: true });
        break;

      case t === '-L' || t === '--location':
        spec.settings.followRedirects = true;
        break;

      case t === '--max-time' || t === '-m': {
        const secs = Number(next());
        if (Number.isFinite(secs) && secs > 0) spec.settings.timeoutMs = Math.round(secs * 1000);
        break;
      }

      case t === '-G' || t === '--get':
        asGet = true;
        break;

      case t === '--url':
        url = next();
        break;

      case t === '-k' || t === '--insecure':
        warnings.push('-k/--insecure is ignored: TLS verification cannot be disabled here.');
        break;

      case t === '--compressed' || t === '-s' || t === '--silent' || t === '-v' || t === '--verbose' || t === '-i' || t === '--include':
        break; // transport/output flags with no meaning for us

      case t === '-o' || t === '--output' || t === '--proxy' || t === '-x':
        warnings.push(`${t} is not supported and was skipped.`);
        i++;
        break;

      case t.startsWith('-'):
        warnings.push(`Unknown flag ${t} was skipped.`);
        break;

      default:
        if (!url) url = t;
        else warnings.push(`Ignored stray argument "${t}".`);
    }
  }

  if (!url) warnings.push('No URL found in the command.');

  // Pull the query string into editable rows.
  try {
    const parsed = new URL(url);
    for (const [key, value] of parsed.searchParams.entries()) {
      spec.params.push({ key, value, enabled: true });
    }
    parsed.search = '';
    spec.url = parsed.toString();
  } catch {
    spec.url = url;
  }

  const body = bodyParts.join('&');
  const contentType = spec.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value;

  // -G turns every data flag into query parameters instead of a body.
  if (asGet) {
    if (body) {
      for (const row of formRows(body)) spec.params.push(row);
      bodyParts = [];
    }
    if (urlencoded.length) {
      spec.params.push(...urlencoded);
      urlencoded.length = 0;
    }
  }

  if (asGet) {
    // body stays 'none'
  } else if (multipart.length) {
    spec.body = { mode: 'multipart', multipart };
  } else if (urlencoded.length) {
    spec.body = { mode: 'form', form: urlencoded };
  } else if (body) {
    const mode = detectBodyMode(body, contentType);
    spec.body = mode === 'form' ? { mode, form: formRows(body) } : { mode, text: body };
  }

  spec.method = method || (spec.body.mode !== 'none' && !asGet ? 'POST' : 'GET');
  spec.name = nameFor(spec);
  return { spec, warnings };
}

function nameFor(spec: RequestSpec): string {
  try {
    const u = new URL(spec.url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return `${last || u.hostname}`;
  } catch {
    return 'Imported request';
  }
}
