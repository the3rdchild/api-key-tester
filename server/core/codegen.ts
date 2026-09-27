// Turn a resolved request into copy-pasteable code in a few languages.
//
// The resolution (interpolation, vault auth, body building) is done once in
// send.ts's resolveRequest() - exactly what an actual send does - so every
// snippet here matches what Keyway would put on the wire. These formatters are
// pure: ResolvedRequest in, string out.

import type { ResolvedRequest } from './send.ts';

export type CodeLang = 'curl' | 'js-fetch' | 'js-axios' | 'python-requests' | 'httpie';

export const CODE_LANGS: { id: CodeLang; label: string; hl: string }[] = [
  { id: 'curl', label: 'cURL', hl: 'bash' },
  { id: 'js-fetch', label: 'JavaScript · fetch', hl: 'javascript' },
  { id: 'js-axios', label: 'JavaScript · axios', hl: 'javascript' },
  { id: 'python-requests', label: 'Python · requests', hl: 'python' },
  { id: 'httpie', label: 'HTTPie', hl: 'bash' },
];

export function toSnippet(req: ResolvedRequest, lang: CodeLang): string {
  switch (lang) {
    case 'curl':
      return curlSnippet(req);
    case 'js-fetch':
      return fetchSnippet(req);
    case 'js-axios':
      return axiosSnippet(req);
    case 'python-requests':
      return pythonSnippet(req);
    case 'httpie':
      return httpieSnippet(req);
  }
}

// ─── shared helpers ───────────────────────────────────────────────────────────

/** POSIX single-quote: safe for any byte, since only ' needs escaping. */
function sh(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A JS/Python double-quoted string literal. */
function q(s: string): string {
  return JSON.stringify(s);
}

function isJson(req: ResolvedRequest): boolean {
  return /\bjson\b/i.test(req.contentType ?? '');
}

/** Parse the body as JSON, or undefined if it isn't. */
function asJson(req: ResolvedRequest): unknown | undefined {
  if (!req.body || !isJson(req)) return undefined;
  try {
    return JSON.parse(req.body);
  } catch {
    return undefined;
  }
}

/** JSON value → indented Python literal (True/False/None, dict/list). */
function toPy(value: unknown, indent = 0): string {
  const pad = '    '.repeat(indent);
  const pad1 = '    '.repeat(indent + 1);
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return q(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((v) => `${pad1}${toPy(v, indent + 1)}`).join(',\n')},\n${pad}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return '{}';
  return `{\n${entries.map(([k, v]) => `${pad1}${q(k)}: ${toPy(v, indent + 1)}`).join(',\n')},\n${pad}}`;
}

// ─── curl ─────────────────────────────────────────────────────────────────────

function curlSnippet(r: ResolvedRequest): string {
  const parts = [`curl -X ${r.method} ${sh(r.url)}`];
  for (const [k, v] of r.headers) parts.push(`  -H ${sh(`${k}: ${v}`)}`);
  if (r.multipart) {
    for (const f of r.multipart) {
      parts.push(
        f.kind === 'file'
          ? `  -F ${sh(`${f.key}=@${f.filename ?? 'file'}`)}`
          : `  -F ${sh(`${f.key}=${f.value ?? ''}`)}`,
      );
    }
  } else if (r.body) {
    parts.push(`  --data ${sh(r.body)}`);
  }
  parts.push(r.followRedirects ? '  -L' : '  --max-redirs 0');
  return parts.join(' \\\n');
}

// ─── JavaScript: fetch ────────────────────────────────────────────────────────

function fetchSnippet(r: ResolvedRequest): string {
  const opts: string[] = [`  method: ${q(r.method)},`];

  if (r.multipart) {
    opts.push('  body: form,');
    // fetch sets the multipart boundary itself, so drop any Content-Type header
    const headers = r.headers.filter(([k]) => k.toLowerCase() !== 'content-type');
    if (headers.length) opts.splice(1, 0, headerObject(headers, '  '));
    return [
      formData(r),
      '',
      `const res = await fetch(${q(r.url)}, {`,
      ...opts,
      '});',
      'const data = await res.json();',
      'console.log(data);',
    ].join('\n');
  }

  if (r.headers.length) opts.splice(1, 0, headerObject(r.headers, '  '));
  const json = asJson(r);
  if (json !== undefined) opts.push(`  body: JSON.stringify(${indentBlock(toJs(json), '  ')}),`);
  else if (r.body) opts.push(`  body: ${q(r.body)},`);

  return [`const res = await fetch(${q(r.url)}, {`, ...opts, '});', 'const data = await res.json();', 'console.log(data);'].join('\n');
}

/** JSON value → JS literal — JSON.stringify's output already is one. */
function toJs(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function headerObject(headers: [string, string][], pad: string): string {
  const lines = headers.map(([k, v]) => `${pad}  ${q(k)}: ${q(v)},`);
  return `${pad}headers: {\n${lines.join('\n')}\n${pad}},`;
}

/** Re-indent a multi-line literal so nested lines line up under `pad`. */
function indentBlock(block: string, pad: string): string {
  return block
    .split('\n')
    .map((line, i) => (i === 0 ? line : pad + line))
    .join('\n');
}

function formData(r: ResolvedRequest): string {
  const lines = ['const form = new FormData();'];
  for (const f of r.multipart ?? []) {
    lines.push(
      f.kind === 'file'
        ? `form.append(${q(f.key)}, /* File: ${f.filename ?? 'file'} */ fileInput.files[0]);`
        : `form.append(${q(f.key)}, ${q(f.value ?? '')});`,
    );
  }
  return lines.join('\n');
}

// ─── JavaScript: axios ────────────────────────────────────────────────────────

function axiosSnippet(r: ResolvedRequest): string {
  const cfg: string[] = [`  method: ${q(r.method.toLowerCase())},`, `  url: ${q(r.url)},`];

  if (r.multipart) {
    const headers = r.headers.filter(([k]) => k.toLowerCase() !== 'content-type');
    if (headers.length) cfg.push(headerObject(headers, '  '));
    cfg.push('  data: form,');
    return [formData(r), '', 'const res = await axios({', ...cfg, '});', 'console.log(res.data);'].join('\n');
  }

  if (r.headers.length) cfg.push(headerObject(r.headers, '  '));
  const json = asJson(r);
  if (json !== undefined) cfg.push(`  data: ${indentBlock(toJs(json), '  ')},`);
  else if (r.body) cfg.push(`  data: ${q(r.body)},`);

  return [`import axios from 'axios';`, '', 'const res = await axios({', ...cfg, '});', 'console.log(res.data);'].join('\n');
}

// ─── Python: requests ─────────────────────────────────────────────────────────

function pythonSnippet(r: ResolvedRequest): string {
  const args = [`    ${q(r.method)},`, `    ${q(r.url)},`];
  if (r.headers.length) {
    const lines = r.headers.map(([k, v]) => `        ${q(k)}: ${q(v)},`);
    args.push(`    headers={\n${lines.join('\n')}\n    },`);
  }

  if (r.multipart) {
    const files: string[] = [];
    const data: string[] = [];
    for (const f of r.multipart) {
      if (f.kind === 'file') files.push(`        ${q(f.key)}: open(${q(f.filename ?? 'file')}, "rb"),`);
      else data.push(`        ${q(f.key)}: ${q(f.value ?? '')},`);
    }
    if (data.length) args.push(`    data={\n${data.join('\n')}\n    },`);
    if (files.length) args.push(`    files={\n${files.join('\n')}\n    },`);
  } else {
    const json = asJson(r);
    if (json !== undefined) args.push(`    json=${indentBlock(toPy(json, 0), '    ')},`);
    else if (r.body) args.push(`    data=${q(r.body)},`);
  }

  return ['import requests', '', 'response = requests.request(', ...args, ')', 'print(response.json())'].join('\n');
}

// ─── HTTPie ───────────────────────────────────────────────────────────────────

function httpieSnippet(r: ResolvedRequest): string {
  const head = [`http ${r.method} ${sh(r.url)}`];
  for (const [k, v] of r.headers) {
    // a JSON body is sent through field syntax below, so its Content-Type is implicit
    if (asJson(r) !== undefined && k.toLowerCase() === 'content-type') continue;
    head.push(`  ${sh(`${k}:${v}`)}`);
  }

  const json = asJson(r);
  if (json !== undefined && json && typeof json === 'object' && !Array.isArray(json)) {
    for (const [k, v] of Object.entries(json)) {
      head.push(typeof v === 'string' ? `  ${sh(`${k}=${v}`)}` : `  ${sh(`${k}:=${JSON.stringify(v)}`)}`);
    }
    return head.join(' \\\n');
  }

  if (r.multipart) {
    head[0] = `http --form ${r.method} ${sh(r.url)}`;
    for (const f of r.multipart) {
      head.push(f.kind === 'file' ? `  ${sh(`${f.key}@${f.filename ?? 'file'}`)}` : `  ${sh(`${f.key}=${f.value ?? ''}`)}`);
    }
    return head.join(' \\\n');
  }

  if (r.body) {
    // arbitrary raw body: feed it on stdin
    return `printf '%s' ${sh(r.body)} | ${head.join(' \\\n')}`;
  }
  return head.join(' \\\n');
}
