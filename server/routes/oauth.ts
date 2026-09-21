// OAuth2 endpoints: start a flow, run a grant, inspect or drop cached tokens,
// and receive the provider's redirect.
//
// The redirect lands on /oauth/callback (not /api/...) because that is the URL
// you register with the provider - short, stable, and the same one the Auth tab
// shows you to copy.

import { Hono } from 'hono';

import {
  DEFAULT_REDIRECT_URI,
  clearToken,
  completeAuthorization,
  completeImplicit,
  describe,
  getStoredToken,
  listTokens,
  pollDeviceToken,
  runGrant,
  startAuthorization,
  startDeviceFlow,
  tokenIdFor,
} from '../core/oauth2.ts';
import type { OAuth2Config } from '../../shared/collections.ts';

export const oauthApiRouter = new Hono();
export const oauthCallbackRouter = new Hono();

const fail = (e: unknown) => (e instanceof Error ? e.message : String(e));

oauthApiRouter.get('/redirect-uri', (c) => c.json({ redirectUri: DEFAULT_REDIRECT_URI }));

oauthApiRouter.get('/tokens', async (c) => c.json(await listTokens()));

oauthApiRouter.delete('/tokens/:id', async (c) => {
  await clearToken(c.req.param('id'));
  return c.json({ ok: true });
});

/** POST /api/oauth/status - is there a usable token for this config? */
oauthApiRouter.post('/status', async (c) => {
  const { config } = (await c.req.json()) as { config: OAuth2Config };
  if (!config) return c.json({ error: 'Missing config' }, 400);
  const id = tokenIdFor(config);
  const token = await getStoredToken(id);
  return c.json({ id, token: token ? describe(token) : null });
});

/** POST /api/oauth/token - run a grant that needs no browser. */
oauthApiRouter.post('/token', async (c) => {
  const { config } = (await c.req.json()) as { config: OAuth2Config };
  if (!config) return c.json({ error: 'Missing config' }, 400);
  try {
    return c.json({ token: describe(await runGrant(config)) });
  } catch (e) {
    return c.json({ error: fail(e) }, 400);
  }
});

/** POST /api/oauth/authorize - build the URL the browser must visit. */
oauthApiRouter.post('/authorize', async (c) => {
  const { config } = (await c.req.json()) as { config: OAuth2Config };
  if (!config) return c.json({ error: 'Missing config' }, 400);
  try {
    return c.json(await startAuthorization(config));
  } catch (e) {
    return c.json({ error: fail(e) }, 400);
  }
});

/** POST /api/oauth/implicit - the callback page posts the URL fragment here. */
oauthApiRouter.post('/implicit', async (c) => {
  const { state, params } = (await c.req.json()) as {
    state: string;
    params: Record<string, string>;
  };
  try {
    return c.json({ token: describe(await completeImplicit(state, params ?? {})) });
  } catch (e) {
    return c.json({ error: fail(e) }, 400);
  }
});

oauthApiRouter.post('/device/start', async (c) => {
  const { config } = (await c.req.json()) as { config: OAuth2Config };
  try {
    return c.json(await startDeviceFlow(config));
  } catch (e) {
    return c.json({ error: fail(e) }, 400);
  }
});

oauthApiRouter.post('/device/poll', async (c) => {
  const { config, deviceCode } = (await c.req.json()) as {
    config: OAuth2Config;
    deviceCode: string;
  };
  try {
    const token = await pollDeviceToken(config, deviceCode);
    return c.json(token ? { token: describe(token) } : { pending: true });
  } catch (e) {
    return c.json({ error: fail(e) }, 400);
  }
});

// ─── the provider's redirect ────────────────────────────────────────────────

function page(title: string, message: string, tone: 'ok' | 'bad', extraScript = ''): string {
  const color = tone === 'ok' ? '#059669' : '#dc2626';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font: 14px/1.6 system-ui, sans-serif; margin: 0; display: grid; place-items: center;
         height: 100vh; background: #f8fafc; color: #0f172a; }
  .card { background: #fff; border-radius: 12px; padding: 28px 32px; box-shadow: 0 10px 30px rgba(15,23,42,.08); max-width: 28rem; }
  h1 { font-size: 16px; margin: 0 0 8px; color: ${color}; }
  p { margin: 0; color: #475569; }
  code { background: #f1f5f9; padding: 1px 4px; border-radius: 4px; }
</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div>
<script>${extraScript}</script></body></html>`;
}

oauthCallbackRouter.get('/callback', async (c) => {
  const url = new URL(c.req.url);
  const error = url.searchParams.get('error');
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');

  if (error) {
    const detail = url.searchParams.get('error_description') || error;
    return c.html(page('Authorization failed', detail, 'bad'));
  }

  // Implicit grant: the token is in the fragment, which never reaches the
  // server - the page has to send it back itself.
  if (!code) {
    return c.html(
      page(
        'Finishing…',
        'Reading the token from the redirect fragment.',
        'ok',
        `
        (async () => {
          const hash = new URLSearchParams(location.hash.slice(1));
          const params = Object.fromEntries(hash.entries());
          const state = params.state || ${JSON.stringify(state ?? '')};
          if (!params.access_token) {
            document.querySelector('h1').textContent = 'Nothing to finish';
            document.querySelector('p').textContent = 'No code and no access_token in this redirect.';
            return;
          }
          const res = await fetch('/api/oauth/implicit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state, params }),
          });
          const body = await res.json();
          document.querySelector('h1').textContent = res.ok ? 'Token received' : 'Authorization failed';
          document.querySelector('p').textContent = res.ok
            ? 'You can close this tab and go back to Keyway.'
            : (body.error || 'Unknown error');
        })();
      `,
      ),
    );
  }

  if (!state) return c.html(page('Authorization failed', 'The provider sent no state.', 'bad'));

  try {
    await completeAuthorization(state, code);
    return c.html(
      page(
        'Token received',
        'You can close this tab and go back to Keyway — the request is ready to send.',
        'ok',
        'setTimeout(() => window.close(), 1500);',
      ),
    );
  } catch (e) {
    return c.html(page('Authorization failed', fail(e), 'bad'));
  }
});
