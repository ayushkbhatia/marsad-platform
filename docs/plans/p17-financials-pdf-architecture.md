# Plan — Financials, PDF-first: acquire → store → extract → validate → serve

> **Supersedes the Mubasher-scrape approach for #1 (DEF-STMT-INGEST).** Written 2026-07-14 after a
> live-probed research pass (`wbhc38d7d`). Mubasher's rendered financials are **too dirty to trust**
> (verified on Aramco 2222: `Total Assets` inconsistent by 1000× across periods — 2.5B vs 2.4T for the
> same company; −14.6T "gross profit"; a period literally labelled "annual budget"). The flagship Score
> cannot be fed unvalidated aggregator numbers. This plan pivots to the **source-of-truth PDFs**, stores
> them (also serving them for download — a reader feature), and extracts line-items through a **hard
> validation gate**. It unifies three deferred items into one pipeline: **DEF-STMT-INGEST** (statements
> → ratios/Score), **DEF-FILING-FACTS** (filing `full_text`/`extracted_facts`/`ai_summary`), and
> **DEF-STMT-LLM-PDF** (the PDF-extraction service).

## 0. TL;DR

- **One PDF, three payoffs:** the same statement PDF yields (a) the line-items the Score needs, (b) the
  filing full-text/facts/AI-summary the reader + search need, and (c) a **downloadable archived PDF**.
- **The hard part is not scraping, it's *trust*.** Every extracted number passes a deterministic
  validation gate (balance-sheet identity, subtotal foot, scale/currency detection, prior-period
  consistency) before it reaches `financial_statements`. This is the exact thing Mubasher lacked.
- **Reachability is the strategic fork:** the *authoritative* Saudi source (Tadawul/Efsah) is
  **Akamai IP-blocked from the VPS** (network-layer 403 — headless won't help, needs a proxy). **Argaam's
  S3 mirror is reachable now over plain HTTP** and covers all TASI/Nomu issuers with born-digital EN/AR
  PDFs. → **Bootstrap on Argaam now (no proxy), architect discovery to swap to Tadawul-official via a
  proxy later** (owner decision D-src-3, the same residential-egress call as Yahoo/BHB).
- **Storage + serve is already built** — reuse the public `filings` bucket + `StorageUploader`; the only
  new code is a non-gzip download-to-`filings` step + the extraction/validation service (`normalizeViaLlm`).

## 1. Reachability reality (live-probed from the VPS, 2026-07-14)

| Source | From VPS | Verdict |
|---|---|---|
| **Tadawul** `saudiexchange.sa/Resources/fsPdf/…` (authoritative, EN+AR, born-digital) | **403 Akamai on every path** incl. robots.txt; no separate CDN/API subdomain (NXDOMAIN) | **IP-blocked — proxy-only.** Best source; gated on egress (D-src-3). |
| **Argaam** `argaamplus.s3.amazonaws.com/{uuid}.pdf` + index `argaam.com/en/company/financial-pdf/{sector}/{year}` | **200 plain HTTP**, 2.2MB born-digital PDF, no WAF/auth on the S3 object | **Reachable NOW — the bootstrap spine for TDWL.** 3rd-party; uuids non-guessable (must scrape the index). |
| **Company IR** — SABIC `sabic.com/en/reportsearch/getreports` (JSON API!) | **200**, machine-readable report list + direct PDF | Clean where it exists; **bespoke per issuer** → not a full-universe spine. |
| Al Rajhi `/-/media/…pdf` | PDF host 200; listing JS-rendered (needs headless) | Fallback for specific big names. |
| **Aramco** `aramco.com/investors` | **000** (Akamai bot-manager h2 reset, all UAs) | Blocked — proxy-only. |
| **ADX/DFM/QE/MSX** disclosure systems | partially reachable (we already poll ADX/DFM/MSX filings) | **RESULTS filings already carry the statement-PDF url** — reuse the filings pipeline. |
| **BHB** | IP-blocked (existing gap) | coverage-gap venue. |

**Consequence:** per-venue strategy differs. TDWL = Argaam-now / Tadawul-proxy-later. ADX/DFM/QE/MSX =
their own disclosure systems, via the **existing filings poller** (RESULTS-type filings). BHB = gap.

## 2. What already exists (reuse — do NOT rebuild)

- **`filings` Storage bucket — public, CDN-served.** Any object at `filings/{key}` is downloadable
  unauthenticated at `https://<proj>.supabase.co/storage/v1/object/public/filings/{key}`. **The reader
  download feature is zero-code** — just put the PDF there.
- **`StorageUploader`** (`ingestion/src/core/storage.ts`) — service-role upload/download, bucket-parametrized.
  (Today only wired to the private gzipped `lake-raw`; we add a **raw, non-gzip** upload to `filings`.)
- **The filings poller + detail fetchers** — `filings_poll` + `enqueueFilingDetails`; TDWL/ADX already
  have `filingDetail` TaskSpecs whose `browser.get` returns PDF bytes. The list-diff (`ingest.seen_items`)
  is the incremental discovery for the venue-disclosure path.
- **Lineage schema** — `public.financial_statements.source_filing_id → public.filings(id)` +
  `source_object_id → lake.objects`. A statement row points at its source PDF/filing for free.
- **The normalizer** — `ingestion/src/lake/statement-normalizer.ts`: the §3.1 primitive-key contract +
  `NormalizedStatements` target + a **declared-throwing `normalizeViaLlm(RawStatementDoc)` seam** waiting
  for exactly this pipeline.
- **The LLM gateway** — `src/lib/llm/` (provider-agnostic, per-role routing, cost accounting). All LLM
  extraction routes through this, never a provider SDK.
- **The derived tier (deployed)** — `nightly` key_ratios + `score_batch` already consume
  `financial_statements.line_items`. Fill statements → the Score lights up with zero further derived code.

## 3. The architecture — five stages

```
 DISCOVER ─────────► ACQUIRE+STORE ─────► EXTRACT+VALIDATE ─────► PROJECT ─────► DERIVED
 (new statement       (download PDF →       (PDF→text→LLM→§3.1       (lake obj →    (nightly
  filings, per         public filings        primitives → HARD       fn_financials  key_ratios
  venue, INCREMENTAL)  bucket + snapshot)     validation gate)        _project)      → Score)
```

### 3.1 DISCOVER (incremental — the coverage invariant, `p17-continuous §2.1`)
Find **only new** statement filings. Never re-enumerate the whole market.
- **TDWL (bootstrap):** poll Argaam's index `financial-pdf/{sector}/{year}` → the `argaamplus.s3` uuid PDF
  links; **list-diff on the S3 uuid / (issuer, period)** so a run emits only statements not seen before.
  History = a one-time backfill; steady state ships new quarters only.
- **TDWL (upgrade):** when a proxy egress lands, swap the discovery adapter to Tadawul Efsah
  (`saudiexchange.sa` issuer-announcements → `/Resources/fsPdf/…`, authoritative + AR). Same downstream.
- **ADX/DFM/QE/MSX:** reuse the **filings poller** — a RESULTS-type filing *is* the statement disclosure;
  its `pdfUrl` (already projected to `public.filings.pdf_en_path`) is the PDF. `ingest.seen_items` already
  makes this incremental. Seed the missing `filing_detail` sources (DFM/QE/MSX) so the PDF is fetched.
- **Event-driven:** a new RESULTS filing → enqueue that one name's statement extraction (no polling).

### 3.2 ACQUIRE + STORE (reuse storage, add one step)
- Download the PDF bytes: Argaam S3 → **plain `ctx.http`**; venue-disclosure PDFs → **`browser.get`** (WAF).
- **Snapshot** the raw bytes (immutable, sha256 — the existing snapshot store, for replay).
- **Upload the raw (non-gzip) PDF to the public `filings` bucket** via `StorageUploader`, content-addressed
  key `{venue}/{sha256}.pdf`. Set `public.filings.pdf_en_path` (or a new `pdf_storage_key` column to avoid
  the 0037 projection re-clobbering it) to that key. → the **downloadable archived PDF** is now live.

### 3.3 EXTRACT + VALIDATE (the genuinely-new piece — where quality lives)
Implement the `normalizeViaLlm` seam as a **hybrid, validated** extractor:
1. **Text layer:** `pdftotext`/pdfplumber on the born-digital PDF (Saudi filings are native text, verified;
   OCR only when the text layer is empty — a conditional branch).
2. **LLM structured extraction:** feed the statement text to the LLM gateway with a **strict JSON schema**
   (constrained/structured output) → `{period, statement_type, currency, scale, line_items:{§3.1 keys}}`.
   Bounded per-filing cost; text (not vision) keeps it cheap. Route via `src/lib/llm` (role: extraction).
3. **HARD VALIDATION GATE (mandatory — this is what Mubasher lacked):**
   - **Scale/currency detection:** infer thousands/millions/units from magnitude + any header hint;
     **normalize every line item to actual currency units** (the Mubasher 1000× bug dies here).
   - **Accounting identities:** `total_assets == total_liabilities + equity` (tolerance); income subtotals
     foot to `net_income`; cash-flow sections reconcile to Δcash.
   - **Prior-period consistency:** a comparative must match the previously-stored value (±tol) or be flagged
     a **restatement**; reject impossible swings (a company's assets can't move 1000× QoQ — the exact
     Mubasher signature).
   - **Sanity bounds:** no negative gross profit at trillions; drop budget/forecast/non-actual periods.
   - On fail → **one LLM repair pass** (re-prompt with the failing check) → still failing → **queue to the
     Desk for human review** (never silently store a bad number). Store per-number provenance (page/bbox).
4. Output `NormalizedStatements` (§3.1 primitives), only for periods that PASS.
- **Idempotent/replayable:** keyed on `pdf sha256 + parserVersion`; a schema/prompt bump re-extracts old
  PDFs from storage with zero re-download.

### 3.4 PROJECT
- Write a VERIFIED lake object per statement (`STATEMENT.LINE` / `FILING.FINANCIALS`, `source_rank`, natural
  key `…:{venue}:{ticker}:{stmt}:{fiscal_period}`) → **new `lake.fn_financials_project`** (mirror
  `fn_filing_project`, migration 0042) → `public.financial_statements` (one row per
  `statement_type×basis×fiscal_period`, `line_items` jsonb, `source_filing_id` = the stored PDF's filing,
  `source_object_id` = lineage). Only validated data reaches `public.*`.

### 3.5 DERIVED (already live)
`nightly` → `key_ratios` reads the new `line_items` → real Value/Growth/Profitability → `score_batch` → a
credible multi-factor Score. No derived code to write.

### 3.6 The filing-facts bonus (DEF-FILING-FACTS, free from the same text)
The same extracted PDF text → `public.filings.full_text` (FTS + phrase-alerts), `extracted_facts` (typed
DPS/dates for dividends), and an LLM `ai_summary`. One pipeline closes three deferred items.

## 4. Build sequence (revised #1)

1. **Storage step:** generalize `StorageUploader` to the `filings` bucket + a `pdf_storage_key` column
   (migration) + a download-to-storage module. Effort **S**. (Immediately gives downloadable filing PDFs
   for the 6 RESULTS filings we already have urls for — a visible win before extraction exists.)
2. **Argaam TDWL discovery + acquire:** the index poller + S3 PDF fetch (plain http) + snapshot + store.
   Incremental (uuid list-diff). Effort **M**.
3. **Extraction + validation service** (`normalizeViaLlm` + the gate): `pdftotext` → LLM structured output
   → validation → `NormalizedStatements`. Fixture = a real Argaam Aramco PDF (which we can now fetch).
   Golden-tested; the validation gate unit-tested against the Mubasher-style garbage as negative cases.
   Effort **L** (the real work; the quality core).
4. **`lake.fn_financials_project` (0042) + wire** → `financial_statements` → re-run `nightly` → confirm real
   ROE/margins/growth for Aramco. Effort **S**.
5. **Fan out:** ADX/DFM/QE/MSX via the filings-poller RESULTS path + seeded `filing_detail` sources; TDWL
   upgrade to Tadawul-official once a proxy lands. Effort **M** each.

## 5. Cost + risks

- **LLM cost:** born-digital text (not vision) extraction, bounded per-filing, via `src/lib/llm` cheapest-
  provider routing. ~hundreds of issuers × quarterly, incremental (only new filings) → modest, and the
  cheapest-run-cost constraint holds because it's per-new-filing, not per-nightly.
- **Argaam dependency:** S3 is public now but 3rd-party — could paywall/move; uuids need index-scraping.
  Mitigate: treat as bootstrap mirror, add schema-drift guards, upgrade to Tadawul-official (proxy) for the
  authoritative spine. **Never the sole long-term source.**
- **Extraction accuracy:** LLM ~84–90% unvalidated on financial tables → **the validation gate is not
  optional**; expect a real human-review queue on merged-cell/restatement edge cases. This is correct: a
  wrong fundamental is worse than a missing one (the Mubasher lesson).
- **Proxy for the authoritative source:** Tadawul + Aramco need a residential/GCC egress (D-src-3). Argaam
  removes this from the critical path for *bootstrap*, not for *authoritative* coverage.
- **Public bucket:** filings are public disclosures → fine to serve openly; never let gated/premium content
  land in the `filings` bucket.

## 6. Owner decisions

- **D-fin-1 · Bootstrap source:** Argaam-now (reachable, all-issuer, no proxy) vs wait for a Tadawul proxy
  (authoritative, EN+AR). *Recommend: Argaam now, proxy-upgrade the discovery adapter later — don't block
  the Score on egress funding.*
- **D-fin-2 · Extraction model/cost:** which LLM role/provider for the extraction + repair passes (cost vs
  accuracy). *Recommend cheapest-capable via the gateway + the validation gate as the safety net.*
- **D-src-3 (existing) · Proxy egress:** funds Tadawul-official + Aramco + BHB + Yahoo. Still the real
  unlock for authoritative, uniform, all-venue coverage.
- **D-fin-3 · Human-review queue:** confirm the Desk absorbs validation-fail statements (volume TBD from the
  first real batch).
