// Collection runner over HTTP.
//
// A run can take minutes, so the POST returns as soon as it starts and the
// progress arrives on the WebSocket - same channel the rest of the app uses.

import { Hono } from 'hono';

import {
  cancelRun,
  currentRun,
  recentRuns,
  runCollection,
  type RunOptions,
} from '../core/collection-runner.ts';

export const runnerRouter = new Hono();

runnerRouter.post('/run', async (c) => {
  if (currentRun()) return c.json({ error: 'A run is already in progress' }, 409);
  const opts = (await c.req.json().catch(() => ({}))) as RunOptions;

  // Fire and forget: progress and the summary arrive over /live.
  runCollection(opts).catch((e) => {
    console.error('[runner] run failed:', e);
  });

  return c.json({ started: true });
});

runnerRouter.get('/status', (c) => c.json({ current: currentRun(), recent: recentRuns() }));

runnerRouter.post('/cancel', (c) => c.json({ cancelled: cancelRun() }));
