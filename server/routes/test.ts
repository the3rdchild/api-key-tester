import { Hono } from 'hono';
import { runOne } from '../core/runner.ts';
import type { WSEvent } from '../../shared/types.ts';
import { broadcast } from './ws.ts';

export const testRouter = new Hono();

const emit = (evt: WSEvent) => broadcast(evt);

// POST /api/test/:id - run single key test
testRouter.post('/:id', async (c) => {
  const id = c.req.param('id');
  const entry = await runOne(id, {
    onStart: (keyId) => emit({ type: 'test:started', keyId }),
    onDone: (keyId, status) => emit({ type: 'test:done', keyId, status }),
  });
  if (!entry) return c.json({ error: 'not found' }, 404);
  return c.json({ key: entry });
});

// Note: POST /api/test-all (batch) lives in server/index.ts as a direct route,
// because mounting it here would require a second router mount at /api.
