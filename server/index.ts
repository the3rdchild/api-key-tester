// Bun-native HTTP + WebSocket server.
// - HTTP routes via Hono's `fetch` handler
// - WebSocket upgrade on /live via Bun.serve's websocket option
// - Serves built UI from ui/dist in production

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { ServerWebSocket, WebSocketHandler } from 'bun';

import { keysRouter } from './routes/keys.ts';
import { testRouter } from './routes/test.ts';
import { exportRouter } from './routes/export.ts';
import { importRouter, previewImportHandler } from './routes/import.ts';
import { rawRouter } from './routes/raw.ts';
import { addSocket, broadcast, socketCount } from './routes/ws.ts';
import { isMirrorEnabled, loadStore, setChangeEmitter, setMarkSelfWriteHook } from './core/store.ts';
import { markSelfWrite, setExternalChangeListener, startWatcher } from './core/watcher.ts';
import { runAll, type RunAllOptions } from './core/runner.ts';
import type { WSEvent } from '../shared/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');
const UI_DIST = resolve(ROOT_DIR, 'ui', 'dist');

const app = new Hono();

// CORS (allow Vite dev server origin)
app.use('*', cors({ origin: ['http://localhost:5174', 'http://127.0.0.1:5174'] }));

app.get('/api/health', (c) =>
  c.json({ ok: true, ts: new Date().toISOString(), sockets: socketCount() }),
);

// Standalone routes at /api root (must be registered before the catch-all
// app.get('*') static handler; Hono matches GET vs POST by method so order
// matters less, but explicit is better than implicit).
app.post('/api/preview-import', previewImportHandler);

app.route('/api/keys', keysRouter);
app.route('/api/test', testRouter);
app.route('/api/export', exportRouter);
app.route('/api/import', importRouter);
app.route('/api/raw', rawRouter);

// POST /api/test-all - batch (lives at root /api because testRouter is mounted
// at /api/test; keeping this separate avoids a /:id collision).
app.post('/api/test-all', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<RunAllOptions>;
  const result = await runAll(
    {
      concurrency: body.concurrency ?? 4,
      delayMs: body.delayMs ?? 200,
      providers: body.providers,
      states: body.states,
    },
    {
      onStart: (keyId) => broadcast({ type: 'test:started', keyId } satisfies WSEvent),
      onDone: (keyId, status) => broadcast({ type: 'test:done', keyId, status } satisfies WSEvent),
    },
  );
  return c.json(result);
});

// ─── store change emitter → broadcast to WS clients ─────────────────────────
setChangeEmitter(() => {
  // fan-out a store snapshot to all WS clients (throttled inline)
  loadStore()
    .then((keys) => broadcast({ type: 'store:changed', keys } satisfies WSEvent))
    .catch((e) => console.warn('[ws] store:changed broadcast failed:', e));
});

setExternalChangeListener((path) => {
  broadcast({ type: 'file:changed', path } satisfies WSEvent);
  loadStore()
    .then((keys) => broadcast({ type: 'store:changed', keys } satisfies WSEvent))
    .catch(() => {});
});

// Mark our own writes so the watcher ignores them (loop prevention)
setMarkSelfWriteHook(markSelfWrite);

// ─── Static UI serving (production) ─────────────────────────────────────────
app.get('*', async (c) => {
  // try to serve the file from ui/dist
  const url = new URL(c.req.url);
  let pathname = url.pathname;
  if (pathname === '/') pathname = '/index.html';
  // SPA fallback: any non-API, non-file path → index.html
  const candidate = resolve(UI_DIST, '.' + pathname);
  if (existsSync(candidate) && !candidate.endsWith('.html')) {
    const data = await readFile(candidate);
    const mime = guessMime(candidate);
    return new Response(data, { headers: { 'Content-Type': mime } });
  }
  const indexPath = resolve(UI_DIST, 'index.html');
  if (existsSync(indexPath)) {
    return new Response(await readFile(indexPath), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  return c.text('UI not built. Run `bun run build` or use `bun run dev`.', 404);
});

function guessMime(path: string): string {
  if (path.endsWith('.js')) return 'text/javascript';
  if (path.endsWith('.css')) return 'text/css';
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.ico')) return 'image/x-icon';
  return 'application/octet-stream';
}

// ─── Boot ────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 8788);
const HOST = process.env.HOST ?? '127.0.0.1';

await loadStore();
startWatcher();

const server = Bun.serve<undefined>({
  port: PORT,
  hostname: HOST,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === '/live') {
      const ok = server.upgrade(req, { data: undefined });
      if (ok) return undefined;
      return new Response('Upgrade failed', { status: 400 });
    }
    return app.fetch(req);
  },
  websocket: {
    open(ws) {
      const unsub = addSocket({
        send: (data) => ws.send(data),
        close: () => ws.close(),
      });
      (ws as unknown as { _unsub?: () => void })._unsub = unsub;
      ws.send(JSON.stringify({ type: 'hello', ts: new Date().toISOString() }));
    },
    close(ws: ServerWebSocket<unknown>) {
      (ws as unknown as { _unsub?: () => void })._unsub?.();
    },
    message() {
      // ignore client messages; this is a push-only channel
    },
  },
});

console.log(`\n  key-tester → http://${HOST}:${PORT}`);
console.log(`  UI (dev)   → http://localhost:5174`);
console.log(`  WebSocket  → ws://${HOST}:${PORT}/live`);
console.log(
  `  keys.md    → ${isMirrorEnabled() ? 'mirrored (UI edits rewrite file)' : 'read-only (use Export to write)'}\n`,
);

process.on('SIGINT', () => {
  server.stop();
  process.exit(0);
});
