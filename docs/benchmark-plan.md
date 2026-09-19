# 📊 LLM Benchmark Plan — Reacteev RND

> **Tujuan:** Mengisi kolom skor (0–1) di `List of LLM Models.xlsx` untuk ~190 model, memakai metodologi di `benchmark.xlsx`, lalu menghasilkan **ranking + model→use-case matching** untuk produk Reacteev.

Tanggal dibuat: 2026-07-29

---

## 1. Snapshot dari 2 file acuan

### `benchmark.xlsx` — METODOLOGI (template)
Berisi 6 sheet:

| Sheet | Isi |
|-------|-----|
| README | Penjelasan 3 metode A/B/C + aturan skor 0–1 |
| Categories | **12 kategori** benchmark + dataset publik + use-case Reacteev + metode rekomendasi |
| A. Public Lookup | Metode A — ambil skor dari leaderboard publik (gratis) |
| B. API Auto-Eval | Metode B — test sendiri via API, auto-score (exact-match / LLM-judge) |
| C. Manual Eval | Metode C — human eval pakai rubrik 0–1 |
| Summary | Agregasi skor final per model per kategori → ranking |

**12 Kategori** (dengan metode & dataset rekomendasi):

| # | Kategori | Metode | Dataset acuan | Prioritas Reacteev |
|---|----------|--------|---------------|--------------------|
| 1 | Academic Q | A/B | MMLU-Pro | High |
| 2 | Research Paper | B/C | dataset sendiri (CORE/Unpaywall) | **High** ⭐ |
| 3 | Code | A/B | HumanEval, MBPP, SWE-Bench | High |
| 4 | General Chatting | A | LMArena Elo | Low |
| 5 | Medical Q | A/B | MedQA, MedMCQA | High (high-risk) |
| 6 | Reasoning | A/B | GPQA Diamond | High |
| 7 | Math | A/B | GSM8K, MATH | High |
| 8 | Long-context | B | NIAH / RULER | Medium |
| 9 | Multilingual | B | MGSM, IndoMMLU ⭐ | Medium |
| 10 | Function Calling | A/B | BFCL | High |
| 11 | Agentic | B/C | GAIA, τ-bench | Very High (mahal) |
| 12 | Instruction Following + Safety | A/C | IFEval, HarmBench | Medium |

**Aturan skor:** semua dinormalisasi ke **0–1** (`skor / max`, Elo → min-max, rubrik langsung 0/0.25/0.5/0.75/1.0).

### `List of LLM Models.xlsx` — KATALOG MODEL (data yang mau diisi)
Berisi **190 model** di 4 tier harga + 14 tool cost-reduction:

| Sheet | Jumlah model |
|-------|--------------|
| `<=0.5$` | 56 |
| `<=1$` | 21 |
| `<=5$` | 61 |
| `high end` | 52 |
| **Total model** | **190** |

Top provider: OpenAI (23), Mistral (19), Alibaba (34), Anthropic (15), Google (16), xAI (10), ZAI (9), Cohere (8), MiniMax (7), Moonshot (7), DeepSeek (4), Perplexity (4), Meta (8), NVIDIA (3).

⚠️ **GAP:** katalog hanya punya **5 kolom skor** (`Academic Q`, `Research Paper`, `Code`, `General Chatting`, `Medical Q`) — padahal metodologi mendefinisikan 12 kategori. 7 kategori (Reasoning, Math, Long-context, Multilingual, Function Calling, Agentic, IFEval) belum ada kolomnya.

---

## 2. Koneksi ke project `key-tester`

Project ini **sudah punya infrastruktur** yang relevan untuk **Metode B (API Auto-Eval)**:

- ✅ Adapters untuk: `openai`, `deepseek`, `openrouter`, `deepinfra`, `anthropic`, `gemini`, `perplexity`, `zai` (+ storage & tool)
- ✅ Keys terkelola di `keys.md` / `store.json`
- ✅ Test runner dengan concurrency + timeout + klasifikasi status
- ✅ WebSocket untuk live progress, history log per key

**⚠️ Coverage gap provider:** katalog punya model dari provider yang **belum** ada adapter-nya:
`Mistral`, `Alibaba/Qwen`, `Cohere`, `MiniMax`, `Moonshot`, `xAI/Grok`, `IBM`, `Reka`, `Meta`, `NVIDIA`, `Amazon Bedrock`, `AI21`.

**Solusi:** `OpenRouter` & `DeepInfra` adalah **gateway agregator** — satu key bisa test puluhan model. Banyak model di katalog (Qwen, Mistral, Meta, dll.) tersedia via OpenRouter. Jadi 1–2 key OpenRouter + DeepInfra menutup sebagian besar gap tanpa bikin adapter per-provider.

---

## 3. Strategi bertingkat (kenapa nggak test semua 190 model via API)

Test 190 model × ~500 soal × ~12 kategori via API = **puluh ribu request → ratusan dolar**. Maka pakai funnel:

```
190 model
  └─ Phase 1 (Metode A, gratis)  →  screening, sisihkan top ~30
       └─ Phase 2 (Metode B, API) →  shortlist ~30, biaya terkontrol
            └─ Phase 3 (Metode C, manual) →  final ~8 model untuk use-case Reacteev
```

---

## 4. Rencana per fase

### Phase 0 — Setup (est. 0,5 hari)
- [ ] Pastikan key aktif untuk: OpenAI, Anthropic, Gemini, DeepSeek, OpenRouter, z.ai (cek via UI key-tester → "Test all")
- [ ] Dapatkan/validasi key **OpenRouter** & **DeepInfra** (penting untuk coverage model non-native)
- [ ] Tentukan **budget API** (usulan awal: **$80–150**) — lihat estimasi Phase 2
- [ ] Putuskan: apakah katalog ditambah 7 kolom kategori lagi, atau fokus 5 kolom dulu

### Phase 1 — Metode A: Public Lookup (est. 1–2 hari, **$0**)
Isi sheet `A. Public Lookup` di benchmark.xlsx untuk **semua 190 model** (atau representative subset per family).

- Sumber skor: [Artificial Analysis](https://artificialanalysis.ai/), [LMArena](https://lmarena.ai/), [LiveBench](https://livebench.ai/), [BFCL](https://gorilla.cs.berkeley.edu/leaderboard.html), [SWE-Bench](https://www.swebench.com/)
- Fokus kategori: Academic Q (MMLU), Code (HumanEval/SWE-Bench), General Chatting (LMArena Elo), Reasoning (GPQA), Math (MATH)
- Output: ranking awal → pilih **~30 shortlist** dengan bobot: skor tinggi + harga masuk akal + relevan use-case Reacteev

> ⚠️ Catatan: tidak semua model ada di leaderboard publik. Model kecil/open-weight/promosi mungkin harus langsung ke Phase 2.

### Phase 2 — Metode B: API Auto-Eval (est. 3–5 hari, **~$80–150**)
Test shortlist (~30 model) via API memakai dataset benchmark sendiri. Auto-score: exact-match atau LLM-as-judge.

- [ ] Siapkan dataset (ambil sample, bukan full set):
  - Academic Q: MMLU-Pro sample **300 soal**
  - Code: HumanEval **200 soal**
  - Reasoning: GPQA Diamond **300 soal**
  - Math: GSM8K **200 soal**
  - Function Calling: BFCL v3 **200 task**
  - Long-context: RULER-NIAH **50 dokumen**
  - Multilingual: IndoMMLU / MGSM-ID **200 soal** ⭐ (penting untuk user Indonesia)
- [ ] Bangun runner benchmark (lihat §5) — extend key-tester atau standalone script
- [ ] Skoring: exact-match (Code, Math, Academic) + LLM-judge (Function Calling, Long-context)
- [ ] Catat: `# Questions`, `# Correct`, `Accuracy (%)`, `Normalized (0–1)`, `Total Cost ($)`
- [ ] **Judge model ≠ model yang di-test** (hindari bias) — pakai 1 judge konsisten (mis. GPT-5.5 atau Claude Sonnet 5)

Estimasi biaya (kasar, 1500 soal × 30 model):
- Input avg ~500 tok, output ~300 tok. Pada model $1/$5 per Mtok ≈ $0.002/panggilan → ~$90 total. Model mahal (high-end) naikkan ke sample lebih kecil.

### Phase 3 — Metode C: Manual Eval (est. 2–3 hari, **$0–10**)
Final **~8 model** di prompt buatan Reacteev (citation pipeline, ppt-maker, grammar, dsb.).

- [ ] Siapkan 20–30 prompt per kategori (Research Paper, Code, Instruction Following)
- [ ] Rubrik 0/0.25/0.5/0.75/1.0 (Correctness + Format → avg)
- [ ] Jalankan prompt ke finalis, simpan output, nilai manual

### Phase 4 — Summary & Matching (est. 0,5 hari)
- [ ] Salin skor normalisasi (0–1) ke sheet `Summary` + kolom katalog
- [ ] Hitung `Avg (0–1)` per model
- [ ] Isi `Best Use-Case` per model (matching skor-tinggi-per-kategori → use-case)
- [ ] Produksikan: **ranking final** + **rekomendasi model per use-case Reacteev**

---

## 5. Pilihan implementasi runner benchmark

**Opsi A — Extend `key-tester` (REKOMENDASI)**
Tambah modul `server/benchmark/` yang memakai adapter & keys yang sudah ada:
- `runner.ts` — loop (model × dataset × soal), concurrency + retry + rate-limit
- `datasets/` — loader untuk tiap benchmark dataset
- `scoring.ts` — exact-match + LLM-judge
- Route `/api/benchmark/run` + UI tab baru + WebSocket progress
- Manfaat: reuse keys, adapters, OpenRouter gateway, history, UI live

**Opsi B — Script standalone** (`scripts/benchmark-run.ts`)
Lebih cepat dibuat, output langsung ke JSON/CSV untuk diimpor manual ke benchmark.xlsx. Cocok kalau mau segera jalan tanpa sentuh UI.

**Saran:** mulai Opsi B untuk validasi cepat di Phase 2 awal, kalau terbukti bergua → upgrade ke Opsi A.

---

## 6. Checklist keputusan yang perlu diambil

1. **Scope kategori:** fokus 5 kolom yang sudah ada di katalog, atau expand ke 12? *(usul: expand ke 12 — tambah kolom Reasoning, Math, Long-context, Multilingual, Function Calling, Agentic, IFEval)*
2. **Budget API:** berapa maksimal? *(usul: $100)*
3. **Judge model:** yang mana? *(usul: GPT-5.5 atau Claude Sonnet 5 — paling kompeten, biaya terbatas)*
4. **Shortlist size:** ~30 masuk akal? atau lebih kecil (~20) untuk hemat biaya?
5. **Prioritas use-case Reacteev** mana yang paling penting? (Research/citation? ppt-maker? code? multilingual ID?) → menentukan kategori yang di-test paling dalam.

---

## 7. Estimasi total

| Item | Estimasi |
|------|----------|
| Waktu | ~7–11 hari kerja |
| Biaya API | ~$80–150 (Phase 2) + $0–10 (Phase 3) |
| Biaya tools | $0 (semua open-source / gateway existing) |
| Output | Katalog terisi skor 0–1 + ranking + rekomendasi model→use-case |
