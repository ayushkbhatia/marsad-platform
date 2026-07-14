# Plan — P1.7b → P1.7e: fundamentals, ratios, the Marsad Score, filings, ownership

> **Self-contained handoff.** Paste into a fresh chat: *"ultracode — execute
> docs/plans/p17b-e-fundamentals-score-filings.md."* Assumes NO prior conversation context.
> The authoritative spec is **`docs/architecture/07-lake-enrichment.md`** — this plan distils it into an
> executable, phased build. Read 07 §3 (derived pipeline + ratio catalog + Score methodology) and §4/§5
> alongside. Written 2026-07-14.
>
> **Companion (the operating architecture):** the code spine from this plan landed 2026-07-14 (commit
> `329bfa7`). The *continuous* operating side — the researcher-agent fleet + derived-refresh agents that
> keep each data family (statements/ratios/filings/earnings/dividends/people/ownership) current on the
> existing scheduler, generalizing P1.7a's backfill+refresh two-feed pattern — is
> **`docs/plans/p17-continuous-enrichment-researchers.md`**. This plan = *what to compute*; that plan =
> *how the lake stays fed*.

---

## 0. TL;DR + the critical path

```
P1.7a price history ──┐
                      ├─→ P1.7c  Marsad Score v1  ─→  P2 reader
P1.7b statements+ratios┘
P1.7d filings/div/earnings  (parallel; feeds the reader + Revisions groundwork)
P1.7e ADX-native / ownership / people  (trails P2)
```

- **7b (fundamentals + ratios)** — the data gate for the Score. Buildable NOW (Yahoo egress solved; Mubasher shapes captured). The biggest scrape. **Start here.**
- **7c (Marsad Score v1)** — the flagship. 100% derived, zero external cost, pure math. Buildable as an engine now (synthetic data) but only *runs* once 7b lands. Needs owner sign-offs **D-1…D-10**.
- **7d (filings publish + dividends + earnings actuals)** — mostly free from the filings corpus; runs **in parallel** with 7b (independent). Includes the deferred `public.filings` publish path.
- **7e (ADX-native depth + ownership + company_people)** — trails P2; fills gaps.

**Current state (2026-07-14):** every 7b–7e table is EMPTY — `key_ratios`, `financial_statements`,
`scores`, `filings` (FILING.REF objects exist in the lake but no publish path), `earnings_events`,
`estimates`, `dividends`, `ownership_snapshots`; `company_people` **not created**. `securities`=660,
`ohlcv_daily` landing (7a). Quote persist (0031) + all ingestion infra are fixed and working.

---

## 1. Context you can rely on (already built)

- **Repo**: this dir. **DB**: Supabase `yjsncnpbjuueaoeejrqj` (`execute_sql` reads; `apply_migration` DDL). **VPS**: `ssh deploy@91.99.99.85`, `/opt/marsad`, systemd `marsad-worker`, deploys from `main`.
- **LLM gateway**: `src/lib/llm/` — Anthropic ↔ OpenRouter ↔ Ollama swap by env (per-role routing + cost accounting). Use this for every LLM step; never call a provider SDK directly.
- **Ingestion pipeline**: fetch → snapshot → parse → stage (`lake.staging_rows`) → cross_check → `lake.objects` → projection triggers → `public.*`. Snapshot-first, config-driven adapters, rotating proxy, BrowserClient for WAF. Proven end-to-end for quotes/OHLCV/filing-refs.
- **Crons (pg_cron, all active)**: `nightly_omnibus` `0 22 * * *` UTC (=02:00 GST), `score_batch` `0 0 * * *` (=04:00 GST), `ohlcv_accrual` `0 18 * * *`. pg_cron **enqueues** to pgmq; the VPS worker **executes**.
- **Sourcing reality (07 §2.2, live-probed)**: Mubasher deep-fundamentals = **TDWL + ADX only** (DFM/QE render empty). Yahoo `fundamentals-timeseries` = **DFM/QE**. MSX = `.aspx` + PDF. BHB = gap. Analyst consensus estimates = **no cheap source** (Revisions ships NULL).
- **Owner** is an ex-hedge-fund PM — the methodology decisions (§5) want his sign-off, not a default.

---

## 2. The shared hard part — the statement-normalization service (build first, 7b depends on it)

Per `01-ingestion.md §9` + 07 §D: the real work in 7b is **not scraping, it's standardization** — mapping
each venue's messy line items onto ONE canonical schema. This is an **LLM-extraction job**, and it's shared
across 7b (statements), 7d (filing full-text/facts), and MSX/BHB PDFs.

**Deliverable:** a normalization service that takes raw statement content (Mubasher HTML table / Yahoo
JSON / MSX PDF text) and emits the **§3.1 primitive keys** into `financial_statements.line_items` (jsonb),
per period (quarterly + annual + a computed **TTM** row, `period_kind='ttm'`):

`revenue` (banks: `total_operating_income`), `gross_profit`, `ebit`, `dep_amort`, `net_income`,
`eps_diluted`, `equity`, `total_assets`, `total_debt`, `cash`, `capital_employed` (derived
`total_assets − current_liabilities`), `nii`/`avg_earning_assets` (banks), `dividends_paid`.

- **Hybrid** (owner-chosen "max coverage"): rule-based deterministic mapping for **structured** sources
  (Mubasher/Yahoo — shapes captured in 07 §2.2), LLM-extraction for **PDF/messy** sources (MSX/BHB).
- LLM cost is per-filing, bounded; route through `src/lib/llm/`.
- This is **Effort L** and gates 7b's ratios. Contract it FIRST (define the primitive keys + a validation
  harness), so the venue adapters have a fixed target.

---

## 3. P1.7b — Fundamentals + ratios  ·  the data gate  ·  Effort L

Read 07 §1.1 D (statements), §1.1 C (ratios), §3.1 (primitives), §3.2 (ratio catalog), §3.3 (sector-conditional validity).

**3a. Statement ingestion (populate `financial_statements`, ≥8 trailing quarters + 3–5 annual):**
- **TDWL/ADX**: Mubasher `/financial-statements` + `/ratios`. Scrape with a **content-poll on the table selector**, NOT `networkidle` (ad scripts keep the network busy → false "no data"). Shapes captured (07 §2.2 "Exact shapes"). New adapter(s); reuse the BrowserClient content-poll pattern.
- **DFM/QE**: Yahoo `fundamentals-timeseries` (multi-year standardized) — egress solved via the rotating proxy. QE native HTML tables as the 2nd source.
- **MSX**: `msx.om` `.aspx` tables + the **PDF-extraction pipeline** (§2). Depth-limited.
- Route each through the §2 normalizer → `financial_statements.line_items`.

**3b. The `[NEW COL]` migration on `public.key_ratios`** (07 §3.2, forward-only additive):
`net_margin, gross_margin, rev_growth_yoy, eps_growth_yoy, rev_cagr_3y, eps_cagr_3y, ret_3m, ret_6m,
ret_12_1, ebitda_ttm numeric(20,2), currency_computed char(3)`. (Exact DDL is in 07 §3.2.)

**3c. `fn_recompute_key_ratios()`** — SQL, **sector-aware** (07 §3.2 formulas + §3.3 validity map):
- Valuation (price+fundamentals): market_cap, pe, pb, ps, eps_ttm, book_value_ps, ev_ebitda.
- Profitability: roe, roce, net_margin, gross_margin (null banks/insurers), nim (banks).
- Leverage: net_debt_ebitda (null/flag banks). Income: dividend_yield, payout_ratio.
- Growth (multi-period). Momentum (from `ohlcv_daily`, div-adjusted — §3.2).
- **Sector map (owner D-1)**: banks/insurers use P/B+ROE+NIM, **NOT** EV/EBITDA / gross margin / net-debt. GCC is ~40–60% banks — getting this wrong is the fastest credibility loss. The fn MUST consult a sector→valid-ratio map, not blind-average.
- TTM = trailing-4Q sum for flows, latest for stocks/balance.
- **Wire into `nightly_omnibus` @ 02:00 GST** (reads `financial_statements` TTM + `quotes_latest` + `dividends` + `ohlcv_daily` → writes all `key_ratios` cols). It's a **complete-table** job — all 812 names ratio-complete before any Score percentile is valid.

**Approach:** a **TDWL vertical slice first** — Mubasher statements → normalize → `financial_statements` →
`fn_recompute_key_ratios` → `key_ratios` for TDWL end-to-end. Then fan out to ADX (Mubasher), DFM/QE
(Yahoo), MSX (PDF). Same "prove the chain on one venue, then scale" play that worked for 7a.

**Buildable now:** yes — 3b (migration) and the SQL skeleton of 3c need no live data; 3a needs the
normalizer (§2). Egress + shapes are ready.

---

## 4. P1.7c — Marsad Score v1  ·  the flagship  ·  Effort L (the IP; no external deps)

Read 07 §1.1 E, §3.4 (five factors + weights), §3.5 (normalization/grades/missing-data), §3.6 (nightly
compute order), §3.7 (minimum credible inputs). **Pure math over the lake, zero LLM/API cost.**

**Build `worker/agents/score.ts`** (does NOT exist yet) — runs in `q_maintenance` off the `score_batch`
cron (already scheduled 04:00 GST):
1. Build **GCC-wide sector cohorts** (owner D-2 — a Saudi bank + a Qatari bank in one "Banks" cohort; FX pegs make it clean). Min cohort 8; thinner → `thin_cohort=true`.
2. Per metric: **winsorize 2/98** (D-9, kills scrape outliers) → **percentile-rank** 0–100 (D-10, distribution-free) → **factor score** = weighted avg of component percentiles, weights renormalized over non-null.
3. Five factors (§3.4): **Value** (E/P, P/B⁻¹, EV/EBITDA⁻¹, div-yield; **bank override**), **Growth**, **Profitability**, **Momentum** (ret_12_1/ret_6m/ret_3m/52w — div-adjusted), **Revisions** (ships **NULL**, D-8, no consensus source).
4. **Composite** `0.25·V + 0.20·G + 0.20·P + 0.20·M + 0.15·R` (weights D-3) → re-percentile across the full universe → `scores.score`. Sector percentile stored too.
5. **Rating bands** (D-4): 80–100 BUY … 0–19 SELL. **Factor grades** A+…D- (regex `^[A-D][+-]?$` already enforced).
6. **Missing-data rules (D-5)**: a factor needs ≥50% component weight non-null else grade=NULL + dropped from composite (renormalize); a name needs ≥3 of 5 factors to publish a `scores` row; never impute zeros; new listings gated by `securities.score_eligible_from` (listing+90 trading days).
7. Write `scores` / `score_history` / `score_events` (diff vs yesterday) + one `COMPUTED.SCORE` lake object/name (lineage). **Freshness-gate abort**: if `max(key_ratios.computed_at) ≤ today 02:00`, abort + alert (don't score on stale ratios).
8. **Event trigger**: on `earnings_events.verdict` set → single-name recompute into `q_maintenance` against the last nightly cohort snapshot (updates Revisions grade).
9. Seed `securities.score_eligible_from` in the listing job (90 trading days); add `estimates_agg` cron @ 23:00 GST (harmless while empty).

**Minimum credible v1 (§3.7):** Value + Profitability + Momentum are fully buildable from data we ingest;
Growth needs 4–8 quarters; Revisions = NULL. Ship on 3 of 5 factors.

**Buildable now:** the engine + unit tests against synthetic `key_ratios` — yes. It *runs* once 7b lands.

---

## 5. P1.7d — Filings upgrade + dividends + earnings actuals  ·  Effort M  ·  runs PARALLEL to 7b

Read 07 §1.1 F/G/H. Filings **lists** already reach the lake as FILING.REF objects — this is enrichment + a publish path.

- **`public.filings` publish path (deferred DEF-FILINGS-PUBLISH)**: FILING.REF `lake.objects` → `public.filings`. Single-source filings stay PENDING forever (no 2nd source), so define a publish rule (fan-out from lake.objects → public, OR reader reads lake.objects). This is a reader/design call — resolve it.
- **F upgrade**: PDF→EN `full_text` extraction → `extracted_facts` jsonb typing → `ai_summary` (LLM via `src/lib/llm/`). The **one bounded LLM cost** in the plan. Uses the §2 PDF-extraction pipeline.
- **H dividends**: parse DIVIDEND filings' `extracted_facts` → `public.dividends` (+ Mubasher `/corporate-action` for TDWL/ADX). Wire the `pending_confirm → live` **human-confirm gate** (33b). Feeds `dividend_yield`/`payout_ratio` in 7b.
- **G earnings actuals**: parse results filings → `earnings_events` (`eps_actual`, `revenue_actual`, `verdict`, `surprise_pct`, `rvc_table`). Consensus stays sparse (no source, OQ-10). This is what fires the Score's event-driven Revisions recompute (7c step 8).

**Buildable now:** the publish path + dividends/earnings parsing (FILING.REF objects exist). Full-text needs the PDF pipeline.

---

## 6. P1.7e — Exchange-native depth + ownership + people  ·  Effort M  ·  trails P2

Read 07 §1.1 I/J, §1.2, §4 P1.7e.

- **ADX native** `financial-reports.json` / `overview.json` as ADX's authoritative fundamentals source + cross-check vs Mubasher (07 §2.2). Feeds 7b for ADX.
- **J ownership**: Mubasher `/major-shareholders` (TDWL/ADX, with history) + venue/registrar disclosures + >5% filings → `ownership_snapshots` / `holders` / `holder_positions`. Quarterly, low volume.
- **I people**: **create `company_people`** (a "Missing entity" per `02-data-lake.md`; DDL: name, role, is_independent, seat_count) + scrape board/management from venue profile pages / filings. Also `shares_outstanding` (load-bearing for market_cap — verify it's populated on `securities`).
- **AI profile prose / pros-cons** over the filings corpus (LLM, bounded).
- **BHB**: proxy-gated; likely accept as coverage-gap (see the ADX/MSX/BHB backfill plan; owner D-src-4).

---

## 7. Cross-cutting blockers (resolve early — they gate multiple phases)

1. **Statement-normalization service** (§2) — gates 7b + 7d + MSX/BHB depth. Build first.
2. **`company_people` table** — create before 7e-I. Effort S.
3. **PDF-extraction pipeline** — MSX/BHB statements + F full-text + statement backfill. Effort L, shared.
4. **Yahoo egress** — SOLVED (rotating proxy). No longer a blocker.
5. **Consensus-estimate source (OQ-10 / D-src-5)** — Revisions factor + the analyst-target strip have no cheap source. Until resolved: Revisions = NULL, PT strip sparse. Owner call.

---

## 8. Owner decisions to resolve (surface these; don't silently default) — 07 §5

**Methodology:** D-1 sector-conditional ratio map (banks≠EV/EBITDA — *critical*) · D-2 GCC-wide cohorts ·
D-3 factor weights 25/20/20/20/15 · D-4 rating bands · D-5 min coverage (≥3 of 5 factors) · D-6
div/split-adjusted momentum (mandatory for correctness) · D-7 no EPS one-off normalization in v1 · D-8
Revisions ships NULL · D-9 winsorize 2/98 · D-10 percentile over z-score.
**Sourcing:** D-src-1 per-venue verification tier · D-src-2 aggregator-first · D-src-5 consensus source ·
D-src-6 statement depth floor (8Q).
All have a doc recommendation — get the ex-PM's yes/override on D-1…D-6 before 7c ships a number.

---

## 9. Agent workflow structure (how to build it)

Not parallel-venues like 7a — this is a **critical path with two parallel tracks**:

**Track A (the Score path, sequential):** §2 normalizer contract → 7b TDWL vertical slice → 7b fan-out (ADX/DFM/QE/MSX) → 7c Score engine (build against synthetic data in parallel, wire once 7b lands).
**Track B (parallel, independent):** 7d filings publish path + dividends + earnings actuals.
**Track C (trailing):** 7e ADX-native + ownership + company_people.

Suggested workflow phases:
1. **Design/contract (parallel):** the §3.1 primitive schema + validation harness; the `[NEW COL]` migration; the `fn_recompute_key_ratios` SQL skeleton (sector map stubbed); the `score.ts` interface + synthetic-data unit tests; the `public.filings` publish-rule decision.
2. **Build 7b vertical slice + 7d in parallel:** TDWL Mubasher statements→ratios end-to-end; filings publish + dividends.
3. **Fan out + wire Score:** other venues' statements; `score.ts` against real `key_ratios`; `nightly_omnibus`/`score_batch` verification.
4. **7e** as a trailing phase.

Agents editing shared files (`runtime.ts`, `core/types.ts`, migrations) concurrently → use
`isolation:'worktree'`.

---

## 10. Guardrails + verification

- **Pure parse / config-driven** adapters (no `Date.now` in parse). LLM only via `src/lib/llm/`. Test against captured fixtures, zero network in unit tests.
- **Cost discipline** (locked constraint): the derived pipeline (ratios + Score) is ~zero marginal cost — keep it SQL/pure-math. LLM cost lives only in 7d full-text + 7e prose, bounded per-filing.
- **Migrations** timestamp-prefixed (next after `20260713000032`), applied via `apply_migration` AND committed.
- **Doc-sync convention** (`AGENTS.md`): log deferred items to `BUILD-STATUS.md §7`; on completion mark done + update `07-lake-enrichment.md` + tick the datapoint-family status.
- **Don't disturb** the running 7a backfill / worker config; pooler ceiling is 25.
- **Verification per phase:** 7b → `key_ratios` populated for the universe, screener `fn_screener_run` returns rows, p95 < 100ms. 7c → `scores` rows for ≥3-factor names, ratings/grades sane, `score_history` diffs, freshness-gate works. 7d → `public.filings` rendering, `dividends` with the confirm gate, `earnings_events` verdicts firing the Score recompute. 7e → `ownership_snapshots` + `company_people` populated.

**Definition of done for this plan:** a credible **Marsad Score** across the 812 universe (Value +
Profitability + Momentum minimum, Growth where available, Revisions NULL), backed by populated
`financial_statements` + `key_ratios`, with filings/dividends/earnings feeding the reader and the Score's
event recompute — all reconciled into `BUILD-STATUS.md` + `07-lake-enrichment.md`.
