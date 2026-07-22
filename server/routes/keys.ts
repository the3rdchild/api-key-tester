import { Hono } from 'hono';
import type { KeyEntry, Provider } from '../../shared/types.ts';
import { createKey, deleteKey, getAllKeys, getKey, updateKey } from '../core/store.ts';
import { listAdapters } from '../adapters/index.ts';

export const keysRouter = new Hono();

// GET /api/providers - adapter metadata (for UI dynamic form fields)
keysRouter.get('/providers', (c) => {
  const providers = listAdapters().map((a) => ({
    id: a.id,
    label: a.label,
    kind: a.kind,
    fields: a.fields,
    defaultSection: a.defaultSection,
  }));
  return c.json({ providers });
});

// GET /api/keys - list all, optional filter ?provider=&state=
keysRouter.get('/', async (c) => {
  const provider = c.req.query('provider') as Provider | undefined;
  const state = c.req.query('state');
  let keys = await getAllKeys();
  if (provider) keys = keys.filter((k) => k.provider === provider);
  if (state) keys = keys.filter((k) => k.status.state === state);
  return c.json({ keys });
});

// GET /api/keys/:id
keysRouter.get('/:id', async (c) => {
  const key = await getKey(c.req.param('id'));
  if (!key) return c.json({ error: 'not found' }, 404);
  return c.json({ key });
});

// POST /api/keys - create
keysRouter.post('/', async (c) => {
  const body = (await c.req.json().catch(() => null)) as Partial<KeyEntry> | null;
  if (!body || !body.provider) {
    return c.json({ error: 'provider is required' }, 400);
  }
  const adapter = listAdapters().find((a) => a.id === body.provider);
  if (!adapter) return c.json({ error: `unknown provider "${body.provider}"` }, 400);
  const created = await createKey({
    provider: body.provider,
    section: body.section || adapter.defaultSection,
    label: body.label,
    credentials: body.credentials || {},
    note: body.note,
    testable: adapter.kind !== 'reference',
  });
  return c.json({ key: created }, 201);
});

// PATCH /api/keys/:id - update creds/label/note
keysRouter.patch('/:id', async (c) => {
  const body = (await c.req.json().catch(() => null)) as Partial<KeyEntry> | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);
  const updated = await updateKey(c.req.param('id'), {
    label: body.label,
    credentials: body.credentials,
    note: body.note,
    section: body.section,
  });
  if (!updated) return c.json({ error: 'not found' }, 404);
  return c.json({ key: updated });
});

// DELETE /api/keys/:id
keysRouter.delete('/:id', async (c) => {
  const ok = await deleteKey(c.req.param('id'));
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});
