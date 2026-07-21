// One-shot parser verifier: reads keys.md, prints what would land in store.json.
// Usage: bun run parse   (or: bun scripts/parse-once.ts)
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseMarkdown } from '../server/core/parser.ts';

const mdPath = resolve(import.meta.dir, '..', 'keys.md');
const md = await readFile(mdPath, 'utf8');
const parsed = parseMarkdown(md);

console.log(`Parsed ${parsed.length} entries from keys.md\n`);
console.log('Provider                    Testable  Label');
console.log('─────────────────────────── ───────── ────────────────────────────────');
for (const p of parsed) {
  const apiKey = p.credentials.apiKey || p.credentials.apiSecret || p.credentials.accessKeyId || '';
  const cred = apiKey ? `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}` : '(no key)';
  const warn = p.warn ? '  ⚠ ' + p.warn : '';
  console.log(
    `${p.provider.padEnd(28)}${p.testable ? 'yes      ' : 'no       '}${p.label || ''}  [${cred}]${warn}`,
  );
}

const byProvider = new Map<string, number>();
for (const p of parsed) byProvider.set(p.provider, (byProvider.get(p.provider) || 0) + 1);
console.log('\nBreakdown:');
for (const [k, v] of byProvider) console.log(`  ${k}: ${v}`);
