# 🔑 API Key Tester

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
