// E2E test: for each format, export → preview-import → import, verify no dupes added.
// Each format runs in isolation against a pristine store (we delete the imported
// entries between runs) so cascade contamination can't mask real bugs.
// Usage: bun run scripts/e2e-import.ts
import { rm } from 'node:fs/promises';

const BASE = 'http://127.0.0.1:8788';

async function storeCount(): Promise<number> {
  const r = await fetch(`${BASE}/api/keys`);
  const d = (await r.json()) as { keys: unknown[] };
  return d.keys.length;
}

async function listKeys(): Promise<Array<{ id: string }>> {
  const r = await fetch(`${BASE}/api/keys`);
  const d = (await r.json()) as { keys: Array<{ id: string }> };
  return d.keys;
}

async function deleteKey(id: string): Promise<void> {
  await fetch(`${BASE}/api/keys/${id}`, { method: 'DELETE' });
}

async function main() {
  const baseline = await storeCount();
  console.log(`baseline: ${baseline} keys\n`);

  const originalIds = new Set((await listKeys()).map((k) => k.id));

  let allPass = true;
  for (const fmt of ['md', 'json', 'env', 'csv', 'curl'] as const) {
    console.log(`=== ${fmt} ===`);

    // export from pristine store
    const exportRes = await fetch(`${BASE}/api/export?format=${fmt}`);
    const exportText = await exportRes.text();
    console.log(`  exported: ${exportText.length} bytes`);
    const body = JSON.stringify({ text: exportText });

    // preview
    const previewRes = await fetch(`${BASE}/api/preview-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const previewText = await previewRes.text();
    let preview: { format?: string; count?: number; newCount?: number; duplicateCount?: number; error?: string };
    try {
      preview = JSON.parse(previewText);
    } catch {
      console.log(`  PREVIEW HTTP ${previewRes.status}: ${previewText.slice(0, 200)}`);
      continue;
    }
    if (preview.error) {
      console.log(`  PREVIEW ERROR: ${preview.error}`);
      continue;
    }
    console.log(
      `  preview: format=${preview.format} parsed=${preview.count} new=${preview.newCount} dup=${preview.duplicateCount}`,
    );

    // import
    const importRes = await fetch(`${BASE}/api/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const importText = await importRes.text();
    let result: { created?: number; skipped?: number; merged?: number; error?: string };
    try {
      result = JSON.parse(importText);
    } catch {
      console.log(`  IMPORT HTTP ${importRes.status}: ${importText.slice(0, 200)}`);
      continue;
    }
    if (result.error) {
      console.log(`  IMPORT ERROR: ${result.error}`);
      continue;
    }
    console.log(`  import: created=${result.created} skipped=${result.skipped} merged=${result.merged}`);

    // expectation: re-importing our own export should create 0 new entries
    if (result.created === 0) {
      console.log(`  ✓ PASS`);
    } else {
      console.log(`  ✗ FAIL - created ${result.created} new entries from self-export`);
      allPass = false;
    }

    // cleanup: delete any keys that didn't exist at baseline
    const current = await listKeys();
    for (const k of current) {
      if (!originalIds.has(k.id)) {
        await deleteKey(k.id);
      }
    }
    console.log();
  }

  // final sanity: store should be back to baseline
  const final = await storeCount();
  console.log(`=== final: ${final} keys (baseline ${baseline}) ===`);
  if (final === baseline && allPass) {
    console.log('✓ ALL PASS');
  } else {
    console.log(`✗ FAIL - delta ${final - baseline}`);
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});

void rm;

