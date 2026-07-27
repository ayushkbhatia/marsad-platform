# 09 — Signal → Article: comprehension, composition, publication

> How one ingested signal — a filing, an earnings release, a corporate action, a news item —
> becomes a designed, publish-ready piece. This document owns the three layers that sit
> **between** `02-data-lake.md` (which owns typed facts) and `03-agent-newsroom.md` (which owns
> the conveyor): **comprehension** of source documents, **research** over the lake, and
> **composition** against a closed design vocabulary.
>
> Companion to `docs/design/` (the stored design system: 61 blocks, 4 longform templates).
> Execution steps live in `docs/BRIDGE-BUILD-PLAN.md` phases **PE** and **PD**.
>
> Author: lead architect. Date: 2026-07-27. Every count in §1 was measured against the live DB
> (`yjsncnpbjuueaoeejrqj`) on that date, not inferred.

---

## 0. Summary

The newsroom conveyor is built, correct, and dormant. It is dormant for a reason that is not a
switch: **there is nothing to write about, nothing is eligible to trigger it, and nothing knows
how to lay it out.** Three layers are missing, and each is independently blocking.

| # | Missing layer | The evidence | Owned by |
|---|---|---|---|
| **L1** | **Comprehension** — the documents are stored and unread | 14,409 filings carry a `pdf_storage_key`; **374 (2.6%) have any text**. TDWL RESULTS: 7,133 PDFs, **0 with text**. 25 GB in the `filings` bucket, essentially write-only | §2, phase **PE** |
| **L2** | **Eligibility** — nothing can reach the state intake requires | Intake fires on `VERIFIED`. `VERIFIED` needs ≥2 agreeing **staging** rows. Every researcher writes `lake.objects` **directly, bypassing staging, always PENDING** — so it is not "not yet promoted", it is **structurally unreachable** | §3, phase **PE** |
| **L3** | **Composition** — a perfect draft would still render as grey paragraphs | Writer emits only `{kind:'text'}`. 61 designed blocks, 14 registry rows, **0 renderer components**, `src/components/blocks/` does not exist. `ops.templates` and `ops.story_blocks` have **zero readers in the entire repo** | §4–§6, phase **PD** |

The single design decision that resolves L3 and hardens L1 at the same time:

> **The writer never emits a number. It emits a binding.**
> `{ block_code, object_id, field }` — and the renderer reads the value from `lake.objects` at
> render time.

The block library's own README already says agents emit "prose + block codes + lake object IDs".
Taking that one step further — to *values* as well as layout — makes a fabricated figure
**structurally impossible** rather than statistically unlikely, and makes `BLK-CORRECTION` /
R-07 work by construction: correct the object once, and every citing piece updates.

---

## 1. Ground truth (measured 2026-07-27)

### 1.1 Where information is stored today

Four tiers, and the boundary between tier 2 and tier 3 is where the pipeline breaks.

```
  ①  RAW BYTES (immutable)
     lake.snapshots            — hash-addressed, one row per distinct content sha256
       ├─ body_inline          — gzip bytes when ≤ 32 KB
       └─ storage_path         — bucket `lake-raw` when > 32 KB   [1,263 objects · 52 MB]
     bucket `filings`          — filing PDFs + researcher-archived XBRL/ZIP artifacts
                                                                  [29,481 objects · 25 GB]
         ↓
  ②  STAGING (Lane A only)
     lake.staging_rows         — candidate facts awaiting corroboration
         ↓  cross-check (±0.5%, ≥2 distinct source_ids)
  ③  TYPED LAKE
     lake.objects              — PENDING | VERIFIED | CONFLICT | RETIRED
                                 natural_key · payload jsonb · parse_run_id lineage
         ↓  lake.fn_*_project()  (AFTER INSERT + AFTER UPDATE triggers)
  ④  READER PROJECTIONS
     public.financial_statements · quotes_latest · ohlcv_daily · securities · key_ratios
     public.scores · filings · earnings_events · dividends · index_levels
```

**Two producer lanes write ③, and they are not equivalent** — this asymmetry is the root of L2:

| | **Lane A** — framework/staging | **Lane B** — researcher direct |
|---|---|---|
| Entry | `ingest.sources` → `ingest.job_queue` → worker handler | a `.mjs` on a systemd timer |
| Raw bytes | `lake.snapshots` + `lake-raw` | `filings` bucket only, or nothing |
| Intermediate | `lake.staging_rows` → cross-check | **none** — `upsertLakeObject()` writes `lake.objects` directly |
| State reachable | PENDING / VERIFIED / CONFLICT | **PENDING, always and only** |
| Owns | quotes, indices, OHLCV, filing lists, EOD | **financials, profiles, index levels — i.e. most of the fundamentals** |

### 1.2 Is the lake dynamically enriched?

**For numbers, yes. For meaning, no.** Every object type ever produced:

| object_type | state | rows |
|---|---|---|
| `OHLCV.CLOSE` | PENDING | 640,992 |
| `FINANCIALS.XCHECK` | PENDING | 41,621 |
| `FILING.FINANCIALS` | PENDING | 36,326 |
| `QUOTE.LAST` | PENDING / VERIFIED / CONFLICT | 10,256 / 264 / 37 |
| `COMPUTED.RATIOS` | **VERIFIED** | 736 |
| `COMPUTED.SCORE` | **VERIFIED** | 540 |
| `PROFILE.SECURITY` | PENDING | 728 |
| `FILING.REF` | PENDING | 623 |
| `INDEX.LEVEL` | PENDING | 42 |
| `FILING.FINANCIALS` | **VERIFIED** | **1** |

Nine families. All price, all fundamentals, all derived. **Zero narrative families** — no
`NEWS.*`, no `TRANSCRIPT.*`, no `DISCLOSURE.DPS`, no `EARNINGS.VERDICT`, no `IPO.*`,
no `GUIDANCE.*`, no `FILING.SEGMENT.*`.

Look closer at what is VERIFIED, and the picture is starker than a count suggests:

| object_type | VERIFIED | verified between | how |
|---|---|---|---|
| `COMPUTED.RATIOS` | 736 | 2026-07-26 22:00 → 23:00 | **self**-verified by `key-ratios.ts` |
| `COMPUTED.SCORE` | 540 | 2026-07-19 → 2026-07-27 | **self**-verified by `scores.ts` |
| `QUOTE.LAST` | 264 | **2026-07-15 07:42 → 08:28** | genuine cross-check corroboration |
| `FILING.FINANCIALS` | 1 | 2026-07-20 13:41 | artefact |

The two large families are **self-verified by the compute agent that produced them** — a lineage
assertion, not a corroboration. The corroborating cross-check engine has produced VERIFIED objects
**exactly once: a 46-minute window on 2026-07-15, and never since.** That is the whole of the
evidence that the VERIFIED pathway works, and it covers a data type (live quotes) the newsroom
explicitly classifies as `not_material`.

The consequence is visible in what the writer actually sees. `lake.fn_writer_context` returns
identity, live quote, 3m/12m returns, 24 ratios, the Marsad Score with five factor grades, and
four quarters × three statement types with full XBRL line items — and then:

```json
"filings": [ { "filing_id": 16862, "title": "Detailed report — 2026-06-30",
               "filing_type": "RESULTS", "ai_summary": null, "facts": null }, … ]
```

**An analyst that can compute everything and quote nothing.** No management commentary, no
segment discussion, no guidance, no risk language, no auditor note — because the documents those
things live in have never been opened.

### 1.3 Why the documents are unread — the enqueue break

`ops.filing_extract_queue` is not backed up. **It is empty**: 374 rows, all `done`.

The only producer is [`filings-detail-poll.ts:244`](../../worker/src/handlers/filings-detail-poll.ts).
The five researchers that archived ~14,000 PDFs (`tadawul-researcher`, `qe-financials`,
`bhb-financials`, `msx-financials`, `dfm-backfill`, `adx-gapfill`) write `public.filings` and the
storage bucket **directly and never enqueue**. Queued, by venue:

| venue | PDFs stored | ever queued |
|---|---|---|
| MSX | 2,395 | 195 |
| ADX | 1,588 | 120 |
| DFM | 807 | 59 |
| **TDWL** | **7,133** | **0** |
| **QE** | **2,118** | **0** |
| **BHB** | **366** | **0** |

So the extractor is not underperforming — **97.4% of the corpus was never offered to it.**
This is `DEF-FILING-EXTRACT-ENQUEUE-GAP`, and it is a ~20-line fix that unlocks 25 GB.

Separately, the extractor itself is thin even where it runs: `pdftotext -layout` →
`pdftoppm|tesseract` → one `claude -p` call against a 6-field schema
(`dividend`, `earnings`, `event_date`, `key_points`). It extracts **no tables as tables**, no
layout, no reading order, no page/bbox provenance, and discards everything outside that schema.

### 1.4 What the design system asks for, versus what exists

| | Designed | In the DB | In code |
|---|---|---|---|
| Story blocks | **61**, 8 families | 14 rows | **0 renderers** — `src/components/blocks/` absent |
| Article templates | 4 longform + wire chassis | 8 `TPL-*` rows | template choice is a 5-arm `switch` in `edit.ts` |
| Registry readers | — | — | **zero.** No SELECT, no join, no view, anywhere |
| Block kinds written | 61 | — | `text`, `heading`, `pull_quote` (seed only); pipeline writes `text` |
| `bound_object_id` | every data block | nullable | **NULL on every agent-written block** |

And a live rendering bug worth naming, because it makes the current output look worse than it is:
the research adapter matches `"pullquote"` while the DB holds `"pull_quote"`, and does not match
`"heading"` at all — so **every heading and every pull quote currently renders as a plain
paragraph** ([`adapters/research.ts:63`](../../src/lib/data/adapters/research.ts)).

---

## 2. Layer 1 — Comprehension

### 2.1 What we need out of a filing

Not "a summary". Six things, each of which a downstream block binds to:

1. **reading-order text** — the narrative spine;
2. **tables as structured rows** — income statement, balance sheet, cash flow, dividend schedule;
3. **document structure** — headings, sections, statement boundaries;
4. **figure and chart captions**;
5. **page + bounding-box provenance per element** — so a published figure traces to a coordinate
   on a page, which is what `BLK-PROV` renders;
6. **language and script per region** — English-primary, some bilingual EN/AR.

### 2.2 The tiered extractor

Cost discipline: run the cheap deterministic tool over everything, and spend model tokens only on
what it demonstrably fails.

**Tier 0 — triage and born-digital text (deterministic, on the existing VPS).**
`@llamaindex/liteparse` (run-llama/liteparse, **Apache-2.0**, Rust core with native Node
bindings, emits PDFium spatial text **with bounding boxes**), OCR disabled. Per PDF: page count,
per-page character count, spatial text. Partition **born-digital** vs **image-only**.

This does three jobs at once: it closes the `full_text` gap for the born-digital majority with
better output than `pdftotext -layout`; it gives bbox provenance for free; and — critically — it
tells us **the true page count of the expensive problem**, which is currently a guess. Keep
`pdftotext -layout` as a sampled cross-check: disagreement between two deterministic extractors
is a cheap corruption signal.

> ⚠️ **Benchmark before sizing.** The widely-quoted "1721 pg/s" LiteParse figure was measured on
> a single B200 host as *sustained concurrent* throughput. It does not transpose to a 4-core
> Hetzner box. Measure on the real hardware in PE.1 before committing a backfill schedule.

**Tier 1 — layout, tables and Arabic (model, only for Tier-0 failures).**
**PaddleOCR-VL-1.6** — **Apache-2.0** weights *and* code, 1.0B params, currently top of
OmniDocBench v1.6 (96.34 overall, **94.76 Table TEDS**, 0.1278 read-order). Two-stage:
`PP-DocLayoutV2` predicts element types, boxes and reading order **discriminatively**, then a
0.9B VLM recognises the cropped regions — which is why it emits provenance and why it
hallucinates far less than a monolithic VLM.

Route to Tier 1 only: all image-only pages; born-digital pages containing tables; **all
Arabic/bilingual pages regardless of type**, because RTL reading order and column mapping are
where deterministic tools fail *silently*. Do not send cover pages, signature pages or
boilerplate.

Arabic is the reason this choice is not close. Character edit distance (lower is better), from
the PaddleOCR-VL paper Table 6(a):

| model | Arabic edit distance |
|---|---|
| **PaddleOCR-VL** | **0.122** |
| Qwen2.5-VL-72B | 0.405 |
| MonkeyOCR-pro-3B | 0.601 |
| Dolphin | 0.682 |
| MinerU2.5 | **0.978** — effectively unusable |

> ⚠️ That figure is the **base** model's. PaddleOCR-VL-1.6's card states no language count and
> does not name Arabic; its Arabic performance is **unmeasured**. Treat the base number as a
> prior, and measure on our own bilingual filings in PE.2.

**Tier 2 — semantic mapping (the existing LLM call, repositioned).**
Today it reads digits off text. It should instead receive **Tier-1's structured tables with
bboxes** and answer only mapping questions: *"which row is revenue?"*, *"is
`إجمالي الإيرادات` the same line as `Total revenue`?"*, *"which column is the comparative
period?"*. It never reads a digit off a pixel. This is a large accuracy gain for zero new
infrastructure and is compatible with the existing `lake.fn_financials_project` contract.

**Tier 3 — validation (mandatory, not optional).**
The best tools cap around **0.81** on real financial tables (Newtuple, 2026-06-21) — well below
their benchmark TEDS. Therefore:

- **arithmetic identities** — assets = liabilities + equity; subtotals sum; CFS ties to the cash
  delta. Reuse the QE Islamic-bank / Takaful three-taxonomy balance-sheet validator already built.
- **cross-source reconciliation** — where XBRL exists (TDWL, QE JSON), **XBRL wins** and the PDF
  extraction is *scored against it*. This yields a free, continuously growing labelled test set
  over our own documents — worth more than any public benchmark.
- **two-model disagreement** on any figure destined for publication → quarantine, do not publish.
- **never publish an unvalidated number.** A gap is a gap; a wrong number is a liability.
  Prefer `NULL` plus a provenance pointer. This is `BLK-CONFLICT`'s stated behaviour: when
  sources disagree the figure is *withheld*, and the block shows both values and picks neither.

### 2.3 Licence gate — decided before any technical evaluation

This is not a footnote. We would be building a permanent derived data asset over 29k documents,
and two of the most obvious tools poison it.

| Tool | Code | Weights | Verdict |
|---|---|---|---|
| **PaddleOCR-VL / PP-StructureV3** | Apache-2.0 | Apache-2.0 | ✅ clean |
| **docling** / **granite-docling-258M** | MIT / Apache-2.0 | Apache-2.0 | ✅ clean |
| **LiteParse** | Apache-2.0 | n/a | ✅ clean |
| **dots.ocr** | MIT | MIT | ✅ clean (read the supplement) |
| **DeepSeek-OCR** / **-OCR-2** | MIT / **Apache-2.0** | same | ✅ clean |
| **MinerU** | custom, Apache-2.0-based | same | ⚠️ usable — but **obliges visible attribution** in any online service built on it |
| **marker / surya** | Apache-2.0 | **AI Pubs OpenRAIL-M** | ❌ **BLOCKED** |
| **Chandra** | Apache-2.0 | modified OpenRAIL-M | ❌ **BLOCKED** |
| **Nougat** | MIT | **CC-BY-NC** | ❌ **BLOCKED** — non-commercial |

The marker/surya model licence prohibits use where the licensee "generated more than five million
US Dollars ($5,000,000) in gross revenue in the prior year", or "raised more than five million
US dollars ($5,000,000) in total equity or debt funding", or "for any purpose if You … provide …
any product or service that competes with any product or service offered by … Licensor" — and
states those restrictions apply to "the Model, Derivatives of the Model, **and Output**
collectively." Datalab sells a document-extraction API. Chandra's threshold is $2M.

Also: **PyMuPDF is AGPL-3.0.** GMFT is MIT precisely because it keeps PyMuPDF in a separate
package. Pulling `pymupdf`/`pymupdf4llm` into the worker inherits AGPL. Poppler's `pdftotext`
invoked as a subprocess is the normal, defensible pattern and is what we already do.

### 2.4 Why not "just send the page to a VLM"

Because it is the wrong failure mode for a financial pipeline. PP-OCRv6 (arXiv 2606.13108) built
an explicit text-hallucination benchmark — the rate of outputs containing no text absent from the
input image:

| model | hallucination-free |
|---|---|
| **PP-OCRv6 Medium — 34.5M params** | **93.20%** |
| Kimi-K2.6 | 85.00% |
| Qwen3-VL-235B | 80.56% |
| GPT-5.5 | 78.00% |
| MiniMax-M3 | 72.60% |

A 34.5M-parameter discriminative model beats a 235B generative VLM on both accuracy and
hallucination, and the mechanism is architectural: CTC/NRTR decoding is grounded in visual
features, whereas autoregressive generation produces plausible-but-nonexistent text.

The failure that matters is not a garbled number — it is a **self-consistent** one: a model
misreads a line item and then silently adjusts the subtotal to match its own arithmetic. That
output passes a checksum. It is caught only by cross-source reconciliation, which is why Tier 3
is mandatory rather than advisory.

A general VLM *is* appropriate as a second pass over already-grounded text — semantic labelling,
entity resolution, EN/AR header disambiguation. Never as the digit-reading layer.

### 2.5 Cost

The model tier is **tens of dollars, not thousands**, provided Tier 0 keeps the page volume down.
Verified hosted rates:

| model | host | in / out per 1M | context |
|---|---|---|---|
| `paddlepaddle/paddleocr-vl` | Novita | $0.02 / $0.02 | 16,384 |
| `deepseek/deepseek-ocr` | Novita (also via HF router mapping) | $0.03 / $0.03 | 8,192 |
| `deepseek/deepseek-ocr-2` | Novita | $0.03 / $0.03 | 8,192 |

At DeepSeek-OCR rates, ~29k pages ≈ **$1.22–$3.74**; ~232k pages ≈ **$9.74–$29.93**. Renting a
GPU (Modal L40S, ~$1.95/hr, per-second billing, scale-to-zero) is the *fallback*, not the default.

> ⚠️ Two unknowns to resolve in PE.1/PE.2 before committing: **(a)** the corpus page count is
> unmeasured — Tier 0 produces it; **(b)** Novita's model id is the **base** `paddleocr-vl`
> (94.18 / 90.65 TEDS), not 1.6 (96.34 / 94.76). Confirm the served version, or self-host 1.6.
>
> The experiment that would most change this plan: **a 100-page bake-off of PaddleOCR-VL-1.6 vs
> docling vs DeepSeek-OCR-2 on real GCC filings, scored against our existing XBRL.** We already
> own the labels. That is worth more than every benchmark cited above.

---

## 3. Layer 2 — Eligibility

### 3.1 The wall, stated exactly

`lake.fn_verified_enqueue()` fires on `state = 'VERIFIED'`. VERIFIED is written by exactly four
code paths, and the only general one is `cross-check.ts`, whose predicate
([`agreement.ts:82-134`](../../ingestion/src/lake/agreement.ts)) is:

> ≥2 distinct `source_id`s in `lake.staging_rows` for the same `natural_key`, unconsumed, in the
> same gather, agreeing within ±0.5% (numeric) or exactly (text/date), with no member of the
> winning cluster carrying `price_sensitive = true`.

**Lane B never writes staging rows.** `upsertLakeObject()` writes `state: 'PENDING'`
unconditionally and has no VERIFIED branch. Therefore every researcher-produced object — which is
to say *all 36,326 `FILING.FINANCIALS`, all 728 profiles, all index levels* — is not merely
unpromoted. **It is unreachable.** No amount of waiting or re-running promotes it.

And the second lock: `price_sensitive = true` can never auto-VERIFY by DB trigger
(`fn_object_state_guard` requires a **human** `verified_by`), and **no code implements the
human-confirm path.** The guard exists and waits. So dividends and ex-dates — precisely the
wire-shaped events — are doubly blocked.

### 3.2 Resolution — this settles decision D-3

`BRIDGE-BUILD-PLAN` D-3 offered three options and recommended (c). Ground truth says **(c) is the
only one that exists**:

- **(a) "promote `FILING.FINANCIALS` to VERIFIED"** — not implementable. Cross-check has nothing
  to gather; there are no staging rows.
- **(b) "accept PENDING for single-source families"** — correct in direction, but unscoped it
  degrades to "anything is publishable".
- **(c) per-`object_type` acceptable-state set** — adopt, **paired with a provenance floor** so
  that broadening the state does not weaken the guarantee.

**The provenance floor.** Intake accepts a PENDING object when *all* hold:

1. its `object_type` is on the intake allowlist;
2. it carries a `lake.parse_runs` lineage that resolves to a stored snapshot or PDF — i.e. a
   primary document we still hold the bytes of;
3. it passed Tier-3 validation (§2.2) at extraction time.

That is a **stronger** guarantee than "two scrapers agreed", because it is traceable to the
primary source rather than to a coincidence between two secondary ones. Record the distinction
honestly: R-03's `distinct_lineage_roots ≥ 2` remains the **auto-publish** gate; the provenance
floor is the **intake** gate. A single-rooted piece still publishes — through a human.

### 3.3 New object families to produce

`DOC.*` is the new comprehension layer's output; the rest are the canonical facts the newsroom,
the registry and the reader already expect but nobody produces.

| family | source | binds to | notes |
|---|---|---|---|
| `DOC.PAGE` | Tier 0/1 | `BLK-PROV`, `BLK-DOC` | text + bbox + language per page |
| `DOC.TABLE` | Tier 1 | `BLK-FINTABLE`, `BLK-KEYSTATS` | structured rows + page/bbox |
| `DOC.SECTION` | Tier 1 | narrative retrieval | headings, statement boundaries |
| `DISCLOSURE.DPS` | Tier 2 | `BLK-EXDATE`, TPL-01 | **price-sensitive** — needs §3.4 |
| `DIVIDEND.EXDATE` | Tier 2 + registrar | `BLK-EXDATE`, `BLK-COUNTDOWN` | **price-sensitive** |
| `EARNINGS.VERDICT` | statements + estimates | `BLK-VERDICT`, `BLK-BEATMISS` | blocked on `public.estimates` (P7.3) |
| `FILING.SEGMENT.*` | Tier 1 tables | `BLK-STACK`, `BLK-WATERFALL` | segment revenue/profit — the deep-dive fuel |
| `GUIDANCE.*` | Tier 2 | `BLK-SCENARIO`, `BLK-RANGE` | management outlook statements |
| `TRANSCRIPT.QUOTE` | (no producer yet) | `BLK-PULLQUOTE`, `BLK-QUOTE` | `transcripts` = 0 rows; P7.6 |
| `IPO.OFFER` / `IPO.COVERAGE` / `IPO.TIMELINE` | P7.2 | `BLK-COVER`, `BLK-TIMELINE`, `BLK-CANDLE` | all 0 rows |

**Registration is a checklist, not a schema change.** `lake.objects.object_type` is free `text`
with no CHECK, no enum, no FK — which means **a new type is never rejected, it is silently
invisible**, because every consumer is an exact string match. The complete registration checklist
(producer → cross-check constants → projection triggers → materiality → templates → story blocks
→ writer context → observability) is enumerated in `docs/BRIDGE-BUILD-PLAN.md` **PE.5**, derived
from the two worked precedents already in the repo: `FINANCIALS.XCHECK` (the full treatment) and
`DIVIDEND.EXDATE` (the 57-line minimum).

### 3.4 The human-confirm path (new, and small)

Price-sensitive objects need a Desk action that sets `verified_by` to a human principal. One RPC,
mirroring `ops.desk_decide_approval`'s guard shape (capability check, `FOR UPDATE`, audit row),
plus a Desk queue view of pending price-sensitive objects. Without it, `BLK-EXDATE`,
`BLK-COUNTDOWN` and the entire dividend wire class can never publish — and 1,229 `dividends` rows
stay at `pending_confirm` forever regardless of what P7.1 does upstream.

---

## 4. Layer 3a — Desk Research

*This is the user's point #3, and it is where the current design is weakest.*

Today the writer stage is **one LLM call**: trigger object + `fn_writer_context` truncated to
12,000 characters, "write a tight, factual news piece". The model is simultaneously the
researcher, the analyst, the editor and the layout designer. It is good at none of those.

**Split retrieval from interpretation. Evidence assembly is deterministic SQL, not an LLM job.**

Insert a **research stage** between `classify` and `draft`:

```
classify ──► research ──► draft ──► compose ──► edit ──► rules ──► fit ──► approval
             ▲ new                   ▲ new                          ▲ new
```

The research stage runs a fixed set of **exhibit queries** keyed by the classifier's
`event_type`. Each returns a candidate *evidence bundle* that already carries its
`lake.objects` id and its natural chart shape. For `EARNINGS_RESULT`, for example:

| bundle | query | natural block |
|---|---|---|
| result vs prior year | income statement, 2 periods | `BLK-BEATMISS` / `BLK-DUMBBELL` |
| what moved profit | segment/cost bridge | `BLK-WATERFALL` — *"WHAT MOVED IT?"* |
| margin trend | 8 quarters | `BLK-LINE` — *"WHEN DID IT TURN?"* |
| revenue mix | segment stack | `BLK-STACK` — *"WHAT'S IT MADE OF?"* |
| peer position | sector P/E vs growth | `BLK-SCATTER` — *"WHO'S POSITIONED?"* |
| the score | `COMPUTED.SCORE` + factor grades | `BLK-SCORE` |

The chart family is **question-indexed by design** — each of the 15 D-family cards is labelled
with the question its shape answers. That labelling *is* the selection contract: the agent picks
a **question**, not a chart type, and the compiler picks the shape. It is stored verbatim in
`docs/design/block-registry.json` under `allowed_piece_types` for family D.

The LLM's job collapses to **selection and interpretation** over a bounded candidate set — which
is a task open-weight models do well, and which is auditable, because the candidate set was
generated by SQL we wrote.

### 4.1 A live bug this stage must fix

The draft stage builds its citation allow-set with `idsInPack()`
([`draft.ts:156-170`](../../worker/src/handlers/newsroom/draft.ts)), which collects **string**
values under `source_object_id`, `row_id`, `object_id`, `source_filing_id`. But in
`fn_writer_context`, `row_id` and `source_filing_id` are **bigints**, not strings. So only
`source_object_id` from statement rows survives.

**The `price`, `ratios`, `score`, `identity` and `filings` sections of the pack carry no citable
id at all.** A writer that cites a share price, a P/E, or the Marsad Score has no legal object id
available — so its citation is rejected as "invented" and the piece is kicked to
`reassigned_human`, terminally. Both recorded real drafts died that way.

The research stage removes the class of bug rather than patching it: every bundle it emits is
constructed *with* its object id, so the allow-set is built server-side and never inferred by
walking a JSON blob.

---

## 5. Layer 3b — Composition against a closed vocabulary

### 5.1 The stored design system

`docs/design/` is now the in-repo source of truth, in three layers, single-sourced:

| Layer | Path | Role |
|---|---|---|
| **Visual reference** (immutable) | `docs/design/artifacts/*.html` | The 61-block library and the 4 longform templates at production fidelity. Opens standalone. **Never edit — replace on a new handoff.** |
| **Machine-readable** | `docs/design/block-registry.json`, `article-templates.json` | 61 blocks × {family, allowed piece types, binding rule, binds_to, required payload fields, constraints, gating, rule id} + 4 templates × {grid, section sequence, rail, gutter, block instances, premium cut, writer metadata fields, hard rules} + design tokens |
| **Runtime** | `ops.story_blocks`, `ops.article_templates` | What a worker on the VPS can actually reach. Seeded **from** the JSON, so drift is a diff |

That third layer is the reason the JSON is not enough on its own: the composing agent runs on the
VPS against Postgres, not against the repo.

### 5.2 The eight families and what each is for

| Family | n | Purpose | Binding character |
|---|---|---|---|
| **A · Inline** | 6 | Units inside a sentence: ticker chip, delta, citation chip, defined term, sparkline, margin note | mostly live values |
| **B · Statement** | 6 | Where the desk commits to a view: thesis, pull quote, big number, rating card, gated Take, falsifiers | desk-authored |
| **C · Tabular** | 8 | Stat strip, facts grid, financials-with-estimate-column, scenarios, league table, beat/miss, ex-date, transposed compare | hard-bound to objects |
| **D · Charts** | 15 | **One shape per question** — see §4 | series of object ids |
| **E · Mechanism** | 8 | Teach a process: timeline, steps, money flow, annotated document, worked example, assumption-vs-mechanism, if/then, glossary | mixed |
| **F · Wire & live state** | 8 | Timestamped and perishable: tape entry, chip row, snapshot, countdown, halt, correction, breadth, venue header | live, freshness-stamped |
| **G · Provenance & trust** | 6 | The audit trail rendered: lake stamp, build chain, freshness, desk-estimate marker, source conflict, rule applied | binds lineage |
| **H · Gates & CTAs** | 4 | Premium cut, paywall band, alert CTA, data download | binds meter state |

**Build order is G first.** Provenance, freshness and estimate markers are prerequisites for every
other family's footer — the design's second hard rule is that *every* number carries a freshness
state and a provenance stamp.

### 5.3 The three hard rules, enforced not decorated

1. **One accent only — ink.** Green `#0a7a3c` and red `#c0342b` are reserved for **direction**,
   never for emphasis or decoration. → a lint over block payloads, not a convention.
2. **Every number carries a freshness state and a provenance stamp** (`BLK-FRESH`, `BLK-PROV`).
   → a `requires_binding` column, checked at the fit stage.
3. **A desk estimate is marked three ways at once** — `E` suffix, ink column header, bold value —
   so it can never be mistaken for a filed figure. **Never colour alone.** → the renderer owns
   this; the agent supplies only an `is_estimate` flag per period.

Per-block constraints are captured verbatim in the registry and are machine-checkable, e.g.:

- `BLK-CUT` — blur 3.5px, gradient to paper, and the cut must fall *after a complete thought* and
  *after at least one data block* (**R-09**).
- `BLK-CORRECTION` — **amber, never red**; must state whether the argument survived (**R-07**).
- `BLK-CONFLICT` — when sources disagree the figure is **withheld**: show both, pick neither.
- `BLK-COVER` — the 1.0× line is always red; below it an offer is undersubscribed, which *is* the
  story.
- `BLK-CANDLE` — on a debut the reference line is the **offer price**, not a prior close.
- `BLK-INDEXED` — always rebase to 100, always show the benchmark; subject solid, benchmark dashed.
- `BLK-DECISION` — one question, two outcomes, **never nested**.
- `BLK-FINTABLE` — max 8 rows inline; longer tables go to the XLSX attachment.

### 5.4 The four longform templates

`docs/design/article-templates.json` carries the full spec. The chassis, in brief:

```
88px marker gutter │ 740–762px measure │ 296–300px rail      (gaps 52–54px)
container 1160–1180px centred, 34px page padding
```

- **The measure is fixed.** Body copy sits at Newsreader 17px / 1.72 and **never** reflows to the
  full width. This is the single most important thing to preserve.
- **The gutter is not padding.** It carries section markers, `BLK-MARGIN` notes and citation
  anchors that must **align to the paragraph they annotate**.
- **Exhibits break the measure deliberately** — charts and tables span gutter + measure, never the
  rail. That is what makes them read as evidence interrupting the argument.
- **The rail is the only independently scrolling column.**

| id | Type | Read | Access | What it adds over 1a |
|---|---|---|---|---|
| **1a** | Feature long read | ~18 min | metered | — the chassis; build first |
| **1b** | Research note | ~14 min | premium | rating header **above** the headline; `BLK-THESIS` replaces the standfirst; **`BLK-FALSIFY` mandatory**; disclosure structural in the byline bar; rail carries valuation scaffolding |
| **3a** | Sector deep dive | ~40 min | premium | reverse headline on ink (reserved for series); series position; a "what this establishes" contract; 4 numbered chapters; **cut falls at chapter 4** |
| **3b** | Explainer | ~11 min | **free** | no byline furniture, no thesis, no rating — it asserts nothing. Exactly one timeline stage in red. A worked example. A "what this is not" box. **Review date, not a timestamp** |

The writer-metadata contract per template is enumerated in the JSON — e.g. 1b requires
`{rating, prior_rating, price_target, prior_price_target, implied_upside_pct, marsad_score,
score_agreement_flag, thesis_statement, falsifiers_statement, analyst_rank, win_rate_pct, …}`
across nine groups. **These are the fields the research stage must produce**, which is what makes
1b buildable at all.

### 5.5 The composition contract

Two passes, both against **narrow** schemas.

**Pass 1 — outline.** Emit `[{ block_code, binding_object_id, one_line_intent }]` against an enum
containing only the codes legal for this template (~5–12, from `ops.article_templates.block_keys`
∩ the family permissions). Validate every code against `ops.story_blocks` and every id against
`lake.objects` **before** pass 2 runs.

**Pass 2 — fill.** One constrained call per block against that block's own `payload_schema`.

Note the reasoning, because a common justification for this shape is now false: OpenAI raised its
structured-output limits on 2025-07-11 (properties 100 → **5,000**, characters 15,000 →
**120,000**, enum values 500 → **1,000**), so a 61-arm union does **not** blow the limits. Two-pass
is right for **auditability and quality** — it makes each refusal point explicit and keeps each
schema small — not because a single schema is impossible.

**Schema source of truth:** Zod v4's native `z.toJSONSchema()` (`zod-to-json-schema` was declared
unmaintained in Nov 2025). Author once in TS, store the emitted JSON Schema in
`ops.story_blocks.payload_schema`, send the same schema to the provider.

**Chart specs are compiled, never emitted.** A Vega-Lite spec *is* layout, so the agent may not
produce one. It emits:

```jsonc
// BLK-CHART body
{ "shape": "line|stacked_bar|waterfall|dumbbell|slope|distribution",
  "series": [ { "object_id": "…", "field": "revenue", "label": "Revenue" } ],
  "emphasis": { "object_id": "…", "reason": "…" },
  "caption": "<prose>" }
```

Six enum values, trivially constrainable. A deterministic compiler in-repo maps
`(shape, resolved series)` → a themed Vega-Lite spec → **SVG for web, PNG for email**.

PNG is not optional: **SVG is dead in email.** Microsoft retired inline SVG in Outlook for Web and
new Outlook for Windows between September and mid-October 2025 (SVG-borne phishing); Gmail blocks
it too. One spec, two renderers.

### 5.6 Failure modes to design against

Constrained generation does not remove failure; it **relocates** it:

- **silent field-dropping** — required fields populate, optional ones the model would have
  volunteered get dropped;
- **truncation** mid-emit → invalid JSON; size `max_tokens` for the whole block payload;
- **confident hallucination in valid syntax** — *the one that matters*: a schema-valid
  `BLK-FINTABLE` with a fabricated number is worse than a parse error, because it **passes**;
- **refusals replacing parse errors**;
- **reasoning degradation** when the answer field precedes the derivation — order schema fields so
  reasoning comes first.

The binding rule (§0) defeats the third and worst of these outright. For inline prose numerals it
does not apply, which is what R-03/R-04 remain for — and what a **numeric-consistency check**
covers: extract every numeral from block prose, require each to match a value reachable from that
block's citations within tolerance, else refuse.

That check is ours to own. No open-source project does "the prose says 12.4% and the bound object
says 12.1%" well.

> ⚠️ **Do not adopt MiniCheck / Bespoke-MiniCheck-7B** as the entailment gate, despite it being the
> obvious candidate. The weights are **CC BY-NC 4.0** — commercial use requires a negotiated
> licence from Bespoke Labs. (The repo's Apache-2.0 covers code, not weights; the GitHub README and
> the HF model card disagree, and the model card governs.) The smaller MiniCheck-Flan-T5-Large /
> RoBERTa / DeBERTa checkpoints — which are what the widely-quoted "~400× cheaper than GPT-4"
> figure actually refers to — must be licence-checked **individually**.

---

## 6. Layer 3c — Fit and Refuse (the publishing agent)

Deterministic, no LLM. Input: an outline of validated blocks + a template. It:

1. **resolves** each `BLK-*` against `ops.story_blocks`;
2. **checks family permission** for the piece type (`ops.article_templates.allowed_families`);
3. **checks binding** — every block with `requires_binding` has a resolvable `bound_object_id`
   *and* a `lake.citations` row;
4. **runs the numeric-consistency check** over prose;
5. **applies the per-block hard constraints** (§5.3);
6. **places the premium cut** — after a complete thought and after ≥1 data block (R-09);
7. **refuses** on any failure. It does not degrade, and it does not invent a fallback block.

> **No agent may invent a new block.** That closed vocabulary is what makes an agent-run newsroom
> safe to operate — which is why every card in the library states its constraints rather than just
> showing a picture.

**This is the missing enforcement point.** `ops.templates.block_keys` has existed since
2026-07-13 and **nothing has ever read it**; nothing validates that a piece's blocks match its
template. The fit stage is that validator, and it is where `always_premium`, `max_words` and
`auto_publish_eligible` finally get read from the registry instead of being re-hard-coded — as
they are today in **three or four places each**.

### 6.1 Renderers

`src/components/blocks/` does not exist; the 14 `renderer_component` names in `ops.story_blocks`
name components that were never written. Build them in family order **G → A + C → D → B, E, F, H**,
per the design handoff's own recommendation, with:

- an `onMissingComponent` posture borrowed from `@portabletext/react`: an unregistered block code
  is a **loud, logged, non-fatal** event at render — because the *publisher* is the thing that
  must hard-refuse, not the renderer;
- a stable opaque `_key` per block so citations and corrections bind to block **identity** rather
  than `seq` (which reordering invalidates).

While doing this, fix the `pull_quote`/`pullquote` and `heading` mismatch in
[`adapters/research.ts:63`](../../src/lib/data/adapters/research.ts) — it is a two-line change that
currently flattens every heading and pull quote in every seeded article.

---

## 7. LLM provisioning — where the HuggingFace token fits

### 7.1 The gateway as it stands

`chatComplete(role, messages, opts)` supports exactly **three** providers
(`anthropic | openrouter | ollama`) and two wire formats: Anthropic's `POST {base}/messages`, and
OpenAI-shaped `POST {base}/chat/completions` for everything else with `Authorization: Bearer`.
Roles: `classifier | writer | editor | summarizer | analyst_take | embedder` (the last throws —
no embeddings route exists).

### 7.2 Adding HuggingFace

The router is OpenAI-shaped, so this is a **provider registration, not a new transport**. Verified
contract:

| | |
|---|---|
| Base URL | `https://router.huggingface.co/v1` → gateway builds `…/v1/chat/completions` ✅ |
| Auth | `Authorization: Bearer <hf_token>` — fine-grained token with *"Make calls to Inference Providers"* |
| Billing header | `X-HF-Bill-To: <org>` (optional) |
| Routing policy | **default is `:fastest`**; alternatives `:cheapest`, `:preferred`, or pin with `model:provider` |
| Markup | none — HF bills at provider rates |
| Credits | Free $0.10 · PRO $2.00/mo · Team/Enterprise $2.00/seat pooled |

Four integration traps, all load-bearing:

1. **Route shape.** The gateway appends `/chat/completions` to the base. That is correct for the
   auto-router (`/v1`) but **wrong for pinned-provider routes**, whose paths differ per provider
   (Novita's is `/v3/openai/chat/completions`). **Pin via the model string, never by rewriting the
   base URL.**
2. **No `/v1/embeddings` on the auto-router** — it serves chat-completions only. Embeddings need a
   provider-specific route or local ONNX. The `embedder` role already throws, so nothing regresses,
   but it stays unsolved.
3. **`supports_structured_output` varies by (model, provider)** — the *same* model is `true` on
   Together and `false` on Novita/Fireworks/DeepInfra. **Pin the provider for every JSON role**
   (classifier, composer, fill).
4. **Unauthenticated errors return HTML, not JSON.** `fetchJson` must guard `res.json()` on
   non-2xx or it will throw a parse error that masks a 401.

And one trap in our own code: **`pricing.ts` returns `cost_usd = 0` for any unknown model**, with
only a one-time `console.warn`. Configure an HF model without adding a price row and the budget
ladder silently reads $0 forever — i.e. the ladder stops working exactly when spend starts.

### 7.3 What the token is and is not for

**Is:** evaluating open-weight models per role at near-zero cost; the classifier, editor and
summarizer roles in production, where the work is constrained and cheap; the OCR bake-off.

**Is not:** funding the backfill. $0.10 free / $2.00 PRO credits do not cover a 29k-document run
or a production newsroom. The verified arithmetic says the extraction itself is **tens of
dollars** — so this is pay-as-you-go or BYOK, and small either way. Worth saying plainly rather
than discovering at the credit wall.

Vision note: everything vision goes through **chat-completions with `image_url` content parts** —
the `image-to-text` pipeline has zero warm models. 38 of the router's 128 listed models accept
image input; 319 warm `image-text-to-text` models exist beyond that list, resolvable individually
via `GET /v1/models/{id}`.

---

## 8. The pipeline, end to end

```
 ① SIGNAL          filing PDF / board JSON / news item lands
                   → lake.snapshots + `filings` bucket                     [works today]
                          │
 ② COMPREHEND      Tier 0 LiteParse (triage + born-digital text + bbox)
      PE           Tier 1 PaddleOCR-VL (image-only · tables · Arabic)
                   Tier 2 LLM semantic mapping over structured tables
                   Tier 3 arithmetic identities + XBRL reconciliation
                   → DOC.PAGE · DOC.TABLE · DOC.SECTION                        [NEW]
                          │
 ③ CANONICALISE    DOC.* → typed facts
      PE           DISCLOSURE.DPS · EARNINGS.VERDICT · FILING.SEGMENT.*
                   GUIDANCE.* · DIVIDEND.EXDATE
                   → lake.objects at an intake-eligible state (§3.2)          [NEW]
                          │
 ④ TRIAGE          materiality prefilter → classifier verdict
                   (event_type, priority, suggested_template, reason)     [built, dormant]
                          │
 ⑤ RESEARCH        deterministic exhibit queries per event_type
      P5           → evidence bundles, each carrying its object id            [NEW]
                          │
 ⑥ DRAFT           prose + [cN] markers over the bundles
                   the classifier's `reason` becomes the required angle   [built, blind]
                          │
 ⑦ COMPOSE         pass 1 outline → pass 2 per-block fill
      PD           block codes from the template's legal vocabulary only      [NEW]
                          │
 ⑧ EDIT            prose tightening + mechanical numeric diff        [spec'd, headline-only]
                          │
 ⑨ RULES           R-01…R-10 + numeric-consistency check                   [built, 4 bugs]
                          │
 ⑩ FIT & REFUSE    registry resolution · family permission · binding
      PD           hard constraints · premium cut placement                   [NEW]
                          │
 ⑪ APPROVE         Desk, 3h SLA — `auto_publish_wires` stays false        [built, correct]
                          │
 ⑫ RENDER          61 block renderers × 4 templates → SVG web / PNG email
      PD                                                                       [NEW]
```

Six of the twelve stages exist and work. Four are new. Two are built but blind or broken.

---

## 9. Sequencing, and what this changes about P4–P7

**P4 as currently written cannot succeed**, and it is worth being precise about why rather than
quietly renumbering it:

- **P4.7** says "build the missing object producers … promote `FILING.REF` for market-moving
  filings". *Promotion is not an available operation* for Lane B objects (§3.1).
- The **96 filings flagged `is_market_moving`** are a measurement of the 374 documents the
  extractor processed — 2.6% of the corpus — not of the corpus. The flag is set *by* the extractor.
- And there is nothing to write about: the documents are unread.

So two new phases, inserted rather than renumbering (the existing P4/P5/P7 step ids stay valid and
are amended in place):

| Phase | Name | Position | Depends on |
|---|---|---|---|
| **PE** | Signal enrichment — comprehension + eligibility | **hard prerequisite of P4** | none (data + bytes are live) |
| **PD** | Block & template system | **parallel to P1–P3**, prerequisite of P5.4 | none — front-end + registry, no producer dependency |

`PD` is deliberately parallel: it is pure front-end and registry work with **zero producer
dependency**, so it can proceed while PE is measuring page counts and running bake-offs. It is
also the phase that makes the seeded P3 editorial content render correctly, so it pays off before
the newsroom produces anything.

Full step lists, acceptance criteria and the new decisions (**D-8 … D-13**) are in
`docs/BRIDGE-BUILD-PLAN.md`.

---

## 10. Deliberately deferred

- **Arabic output.** Arabic *input* comprehension is in scope (Tier 1 routes bilingual pages).
  Arabic *publishing* remains locked per decision 4.
- **Decode-time constrained generation** (llguidance / XGrammar / outlines / GBNF). All require
  logits access; none has a usable Node binding; we call hosted APIs from a 4-core VPS. Schema
  validation plus a **bounded** repair loop (max 2, then human) is what we can actually run.
- **Adopting a document format** (Portable Text, ProseMirror, Lexical, ADF, MDX). We already have
  the better shape: rows in Postgres with per-block RLS and a citation join table. Borrow the
  `_key` convention and the missing-component posture; adopt nothing. **MDX is actively
  disqualified** — it compiles to executable JavaScript, and `next-mdx-remote` 4.3.0–5.0.0 carries
  CVE-2026-0969 (arbitrary code execution during SSR of untrusted MDX). Agent output is untrusted
  input by definition.
- **A workflow engine for editorial state** (Temporal / Inngest / Trigger.dev). Right for
  orchestration, wrong for document state, and unjustified infrastructure on a box already running
  the ingest fleet. `xstate` v5 is worth considering for *typing and visualising* the machine and
  deriving the SQL transition table — not for executing it.
- **A headless CMS** (Payload, Directus, Strapi, Decap). Adopting their content model to obtain a
  state machine we can write in 200 lines of SQL, and discarding our RLS-gated premium cut to do it.
- **Self-hosting the OCR model.** Start hosted; revisit if per-page cost or throughput says
  otherwise after the PE.2 bake-off.
- **Embeddings / pgvector.** Still deferred per `03 §14` and `04` (FTS-first). The research stage
  is deterministic SQL precisely so this stays deferred.

---

## 11. Open questions for the owner

| id | question | why it matters |
|---|---|---|
| **Q-1** | Is a **visible MinerU attribution** acceptable if MinerU ever enters the stack? | Its licence obliges prominent attribution for online services. PaddleOCR-VL (Apache-2.0) avoids it entirely — this only bites if the bake-off favours MinerU. |
| **Q-2** | Who signs off **price-sensitive lake objects** (§3.4)? | The DB requires a *human* principal. Today that is the owner alone; at volume it needs a named desk role. |
| **Q-3** | Does the **XLSX attachment** path (`BLK-FINTABLE` >8 rows, `BLK-DOWNLOAD`) ship with PD or later? | `content_attachments` exists and is empty; the block library assumes the overflow target exists. |
| **Q-4** | Confirm the **HF billing posture** — PAYG on a personal token, or BYOK to a provider account? | Changes nothing architecturally; changes who gets the invoice. |
