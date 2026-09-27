// Matrix run over HTTP: start it, follow it on /live, read the last result.

import { Hono } from 'hono';

import { currentMatrix, lastMatrix, matrixCell, runMatrix } from '../core/matrix.ts';
import type { MatrixTarget, RequestSpec } from '../../shared/collections.ts';

export const matrixRouter = new Hono();

matrixRouter.post('/run', async (c) => {
  if (currentMatrix()) return c.json({ error: 'A matrix run is already in progress' }, 409);
  const body = (await c.req.json()) as {
    spec: RequestSpec;
    targets: MatrixTarget[];
    concurrency?: number;
  };
  if (!body?.spec?.url) return c.json({ error: 'Missing request' }, 400);

  try {
    // Kick it off; the table fills in over the socket.
    runMatrix({ spec: body.spec, targets: body.targets ?? [], concurrency: body.concurrency }).catch(
      (e) => console.error('[matrix] run failed:', e),
    );
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
  return c.json({ started: true, total: body.targets?.length ?? 0 });
});

matrixRouter.get('/status', (c) => c.json({ current: currentMatrix(), last: lastMatrix() }));

/** GET /api/matrix/:runId/cells/:cellId - one cell's whole response, for a compare. */
matrixRouter.get('/:runId/cells/:cellId', (c) => {
  const result = matrixCell(c.req.param('runId'), c.req.param('cellId'));
  return result ? c.json(result) : c.json({ error: 'That run is no longer the latest one' }, 404);
});
