// CRUD over collections.json + the request history and cookie jar that the
// API client needs alongside it.

import { Hono } from 'hono';
import { nanoid } from 'nanoid';

import {
  loadCollections,
  saveRequest,
  deleteRequest,
  duplicateRequest,
  createFolder,
  deleteFolder,
  renameNode,
  moveNode,
  saveEnvironment,
  deleteEnvironment,
  setActiveEnvironment,
} from '../core/collections.ts';
import { listHistory, clearHistory, getHistoryDetail } from '../core/req-history.ts';
import { listCookies, clearCookies } from '../core/cookies.ts';
import { importCurl } from '../core/import-curl.ts';
import { applyImport, importAny, summarise } from '../core/import/index.ts';
import { listRemembered } from '../core/responses.ts';
import { emptyRequest } from '../../shared/collections.ts';
import type { EnvironmentDef, RequestSpec } from '../../shared/collections.ts';

export const collectionsRouter = new Hono();

collectionsRouter.get('/', async (c) => c.json(await loadCollections()));

// ─── requests ───────────────────────────────────────────────────────────────

collectionsRouter.post('/requests', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    spec?: Partial<RequestSpec>;
    parentId?: string;
  };
  const spec: RequestSpec = { ...emptyRequest(nanoid(12)), ...body.spec, id: nanoid(12) };
  return c.json(await saveRequest(spec, body.parentId));
});

collectionsRouter.put('/requests/:id', async (c) => {
  const body = (await c.req.json()) as { spec: RequestSpec; parentId?: string };
  const spec = { ...body.spec, id: c.req.param('id') };
  return c.json(await saveRequest(spec, body.parentId));
});

collectionsRouter.delete('/requests/:id', async (c) => {
  await deleteRequest(c.req.param('id'));
  return c.json({ ok: true });
});

collectionsRouter.post('/requests/:id/duplicate', async (c) => {
  const copy = await duplicateRequest(c.req.param('id'));
  if (!copy) return c.json({ error: 'not found' }, 404);
  return c.json(copy);
});

// ─── folders / tree ─────────────────────────────────────────────────────────

collectionsRouter.post('/folders', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: string; parentId?: string };
  return c.json(await createFolder(body.name?.trim() || 'New folder', body.parentId));
});

collectionsRouter.delete('/folders/:id', async (c) => {
  await deleteFolder(c.req.param('id'));
  return c.json({ ok: true });
});

collectionsRouter.patch('/nodes/:id', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    parentId?: string | null;
    index?: number;
  };
  if (typeof body.name === 'string') await renameNode(c.req.param('id'), body.name);
  if (body.parentId !== undefined) await moveNode(c.req.param('id'), body.parentId, body.index);
  return c.json(await loadCollections());
});

// ─── environments ───────────────────────────────────────────────────────────

collectionsRouter.put('/environments/:id', async (c) => {
  const body = (await c.req.json()) as { env: EnvironmentDef };
  return c.json(await saveEnvironment({ ...body.env, id: c.req.param('id') }));
});

collectionsRouter.post('/environments', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: string };
  const env: EnvironmentDef = { id: nanoid(12), name: body.name?.trim() || 'New environment', vars: [] };
  return c.json(await saveEnvironment(env));
});

collectionsRouter.delete('/environments/:id', async (c) => {
  await deleteEnvironment(c.req.param('id'));
  return c.json({ ok: true });
});

collectionsRouter.post('/active-env', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { id?: string | null };
  await setActiveEnvironment(body.id ?? null);
  return c.json({ ok: true });
});

// ─── history & cookies ──────────────────────────────────────────────────────

collectionsRouter.get('/history', async (c) => {
  const limit = Number(c.req.query('limit') ?? 200);
  return c.json(await listHistory(Number.isFinite(limit) ? limit : 200));
});

/** GET /api/collections/history/:id - the stored request + response. */
collectionsRouter.get('/history/:id', async (c) => {
  const detail = await getHistoryDetail(c.req.param('id'));
  if (!detail) return c.json({ error: 'No stored response for that entry' }, 404);
  return c.json(detail);
});

collectionsRouter.delete('/history', async (c) => {
  await clearHistory();
  return c.json({ ok: true });
});

collectionsRouter.get('/cookies', async (c) => c.json(await listCookies()));

// ─── import & chaining ──────────────────────────────────────────────────────

/** POST /api/collections/import-curl - parse a curl command into a request.
 *  Nothing is saved; the UI opens the result in a tab so it can be checked. */
collectionsRouter.post('/import-curl', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { text?: string };
  if (!body.text?.trim()) return c.json({ error: 'Paste a curl command first' }, 400);
  return c.json(importCurl(body.text));
});

/** POST /api/collections/import/preview - parse a Postman / Insomnia /
 *  OpenAPI file and report what an import would create. Writes nothing. */
collectionsRouter.post('/import/preview', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { text?: string };
  if (!body.text?.trim()) return c.json({ error: 'Paste or upload a file first' }, 400);
  try {
    return c.json(summarise(importAny(body.text)));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

/** POST /api/collections/import - convert and merge into collections.json.
 *  `name` renames the wrapper folder; pass an empty string for no wrapper. */
collectionsRouter.post('/import', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { text?: string; name?: string };
  if (!body.text?.trim()) return c.json({ error: 'Paste or upload a file first' }, 400);
  try {
    const imported = importAny(body.text);
    if (imported.format === 'unknown') return c.json({ error: imported.warnings[0] }, 400);
    const result = await applyImport(imported, { parentName: body.name });
    return c.json({ ...result, format: imported.format, warnings: imported.warnings });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

/** GET /api/collections/chainable - requests whose last response can be
 *  referenced with {{res.<name>.…}} in this session. */
collectionsRouter.get('/chainable', (c) => c.json(listRemembered()));

collectionsRouter.delete('/cookies', async (c) => {
  await clearCookies(c.req.query('domain') || undefined);
  return c.json({ ok: true });
});
