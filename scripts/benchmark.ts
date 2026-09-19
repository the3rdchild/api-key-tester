// CLI entrypoint for the benchmark pipeline.
// Usage:
//   bun scripts/benchmark.ts status      # catalog stats + coverage + quota
//   bun scripts/benchmark.ts phase-a     # online lookup only (free)
//   bun scripts/benchmark.ts run         # full pipeline (Phase 0 → A → B)
//   bun scripts/benchmark.ts final       # scored catalog + CSV
//   bun scripts/benchmark.ts run --dry   # dry-run (probes + counts, no API spend)

import { runBenchmark, buildFinalCatalog, loadCatalog, catalogStats, probeAllKeys, phaseALookup, coverageReport, RESULTS_DIR } from '../server/benchmark/index.ts';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const cmd = process.argv[2] ?? 'status';
const dry = process.argv.includes('--dry');

async function status() {
  const models = await loadCatalog();
  console.log('=== Catalog ===');
  console.log(catalogStats(models));
  console.log('\n=== Provider coverage ===');
  const cov = coverageReport(models);
  console.log(`reachable: ${cov.reachable}/${cov.total} (native ${cov.bySource.native}, gateway ${cov.bySource.gateway}, none ${cov.bySource.none})`);
  if (cov.unreachable.length) {
    console.log('\nunreachable models:');
    cov.unreachable.slice(0, 20).forEach((m) => console.log(`  - ${m.name} (${m.provider})`));
    if (cov.unreachable.length > 20) console.log(`  ... +${cov.unreachable.length - 20} more`);
  }
  console.log('\n=== Quota probe (Phase 0) ===');
  const { probes, byStatus } = await probeAllKeys();
  probes.forEach((p) => console.log(`  ${p.status.padEnd(12)} ${p.label} — ${p.detail}`));
  console.log('\nby status:', byStatus);
}

async function phaseA() {
  const models = await loadCatalog();
  const { results, missing } = await phaseALookup(models);
  console.log(`Phase A: ${results.length} scores found online, ${missing.length} models missing`);
  if (missing.length) {
    console.log('\nmissing (need Phase B):');
    missing.slice(0, 30).forEach((m) => console.log(`  - ${m.name}`));
  }
}

async function run() {
  console.log(dry ? '[DRY RUN] no API calls will be made' : 'Running full pipeline...');
  const report = await runBenchmark({ dryRun: dry });
  console.log('\n=== Report ===');
  console.log('catalog total:', report.catalogTotal);
  console.log('quota:', report.quota.length, 'probes');
  console.log('phase A:', report.phaseA);
  console.log('phase B:', report.phaseB);
  console.log('results saved:', report.results.length);
}

async function final() {
  const { models, csv } = await buildFinalCatalog();
  await mkdir(RESULTS_DIR, { recursive: true });
  const out = resolve(RESULTS_DIR, 'catalog-scored.csv');
  await writeFile(out, csv, 'utf8');
  console.log(`Wrote ${models.length} models → ${out}`);
}

switch (cmd) {
  case 'status': await status(); break;
  case 'phase-a': await phaseA(); break;
  case 'run': await run(); break;
  case 'final': await final(); break;
  default:
    console.error(`Unknown command: ${cmd}`);
    console.error('Usage: bun scripts/benchmark.ts [status|phase-a|run|final] [--dry]');
    process.exit(1);
}
