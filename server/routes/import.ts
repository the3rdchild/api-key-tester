import { Hono, type Context } from 'hono';
import { parseAny, type ImportFormat } from '../core/parser.ts';
import { appendParsed, getAllKeys } from '../core/store.ts';

export const importRouter = new Hono();

interface PreviewEntry {
  index: number;
  provider: string;
  label?: string;
  testable: boolean;
  warn?: string;
  apiKeyMasked: string;
  /** this parsed entry would be a duplicate of an existing store entry */
  duplicate?: boolean;
}

function maskCred(cred: string): string {
  if (!cred) return '';
  if (cred.length <= 8) return '*'.repeat(cred.length);
  return `${cred.slice(0, 4)}…${cred.slice(-4)}`;
}

function mainCredOf(creds: Record<string, string>): string {
  return creds.apiKey || creds.apiSecret || creds.accessKeyId || '';
}

// Build the set of "provider::prefix8" (or "provider::label" for reference
// entries) already in the store, so the preview can flag duplicates before commit.
async function buildExistingKeys(): Promise<{
  byPrefix: Set<string>;
  byLabel: Set<string>;
}> {
  const keys = await getAllKeys();
  const byPrefix = new Set<string>();
  const byLabel = new Set<string>();
  for (const k of keys) {
    const main = mainCredOf(k.credentials);
    if (main) {
      byPrefix.add(`${k.provider}::${main.slice(0, 8)}`);
    } else {
      byLabel.add(`${k.provider}::${k.label || ''}`);
    }
  }
  return { byPrefix, byLabel };
}

// POST /api/preview-import - parse text (auto-detect format), return preview
// Exported as a standalone handler so it can be mounted at /api/preview-import
// (not /api/import/preview) in index.ts.
export async function previewImportHandler(c: Context) {
  const body = (await c.req.json().catch(() => null)) as
    | { text?: string; format?: ImportFormat }
    | null;
  if (!body?.text) return c.json({ error: 'text is required' }, 400);

  const { format, entries } = parseAny(body.text, body.format);
  const { byPrefix, byLabel } = await buildExistingKeys();

  const preview: PreviewEntry[] = entries.map((p, i) => {
    const main = mainCredOf(p.credentials);
    const duplicate = main
      ? byPrefix.has(`${p.provider}::${main.slice(0, 8)}`)
      : byLabel.has(`${p.provider}::${p.label || ''}`);
    return {
      index: i,
      provider: p.provider,
      label: p.label,
      testable: p.testable,
      warn: p.warn,
      apiKeyMasked: maskCred(main),
      duplicate,
    };
  });

  const dupCount = preview.filter((p) => p.duplicate).length;
  return c.json({
    format,
    count: entries.length,
    newCount: entries.length - dupCount,
    duplicateCount: dupCount,
    entries: preview,
  });
}

// POST /api/import - parse + persist (skip duplicates by default)
importRouter.post('/', async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { text?: string; format?: ImportFormat; mergeExisting?: boolean; allowDuplicates?: boolean }
    | null;
  if (!body?.text) return c.json({ error: 'text is required' }, 400);

  const { format, entries } = parseAny(body.text, body.format);
  if (entries.length === 0) {
    return c.json({ error: `no entries parsed from ${format} input` }, 400);
  }

  const result = await appendParsed(entries, {
    dedup: !body.allowDuplicates,
    mergeExisting: !!body.mergeExisting,
  });

  return c.json({
    format,
    parsed: entries.length,
    created: result.created.length,
    skipped: result.skippedIndices.length,
    merged: result.mergedIndices.length,
    keys: result.created,
  });
});
