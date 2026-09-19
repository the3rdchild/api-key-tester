# 🔑 API Key Tester

![Home](docs/home.png)

Local-first web app for **testing, managing, and exporting** API keys for LLM providers, tool APIs, and object storage.

## Quick start

```bash
bun install           # first time only
bun run dev           # → http://localhost:5174
```

On first run, the parser reads `keys.md` and bootstraps `store.json` (~29 entries from the current file). Subsequent runs load from `store.json` directly.

### Production build (single port)

```bash
bun run build         # vite build → ui/dist
bun start             # → http://127.0.0.1:8788 (serves UI + API)
```

### Docker

```bash
docker compose up -d      # → http://127.0.0.1:8788 (auto-restarts on boot)
docker compose logs -f
docker compose down
```

- **Loopback only.** The port is published on `127.0.0.1` because `store.json` holds real keys and the panel has no auth. For remote access, tunnel port 8788 through the panel in `../port-forward`.
- **Data stays on the host.** The whole project dir is bind-mounted, so `store.json`, `history.jsonl`, `keys.md` and `benchmark/` are the same files you edit locally. Bun runs the TypeScript as-is, so a server code change only needs `docker compose restart` - no rebuild.
- **UI build runs at container start**, but only when `ui/dist` is missing or older than `ui/src` - so an edited UI is picked up by `docker compose restart` too.
- **`node_modules` comes from a named volume** (installed inside the image, masking the host folder). After changing `package.json`:

  ```bash
  docker compose build && docker compose up -d --force-recreate
  docker volume rm key-tester_node_modules   # only if you want a clean reinstall
  ```

- **Env overrides**: `PORT` (8788), `HOST` (must stay `0.0.0.0` inside the container), `TZ`, `KEYTESTER_MIRROR_MD=1` to mirror UI edits back into `keys.md`.

## API client

The app opens on the **API client** (the key vault is the second tab). It is the Postman/Apier replacement described in [`docs/api-client-plan.md`](docs/api-client-plan.md):

- **Request tabs** — `Alt+T` new, `Alt+W` close, `Alt+D` duplicate, so testing a GET and a POST no longer means two browser tabs
- **Fixed 3-pane layout** — collections/history sidebar, request, response; the divider is draggable and its position is remembered
- **Bodies** — JSON / text / XML / form-urlencoded / multipart with real file upload (files are picked in the browser and streamed through the server, so nothing is copied into the project)
- **Per-request settings** — timeout, follow-redirects, max redirects, cookie jar on/off
- **Cookie jar** — `Set-Cookie` is captured and replayed, so a login survives across requests
- **Variables** — `{{name}}` from the active environment, plus `{{$uuid}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}`
- **History** — last 200 requests, with `Authorization`-style headers and any vault credential redacted before they are written
- **Auth from the vault** — pick a stored key in the Auth tab and the request is signed the way that provider wants it (Bearer, `x-api-key`, Gemini's query param, a freshly minted z.ai JWT). Its non-secret fields come along as variables: `{{vault.baseURL}}`, `{{vault.model}}`
- **Chaining** — reference an earlier response anywhere: `{{res.Login.body.access_token}}`, `{{res.Login.status}}`, `{{res.Search.headers.content-type}}`. Kept in memory for the last 50 requests
- **Import cURL** — `Alt+I` (or the cURL button), paste what devtools gave you; query strings become editable params and unsupported flags are reported, not dropped
- **Copy as curl** — exactly what was sent, auth included

Everything is stored in `collections.json` at the project root. It holds **no secrets**: vault-backed auth (M2) will reference a key by id, never its value.

Other shortcuts: `Ctrl+Enter` send, `Ctrl+S` save, `Alt+L` focus the URL bar, `Alt+I` import cURL.

## What it does

- **Tests keys** via cheap probes (GET `/models`, `HeadBucket`, etc.) - costs nothing on most providers
- **Two-way file sync** - edit `keys.md` in your editor, the UI updates live; edit in the UI, the file is rewritten
- **CRUD via UI** - add/edit/delete keys with dynamic fields per provider
- **Import** - paste raw markdown / env / curl snippets, preview, then commit
- **Export** - `.md`, `.json`, `.env`, `curl` snippets, or `.csv`
- **Live updates** - WebSocket pushes test results and store changes instantly
- **History log** - `history.jsonl` keeps the last 50 results per key

## Supported providers

| Kind | Providers |
|------|-----------|
| LLM | OpenAI, DeepSeek, OpenRouter, DeepInfra, Anthropic, Gemini, Perplexity, z.ai, any OpenAI-compatible proxy |
| Tool | ElevenLabs (TTS), CORE (scientific) |
| Storage | Cloudflare R2, DigitalOcean Spaces |

## Project layout

```
key-tester/
├─ keys.md                # human-readable (editable, auto-synced)
├─ store.json             # canonical state (auto-generated, gitignored)
├─ history.jsonl          # test history (auto-generated, gitignored)
├─ shared/types.ts        # shared TypeScript types
├─ server/
│  ├─ index.ts            # Bun.serve: Hono routes + WebSocket + static
│  ├─ adapters/           # one file per provider family
│  ├─ core/               # parser, writer, store, watcher, runner
│  └─ routes/             # keys, test, export, import
├─ ui/
│  ├─ src/App.tsx         # main UI shell
│  └─ src/components/     # KeyTable, EditModal, ImportDialog, ExportMenu
└─ dev.mjs                # spawns api + vite concurrently
```

## How two-way sync works

- **`store.json`** is canonical for: `id`, `status`, `lastTestedAt`, history references
- **`keys.md`** is canonical for: `credentials`, `label`, `baseURL`, `note` (so you can edit it directly)
- The watcher debounces external file changes (300 ms) and merges them by matching `provider + apiKeyPrefix(8) + section` - status is preserved, credentials are updated
- When the server itself writes `keys.md` (via UI edit), it tags the write to prevent feedback loops

## API reference

```
GET    /api/health
GET    /api/keys                      list (filter: ?provider=&state=)
POST   /api/keys                      create
GET    /api/keys/:id
PATCH  /api/keys/:id                  update creds/label/note
DELETE /api/keys/:id
POST   /api/test/:id                  run single adapter
POST   /api/test-all                  batch (concurrency 4, 200 ms delay)
GET    /api/keys/providers            adapter metadata for dynamic forms
POST   /api/preview-import            parse text → preview (no write)
POST   /api/import                    parse + persist
GET    /api/export?format=md|json|env|curl|csv
WS     /live                          push: test:started|done, store:changed, file:changed
```

## Test methods per provider

| Provider | Probe | Cost |
|----------|-------|------|
| OpenAI / DeepSeek / OpenRouter / DeepInfra / gonka proxies | `GET /models` (fallback: 1-token chat) | 0 tokens |
| Anthropic | `GET /v1/models` with `x-api-key` | 0 tokens |
| Gemini | `GET /v1beta/models?key=…` | 0 tokens |
| Perplexity | `GET /chat/models` | 0 tokens |
| ElevenLabs | `GET /v1/user` (returns sub tier) | 0 credits |
| CORE | `GET /v3/search/works?limit=1` | 0 credits |
| z.ai | JWT-signed `GET /v1/models` | 0 tokens |
| Cloudflare R2 | `HeadBucketCommand` (AWS SDK) | n/a |
| DigitalOcean Spaces | `HeadBucketCommand` (AWS SDK) | n/a |

All probes use a 6 s timeout. Failures classify as `invalid` (401/403), `rate_limited` (429), or `error` (5xx/network).

## Extending

### Add a new OpenAI-compatible provider

No code change needed - use the "OpenAI-compatible (generic)" provider in the UI and supply `baseURL`.

### Add a new native provider

1. Create `server/adapters/<name>.ts` exporting an `Adapter` (see `native.ts` for examples)
2. Register it in `server/adapters/index.ts`
3. The UI picks it up automatically via `/api/keys/providers`

## Troubleshooting

- **WebSocket shows "offline"** - dev mode runs both processes; the API must be up for `/live` to upgrade. Check the `[api]` log.
- **Parser misses a key** - run `bun run parse` to dry-run the parser and see what it extracts. Messy formats (account/password-only sections) intentionally become `reference` entries (shown but not testable).
