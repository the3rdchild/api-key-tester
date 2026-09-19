// POST /api/send - run one request through the send pipeline.
//
// Two content types are accepted:
//   application/json      { spec, vars? }               - the common case
//   multipart/form-data   spec=<json>, file:<field>=…   - when the body has files
// The browser attaches real File objects, so uploads never touch the host
// filesystem: bytes go browser → this server → target.

import { Hono } from 'hono';
import type { Context } from 'hono';

import { sendRequest, toCurl } from '../core/send.ts';
import { activeEnvVars, applyEnvVarChanges } from '../core/collections.ts';
import { record } from '../core/req-history.ts';
import { broadcast } from './ws.ts';
import type { RequestSpec } from '../../shared/collections.ts';

export const sendRouter = new Hono();

interface SendPayload {
  spec: RequestSpec;
  vars?: Record<string, string>;
}

async function readPayload(
  c: Context,
): Promise<{ spec: RequestSpec; vars?: Record<string, string>; files: Map<string, File[]> }> {
  const files = new Map<string, File[]>();
  const contentType = c.req.header('content-type') ?? '';

  if (contentType.includes('multipart/form-data')) {
    const form = await c.req.formData();
    const specRaw = form.get('spec');
    const payload = JSON.parse(String(specRaw ?? '{}')) as SendPayload;
    for (const [key, value] of form.entries()) {
      if (!key.startsWith('file:') || typeof value === 'string') continue;
      const field = key.slice('file:'.length);
      files.set(field, [...(files.get(field) ?? []), value as File]);
    }
    return { spec: payload.spec, vars: payload.vars, files };
  }

  const payload = (await c.req.json()) as SendPayload;
  return { spec: payload.spec, vars: payload.vars, files };
}

sendRouter.post('/', async (c) => {
  let spec: RequestSpec;
  let vars: Record<string, string> | undefined;
  let files: Map<string, File[]>;
  try {
    ({ spec, vars, files } = await readPayload(c));
  } catch (e) {
    return c.json({ error: `Bad request payload: ${e instanceof Error ? e.message : e}` }, 400);
  }
  if (!spec?.url) return c.json({ error: 'Missing url' }, 400);

  const envVars = { ...(await activeEnvVars()), ...(vars ?? {}) };
  const outcome = await sendRequest(spec, { files, vars: envVars });
  if (outcome.envVars) await applyEnvVarChanges(outcome.envVars);
  const entry = await record(spec, outcome.sentHeaders, outcome.sentBody, outcome.result);
  broadcast({ type: 'req-history:appended', entry });

  return c.json({
    result: outcome.result,
    missing: outcome.missing,
    note: outcome.note,
    needsAuthorization: outcome.needsAuthorization,
    historyId: entry.id,
  });
});

/** POST /api/send/curl - render the request as a curl command. */
sendRouter.post('/curl', async (c) => {
  const payload = (await c.req.json().catch(() => ({}))) as SendPayload;
  if (!payload?.spec) return c.json({ error: 'Missing spec' }, 400);
  const vars = { ...(await activeEnvVars()), ...(payload.vars ?? {}) };
  return c.json({ curl: await toCurl(payload.spec, vars) });
});
