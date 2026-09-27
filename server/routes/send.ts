// POST /api/send - run one request through the send pipeline.
//
// Two content types are accepted:
//   application/json      { spec, vars? }               - the common case
//   multipart/form-data   spec=<json>, file:<field>=…   - when the body has files
// The browser attaches real File objects, so uploads never touch the host
// filesystem: bytes go browser → this server → target.

import { Hono } from 'hono';
import type { Context } from 'hono';

import { sendRequest, toCurl, toCode, type SendOutcome } from '../core/send.ts';
import { CODE_LANGS, type CodeLang } from '../core/codegen.ts';
import { activeEnvVars, applyEnvVarChanges } from '../core/collections.ts';
import { pollUntil } from '../core/poll.ts';
import { record } from '../core/req-history.ts';
import { broadcast } from './ws.ts';
import { DEFAULT_POLL, hasChecks, type PollSettings, type RequestSpec } from '../../shared/collections.ts';

export const sendRouter = new Hono();

interface SendPayload {
  spec: RequestSpec;
  vars?: Record<string, string>;
  /** when present, stream chunks are pushed to /live under this id; a Poll
   *  reports its attempts under it too, and is cancelled by it */
  streamId?: string;
}

/** One send, as the Send button does it: the environment re-read (a script
 *  may have changed it), and whatever the scripts set written back. */
async function sendOnce(
  spec: RequestSpec,
  vars: Record<string, string> | undefined,
  files: Map<string, File[]>,
  extra: { streamId?: string; signal?: AbortSignal } = {},
): Promise<SendOutcome> {
  const envVars = { ...(await activeEnvVars()), ...(vars ?? {}) };
  const outcome = await sendRequest(spec, {
    files,
    vars: envVars,
    signal: extra.signal,
    onStreamChunk: extra.streamId
      ? (text) => broadcast({ type: 'stream:chunk', streamId: extra.streamId!, text })
      : undefined,
  });
  if (outcome.envVars) await applyEnvVarChanges(outcome.envVars);
  return outcome;
}

/** Into the history, and the response the client gets. */
async function respond(c: Context, spec: RequestSpec, outcome: SendOutcome) {
  const entry = await record(spec, outcome.sentHeaders, outcome.sentBody, outcome.result, outcome.sentUrl);
  broadcast({ type: 'req-history:appended', entry });
  return c.json({
    result: outcome.result,
    missing: outcome.missing,
    note: outcome.note,
    needsAuthorization: outcome.needsAuthorization,
    historyId: entry.id,
  });
}

async function readPayload(
  c: Context,
): Promise<{
  spec: RequestSpec;
  vars?: Record<string, string>;
  streamId?: string;
  files: Map<string, File[]>;
}> {
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
    return { spec: payload.spec, vars: payload.vars, streamId: payload.streamId, files };
  }

  const payload = (await c.req.json()) as SendPayload;
  return { spec: payload.spec, vars: payload.vars, streamId: payload.streamId, files };
}

sendRouter.post('/', async (c) => {
  let spec: RequestSpec;
  let vars: Record<string, string> | undefined;
  let streamId: string | undefined;
  let files: Map<string, File[]>;
  try {
    ({ spec, vars, streamId, files } = await readPayload(c));
  } catch (e) {
    return c.json({ error: `Bad request payload: ${e instanceof Error ? e.message : e}` }, 400);
  }
  if (!spec?.url) return c.json({ error: 'Missing url' }, 400);

  return respond(c, spec, await sendOnce(spec, vars, files, { streamId }));
});

// ─── poll ───────────────────────────────────────────────────────────────────

/** Polls in progress, by id (the client uses the tab's), so they can be cancelled. */
const polls = new Map<string, AbortController>();

/** POST /api/send/poll - resend until every check passes; same payload as a
 *  send. Attempts are reported on /live as they happen; the response is the
 *  last attempt, with the poll's summary on it. */
sendRouter.post('/poll', async (c) => {
  let spec: RequestSpec;
  let vars: Record<string, string> | undefined;
  let pollId: string | undefined;
  let files: Map<string, File[]>;
  try {
    ({ spec, vars, streamId: pollId, files } = await readPayload(c));
  } catch (e) {
    return c.json({ error: `Bad request payload: ${e instanceof Error ? e.message : e}` }, 400);
  }
  if (!spec?.url) return c.json({ error: 'Missing url' }, 400);
  if (!hasChecks(spec)) {
    return c.json(
      { error: 'Nothing to poll for: add an assertion in the Tests tab (or a test() in the post-response script).' },
      400,
    );
  }

  const settings: PollSettings = { ...DEFAULT_POLL, ...spec.settings?.poll };
  const ctrl = new AbortController();
  if (pollId) {
    polls.get(pollId)?.abort(); // a new poll from the same tab replaces the old
    polls.set(pollId, ctrl);
  }
  try {
    const { outcome, poll } = await pollUntil({
      settings,
      signal: ctrl.signal,
      send: () => sendOnce(spec, vars, files, { signal: ctrl.signal }),
      // Stopped before anything went out — an undefined {{var}}, a bad URL,
      // OAuth waiting on the browser. A network error still sent headers, and
      // is worth retrying: the service may simply not be up yet.
      fatal: (o) =>
        !!o.needsAuthorization || o.missing.length > 0 || (!!o.result.error && Object.keys(o.sentHeaders).length === 0),
      onAttempt: (attempt, nextInMs) => {
        if (pollId) broadcast({ type: 'poll:attempt', pollId, attempt, nextInMs });
      },
    });
    outcome.result.poll = poll;
    return respond(c, spec, outcome);
  } finally {
    if (pollId && polls.get(pollId) === ctrl) polls.delete(pollId);
  }
});

/** DELETE /api/send/poll/:id - stop a poll; it answers with its last attempt. */
sendRouter.delete('/poll/:id', (c) => {
  const ctrl = polls.get(c.req.param('id'));
  if (!ctrl) return c.json({ error: 'No poll running under that id' }, 404);
  ctrl.abort();
  return c.json({ ok: true });
});

/** POST /api/send/curl - render the request as a curl command. */
sendRouter.post('/curl', async (c) => {
  const payload = (await c.req.json().catch(() => ({}))) as SendPayload;
  if (!payload?.spec) return c.json({ error: 'Missing spec' }, 400);
  const vars = { ...(await activeEnvVars()), ...(payload.vars ?? {}) };
  return c.json({ curl: await toCurl(payload.spec, vars) });
});

/** POST /api/send/code - render the request as a code snippet in `lang`. */
sendRouter.post('/code', async (c) => {
  const payload = (await c.req.json().catch(() => ({}))) as SendPayload & { lang?: CodeLang };
  if (!payload?.spec) return c.json({ error: 'Missing spec' }, 400);
  const lang = payload.lang ?? 'curl';
  if (!CODE_LANGS.some((l) => l.id === lang)) return c.json({ error: `Unknown language: ${lang}` }, 400);
  const vars = { ...(await activeEnvVars()), ...(payload.vars ?? {}) };
  return c.json({ code: await toCode(payload.spec, lang, vars) });
});
