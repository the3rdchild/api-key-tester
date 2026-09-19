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
| **M1** | `collections.json` + tab request + pipeline kirim (tanpa script) + form-data/upload + cookie jar | ✅ selesai — **Apier sudah bisa dicopot** |
| **M2** | Variabel + environment + chaining + auth dari vault + import cURL | ✅ selesai — setara Postman harian |
| **M3** | Sandbox QuickJS + assertion + tab Tests | ✅ selesai |
| **M4** | OAuth2 penuh (termasuk authorization_code + PKCE) | ✅ selesai |
| **M5** | Collection runner + CLI + reporter | ✅ selesai — bisa dipakai di CI |
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

## 10b. Status M1 (selesai 2026-09-19)

Yang sudah jalan dan terukur:

| Bagian | File | Bukti |
|---|---|---|
| Skema + penyimpanan koleksi | `server/core/collections.ts`, `shared/collections.ts` | folder + request + duplicate lewat REST, tulis atomik (tmp → rename) |
| Pipeline kirim | `server/core/send.ts`, `server/routes/send.ts` | JSON body 200 (12 ms), redirect 302 → 200 dengan rantai hop tercatat, timeout 600 ms berhenti di 604 ms |
| Multipart + upload file | idem | target menerima `note=catatan` + `berkas` (21 B, text/plain) |
| Cookie jar | `server/core/cookies.ts` | `Set-Cookie` tertangkap, request berikutnya mengirim `session=abc123` |
| History + redaksi | `server/core/req-history.ts` | 200 entri, `authorization` tersimpan sebagai `«redacted»` |
| Copy as curl | `toCurl()` di `send.ts` | perintah curl lengkap dengan header auth hasil interpolasi |
| UI 3 pane + tab | `ui/src/client/*` | render terverifikasi lewat screenshot headless |

Keputusan kecil yang diambil saat implementasi:

- **Belum pakai CodeMirror.** Editor body masih `textarea` monospace + tombol Format JSON. CodeMirror ditunda ke M3 (saat editor script benar-benar perlu) supaya M1 tidak menambah dependensi UI baru.
- **Shortcut pakai Alt, bukan Ctrl.** `Ctrl+T`/`Ctrl+W` milik browser dan tidak bisa dicegat dari halaman, jadi: `Alt+T` tab baru, `Alt+W` tutup, `Alt+D` duplikat, `Alt+L` fokus URL. Yang tetap Ctrl: `Ctrl+Enter` kirim, `Ctrl+S` simpan.
- **Variabel `{{...}}` sudah aktif lebih awal** (environment + `{{$uuid}}`/`{{$timestamp}}`), karena biayanya kecil dan tab Environment butuh itu. Auth dari vault tetap M2.
- **Response biner** (gambar/pdf) masih di-decode sebagai teks; preview biner menyusul.

## 10c. Status M2 (selesai 2026-09-19)

| Bagian | File | Bukti |
|---|---|---|
| Auth dari vault | `server/core/vault-auth.ts` | key DeepSeek → `Authorization: Bearer sk-60d0931d…` sampai ke target |
| Variabel dari vault | idem | `{{vault.baseURL}}/models` → 200 dari DeepSeek, daftar model kembali |
| Chaining antar request | `server/core/responses.ts` | `{{res.Login.body.query.token}}` → `abc123xyz`, `{{res.Login.status}}` → `200` |
| Import cURL | `server/core/import-curl.ts` | 4 bentuk perintah diuji: devtools JSON, `-F` + `-u` + `--max-time`, form + line-continuation + `-k`, dan `-G --data-urlencode` |
| Pesan variabel kosong | `server/core/send.ts` | `{{baseURL}}` tak terdefinisi → "Undefined variable: baseURL — set it in the Environment panel…" (bukan lagi "Invalid URL") |
| UI | `ui/src/client/*` | tombol **cURL** di tab bar (Alt+I), picker key di tab Auth, baris "chain from: …" di footer |

Skema auth per provider mengikuti adapter yang sudah ada, jadi request dari client
autentikasinya identik dengan probe di tab Vault:

| Provider | Cara |
|---|---|
| openai, deepseek, openrouter, deepinfra, openai-compat, perplexity, core | `Authorization: Bearer <apiKey>` |
| anthropic | `x-api-key` + `anthropic-version: 2023-06-01` |
| gemini | query `?key=<apiKey>` |
| elevenlabs | `xi-api-key` |
| zai | JWT HS256 baru tiap kirim (`signZAIJWT`, berlaku 1 jam) |
| cloudflare-r2, do-spaces | tidak didukung dari raw request (butuh SigV4) — panel memberi catatan, bukan diam-diam gagal |

Keputusan saat implementasi:

- **Header yang kamu tulis sendiri menang** atas header dari vault. Vault hanya mengisi yang kosong, jadi override manual tetap mungkin.
- **Field rahasia tidak pernah jadi variabel.** `{{vault.*}}` hanya membuka field non-rahasia (`baseURL`, `model`, `endpoint`, `bucket`, …); `apiKey`/`apiSecret` sengaja tidak diekspos supaya tidak ikut ke preview history.
- **Registry response untuk chaining disimpan di memori saja** (maks. 50 request terakhir). Token hasil chaining berumur pendek, dan menyimpan body response ke disk sama saja dengan menyimpan rahasia ke disk. Restart container = jalankan ulang request sumbernya.
- **`{{res.<ref>...}}` menerima nama atau id request**, dengan path bebas: `body.a.0.b`, `headers.content-type`, `status`, `latencyMs`.
- **Import cURL tidak langsung menyimpan** — hasilnya dibuka sebagai tab supaya bisa diperiksa dulu; flag yang tidak didukung jadi warning, bukan hilang diam-diam.

## 10d. Status M3 (selesai 2026-09-19)

| Bagian | File | Bukti |
|---|---|---|
| Sandbox QuickJS | `server/core/script.ts` | `fetch`, `require`, `process`, `Bun` semuanya `undefined` di dalam sandbox |
| Timeout script | idem | `while(true){}` dihentikan di 1001 ms dengan pesan "Script stopped after 1000 ms (infinite loop?)" |
| Nomor baris | idem | `throw` di baris 3 dilaporkan sebagai `script:3:16`, bukan baris kode pembungkus |
| Mutasi pre-request | `server/core/send.ts` | script mengubah method GET→POST, menambah `X-Trace`, menempel `?page=2` |
| Chaining lewat `bru.setVar` | `server/core/runtime-vars.ts` | `sockets` & `sentAt` dari script terpakai di request berikutnya (0 variabel hilang) |
| `bru.setEnvVar` persisten | `server/core/collections.ts` | ditulis balik ke environment aktif di `collections.json` |
| Assertion deklaratif | `server/core/assert.ts` | 4 assertion dijalankan: status/latency/JSON path lolos, `$.nope exists` gagal dengan actual `(missing)` |
| `test()` + `expect()` | `script.ts` | 3 test: 2 lolos, 1 sengaja gagal → "expected 418, got 200" |
| Hasil test di history | `server/core/req-history.ts` | entri tercatat `checks: 5/7`, tampil sebagai badge di sidebar |
| Editor CodeMirror 6 | `ui/src/client/CodeEditor.tsx` | body + dua editor script, nomor baris & highlight JS/JSON |

Keputusan saat implementasi:

- **QuickJS (WASM), bukan `node:vm`.** Script adalah satu-satunya tempat kode sembarang dijalankan; `node:vm` berbagi heap dengan host, sementara QuickJS punya batas memori sendiri (32 MB), interrupt handler, dan nol akses ke host. Ini juga pilihan Bruno untuk pekerjaan yang sama.
- **Urutan variabel: script (`bru.setVar`) → environment → `{{res.…}}` → `{{vault.…}}`.** Nilai yang baru saja di-set script menang atas environment — itu justru alasan orang menulis script-nya.
- **`bru.setVar` hidup di memori, `bru.setEnvVar` ditulis ke `collections.json`.** Yang pertama untuk token berumur pendek, yang kedua untuk konfigurasi.
- **Assertion tetap deklaratif**, bukan script. Tiga kolom (source/operator/value) menutup kebutuhan sehari-hari, tetap bisa di-diff di `collections.json`, dan jalan dalam mikrodetik. Script tersedia untuk yang tidak tertampung.
- **Body multipart tidak bisa diubah dari script** (byte-nya sudah dirakit sebelum script jalan) — `req.body` hanya berlaku untuk body teks.
- **Bundle UI naik dari 234 KB ke 763 KB** (gzip 249 KB) karena CodeMirror. Untuk aplikasi lokal ini tidak berarti apa-apa; kalau nanti terasa, editor bisa di-`React.lazy`.

### Catatan operasional: install dependensi

`bun install` di host **mandek** di mount NTFS ini (proses tidur, 16 MB tertulis dalam 7 menit, lockfile tak tersentuh). Solusinya: install di dalam container, yang `node_modules`-nya ada di volume Docker — selesai dalam 74 detik.

```bash
docker compose exec key-tester bun install       # setelah mengubah package.json
docker compose exec key-tester bunx tsc --noEmit # typecheck ikut di container
```

Konsekuensinya: `node_modules` di host tertinggal (tidak punya `quickjs-emscripten` maupun CodeMirror), jadi `bun run dev` dari host tidak akan jalan sampai install host berhasil. Mode container tetap penuh.

## 10e. Status M4 (selesai 2026-09-19)

Diuji lawan mock provider OAuth2 (`scratchpad/oauth-mock.ts`: `/authorize`, `/token`,
`/device`, `/me`) yang memvalidasi client secret, `redirect_uri`, dan PKCE sungguhan.

| Skenario | Hasil |
|---|---|
| `client_credentials` | token 3600 s, request ke `/me` → 200 (`sub: service`) |
| `password` (token 30 s) | token disegarkan otomatis **sebelum** kirim: `at_1…3vqs` → `at_1…ig9c`, provider menerima token baru, expiry jadi 3600 s |
| `authorization_code` + PKCE | URL otorisasi membawa `code_challenge` + `code_challenge_method=S256`; callback menukar code (server memverifikasi verifier) → 200 (`sub: budi`) |
| `implicit` | diuji lewat Firefox headless sungguhan: fragment `#access_token=…` dibaca JS di halaman callback lalu dikirim balik → token tersimpan (tanpa refresh token, sesuai sifatnya) |
| `refresh_token` (ditempel manual) | token baru terbit, request → 200 |
| `device_code` | poll #1 `authorization_pending`, poll #2 token terbit, request → 200 |
| Belum punya token | request **tidak dikirim**; balasannya "No token yet - click Authorize in the Auth tab" + flag `needsAuthorization` |
| Client secret salah | "Token endpoint said 401: invalid_client" |

Keputusan saat implementasi:

- **Token disimpan di `oauth-tokens.json`, bukan di `store.json`** seperti rencana awal. Alasannya: `store.json` dicerminkan ke `keys.md` lewat parser/writer, dan menempelkan bagian yang tidak berhubungan ke sana berisiko merusak sinkronisasi dua arah. Token itu artefak runtime — tempatnya sebelah `cookies.json`.
- **`collections.json` tetap bebas rahasia.** Yang tersimpan di koleksi hanya konfigurasi (endpoint, client id, scope); tokennya di file terpisah yang di-gitignore. Client secret memang ikut di konfigurasi — pakai `{{vars}}` kalau koleksinya mau dibagikan.
- **Cache key token diturunkan dari grant + endpoint + client id + scope + username**, jadi dua request dengan client yang sama berbagi satu token (dan satu refresh). Bisa dipaksa pisah lewat `tokenId`.
- **Refresh 60 detik sebelum kedaluwarsa**, memakai refresh token bila ada; kalau tidak ada, grant yang bisa jalan sendiri (client_credentials/password) dijalankan ulang. Kalau tetap tidak bisa, request ditolak dengan alasan — bukan dikirim untuk dijawab 401.
- **PKCE menyala secara default** untuk authorization_code; `code_verifier` disimpan di memori bersama `state` dan kedaluwarsa dalam 10 menit.
- **Halaman callback melayani dua kasus**: `?code=` ditukar di server, sedangkan implicit (`#access_token=`) tidak pernah sampai ke server sehingga halaman itu sendiri yang mengirimkannya balik lewat `/api/oauth/implicit`.
- **Header `Authorization` tulisan tangan tetap menang** atas token OAuth2 — aturan yang sama seperti vault.

## 10f. Status M5 (selesai 2026-09-19)

| Bagian | File | Bukti |
|---|---|---|
| Runner berurutan | `server/core/collection-runner.ts` | folder 5 request jalan berurutan, hasil per request + per assertion |
| Variabel mengalir di dalam run | idem | request ke-2 memakai `{{socketCount}}` yang di-set script request ke-1; dibuktikan lewat echo server: `$.query.token` cocok `^[0-9]+$`, bukan string `{{socketCount}}` |
| Progress langsung | `server/routes/runner.ts` + WS | `run:started` → 5× `run:item` → `run:done` diterima klien saat run berjalan |
| Cancel & stop-on-failure | `collection-runner.ts` | sisa request ditandai `skipped`, bukan dihapus dari laporan |
| CLI | `scripts/run.ts` | `bun scripts/run.ts Smoke` → laporan rapi; `--bail` keluar dengan **exit code 1** saat ada yang gagal |
| Reporter JUnit | idem | XML valid: `<testsuites tests="5" failures="1">` dengan `<failure message="latencyMs lt 0 — actual: 0">` |
| UI Runner | `ui/src/client/RunnerView.tsx` | tab ketiga di shell: pilih folder/environment/delay, ringkasan lulus-gagal, detail check yang gagal, tombol "Rerun N failed" |

Keputusan saat implementasi:

- **Berurutan, bukan paralel.** Satu run biasanya sebuah alur (login dulu, baru pakai tokennya), dan chaining hanya bermakna kalau urutannya terjaga. Paralel menukar properti yang justru jadi alasan runner ini ada dengan sedikit kecepatan.
- **Request dari runner tidak masuk `requests-history.jsonl`.** Satu run folder berisi 30 request akan menggusur seluruh history manual yang cuma menyimpan 200 entri.
- **Kriteria lulus:** tidak ada error transport, script tidak melempar, dan semua check hijau. Kalau request tidak punya assertion sama sekali, status HTTP non-2xx dihitung gagal — kalau kamu memang mengharapkan 404, tulis assertion-nya.
- **CLI berdiri sendiri**, membaca `collections.json` langsung tanpa server. Jadi bisa dipanggil di CI tanpa menyalakan panel: `docker compose exec key-tester bun scripts/run.ts Smoke --bail`.
- **Nilai assertion sekarang ikut diinterpolasi** (`$.user.id eq {{expectedId}}`). Celah ini ketahuan waktu menulis fixture runner — sebelumnya hanya URL/header/body yang kena interpolasi.

Folder contoh `Smoke` ditinggal di `collections.json` (3 request, lulus semua) sebagai titik awal.

## 11. Yang masih terbuka

1. **Nama produk** — repo masih `key-tester`, padahal vault cuma satu tab.
2. **Upload file**: cukup lewat file picker browser (byte dikirim ke server), atau perlu juga referensi path host (butuh mount seperti `../local-web-player`)?
3. **Nasib `keys.md`**: dipertahankan dengan sinkronisasi dua arah (parser 35 KB + writer + watcher), atau dipensiunkan jadi import/export saja?
