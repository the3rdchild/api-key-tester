# 🧪 Rencana Pivot — dari Key Tester ke API Client

> **Tujuan:** menjadikan project ini API client lokal pengganti Postman (dan pengganti ekstensi Apier di Zen), dengan vault key yang sudah ada sebagai fitur pendukung — bukan sebaliknya.

Tanggal dibuat: 2026-09-19

---

## 1. Keputusan yang sudah dikunci

| Topik | Keputusan |
|---|---|
| Posisi produk | Request-first. Key vault jadi satu tab, bukan pusat aplikasi |
| Target | Pengganti Postman penuh — koleksi, environment, scripting, OAuth2, runner |
| Penyimpanan koleksi | `collections.json` tunggal di root project |
| Secret | **Tidak pernah** disimpan di `collections.json`; hanya referensi `keyId` ke `store.json` |
| Scripting | JS penuh (pre-request + post-response) di sandbox QuickJS |
| OAuth2 | Semua grant utama, termasuk `authorization_code` + PKCE + refresh |
| Runner | Jalankan folder/koleksi berurutan + mode CLI untuk CI |
| Layout | Selalu tab penuh (tidak perlu mode sidebar sempit) |
| History | 200 entri terakhir, header sensitif diredaksi, body dipotong |
| Jaringan Docker | `network_mode: host` — wajib supaya `localhost:3000` dst. bisa diuji |

### Tiga keluhan Apier yang jadi acceptance criteria

1. **"UI placement tidak pas"** → 3 pane tetap; baris `method + URL + Send` tidak pernah bergeser; response hanya mengisi pane-nya sendiri; ukuran splitter diingat.
2. **"Klik apa, malah mark apa"** → semua kontrol pakai primitive beraksesibilitas (Radix/shadcn), `<label for>` benar, tinggi baris ≥ 32 px, satu target klik per sel, focus ring eksplisit, checkbox "enabled" tidak berbagi area klik dengan baris.
3. **"Harus buka 2 tab URL untuk POST dan GET"** → tab request ala browser: `Ctrl+T` baru, `Ctrl+W` tutup, `Ctrl+D` duplikat (GET → duplikat → ubah jadi POST), tiap tab menyimpan response sendiri, plus split view untuk membandingkan dua response.

---

## 2. Skema `collections.json` (v1)

```jsonc
{
  "version": 1,
  "activeEnvId": "env_local",
  "environments": [
    {
      "id": "env_local",
      "name": "Local dev",
      "vars": { "baseURL": "http://localhost:3000", "model": "deepseek-chat" },
      // referensi ke vault - bukan nilai key-nya
      "keyRefs": { "llm": "l9F7gxik7iQe" }
    }
  ],
  "tree": [
    { "id": "f_auth", "type": "folder", "name": "Auth", "children": ["r_login", "r_me"] },
    { "id": "r_chat", "type": "request" }
  ],
  "requests": {
    "r_login": {
      "name": "Login",
      "method": "POST",
      "url": "{{baseURL}}/auth/login",
      "params":  [{ "key": "verbose", "value": "1", "enabled": false }],
      "headers": [{ "key": "Content-Type", "value": "application/json", "enabled": true }],
      "auth":    { "type": "none" },
      "body":    { "mode": "json", "json": "{\n  \"email\": \"{{email}}\"\n}" },
      "settings": { "timeoutMs": 30000, "followRedirects": true, "maxRedirects": 5 },
      "scripts": { "pre": "", "post": "bru.setVar('token', res.body.access_token)" },
      "assertions": [
        { "source": "status",            "op": "eq",     "value": 200 },
        { "source": "$.access_token",    "op": "exists" },
        { "source": "latencyMs",         "op": "lt",     "value": 2000 }
      ]
    },
    "r_chat": {
      "name": "Chat completion",
      "method": "POST",
      "url": "{{llm.baseURL}}/chat/completions",
      // auth diambil dari vault: header/scheme mengikuti adapter provider
      "auth": { "type": "vault", "keyId": "{{env.keyRefs.llm}}" },
      "body": { "mode": "json", "json": "{ \"model\": \"{{model}}\", \"stream\": true }" }
    }
  }
}
```

**Mode body yang didukung:** `none | json | text | xml | form-urlencoded | multipart | binary | graphql`.
Multipart menyimpan `[{ field, filename, size, blobId }]` — byte-nya diunggah dari browser, bukan path host (lihat §9).

**Urutan resolusi variabel** (yang pertama ketemu menang):
`runtime (set dari script) → environment aktif → variabel koleksi → vault (keyId → credentials)`.

**Chaining antar request:** `{{res.r_login.body.access_token}}` atau via script `bru.setVar()`.

---

## 3. Perubahan di `server/`

| File | Status | Isi |
|---|---|---|
| `routes/send.ts` | **baru** (gantikan `routes/raw.ts`) | pipeline kirim: interpolasi → script pre → auth → fetch → script post → assertion → history |
| `core/collections.ts` | baru | load/save `collections.json`, tulis atomik, broadcast `collections:changed` lewat WS |
| `core/vars.ts` | baru | interpolasi `{{...}}`, resolusi berlapis, deteksi variabel tidak terdefinisi |
| `core/script.ts` | baru | sandbox QuickJS + permukaan API `bru.*` (§4) |
| `core/oauth2.ts` | baru | grant + cache token + auto-refresh (§5) |
| `routes/oauth.ts` | baru | `GET /oauth/callback` (authorization_code + PKCE) |
| `core/assert.ts` | baru | evaluasi assertion deklaratif (JSONPath + operator) |
| `core/collection-runner.ts` | baru | jalankan folder berurutan, kumpulkan hasil, progress lewat WS |
| `core/history.ts` | baru (pecahan dari `store.ts`) | retensi 200 entri, redaksi header, potong body |
| `core/cookies.ts` | baru | cookie jar per-environment |
| `scripts/run.ts` | baru | CLI: `bun run collections run <folder> --env local --reporter junit` |
| `core/store.ts` | ubah | tetap jadi vault; fungsi history dipindah keluar |
| `adapters/*` | tetap | dipakai untuk auth `type: "vault"` + kolom kuota nanti |

Yang **tidak** berubah: `Bun.serve` + Hono + WS `/live` di [`server/index.ts`](../server/index.ts) — arsitekturnya sudah pas.

### Kemampuan HTTP yang harus ditambah di pipeline kirim

Saat ini [`routes/raw.ts`](../server/routes/raw.ts) hanya menerima `body: string`, timeout hardcoded 30 detik, dan selalu `redirect: 'follow'`. Yang perlu masuk:

- `multipart/form-data` + upload file, `x-www-form-urlencoded`, body biner
- timeout & follow-redirect per request, batas jumlah redirect
- cookie jar (kirim + tangkap `Set-Cookie`)
- **streaming SSE** diteruskan lewat WS `/live` → sekalian metrik TTFT dan token/detik
- response besar ditulis ke file sementara, bukan ditahan di memori (cap sekarang 256 KB)
- ukuran, waktu per fase (DNS/TLS/TTFB), dan status redirect chain

---

## 4. Sandbox scripting

**Mesin: `quickjs-emscripten`** (WASM, versi 0.32.0). Alasan: itu yang dipakai Bruno, tidak butuh kompilasi native, aman dijalankan di image Bun slim. `node:vm` bawaan Bun sudah diuji jalan (`vm.runInContext` → OK), tapi ia bukan isolasi sungguhan; dipakai hanya sebagai fallback kalau QuickJS bermasalah. Hoppscotch memakai `isolated-vm` + `faraday-cage` — ditolak karena native build.

Permukaan API (mirip `pm.*`, tapi lebih ringkas):

```js
// pre-request
bru.getVar(k) / bru.setVar(k, v)          // variabel runtime
bru.getEnvVar(k) / bru.setEnvVar(k, v)    // environment aktif (persist)
bru.vault(keyId)                          // ambil kredensial dari vault
req.method / req.url / req.headers / req.body   // bisa dimutasi

// post-response
res.status / res.headers / res.body / res.latencyMs / res.size
test('nama', () => expect(res.status).to.equal(200))
```

Batas: timeout eksekusi 5 detik, tanpa akses filesystem, `fetch` hanya lewat host yang diizinkan (opsional).

---

## 5. OAuth2

Grant yang didukung: `client_credentials`, `password`, `authorization_code` (+ **PKCE**), `implicit`, `refresh_token`, plus `device_code` kalau sempat.

- Callback: `http://127.0.0.1:8788/oauth/callback` — aman karena container memakai network host dan panel bind ke loopback.
- Token disimpan di `store.json` bagian `oauth` (terpisah dari koleksi), dengan `expiresAt`; refresh otomatis saat tinggal < 60 detik.
- Alur authorization_code: panel buka URL provider di browser → provider redirect ke callback → server tukar `code` → token masuk cache → tab request yang menunggu langsung dapat token lewat WS.

---

## 6. Runner + CLI

- **UI:** pilih folder → jalankan berurutan → tabel pass/fail per request + per assertion, dengan waktu total dan tombol "rerun yang gagal".
- **CLI:** `bun run collections run Auth --env local --reporter junit --out report.xml`, exit code ≠ 0 kalau ada yang gagal — bisa dipanggil dari CI atau cron di container.
- Variabel antar request otomatis mengalir (chaining `{{res.<id>...}}` + `bru.setVar`).

---

## 7. Perubahan di `ui/`

Layout tetap (tab penuh):

```
┌────────────┬──────────────────────────────┬───────────────────────────┐
│ Collections│  [GET ▾][ {{baseURL}}/users ][Send]                      │
│  + History │  Params | Headers | Body | Auth | Scripts | Tests        │
│            │  (editor CodeMirror 6)       │  Response: 200 · 143ms    │
│            │                              │  Body | Headers | Cookies │
└────────────┴──────────────────────────────┴───────────────────────────┘
        ↑ tab request di atas: [Login ×][Chat ×][+]
```

- **Editor:** CodeMirror 6 (JSON/JS/XML, lipat baris, format, cari) — sama seperti Bruno & Hoppscotch.
- **Kontrol form:** shadcn/ui + Radix, supaya bug "klik apa mark apa" hilang di level primitive.
- **Komponen baru:** `Sidebar` (tree koleksi + history), `RequestTabs`, `RequestPane`, `ResponsePane`, `EnvSwitcher`, `RunnerPanel`, `CommandPalette`.
- **Komponen lama yang dipertahankan:** `KeyTable`, `EditModal`, `ImportDialog`, `ExportMenu`, `StatusBadge`, `MaskedKey` → pindah ke tab **Vault**.
- **Shortcut:** `Ctrl+T/W/D` tab, `Ctrl+Enter` kirim, `Ctrl+S` simpan, `Ctrl+K` command palette, `Ctrl+L` fokus ke URL.

---

## 8. History & keamanan

- Simpan **200 entri terakhir** (global, bukan per key), body dipotong 64 KB, sisanya ditulis ke file kalau diminta.
- Redaksi otomatis sebelum menulis: `Authorization`, `x-api-key`, `api-key`, `cookie`, `set-cookie`, dan nilai yang persis sama dengan kredensial di vault.
- `collections.json` aman dibagikan: hanya berisi referensi `keyId`, tidak pernah nilai key.
- Panel tetap tanpa auth dan **bind ke `127.0.0.1` saja**. Kalau suatu saat ditunnel lewat `../port-forward`, tambahkan dulu token (`KEYTESTER_TOKEN`).

---

## 9. Milestone

| # | Isi | Hasil yang bisa dipakai |
|---|---|---|
| **M0** | Infra: `network_mode: host`, `ref/` diabaikan git & docker | ✅ selesai — `localhost:3000` sudah bisa diuji dari container |
| **M1** | `collections.json` + tab request + pipeline kirim (tanpa script) + form-data/upload + cookie jar | **Apier sudah bisa dicopot** |
| **M2** | Variabel + environment + chaining + auth dari vault + import cURL | Setara Postman harian |
| **M3** | Sandbox QuickJS + assertion + tab Tests | |
| **M4** | OAuth2 penuh (termasuk authorization_code + PKCE) | |
| **M5** | Collection runner + CLI + reporter | Bisa dipakai di CI |
| **M6** | Khas LLM: streaming SSE + token/detik, matrix run lintas key, kolom kuota | Yang tidak dimiliki Postman |
| **M7** | Import Postman v2.1 / Insomnia / OpenAPI | Migrasi koleksi kantor |

---

## 10. Referensi di `ref/` (read-only, di-gitignore)

| Repo | Lisensi | Dipakai untuk |
|---|---|---|
| `ref/bruno` (sparse: `bruno-js`, `bruno-converters`, `bruno-cli`, `bruno-common`, `bruno-app/src`) | MIT | Acuan sandbox QuickJS, importer Postman/Insomnia/OpenAPI, struktur CLI runner, pola UI React |
| `ref/hoppscotch` (sparse: `hoppscotch-js-sandbox`, `hoppscotch-data`) | MIT | Acuan skema auth/koleksi berversi (Zod) dan desain permukaan API sandbox |

Keduanya **acuan baca**, bukan dependensi. Kode yang benar-benar disalin harus dicatat asal + lisensinya di file terkait.

---

## 11. Yang masih terbuka

1. **Nama produk** — repo masih `key-tester`, padahal vault cuma satu tab.
2. **Upload file**: cukup lewat file picker browser (byte dikirim ke server), atau perlu juga referensi path host (butuh mount seperti `../local-web-player`)?
3. **Nasib `keys.md`**: dipertahankan dengan sinkronisasi dua arah (parser 35 KB + writer + watcher), atau dipensiunkan jadi import/export saja?
