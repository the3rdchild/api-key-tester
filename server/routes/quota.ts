// Quota probes for stored keys.

import { Hono } from 'hono';

import { probeQuota, supportsQuota } from '../core/quota-probe.ts';
import { getAllKeys, getKey, setQuota } from '../core/store.ts';

export const quotaRouter = new Hono();

/** POST /api/quota/:id - check one key. */
quotaRouter.post('/:id', async (c) => {
  const entry = await getKey(c.req.param('id'));
  if (!entry) return c.json({ error: 'not found' }, 404);
  const quota = await probeQuota(entry);
  if (!quota) return c.json({ supported: false });
  await setQuota(entry.id, quota);
  return c.json({ supported: true, quota });
});

/** POST /api/quota - check every key whose provider exposes a balance. */
quotaRouter.post('/', async (c) => {
  const keys = (await getAllKeys()).filter(supportsQuota);
  const results: Record<string, unknown> = {};
  const queue = [...keys];

  const worker = async () => {
    for (;;) {
      const entry = queue.shift();
      if (!entry) return;
      const quota = await probeQuota(entry);
      if (quota) {
        await setQuota(entry.id, quota);
        results[entry.id] = quota;
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  return c.json({ checked: keys.length, results });
});
