// HTTP routes for the benchmark module.
// Mounted at /api/benchmark. Progress is pushed over the existing /live socket
// as ProgressEvent payloads (type: 'benchmark:progress').

import { Hono } from 'hono';
import {
  loadCatalog,
  catalogStats,
  probeAllKeys,
  phaseALookup,
  loadResults,
  buildFinalCatalog,
  runBenchmark,
  coverageReport,
} from '../benchmark/index.ts';
import { broadcast } from './ws.ts';
import type { WSEvent } from '../../shared/types.ts';

export const benchmarkRouter = new Hono();

/** GET /api/benchmark/catalog — list models + stats. */
benchmarkRouter.get('/catalog', async (c) => {
  const models = await loadCatalog();
  return c.json({ stats: catalogStats(models), coverage: coverageReport(models), models });
});

/** GET /api/benchmark/results — all saved results. */
benchmarkRouter.get('/results', async (c) => {
  return c.json(await loadResults());
});

/** GET /api/benchmark/quota — probe keys (Phase 0). */
benchmarkRouter.get('/quota', async (c) => {
  const { probes, byStatus } = await probeAllKeys();
  return c.json({ probes, byStatus });
});

/** GET /api/benchmark/phase-a — dry-run online lookup (no cost). */
benchmarkRouter.get('/phase-a', async (c) => {
  const models = await loadCatalog();
  const { results, missing } = await phaseALookup(models);
  return c.json({
    found: results.length,
    missingCount: missing.length,
    results,
    missingModels: missing.map((m) => m.name),
  });
});

/** POST /api/benchmark/run — run full pipeline (Phase 0 → A → B). */
benchmarkRouter.post('/run', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    models?: string[];
    categories?: string[];
    sampleSize?: number;
    dryRun?: boolean;
  };
  const report = await runBenchmark(
    {
      models: body.models,
      categories: body.categories as never[],
      sampleSize: body.sampleSize,
      dryRun: body.dryRun,
    },
    {
      onProgress: (e) =>
        broadcast({ type: 'file:changed', path: `benchmark:${e.type}` } satisfies WSEvent),
    },
  );
  return c.json(report);
});

/** GET /api/benchmark/final — scored catalog + CSV. */
benchmarkRouter.get('/final', async (c) => {
  const { models, csv } = await buildFinalCatalog();
  return c.json({ models, csv });
});
