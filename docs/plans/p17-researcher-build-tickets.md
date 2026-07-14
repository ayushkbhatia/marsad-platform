# P1.7 Researcher / refresh — executable build tickets

> Plan of record for the continuous-enrichment build (items #1–#6). Generated 2026-07-14 from a code-grounded
> scoping pass (6 parallel scopers, live-probed). Companion to `p17-continuous-enrichment-researchers.md`
> (the architecture) — this doc is the *executable* per-item ticket. Sequence + guardrails: that plan §5–6.
>
> **LOCKED cross-cutting rule for every ticket below — incremental-only (no full-runs)** (`p17-continuous §2.1`):
> each researcher must gate its symbol injector to only securities that need work (coverage/freshness flag +
> `external_id` list-diff + event-driven-on-filing), so a steady-state run fetches nothing and writes zero
> rows unless genuinely new data landed. PR#3's `securities.ohlcv_backfilled_at` is the reference pattern.
> Applies per ticket: #1 financials = `period_end`-vs-expected-period gate + RESULTS-filing event; #6
> dividends = `external_id` list-diff (`ingest.seen_items`); #2 sector/people = capture/staleness flag +
> GOVERNANCE-filing event; #5 derived = recompute only the changed-security set (`securityIds` slice).


## Summary

| # | Item | Effort | Key dependency |
|---|---|---|---|
| #1 | DEF-STMT-INGEST — Financials Researcher: TDWL/Mubasher vertical slice  | L | statement-normalizer.ts (BUILT — normalizeMubasherStatements |
| #2 | SECTOR + PEOPLE SCRAPE (DEF-SECTOR-DATA + P1.7e-I): a `people` DataTyp | L | ingestion/src/core/types.ts DataType union + VenueAdapter sl |
| #3 | ADX/MSX OHLCV backfill unstuck: fix duplicate User-Agent header that M | S | ingestion/src/core/fetcher.ts (header merge), Worker redeplo |
| #4 | V-1 EOD Accrual Validation: prove ohlcv_accrual mints one correct bar/ | M | A live GCC trading session (next: 2026-07-14 18:00 UTC first |
| #5 | Set-based nightly key_ratios recompute — batch the DB I/O (Option B),  | M | Rebase this worktree onto origin/main HEAD (a489fe4 / 487ed9 |
| #6 | Scope Item 6 — Dividends Researcher (Mubasher /corporate-action → publ | L | Pull origin/main to sync migrations 0039-0041 into the workt |


---

## #1 Financials researcher — effort L

**Title:** DEF-STMT-INGEST — Financials Researcher: TDWL/Mubasher vertical slice populating public.financial_statements

**Files to create/edit:** `ingestion/src/core/types.ts (add NormalizedFinancialStatement + VenueAdapter.financials slot)`, `ingestion/src/core/browser.ts (add waitForContent to BrowserPage interface)`, `ingestion/src/core/playwright-driver.ts (implement waitForContent content-poll)`, `ingestion/src/adapters/mubasher/financials.ts (NEW — TaskSpec fetch+parse)`, `ingestion/src/adapters/mubasher/financials.test.ts (NEW — golden test)`, `ingestion/src/adapters/mubasher/index.ts (export financials, add to mubasherTasks)`, `ingestion/src/adapters/tdwl/index.ts (mount tdwlAdapter.financials)`, `ingestion/src/runtime.ts (tasksForDataType financials case + isFinancial/mapFinancial in mapRowsToStaging + financials symbol injection)`, `ingestion/fixtures/mubasher/financial-statements-2222.html (NEW — rendered-table fixture for the parser golden test)`, `supabase/migrations/20260713000042_financials_project.sql (NEW — lake.fn_financials_project trigger + backfill)`, `supabase/migrations/20260713000043_tdwl_financials_source.sql (NEW — ingest.sources+schedules seed active=false + RESULTS-filing wake-up trigger)`, `supabase/migrations/20260713000044_activate_tdwl_financials.sql (NEW — flip active=true after VPS deploy)`, `worker/src/ingest-poller.ts (add 'financials' → handler mapping IF financials needs its own handler routing)`, `docs/BUILD-STATUS.md (mark DEF-STMT-INGEST done, update §5/§7)`, `docs/architecture/07-lake-enrichment.md (tick P1.7b, update §2.2/§4 build-status note)`

**Dependencies:** statement-normalizer.ts (BUILT — normalizeMubasherStatements/normalizeMubasherRatios/deriveTtm/validateNormalizedPeriod); key-ratios.ts gatherInputs (BUILT — reads financial_statements.line_items by §3.1 primitive keys); lake.objects state machine + one-live-per-key (0004); public.financial_statements DDL + unique key (0006); ingest.sources/schedules + enqueue_due_jobs scheduler (0005/0017); ingest-poller data_type→handler routing (worker/src/ingest-poller.ts — NOTE: no 'financials' mapping today; financials sweep reuses quote_poll's source-scoped path OR needs a DATA_TYPE_TO_HANDLER entry — CONFIRM); cross-check sweep + FILING.REF projection template (0037); playwright browser driver (needs a NEW waitForContent content-poll primitive); DEF-SECTOR-DATA (parallel — needed for Score cohorts, NOT for key_ratios)

**Live probes needed:** Mubasher /financial-statements + /ratios page shape for TDWL 2222 from the VPS: JSON API vs Angular HTML? capture the settled tableSelector + real table markup (the .json fixture is the normalized shape, NOT a captured live response) — ssh deploy@91.99.99.85; Confirm Mubasher stock 'code' == public.securities.ticker exactly across the TDWL universe (else projection silently drops statements on security_id resolution); Does the ingest-poller need a 'financials'→handler entry in DATA_TYPE_TO_HANDLER, or does financials ride quote_poll's source-scoped runTask path? (worker/src/ingest-poller.ts line ~40); Confirm normalize_rules needed to dedupe an unchanged statement page (any per-response volatile bytes in the rendered HTML); Confirm owner's exact-vs-approximate weekly cadence preference: cadence_minutes=10080 approximation vs a dedicated pg_cron '0 9 * * 6' enqueue

**Open questions:** Live Mubasher financials transport: JSON endpoint (plain http) or Angular HTML content-poll (headless)? Determines whether fetch uses ctx.http or ctx.browser+waitForContent, and whether parse does JSON.parse or HTML table extraction. RESOLVE ON PROBE before building fetch.; ingest.schedules has no day-of-week column — weekly Sat 09:00 UTC is either an approximate cadence_minutes=10080 or a dedicated pg_cron entry. Which does the owner want?; RESULTS-filing event-driven refresh: SQL after-insert trigger on public.filings (filing_type='RESULTS') enqueuing a job_queue wake-up (preferred, no worker change) vs a TS worker hook. Confirm the trigger approach is acceptable given filings project via lake.fn_filing_project.; Extending the FROZEN VenueAdapter surface (types.ts) with a financials slot — brief authorises it, but needs a CONTRACT.md sign-off note per the types.ts header rule.; TTM: Mubasher TDWL is annual-only, so deriveTtm emits nothing; key-ratios ttmFlow falls back to latest annual as TTM proxy. Acceptable for v1 (matches 07 §3.7 'Growth needs 4-8 quarters')? Quarterly statements are a later enrichment.


# DEF-STMT-INGEST — Financials Researcher (TDWL / Mubasher vertical slice)

## Objective
Populate `public.financial_statements` from a live Mubasher scrape of TDWL (Tadawul) so the already-deployed nightly `key_ratios` recompute + `score_batch` produce real Value/Growth/Profitability factors. Today `public.financial_statements` is **empty (0 rows, verified live)**, `key_ratios` has 200 rows all with null fundamentals, and the Score has no V/G/P inputs. This ticket builds the TDWL slice end-to-end (adapter TaskSpec → staging → lake object → projection trigger → `financial_statements`) and is designed to fan out to ADX (same Mubasher shape), DFM/QE (Yahoo timeseries — normalizer already built), MSX (PDF) as follow-on sub-tickets.

The hard part — the statement normalizer — is **already built and golden-tested**: `ingestion/src/lake/statement-normalizer.ts` exports `normalizeMubasherStatements`, `normalizeMubasherRatios`, `normalizeYahooTimeseries`, `validateNormalizedPeriod`, `deriveTtm`, and the `NormalizedStatements`/`NormalizedPeriod` types. This ticket **wires** to it; it does not reinvent it.

## Exact approach

### The end-to-end shape the builder is reproducing (mirror the OHLCV/quote pattern exactly)
`fetch (impure)` → `runtime.runTask` snapshots → `parse (PURE)` emits `NormalizedFinancialStatement[]` rows → `mapRowsToStaging` (NEW shape branch) → `lake.staging_rows` → cross-check-sweep/cross-check → `lake.objects` (object_type `FILING.FINANCIALS`, single-source PENDING) → **NEW projection trigger `lake.fn_financials_project`** → `public.financial_statements`. Nightly `key_ratios` (`ingestion/src/lake/key-ratios.ts`) then reads `financial_statements.line_items` by the §3.1 primitive keys.

### 1. The `financials` slot on VenueAdapter (frozen surface — needs CONTRACT sign-off note)
`ingestion/src/core/types.ts`:
- Add a new normalized row shape (§6 block). Mirror `NormalizedFiling`. Suggested:
```ts
/** §6.6 → public.financial_statements via lake object (one row per statement×basis×fiscal_period). */
export interface NormalizedFinancialStatement {
  venue: VenueCode;
  ticker: string;                                   // resolve → securities.id via (venue_code, ticker)
  statementType: 'income' | 'balance' | 'cashflow'; // → statement_type
  basis: 'consolidated' | 'standalone';             // → basis (default 'consolidated')
  periodKind: 'quarter' | 'annual' | 'ttm';         // → period_kind
  fiscalPeriod: string;                             // → fiscal_period, e.g. 'FY2025'
  periodEnd: string;                                // 'YYYY-MM-DD' → period_end
  currency: string;                                 // char(3) → currency
  lineItems: Record<string, number | null>;         // → line_items jsonb (§3.1 primitive keys)
  isEstimate?: boolean;                             // → is_estimate (default false)
}
```
- Add `financials?: TaskSpec<NormalizedFinancialStatement>;` to the `VenueAdapter` interface (alongside `quotes`, `filingDetail`, etc.).
- **Note in `types.ts` header + CONTRACT.md**: this extends the frozen surface — the brief authorises it ("add a financials slot to VenueAdapter"). Keep the field optional so all existing adapters are byte-identical.

### 2. The TaskSpec — `ingestion/src/adapters/mubasher/financials.ts` (NEW)
Model on `ingestion/src/adapters/mubasher/ohlcv-csv.ts` (per-ticker sweep, config-driven, meta-carried venue/ticker, PURE parse recovering identity from `snapshot.meta`).

**fetch (impure):**
- Per-ticker sweep over `endpoint_config.symbols` (RAW TDWL tickers, injected by the runtime — see §5). Bounded-concurrency `runPool` + streaming `ctx.onFetched` sink exactly like `ohlcv-csv.ts` (`fetchConcurrency` default 4). Each ticker emits **two** `FetchResult`s (or one combined) — one for `/financial-statements`, one for `/ratios`.
- **CRITICAL — content-poll, NOT networkidle (07 §2.2):** Mubasher's `/financial-statements` + `/ratios` pages are **Angular client-rendered HTML**, not a JSON API (unlike `/stocks/prices` which the quotes adapter hits). The doc is explicit: "Must scrape with a **content-poll on the table selector**, NOT `networkidle` (ad scripts keep the network busy → false 'no data' 4/6 times in testing)." **This means `transport: 'headless'`** (Playwright, `ctx.browser`), not plain `ctx.http`. The current `playwright-driver.ts` `newPageAndGoto` hardcodes `waitUntil: 'networkidle'` and its `BrowserPage` exposes only `discoverAjaxUrl`/`captureResponseUrl`/`settle`/`close` — **there is no `waitForSelector`/content-poll primitive yet**. The builder must add one:
  - Extend `BrowserPage` (in `ingestion/src/core/browser.ts`) + the Playwright driver (`playwright-driver.ts`) with a `waitForContent(selector: string, timeoutMs: number): Promise<string>` that does `page.goto(url, { waitUntil: 'domcontentloaded' })` then `page.waitForSelector(selector, { timeout })` then returns `page.content()` (the settled HTML). Selector comes from `endpoint_config.tableSelector` (config over code).
  - fetch() stamps `meta: { venue, ticker, statement: 'financial-statements'|'ratios', lang:'en', source:'mubasher', delayed:true }` on each FetchResult so the PURE parser recovers identity from `snapshot.meta` (the HTML carries no reliable venue/ticker key). This round-trips through the snapshot store exactly as `ohlcv-csv.ts` meta does.
  - Per-ticker isolation: a 404/empty-table ticker returns null and is skipped, never aborting the sweep.
- **OPEN QUESTION / LIVE PROBE (see below):** whether Mubasher exposes a JSON endpoint for these two datasets (the `financial-statements-2222.json` fixture is the *normalized* shape, hand-built from the rendered table, NOT a captured live API response). If a JSON API is found on the live probe, fetch reduces to plain `ctx.http` and parse skips HTML extraction — much cheaper. **Resolve on the VPS before building fetch.**

**parse (PURE — no I/O, no Date.now, replayable):**
- Recover `venue`, `ticker`, `statement` kind from `snapshot.meta`.
- If `statement === 'financial-statements'`: extract the label×year table out of the HTML into the exact `{exchange, code, currency, columns, rows:[{label, values}]}` shape the normalizer consumes (this is the fixture shape), then call `normalizeMubasherStatements(doc)` → `NormalizedStatements`. **The HTML→doc extraction is the one net-new pure code** (a deterministic table parse: find the table by header row `columns`, read `<tr>` label + `<td>` value cells). If the live probe finds JSON, `JSON.parse` replaces the HTML extraction and everything downstream is unchanged.
- If `statement === 'ratios'`: extract the flat ratio grid → `{ratios:{...}}` shape → `normalizeMubasherRatios(doc)`. Ratios are a **cross-check signal** (07 §2.2: "a cross-check source for our own ratios-compute.ts output"), NOT line items — carry them on the object payload for later reconciliation, do not write them to `financial_statements.line_items`.
- **Split the mixed-statement grid into rows.** `normalizeMubasherStatements` emits ONE `NormalizedPeriod` per year with `statementType:'income'` carrying balance+income keys together (see its header comment). The parser/mapper must **re-split each period into per-`statement_type` `NormalizedFinancialStatement` rows** so the unique key `(security_id, statement_type, basis, fiscal_period, is_estimate)` and `key-ratios.ts`'s per-statement_type reads work. Concretely, for each normalized period, emit up to 3 rows keyed by which primitive keys are present:
  - `income`: `revenue, gross_profit, ebit, net_income, eps_diluted, nii`
  - `balance`: `equity, total_assets, total_debt, cash, current_liabilities, capital_employed, avg_earning_assets`
  - `cashflow`: `dep_amort, dividends_paid`
  - Skip a statement_type whose key subset is entirely empty (Mubasher TDWL gives Total Assets/Owners' Equity/Net Income/Gross Profit + the 3 cashflow rows → income+balance+cashflow all non-empty in the fixture; ebit/debt/cash/eps are absent and simply omitted, per the normalizer's "never guessed" rule).
- Also call `deriveTtm(periods)` to emit `period_kind='ttm'` rows (empty when <4 quarters; Mubasher gives annual-only, so TTM is empty for the TDWL slice — that's fine, `key-ratios.ts` `ttmFlow` falls back to latest annual as the TTM proxy).
- Zero rows on a CHANGED snapshot ⇒ PARSE_DRIFT (§10); malformed HTML ⇒ zero rows (never throw), matching `ohlcv-csv.ts`.
- `parserVersion = 1` (`MUBASHER_FINANCIALS_PARSER_VERSION`).

Wire the TaskSpec into `ingestion/src/adapters/mubasher/index.ts` (`mubasherTasks.financials`) and mount it on `tdwlAdapter.financials` in `ingestion/src/adapters/tdwl/index.ts` (import + re-export like `tdwlQuotes`). Mubasher is an aggregator (no VenueAdapter of its own), so — like the CSV backfill — either route via `provider='mubasher_financials'` in `runtime.tasksForProvider` OR mount directly on `tdwlAdapter.financials` and route via `tasksForDataType`. **Prefer the `tasksForDataType` path** (§3) since financials is a first-class `data_type` and TDWL is the venue of record; the CSV-provider indirection exists only because OHLCV is cross-venue symbol-listed. Mount on `tdwlAdapter.financials`.

### 3. Runtime routing — `ingestion/src/runtime.ts`
Add a `financials` case to `tasksForDataType` (the `switch` at ~line 321):
```ts
case 'financials':
  if (adapter.financials) out.push(adapter.financials as TaskSpec<unknown>);
  break;
```
Add the staging-map branch in `mapRowsToStaging` + a shape discriminator:
- `isFinancial(row)`: `has(row,'statementType') && has(row,'lineItems') && has(row,'fiscalPeriod')` (disjoint from all existing shapes).
- `mapFinancial(source, snapshotId, f)`:
```ts
objectType: 'FILING.FINANCIALS',
naturalKey: `FILING.FINANCIALS:${f.venue}:${f.ticker}:${f.statementType}:${f.basis}:${f.fiscalPeriod}`,
venue: f.venue, sourceId: source.id, snapshotId,
externalId: `${f.ticker}:${f.statementType}:${f.fiscalPeriod}`,  // per-statement id for idempotent dedupe
sourceRank: sourceRankFor(source),          // EXCHANGE_RANK 20
payload: f,                                  // full NormalizedFinancialStatement (camelCase)
numericValue: null,
unit: f.currency,
effectiveDate: f.periodEnd,
priceSensitive: false,                        // ⚠ MUST be false — see gate note below
extractedAt: snapshotExtractedAtIso,
```
- **`priceSensitive: false` is load-bearing.** The `lake.fn_object_state_guard` trigger (0004, line 119) raises `price-sensitive objects require a HUMAN verifier (33b)` if a `price_sensitive=true` object is transitioned to VERIFIED by a non-human. Financials are numeric facts published automatically (single-source PENDING, like filings/quotes), so they must never carry `price_sensitive=true`. (Distinct from `FILING.RESULTS` filings, which are the announcement event and DO gate.)

Natural-key convention (matches the brief): `FILING.FINANCIALS:{venue}:{ticker}:{stmt}:{basis}:{fiscal_period}` — one lake object per (statement_type × basis × fiscal_period), superseded on re-scrape via the standard one-live-per-key discipline.

### 4. NEW migration `supabase/migrations/20260713000042_financials_project.sql`
Next free number is **42** (0041 `ohlcv_backfill_coverage_flag` is the last applied live — verified via `supabase_migrations.schema_migrations`). Copy the structure of `20260713000037_filing_project.sql`. Trigger `lake.fn_financials_project` fires on insert/update of `lake.objects where object_type = 'FILING.FINANCIALS'`, projecting PENDING+VERIFIED (single-source rule D-src-1: TDWL financials are Mubasher-only until Yahoo/ADX second source lands).

DDL sketch:
```sql
set search_path = '';

create or replace function lake.fn_financials_project() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_venue  text := coalesce(new.venue_code, new.payload ->> 'venue');
  v_ticker text := new.payload ->> 'ticker';
  v_stmt   text := new.payload ->> 'statementType';
  v_basis  text := coalesce(nullif(new.payload ->> 'basis',''), 'consolidated');
  v_pkind  text := new.payload ->> 'periodKind';
  v_fiscal text := new.payload ->> 'fiscalPeriod';
  v_pend   date := nullif(new.payload ->> 'periodEnd','')::date;
  v_ccy    text := new.payload ->> 'currency';
  v_items  jsonb := new.payload -> 'lineItems';
  v_isest  boolean := coalesce((new.payload ->> 'isEstimate')::boolean, false);
  v_secid  bigint;
begin
  if new.object_type <> 'FILING.FINANCIALS' then return null; end if;
  if new.state not in ('PENDING','VERIFIED') then return null; end if;
  if v_venue is null or v_ticker is null or v_stmt is null or v_fiscal is null
     or v_pend is null or v_ccy is null or v_items is null then return null; end if;

  -- Resolve security_id from (venue_code, ticker). Skip if the ticker is not in the master.
  select id into v_secid from public.securities
   where venue_code = v_venue and ticker = v_ticker and status = 'listed' limit 1;
  if v_secid is null then return null; end if;

  insert into public.financial_statements
    (security_id, statement_type, basis, period_kind, fiscal_period, period_end,
     currency, is_estimate, line_items, source_object_id)
  values
    (v_secid, v_stmt, v_basis, v_pkind, v_fiscal, v_pend,
     left(v_ccy,3), v_isest, v_items, new.id)
  on conflict (security_id, statement_type, basis, fiscal_period, is_estimate) do update set
    period_kind      = excluded.period_kind,
    period_end       = excluded.period_end,
    currency         = excluded.currency,
    line_items       = excluded.line_items,
    source_object_id = excluded.source_object_id,
    updated_at       = now();
  return null;
end $$;

drop trigger if exists objects_financials_project_ins on lake.objects;
create trigger objects_financials_project_ins after insert on lake.objects
  for each row when (new.object_type = 'FILING.FINANCIALS')
  execute function lake.fn_financials_project();

drop trigger if exists objects_financials_project_upd on lake.objects;
create trigger objects_financials_project_upd after update on lake.objects
  for each row when (new.object_type = 'FILING.FINANCIALS')
  execute function lake.fn_financials_project();

-- One-time backfill of FILING.FINANCIALS objects created before this trigger (idempotent
-- via the unique upsert; only live revisions project).
-- (mirror 0037's INSERT ... SELECT ... on conflict do nothing, with the security_id join)
```
Notes:
- The unique key is already on the table: `unique (security_id, statement_type, basis, fiscal_period, is_estimate)` (0006 line 51). The upsert conflict target must match it exactly — note `period_kind` is NOT in the key, so a period that flips quarter↔annual on the same fiscal_period updates in place.
- `line_items` writes the §3.1 primitive keys VERBATIM from the normalizer (`revenue, gross_profit, ebit, dep_amort, net_income, eps_diluted, equity, total_assets, total_debt, cash, current_liabilities, capital_employed, nii, avg_earning_assets, dividends_paid`) — exactly the keys `key-ratios.ts gatherInputs` reads (via `numFrom` with its fallback alias lists). No key renaming.
- `source_object_id` = `new.id` for lineage (column exists, FK to `lake.objects(id)`).
- Apply via Supabase MCP `apply_migration` (project `yjsncnpbjuueaoeejrqj`) **and commit the .sql** (migration-workflow trap: MCP-apply without committing causes repo drift).

### 5. Seed rows — NEW migration `supabase/migrations/20260713000043_tdwl_financials_source.sql` (or fold into 0042)
`ingest.sources` + `ingest.schedules` for TDWL `financials`, modeled on 0033/0017:
- `ingest.sources`: `venue='TDWL'`, `data_type='financials'`, `entry_url='https://english.mubasher.info/markets/TDWL/stocks'`, `transport='headless'`, `robots_status='allowed'`, `active=false` (seed inactive; flip active AFTER the adapter + `waitForContent` primitive deploy to the VPS — mirror the 0033→0035 split so the scheduler never dispatches before the runtime can serve). `endpoint_config` jsonb:
```json
{ "method":"GET", "responseKind":"html",
  "pageUrlTemplate":"https://english.mubasher.info/markets/TDWL/stocks/{symbol}/financial-statements",
  "ratiosUrlTemplate":"https://english.mubasher.info/markets/TDWL/stocks/{symbol}/ratios",
  "tableSelector":"<CONFIRM ON LIVE PROBE — the settled statements table selector>",
  "ratiosSelector":"<CONFIRM ON LIVE PROBE>",
  "fetch_concurrency":4,
  "headers":{"Referer":"https://english.mubasher.info/markets/TDWL","Accept":"text/html"},
  "use_proxy":false }
```
  `symbols` is auto-injected by the runtime from `public.securities` (RAW TDWL tickers) — add a `withMubasherFinancialsSymbols` populator OR reuse `withMubasherCsvSymbols`'s RAW-ticker logic by generalising the provider check. **Do NOT hardcode symbols** (CONTRACT §0.6). `normalize_rules`: strip any per-response volatile bytes the rendered HTML carries (timestamps/nonces) before hashing so an unchanged statement dedupes — confirm on the probe; likely `[]` since statements are stable.
- `ingest.schedules`: **weekly, Sat 09:00 UTC**. The DDL is `(source_id, cadence_minutes, session_only, offset_minutes, active)` — there is **no day-of-week/cron column**. Options (pick one, note in ticket):
  1. `cadence_minutes = 10080` (7 days), `session_only=false`, `offset_minutes` chosen so the first run lands ~Sat 09:00 UTC; the scheduler's `enqueue_due_jobs` re-fires every 10080 min from `last_enqueued_at`. **Simplest; approximate day-of-week.**
  2. If exact Sat-09:00 is required, add a dedicated pg_cron entry (like `ohlcv_accrual`/`nightly` in 0015/0028) that enqueues a TDWL-financials `ingest.job_queue` row `on cron '0 9 * * 6'`. **Preferred for exact cadence.** Confirm which the owner wants.
- **Event-driven on RESULTS filings (mirror filings-poll enqueue):** when a `RESULTS` filing lands, enqueue a financials refresh. The pattern to mirror is `worker/src/handlers/enqueue.ts::enqueueFilingDetails` — it records pending `ingest.seen_items` against the list source and enqueues ONE priority-1 `ingest.job_queue` wake-up row against the target source. For financials: in the filings pipeline (or the `filing_project` path), when `fn_classify_filing_type` yields `'RESULTS'` for a TDWL filing, enqueue one `ingest.job_queue (source_id = <TDWL financials source id>, priority = 1, run_after = now())` row. Since the financials fetch is a full per-ticker sweep (not per-announcement), the wake-up just means "re-scrape TDWL financials now"; per-ticker dedupe on snapshot hash makes it cheap. Implement this enqueue either (a) in a new `worker/src/handlers` hook invoked when a RESULTS FILING.REF projects, or (b) as a SQL `after insert` trigger on `public.filings where filing_type='RESULTS'` that inserts the job_queue wake-up. **Prefer (b)** for simplicity and because it needs no worker change; cite `enqueueFilingDetails` as the mirrored contract (one wake-up row, idempotent, priority 1).

### Build order
1. `types.ts`: add `NormalizedFinancialStatement` + `financials?` slot.
2. `browser.ts` + `playwright-driver.ts`: add `waitForContent(selector, timeoutMs)` content-poll primitive.
3. `adapters/mubasher/financials.ts`: TaskSpec (fetch headless content-poll + PURE parse → HTML-table→doc→normalizer→split per statement_type).
4. `adapters/mubasher/index.ts` + `adapters/tdwl/index.ts`: export + mount `financials`.
5. `runtime.ts`: `tasksForDataType` financials case + `mapRowsToStaging` `isFinancial`/`mapFinancial` branch + symbol injection for financials sources.
6. Migration 0042 `financials_project.sql` (trigger + backfill).
7. Migration 0043 seed source + schedule (active=false) + RESULTS-filing wake-up trigger.
8. Fixture + golden test (§ test plan).
9. `npm run typecheck` + `npm test` in `ingestion/` (and worker if the enqueue hook is TS).
10. Deploy adapter to VPS, flip `active=true` in a follow-up migration (0044), live-verify.
11. Docs: mark DEF-STMT-INGEST done in `docs/BUILD-STATUS.md` §5/§7, tick 07 §P1.7b, update 07 §2.2/§4 build-status note.

## Test plan (zero-network, node --import tsx --test)
- **Fixture:** the two Mubasher fixtures already exist (`ingestion/fixtures/mubasher/financial-statements-2222.json`, `ratios-2222.json`) in the exact normalizer-input shape. ADD an **HTML fixture** (`ingestion/fixtures/mubasher/financial-statements-2222.html`) representing the rendered Angular table the fetch returns, so the parser's HTML→doc extraction is golden-tested against the same numbers. Build it to contain the fixture JSON's `columns`/`rows` verbatim in the real Mubasher table markup (capture the actual selector + markup on the live probe).
- **Adapter golden test** `ingestion/src/adapters/mubasher/financials.test.ts` (mirror `statement-normalizer.test.ts` + `ohlcv-csv` test style):
  - `parse` over a `StoredSnapshot` built from the HTML fixture with `meta={venue:'TDWL',ticker:'2222',statement:'financial-statements'}` → asserts: emits income+balance+cashflow rows for each of FY2021..FY2025; `income` FY2025 has `net_income=398200000`, `gross_profit=665900000`; `balance` FY2025 has `total_assets=2516431000`, `equity=1506000000`; `cashflow` FY2025 has `dep_amort` absent (Mubasher gives no dep line — assert key omitted, not zero); currency `SAR`; `periodEnd='2025-12-31'`; `fiscalPeriod='FY2025'`; `basis='consolidated'`.
  - Purity: two `parse` calls on the same snapshot are byte-identical (no `Date.now`).
  - `mapFinancial`: natural_key `FILING.FINANCIALS:TDWL:2222:balance:consolidated:FY2025`, `priceSensitive===false`, `objectType==='FILING.FINANCIALS'`, `effectiveDate==='2025-12-31'`, `unit==='SAR'`.
  - Zero-row drift: malformed HTML → `rows:[]` (no throw).
- **Runtime map test** (`runtime.test.ts` or `staging-map.test.ts`): `mapRowsToStaging` dispatches a `NormalizedFinancialStatement` to `mapFinancial` (shape discriminator disjoint from quote/ohlcv/filing).
- Run `npm run typecheck` and `npm test` in `ingestion/`.

## Deploy + live-verification steps
1. Apply migration 0042 (+0043 seed) via Supabase MCP `apply_migration` (project `yjsncnpbjuueaoeejrqj`); commit both .sql files.
2. Deploy the ingestion build to the VPS (`/opt/marsad/ingestion`), restart the worker.
3. **Live probe FIRST (before flipping active):** on the VPS, confirm the Mubasher `/financial-statements` + `/ratios` page shape for `2222` — is it a JSON endpoint or Angular HTML? Capture the settled `tableSelector` and the actual table markup. `ssh -o ConnectTimeout=10 -o BatchMode=yes deploy@91.99.99.85 '<playwright/curl probe of english.mubasher.info/markets/TDWL/stocks/2222/financial-statements>'`. Update `endpoint_config.tableSelector` + the HTML fixture from the real capture. Repoint fetch to plain `ctx.http` if a JSON API exists.
4. Flip `active=true` (migration 0044) or manually enqueue one TDWL-financials `ingest.job_queue` row for a fast test:
   `insert into ingest.job_queue (source_id, priority, run_after) select id, 1, now() from ingest.sources where venue='TDWL' and data_type='financials';`
5. Watch the pipeline (SQL via MCP):
   - `select count(*) from lake.staging_rows where object_type='FILING.FINANCIALS';` (>0 after sweep)
   - `select natural_key, state from lake.objects where object_type='FILING.FINANCIALS' order by created_at desc limit 20;` (PENDING single-source)
   - `select security_id, statement_type, fiscal_period, line_items from public.financial_statements order by updated_at desc limit 20;` (populated, keys = §3.1 primitives)
6. Re-run nightly key_ratios for the TDWL name(s): enqueue a `key_ratios_recompute` job (or `select` the securityId and run the handler) and confirm `select security_id, pe, roe, net_margin, book_value_ps from public.key_ratios where security_id = <2222 id>;` now has non-null `pe`/`roe`/`net_margin` (was all-null).
7. Verify lineage: `financial_statements.source_object_id` resolves to the `FILING.FINANCIALS` lake object.

## Idempotency / rollback
- **Idempotent:** snapshot dedupe on normalized hash (unchanged statement re-scrapes to no-op); staging upsert on `(source_id, external_id, content_hash)`; lake one-live-per-key supersede; projection upsert on the `financial_statements` unique key; seed migrations `on conflict do nothing`. A re-run or crash mid-sweep is safe (per-ticker isolation).
- **Rollback:** `drop trigger objects_financials_project_ins/upd on lake.objects; drop function lake.fn_financials_project;` and set the source `active=false`. `public.financial_statements` rows can be left (harmless) or `delete where source_object_id in (select id from lake.objects where object_type='FILING.FINANCIALS')`.

## Fan-out (follow-on sub-tickets — note, do not build here)
- **ADX (Mubasher, same shape):** identical adapter; seed an ADX `financials` source pointing at `/markets/ADX/stocks/{symbol}/financial-statements`. `normalizeMubasherStatements` already handles ADX. Gives TDWL+ADX the 2-source VERIFIED tier once ADX-native lands (D-src-1).
- **DFM/QE (Yahoo `fundamentals-timeseries`):** `normalizeYahooTimeseries` is already built; blocked on Yahoo egress (cross-cutting blocker #1). Route via the existing `provider='yahoo'` path, `data_type='financials'`, adding a `yahooTasks.financials` TaskSpec.
- **MSX (PDF):** rides the `normalizeViaLlm` seam (currently a declared-throwing stub, P1.7d PDF pipeline). Do NOT touch here.

## Risks
- **HTML-shape drift:** Mubasher's Angular markup can change → PARSE_DRIFT. Mitigated by the content-poll selector being config (`tableSelector`) + zero-row-not-throw + snapshot-first replay. The HTML→doc extraction is the fragile net-new code.
- **content-poll primitive:** `waitForContent` is new plumbing in the browser driver; must not regress the existing `networkidle` bootstrap path used by TDWL/ADX WAF adapters (add a new method, don't change `newPageAndGoto`).
- **security_id resolution:** projection skips a statement whose `(venue_code, ticker)` isn't a listed security. TDWL has 387 listed (verified) — but confirm the Mubasher `code` (e.g. `2222`) matches `securities.ticker` exactly for the TDWL universe, else statements silently drop.
- **Sector data gap:** `securities.sector` is all `'unknown'` (1 distinct sector, verified live — DEF-SECTOR-DATA). The Score's sector cohorts (§3.3/§3.5) can't key until that lands, but `key_ratios` (pe/roe/net_margin) populate correctly regardless. This ticket unblocks ratios; full Score needs DEF-SECTOR-DATA too.


---

## #2 Sector + people — effort L

**Title:** SECTOR + PEOPLE SCRAPE (DEF-SECTOR-DATA + P1.7e-I): a `people` DataType + profile/board scrape that fills securities.sector and company_people

**Files to create/edit:** `ingestion/src/core/types.ts (EDIT: add 'people' to DataType; add NormalizedProfileRow/NormalizedProfile/NormalizedPerson/SectorKey; add people? slot to VenueAdapter)`, `ingestion/src/lake/sector-taxonomy.ts (NEW: normalizeSectorKey + SECTOR_KEYS, pure)`, `ingestion/src/adapters/mubasher/profile.ts (NEW: mubasherProfile TaskSpec, config-driven parser)`, `ingestion/src/adapters/mubasher/index.ts (EDIT: export mubasherProfile)`, `ingestion/src/adapters/adx/profile.ts (NEW: adxProfile TaskSpec via overview.json)`, `ingestion/src/adapters/adx/index.ts (EDIT: mount adxAdapter.people)`, `ingestion/src/adapters/tdwl/index.ts (EDIT: mount mubasherProfile on people slot)`, `ingestion/src/runtime.ts (EDIT: tasksForDataType case 'people'; mapRowsToStaging + isProfile/isPerson discriminators + mapProfile/mapPerson; withProfileSymbols in withInjectedSymbols)`, `supabase/migrations/20260713000042_profile_people_project.sql (NEW: fn_profile_project + fn_people_project + triggers + backfill)`, `supabase/migrations/20260713000043_people_sources.sql (NEW: seed ingest.sources + ingest.schedules for TDWL/ADX people)`, `ingestion/src/lake/__tests__/sector-taxonomy.test.ts (NEW)`, `ingestion/src/adapters/mubasher/__tests__/profile.test.ts (NEW)`, `ingestion/src/adapters/adx/__tests__/profile.test.ts (NEW)`, `ingestion/src/__tests__/runtime.test.ts (EDIT: people routing + staging map assertions)`, `ingestion/fixtures/mubasher/profile-tdwl.* (NEW, from live probe)`, `ingestion/fixtures/adx/overview.json (NEW, from live probe)`, `ingestion/CONTRACT.md (EDIT: record people DataType + Normalized types)`, `docs/BUILD-STATUS.md (EDIT: DEF-SECTOR-DATA + P1.7e-I done for TDWL/ADX; defer DFM/QE/MSX/BHB)`, `docs/architecture/07-lake-enrichment.md (EDIT: tick §1.1 I + §4 P1.7e people/sector)`, `docs/plans/p17-continuous-enrichment-researchers.md (EDIT: §3.7 mark built)`

**Dependencies:** ingestion/src/core/types.ts DataType union + VenueAdapter slot are a frozen-contract surface (ingestion/CONTRACT.md) — additive extension needs the CONTRACT.md note per the file header rule; Mubasher /profile is reachable no-proxy from the VPS (same host as the working stocks/prices board); ADX overview.json needs the existing ADX Playwright request-context; DEF-STMT-INGEST (financial statements live feed) is a SEPARATE deferred item — scores rows won't fully populate until key_ratios has fundamentals; but sector-cohort FORMATION is independently verifiable via securities.sector distribution; shares_outstanding (660/660 null) blocks market_cap universe-wide — profile scrape MAY fill it if Mubasher exposes it (live-probe); otherwise a separate gap remains

**Live probes needed:** Mubasher /profile DOM/JSON shape for a TDWL ticker (2222) and an ADX ticker: selectors/paths for sector, industry, shares_outstanding, isin, listing_date, free_float, and the board/management table (name/title/independence). Determines http vs http_bootstrap + content-poll-on-selector need (07 §2.1).; The actual sector label strings each venue prints, to tighten normalizeSectorKey's regex beyond GICS-like defaults; ADX overview.json exact field names to populate AdxProfileFieldMap (capture via ADX Playwright request-context on VPS, then flip seeded source active=true); Whether Mubasher /profile exposes shares_outstanding at all — if not, market_cap stays blocked for the whole 660-name universe and needs a separate source

**Open questions:** Does any venue profile source expose shares_outstanding? 660/660 are null, blocking market_cap → pe/pb/ps/ev_ebitda → the Value factor for the ENTIRE universe. If Mubasher /profile lacks it, this ticket un-neuters cohorts (D-1/D-2) but Value stays starved until a shares source is found (Yahoo defaultKeyStatistics per 07 §2.2 line 294, but Yahoo is egress-blocked).; Should the ADX source use Mubasher /profile (reachable now, active=true) or ADX overview.json (needs shape capture, active=false) as PRIMARY? Recommend Mubasher primary for parity with TDWL, overview.json as the 2-source cross-check partner (D-src-1: ADX is VERIFIED-capable = Mubasher + ADX-native).; Event-driven GOVERNANCE refresh wiring: does the filings-poll → pipeline path already expose a generic 'enqueue a follow-up job for this security' seam, or does this need a new trigger on public.filings? 14 GOVERNANCE filings already exist to test against. (filings-poll.ts / enqueue.ts to be read at build time.); Confirm next free migration number with list_migrations at build time — context says 0041 last committed / next=0042, but 0038-0041 numbering was recently renumbered (commit 0729e5d), so verify before apply.


# Build Ticket — Sector + People scrape (DEF-SECTOR-DATA + P1.7e-I)

## 0. Objective

`public.securities.sector` is **660/660 = literal `'unknown'`** (verified live; `select sector,count(*)` returns one row `unknown:660`). That single-cohort state neuters:
- **D-2 GCC sector cohorts** in `ingestion/src/lake/score-engine.ts` — `scoreUniverse` groups by `input.sector ?? 'unknown'`, so the whole universe is one cohort and every `sectorPercentile` is meaningless.
- **D-1 ratio validity** in `ingestion/src/lake/ratios-compute.ts` `sectorValidity()` (regex `/bank/i`, `/insur/i`) and `score-engine.ts` `isBankOrInsurer()` (regex `/bank|insur/i`) — with sector always `'unknown'` these NEVER fire, so banks wrongly get EV/EBITDA and gross_margin, and the bank-override Value factor never applies.

`public.company_people` (migration `20260713000038_company_people.sql`) is shipped but **empty (0 rows)**. Both are filled by ONE per-company **profile scrape** per the coverage matrix (07 §2.2 row "Profile / sector / description").

This ticket adds a new **`people` DataType** (naming per p17 §3.7 / §4, which uses `data_type='people'` at cadence 129600 quarterly + event on GOVERNANCE) that scrapes a company profile page and emits TWO object families:
1. `SECURITY.PROFILE` → new `lake.fn_profile_project()` that **updates `public.securities` directly** (sector, industry, shares_outstanding, listing_date, isin, free_float_pct, board_segment).
2. `COMPANY.PERSON` (one per board/management seat) → new `lake.fn_people_project()` → `public.company_people`.

Also delivers a **canonical sector taxonomy normalizer** (venue sector strings → the 11 `public.sectors` keys) so D-1/D-2 come alive, and reports the **shares_outstanding** gap (660/660 null — blocks `market_cap` for the ENTIRE universe).

---

## 1. Grounded facts (read these before touching code)

### 1.1 The canonical sector taxonomy IS `public.sectors.key` (FK-constrained — NOT free text)
`supabase/migrations/20260713000003_market_reference.sql:32` — `securities.sector text NOT NULL references public.sectors(key)`. Any value written MUST be one of these keys (verified live via `select key from public.sectors`):

```
energy · materials · banks · financials · insurance · telecom · utilities ·
real_estate · consumer · healthcare · industrials · unknown
```

(`financials` = "Diversified Financials"; `industrials` = "Capital Goods & Industrials".) The `'unknown'` key was seeded by `20260713000029_securities_bootstrap.sql:31-33`.

**This is decisive:** the Score regexes match against `securities.sector`, which will hold the KEY. `/bank|insur/i` matches key `banks` and `insurance`; `/bank/i` matches `banks`; `/insur/i` matches `insurance`. So **normalizing venue strings into these keys automatically wires D-1 + D-2** — no Score code change needed. The normalizer's job is: map a venue's free-text sector label (e.g. Mubasher `/profile` "Banks", ADX `overview.json` "Financials / Real Estate") → one of the 11 keys, falling back to `'unknown'` when unmatched (never guess).

### 1.2 `data_type='people'` is allowed at the DB layer; only the TS union blocks it
`ingest.sources.data_type` is `text not null` with **NO check constraint** (`20260713000005_prices.sql:192-206`). `lake.staging_rows.object_type` (`20260713000018_lake_staging_rows.sql:22`) and `lake.objects.object_type` (`20260713000004_lake.sql:69`) are both free `text` — new object types `SECURITY.PROFILE` and `COMPANY.PERSON` need no DDL change. The only code gate is the `DataType` union in `ingestion/src/core/types.ts:22-32` (which lists `financials` but NOT `people`).

### 1.3 security_id resolution requires `payload.ticker`
`ingestion/src/lake/cross-check.ts:503-511` `resolveSecurityId()` reads `tickerOf(winner.payload)` (line 588: `payload.ticker`) + `winner.venue_code` → `select id from public.securities where venue_code=$ and ticker=$`. **Both the profile and person staging payloads MUST carry `ticker` + `venue`** so cross-check stamps `lake.objects.security_id`, which the projections then use.

### 1.4 Projection pattern (template = `20260713000037_filing_project.sql`)
`lake.fn_filing_project()` is the exact template: `security definer set search_path=''`, `if new.object_type <> '...' then return null`, `if new.state not in ('PENDING','VERIFIED') then return null`, read `new.payload ->> 'field'`, `insert ... on conflict ... do update`, plus AFTER INSERT and AFTER UPDATE triggers `when (new.object_type = '...')`, plus a one-time idempotent backfill of pre-existing objects. Mirror this for both new projections. Single-source rule (D-src-1): profile/people are single-source on most venues → objects are usually PENDING → project PENDING+VERIFIED (exactly like `fn_quote_project` 0031 and `fn_filing_project` 0037).

### 1.5 Adapter contract + runtime routing
- `VenueAdapter` (`core/types.ts:165-177`) has NO `people`/`profile` slot — must add `people?: TaskSpec<NormalizedProfile>`.
- `TaskSpec` (`core/types.ts:149-154`): `fetch` impure, `parse` PURE (no I/O, no Date.now, replayable against `ingestion/fixtures/`).
- Runtime routing: `runtime.ts:321-348` `tasksForDataType` switch — add a `case 'people':` that pushes `adapter.people`.
- Staging mapper `runtime.ts:532-568` `mapRowsToStaging` dispatches on row SHAPE via discriminators (`isQuote`, `isFiling`, …). Must add `isProfile`/`isPerson` discriminators + `mapProfile`/`mapPerson` functions producing `StagingRow`s.

### 1.6 Live coverage matrix (07 §2.2 row "Profile / sector / description", verbatim)
| Venue | Profile/sector source |
|---|---|
| TDWL | Mubasher `/profile` (+ Yahoo) |
| DFM | Yahoo (Mubasher DFM pages are empty shells — 07 §2.2) |
| ADX | Mubasher `/profile` **or** ADX `overview.json` |
| QE | Yahoo + QE `/companymoreinformationsearch` |
| MSX | `msx.om` `companies.aspx` |
| BHB | **GAP** (Radware IP-block; D-src-4 coverage-gap venue) |

Mubasher `/profile` is the plain-HTTP, no-auth, no-proxy workhorse reachable from the VPS (same host as the working `english.mubasher.info/api/1/stocks/prices` board the bootstrap already uses, `20260713000029` and `tdwl-quotes.ts`). **ADX `overview.json`** is clean Next.js SSR JSON reachable via the ADX Playwright request-context that `adx/filings.ts` already uses (the filings adapter fetches `apigateway.adx.ae` directly — same browser transport).

### 1.7 Live gap counts (probed this session, project `yjsncnpbjuueaoeejrqj`)
- `securities` total **660**; `shares_outstanding` NULL = **660/660** (→ `market_cap` null for the entire universe → `pe`/`pb`/`ps`/`ev_ebitda` all null → Value factor starved even after statements land). Also NULL for all 660: `industry`, `board_segment`, `free_float_pct`, `listing_date`, `isin`.
- `company_people` rows = **0**.
- `filings` with `filing_type='GOVERNANCE'` = **14** (event-trigger candidates already exist).
- `lake.objects` distinct object_types = **4** (QUOTE.LAST, OHLCV.CLOSE, FILING.REF, +1) — no profile/person types yet.

---

## 2. Decisions (made + justified)

### D-A · Add a NEW `people` DataType — do NOT extend an existing one. **DECIDED: new DataType.**
p17 §3.7/§4 already names `data_type='people'` with its own cadence (129600) and event trigger (GOVERNANCE). Financials/quotes have incompatible cadences and adapters. A `people` source scrapes the profile page, which carries BOTH sector-identity fields and board/management — one fetch, two object families. Justification: matches the shipped plan, keeps the profile scrape on its own quarterly schedule, and reuses the existing `enqueue_due_jobs`→`job_queue`→worker path with zero new scheduler.

### D-B · The `people` task emits TWO object families from ONE parse. **DECIDED.**
`parse()` returns a `NormalizedProfile[]` where each element is EITHER a profile record OR a person record (discriminated by a `kind: 'profile' | 'person'` field), OR — cleaner — parse returns `{ profile: NormalizedProfile; people: NormalizedPerson[] }` flattened into one array of a tagged union. Recommend a **single tagged-union row type** so the existing `ParseResult<T>` / `mapRowsToStaging(rows: unknown[])` shape is unchanged. `mapRowsToStaging` then routes each row by shape to `mapProfile` or `mapPerson`.

### D-C · Sector reaches `public.securities` via a **PROFILE PROJECTION that UPDATEs securities directly** — NOT a separate lake object that securities reads. **DECIDED: direct UPDATE in `lake.fn_profile_project()`.**
Justification: `securities` is the identity master, not a projected serving table; it has no `security_id`-keyed "latest object" read path. The established pattern (`fn_quote_project`, `fn_filing_project`) is "object trigger writes the public table." So `fn_profile_project()` fires on `SECURITY.PROFILE` objects and does `update public.securities set sector=..., shares_outstanding=..., ... where id = new.security_id`. It must **only overwrite when the incoming value is non-null AND (for sector) resolves to a known key** — never clobber a curated value with a null (use `coalesce(new_value, securities.existing)` semantics, i.e. `set sector = coalesce(v_sector_key, sector)`). Because `securities.sector` is NOT NULL, writing `coalesce(v_key, sector)` is safe (falls back to current `'unknown'`).

### D-D · Sector normalization is a PURE function in the adapter/statement-normalizer layer, applied at parse time so the payload carries the CANONICAL key. **DECIDED.**
The `NormalizedProfile.sector` field holds the already-normalized key (one of the 11 or `'unknown'`), so the projection can write it verbatim with only an existence guard. Put `normalizeSectorKey(raw: string | null): SectorKey` in a new `ingestion/src/lake/sector-taxonomy.ts` (pure, unit-tested), imported by every venue profile parser. This keeps the FK-safety logic in one tested place and out of SQL.

### D-E · Cadence: quarterly + event on GOVERNANCE. **DECIDED per p17 §4.**
`ingest.schedules`: `cadence_minutes=129600` (90 days), `session_only=false`, staggered `offset_minutes` (TDWL+0…BHB+5). Event trigger: on a `filings` row landing with `filing_type='GOVERNANCE'`, enqueue a single-company `people` refresh (piggyback the existing filings→pipeline enqueue path; see §5 step 7). BHB has no source (coverage-gap) — seed no BHB `people` source.

### D-F · v1 venue scope: **TDWL + ADX via Mubasher `/profile`; ADX also cross-checkable via `overview.json`.** DFM/QE/MSX deferred, BHB gap.
Justification: Mubasher `/profile` is the only reachable, no-proxy, no-Yahoo-egress source that covers the two biggest venues (TDWL 387, ADX 93 = 480/660 securities) TODAY. DFM/QE need Yahoo egress (blocker #1, currently 429-blocked); MSX needs the `.aspx` scrape. Ship TDWL+ADX now to un-neuter the Score cohorts for the bulk of the universe; log DFM/QE/MSX as deferred rows in BUILD-STATUS §7. Seed the ADX source `active=false` until the `overview.json` shape is captured live (mirrors how 0033/0034 backfill sources shipped `active=false`).

---

## 3. Normalized types (add to `ingestion/src/core/types.ts`)

Add to the `DataType` union (line 22-32): `| 'people'`.

Add slot to `VenueAdapter` (after `ipo?`): `people?: TaskSpec<NormalizedProfileRow>;`

Add the tagged-union row shape (new §6 block):
```ts
/** §6.x profile/people scrape → SECURITY.PROFILE + COMPANY.PERSON lake objects. */
export type NormalizedProfileRow =
  | ({ kind: 'profile' } & NormalizedProfile)
  | ({ kind: 'person' } & NormalizedPerson);

export interface NormalizedProfile {
  venue: VenueCode;
  ticker: string;                 // → resolveSecurityId (cross-check.ts:588 needs payload.ticker)
  sector: SectorKey | null;       // ALREADY normalized to a public.sectors key (or null)
  industry?: string | null;
  boardSegment?: string | null;
  isin?: string | null;
  sharesOutstanding?: number | null;
  freeFloatPct?: number | null;
  listingDate?: string | null;    // 'YYYY-MM-DD'
  asOf: string;                    // ISO UTC (page scrape time or stated as-of)
}

export interface NormalizedPerson {
  venue: VenueCode;
  ticker: string;
  name: string;
  role: 'board' | 'management';   // company_people.role CHECK
  title?: string | null;          // 'Chairman','CEO','CFO','Independent Director'
  isIndependent?: boolean | null;
  seatCount?: number | null;
  asOf?: string | null;           // → company_people.as_of (date)
}

/** The 11 canonical public.sectors keys + unknown (FK-safe). */
export type SectorKey =
  | 'energy' | 'materials' | 'banks' | 'financials' | 'insurance'
  | 'telecom' | 'utilities' | 'real_estate' | 'consumer'
  | 'healthcare' | 'industrials' | 'unknown';
```

---

## 4. Sector taxonomy normalizer (`ingestion/src/lake/sector-taxonomy.ts` — NEW, PURE)

```ts
export const SECTOR_KEYS = ['energy','materials','banks','financials','insurance',
  'telecom','utilities','real_estate','consumer','healthcare','industrials','unknown'] as const;

/** Map a venue's free-text sector/industry label → a public.sectors key.
 *  Conservative: unmatched → 'unknown' (never a wrong cohort). Ordered regex,
 *  earliest match wins; bank/insurance FIRST because D-1/D-2 pivot on them. */
export function normalizeSectorKey(raw: string | null | undefined): SectorKey { ... }
```
Recommended mapping table (match on lowercased raw, `bank|insur` first to protect D-1):
| Regex (case-insensitive) | key |
|---|---|
| `bank` | `banks` |
| `insur` | `insurance` |
| `real ?estate|reit|property` | `real_estate` |
| `telecom|communication` | `telecom` |
| `utilit|electric|water|power|gas distrib` | `utilities` |
| `energy|oil|petro|gas(?! distrib)` | `energy` |
| `material|chemical|cement|mining|metal|steel` | `materials` |
| `health|pharma|medical` | `healthcare` |
| `divers.*financ|financ.*servic|investment|holding` | `financials` |
| `consumer|retail|food|beverage|staple|discretionary|transport|media|hotel|hospitality` | `consumer` |
| `industr|capital goods|construction|engineering|contract` | `industrials` |
| else | `unknown` |

Note: Mubasher/ADX sector labels observed in 07 §2.2 are GICS-like ("Banks", "Real Estate", "Materials", "Energy") which map cleanly. **This exact label list per venue is a LIVE PROBE** (see §8) — the regex table above is the safe default; tighten after capturing real labels.

---

## 5. Build order (step by step)

1. **`ingestion/src/core/types.ts`** — add `'people'` to `DataType`; add `NormalizedProfileRow`/`NormalizedProfile`/`NormalizedPerson`/`SectorKey`; add `people?` slot to `VenueAdapter`. (Frozen-contract file — this is an additive extension; note it in `ingestion/CONTRACT.md` per the file header rule.)

2. **`ingestion/src/lake/sector-taxonomy.ts`** (NEW) — `normalizeSectorKey` + `SECTOR_KEYS`. Pure.

3. **Adapter: Mubasher profile** — `ingestion/src/adapters/mubasher/profile.ts` (NEW). `fetch` = plain `ctx.http.get` of the `/profile` page (URL from `source.endpointConfig.urlTemplate` with `{symbol}` per-ticker, symbols injected like `withMubasherCsvSymbols` — see step 6). `parse` = PURE: profile HTML/JSON → `[{kind:'profile',...}, {kind:'person',...}×N]`, sector run through `normalizeSectorKey`. Export `mubasherProfile: TaskSpec<NormalizedProfileRow>`. Model the fetch/config-over-code discipline on `tdwl-quotes.ts`; model per-symbol iteration + `snapshot.meta.venue`/`symbol` stamping on `ohlcv-csv.ts`. **The Mubasher `/profile` DOM/field shape is a LIVE PROBE (§8)** — write the parser config-driven (a `profileFieldMap` on `endpoint_config`, like `AdxFieldMap`) so a field rename is a data fix, and fixture-harden after capture.

4. **Adapter: ADX overview** — `ingestion/src/adapters/adx/profile.ts` (NEW), `overview.json` via the ADX browser request-context (reuse `browserOpts`/`getPath` from `adx/quotes.ts`; direct fetch pattern from `adx/filings.ts`). Config-driven field map (`AdxProfileFieldMap`). Mount on `adxAdapter.people` in `adx/index.ts`. Seed `active=false` until shape captured.

5. **Mount + route:**
   - `ingestion/src/adapters/tdwl/index.ts` (and/or wherever TDWL adapter is assembled) → mount `mubasherProfile` on the `people` slot. (TDWL adapter re-exports Mubasher tasks — mirror how `tdwl/quotes.ts` re-exports `mubasherTdwlQuotes`.)
   - `ingestion/src/runtime.ts` `tasksForDataType` (line 321) → add `case 'people': if (adapter.people) out.push(adapter.people as TaskSpec<unknown>); break;`
   - `ingestion/src/runtime.ts` `mapRowsToStaging` (line 532) + discriminators (line 570-596): add `isProfile(row)` (`has(row,'kind') && row.kind==='profile'`, or `has(row,'sector') && has(row,'ticker') && !has(row,'last')`) and `isPerson` (`row.kind==='person'` or `has(row,'name') && has(row,'role')`), and `mapProfile`/`mapPerson` staging builders.

6. **Symbol injection** — `runtime.ts`: add `withProfileSymbols` (RAW listed tickers, no suffix — Mubasher profile slug is the raw ticker, like `withMubasherCsvSymbols`) and wire it into `withInjectedSymbols` (line 290) under a new `provider`/dataType branch. Simplest: gate on `source.dataType === 'people'`.

7. **Staging mappers** (`runtime.ts`):
   - `mapProfile` → `objectType:'SECURITY.PROFILE'`, `naturalKey:'SECURITY.PROFILE:{venue}:{ticker}'`, `numericValue:null`, `effectiveDate: dateOnly(asOf)`, `priceSensitive:false`, payload carries `ticker`+`venue`.
   - `mapPerson` → `objectType:'COMPANY.PERSON'`, `naturalKey:'COMPANY.PERSON:{venue}:{ticker}:{role}:{name}'` (deterministic; matches `company_people` unique `(security_id,name,role)`), payload carries `ticker`+`venue`+person fields.

8. **Migration `20260713000042_profile_people_project.sql`** (NEXT FREE NUMBER — 0041 is last committed per the context; VERIFY with `list_migrations` before applying). Two projection functions + triggers + backfills, mirroring `fn_filing_project`:

```sql
set search_path = '';

-- A. SECURITY.PROFILE → public.securities (direct UPDATE; coalesce-guarded).
create or replace function lake.fn_profile_project() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_sector text := new.payload ->> 'sector';   -- already a public.sectors key or null
begin
  if new.object_type <> 'SECURITY.PROFILE' then return null; end if;
  if new.state not in ('PENDING','VERIFIED') then return null; end if;
  if new.security_id is null then return null; end if;
  -- FK-safety: only accept a sector that exists in public.sectors.
  if v_sector is not null and not exists (select 1 from public.sectors where key = v_sector) then
    v_sector := null;
  end if;
  update public.securities s set
    sector             = coalesce(v_sector, s.sector),
    industry           = coalesce(nullif(new.payload ->> 'industry',''), s.industry),
    board_segment      = coalesce(nullif(new.payload ->> 'boardSegment',''), s.board_segment),
    isin               = coalesce(nullif(new.payload ->> 'isin',''), s.isin),
    shares_outstanding = coalesce(nullif(new.payload ->> 'sharesOutstanding','')::numeric, s.shares_outstanding),
    free_float_pct     = coalesce(nullif(new.payload ->> 'freeFloatPct','')::numeric, s.free_float_pct),
    listing_date       = coalesce(nullif(new.payload ->> 'listingDate','')::date, s.listing_date)
  where s.id = new.security_id;
  return null;
end $$;

-- B. COMPANY.PERSON → public.company_people (upsert on the shipped unique key).
create or replace function lake.fn_people_project() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.object_type <> 'COMPANY.PERSON' then return null; end if;
  if new.state not in ('PENDING','VERIFIED') then return null; end if;
  if new.security_id is null then return null; end if;
  if (new.payload ->> 'name') is null or (new.payload ->> 'role') is null then return null; end if;
  insert into public.company_people
    (security_id, name, role, title, is_independent, seat_count, as_of, source_object_id)
  values (new.security_id,
          new.payload ->> 'name',
          new.payload ->> 'role',
          nullif(new.payload ->> 'title',''),
          (new.payload ->> 'isIndependent')::boolean,
          nullif(new.payload ->> 'seatCount','')::smallint,
          nullif(new.payload ->> 'asOf','')::date,
          new.id)
  on conflict (security_id, name, role) do update set
    title          = coalesce(excluded.title, public.company_people.title),
    is_independent = coalesce(excluded.is_independent, public.company_people.is_independent),
    seat_count     = coalesce(excluded.seat_count, public.company_people.seat_count),
    as_of          = coalesce(excluded.as_of, public.company_people.as_of),
    source_object_id = excluded.source_object_id;
  return null;
end $$;

-- Triggers (INSERT + UPDATE, filtered by object_type — mirror 0037).
drop trigger if exists objects_profile_project_ins on lake.objects;
create trigger objects_profile_project_ins after insert on lake.objects
  for each row when (new.object_type = 'SECURITY.PROFILE') execute function lake.fn_profile_project();
drop trigger if exists objects_profile_project_upd on lake.objects;
create trigger objects_profile_project_upd after update on lake.objects
  for each row when (new.object_type = 'SECURITY.PROFILE') execute function lake.fn_profile_project();
drop trigger if exists objects_people_project_ins on lake.objects;
create trigger objects_people_project_ins after insert on lake.objects
  for each row when (new.object_type = 'COMPANY.PERSON') execute function lake.fn_people_project();
drop trigger if exists objects_people_project_upd on lake.objects;
create trigger objects_people_project_upd after update on lake.objects
  for each row when (new.object_type = 'COMPANY.PERSON') execute function lake.fn_people_project();

-- One-time backfill of any pre-existing objects (idempotent; superseded_by is null → live revision only).
-- (Mirror 0037's tail INSERT/UPDATE for both object types.)
```

9. **Seed migration `20260713000043_people_sources.sql`** (or fold into 0042) — `insert into ingest.sources (venue,data_type,entry_url,endpoint_config,normalize_rules,transport,robots_status,active)` for TDWL (Mubasher `/profile`, `transport='http'`, `active=true`) and ADX (`overview.json`, `transport='http_bootstrap'`, `active=false` pending shape capture), each with a `profileFieldMap` in `endpoint_config`; then `insert into ingest.schedules (source_id,cadence_minutes,session_only,offset_minutes,active)` values `(…,129600,false,0/2,true)`. Mirror the seed style of `20260713000017_ingest_sources.sql:315-337`.

10. **Docs (same change, per AGENTS.md):** `docs/BUILD-STATUS.md` — mark DEF-SECTOR-DATA + P1.7e-I people done for TDWL/ADX; move DFM/QE/MSX profile + BHB to §7 deferred backlog WITH triggers (Yahoo-egress for DFM/QE; MSX `.aspx` scrape; BHB proxy). `docs/architecture/07-lake-enrichment.md` §1.1 I + §4 P1.7e — tick people/sector. `docs/plans/p17-continuous-enrichment-researchers.md` §3.7 — mark built. `ingestion/CONTRACT.md` — record the `people` DataType + `NormalizedProfile`/`NormalizedPerson` additions.

---

## 6. Test plan (zero-network, `npm test` = `node --import tsx --test`; `npm run typecheck`)

Fixtures under `ingestion/fixtures/mubasher/profile-tdwl.<html|json>` and `ingestion/fixtures/adx/overview.json` (captured live in §8; until then use a synthetic fixture exercising the field map, exactly as `adx/quotes.ts` does with `DEFAULT_FIELD_MAP`).

1. **`sector-taxonomy.test.ts`** — table-driven: `normalizeSectorKey('Banks')==='banks'`, `'Insurance'==='insurance'`, `'Real Estate'==='real_estate'`, `'Materials'==='materials'`, `'Energy'==='energy'`, `'Diversified Financials'==='financials'`, `'Telecommunication Services'==='telecom'`, `null==='unknown'`, `'Widgets Inc'==='unknown'`. Assert **every** output ∈ `SECTOR_KEYS` (FK-safety invariant). Assert `bank`/`insur` win over generic (`'Investment Bank'==='banks'`).
2. **`mubasher/profile.test.ts`** (golden) — parse the fixture → assert the profile row carries a normalized sector key + `ticker`, and N person rows with correct `role`/`title`/`isIndependent`. Assert `parse()` is pure (call twice, deep-equal). Assert an unknown sector label yields `'unknown'`, never throws.
3. **`adx/profile.test.ts`** (golden, config-driven) — like `adx/quotes.ts` golden: synthetic `overview.json` + `AdxProfileFieldMap` → profile+people rows.
4. **`runtime.test.ts`** additions — `resolveTasksForSource` for a `data_type='people'` source returns `[adapter.people]`; `mapRowsToStaging` routes a `{kind:'profile'}` row → `SECURITY.PROFILE` staging with `naturalKey==='SECURITY.PROFILE:TDWL:2222'` and payload.ticker set, and a `{kind:'person'}` row → `COMPANY.PERSON:TDWL:2222:board:<name>`. Assert natural-key determinism (re-map same rows → identical keys).
5. **Migration test** (if a SQL/fake-db harness exists — `ingestion/src/lake/fake-db.ts` models lake.objects): insert a `SECURITY.PROFILE` object with `security_id` set + sector `'banks'` → assert `securities.sector` updated to `banks`; insert with an invalid sector `'zzz'` → assert sector unchanged (FK guard). Insert `COMPANY.PERSON` → assert `company_people` upsert; re-insert same (name,role) → assert single row (upsert, no dup).

---

## 7. Deploy + live-verification (VPS read-only + Supabase MCP)

Apply migration(s) via Supabase MCP `apply_migration` (project `yjsncnpbjuueaoeejrqj`) AND commit the `.sql` (per marsad-migration-workflow memory: commit the file, don't leave MCP-apply drift). Deploy worker (ingestion is bundled into the worker per runtime.ts header). Then:

1. **Confirm source seeded + schedule active:**
   `select id, venue, data_type, active from ingest.sources where data_type='people';`
   `select * from ingest.schedules sc join ingest.sources s on s.id=sc.source_id where s.data_type='people';`
2. **Trigger a run** — either wait for `ingest_tick` to enqueue (cadence is 90d so force it: `update ingest.schedules set last_enqueued_at=null where source_id=<tdwl people id>;` then the next 5-min tick enqueues), OR manually enqueue a `people` job. Watch the worker: `ssh -o ConnectTimeout=10 -o BatchMode=yes deploy@91.99.99.85 'journalctl -u marsad-worker --since "-10min" | grep -i profile'` (single-quote the remote cmd).
3. **Verify objects landed:**
   `select object_type, state, count(*) from lake.objects where object_type in ('SECURITY.PROFILE','COMPANY.PERSON') group by 1,2;`
4. **Verify sector projected (the whole point):**
   `select sector, count(*) from public.securities group by sector order by 2 desc;` — expect multiple keys (banks/energy/…), NOT just `unknown:660`. Then:
   `select count(*) from public.securities where venue_code='TDWL' and sector<>'unknown';` — expect >0.
5. **Verify people projected:** `select role, count(*) from public.company_people group by role;` — expect board+management rows.
6. **Re-run the derived pipeline and confirm cohorts form:**
   - Enqueue `nightly` (key_ratios recompute): `select cron.schedule(...)` already exists; force by enqueuing `q_maintenance {task:'nightly'}` or invoke `runtime.recomputeKeyRatios()` via a one-off. Handler entry: `worker/src/handlers/nightly.ts` `makeNightly` → `runtime.recomputeKeyRatios()`.
   - Enqueue `score_batch`: `worker/src/handlers/score-batch.ts` `makeScoreBatch` → `runtime.runScoreBatch()`.
   - Then: `select sector_peer_count, count(*) from public.scores group by 1 order by 1;` — expect **multiple distinct `sector_peer_count` values** (one per cohort), NOT a single universe-sized cohort. And `select count(distinct sector) from public.securities where sector<>'unknown';` > 1 confirms `scoreUniverse`'s `cohorts` map now has >1 key. (Score rows also require key_ratios to be non-empty, which is starved until DEF-STMT-INGEST lands — so cohort *formation* is verifiable via `securities.sector` distribution even before `scores` fully populates.)

---

## 8. LIVE PROBES NEEDED (do not invent — capture these first)

1. **Mubasher `/profile` shape** for a TDWL ticker (e.g. `english.mubasher.info/.../TDWL/stocks/2222/profile`) and an ADX ticker — the exact HTML selector / JSON path for sector, industry, shares outstanding, ISIN, listing date, free float, and the board/management table (name, title, independence). Angular client-rendered per 07 §2.1 → may need the content-poll-on-selector technique (07 §2.1: NOT networkidle). Determines whether `transport='http'` suffices or `http_bootstrap`.
2. **The actual sector LABELS** each venue prints (to tighten the `normalizeSectorKey` regex table beyond the GICS-like defaults).
3. **ADX `overview.json`** exact field names for the same fields (to fill `AdxProfileFieldMap`). Capture via the ADX Playwright request-context on the VPS (same as `adx/filings.ts`), then flip the seeded source `active=true`.
4. Whether Mubasher `/profile` exposes **shares_outstanding** at all (07 doesn't confirm it) — if not, shares_outstanding stays a separate gap (see Open Questions) and market_cap remains blocked universe-wide.

---

## 9. Idempotency / rollback / risks

- **Idempotent:** snapshot dedup (unchanged profile → no re-parse); staging upsert on `(source_id, external_id, content_hash)`; both projections use `coalesce`-guarded UPDATE / `on conflict do update` → re-runs are safe. Backfill tail uses live-revision-only (`superseded_by is null`).
- **Rollback:** drop the 4 triggers + 2 functions; sources/schedules rows removed by `delete where data_type='people'`. `securities`/`company_people` data written is additive (sector reverts to `'unknown'` only if you re-run the bootstrap; otherwise it persists harmlessly).
- **Risk — FK violation:** mitigated by the `exists (select 1 from public.sectors where key=v_sector)` guard AND `normalizeSectorKey` never emitting a non-key. Belt-and-suspenders.
- **Risk — wrong cohort from a mis-mapped label:** conservative `unknown` fallback + `bank|insur` priority ordering protect D-1 (the stated #1 credibility item). A mis-map degrades a name to `unknown` cohort, never to a *wrong* ratio-validity verdict.
- **Risk — clobbering curated identity:** all UPDATEs are `coalesce(new, existing)` so a null scrape never wipes a good value.
- **Risk — Mubasher DFM/QE empty shells** (07 §2.2): do NOT seed DFM/QE Mubasher profile sources — they render empty and would produce zero-row PARSE_DRIFT. Deferred to Yahoo egress.


---

## #3 ADX/MSX backfill unstuck — effort S

**Title:** ADX/MSX OHLCV backfill unstuck: fix duplicate User-Agent header that MSX's WAF 400s (MSX still broken; ADX unstuck-but-incomplete)

**Files to create/edit:** `ingestion/src/core/fetcher.ts`, `ingestion/src/core/fetcher.test.ts`, `supabase/migrations/20260713000042_ohlcv_backfill_header_keys.sql`, `docs/BUILD-STATUS.md`, `docs/architecture/01-ingestion.md`, `docs/architecture/07-lake-enrichment.md`

**Dependencies:** ingestion/src/core/fetcher.ts (header merge); Worker redeploy to VPS for Fix 1; Supabase MCP apply_migration + commit for Fix 2 (0042)

**Live probes needed:** Confirm exact seed header keys pre-migration: select id, endpoint_config->'headers' from ingest.sources where id in (25,26); After deploy: MSX bars > 0 in public.ohlcv_daily and ingest.fetch_log source_id=26 shows http_status=200; After deploy: ADX secs count climbs from 20 toward 93 on a full re-sweep; Verify momentum populates: public.key_ratios ret_3m/ret_6m/ret_12_1 non-null for MSX securities

**Open questions:** Does MSX's Imperva WAF start 403/429-ing the VPS IP under the full 68-symbol sweep volume (single-symbol probes are clean)? If so escalate to use_proxy=true/rotate on source 26 — not a UA fix.; Are the ADX per-ticker NETWORK drops purely transient (retry ladder clears them on re-sweep) or do specific slugs consistently fail? Determine after one full re-sweep before considering Fix 3 (concurrency 4->2).


# ADX/MSX OHLCV Backfill — Root Cause + Fix

## TL;DR (diagnosis outcome)
The 16:54 UTC redeploy (487ed99) **DID unstick the claim** — jobs for sources 25/26 are now claimed and run (job 1247/MSX ran `ok` at 16:32; ADX ran 17:04–17:13). But the two venues are in different states:

- **ADX (source 25, `mubasher_csv`): SUBSTANTIALLY WORKING but INCOMPLETE.** 34,188 bars are in `public.ohlcv_daily` across **20 of 93** securities (first `2000-11-15`, last `2026-07-14`); 34,408 `lake.staging_rows` (OHLCV.CLOSE), all `lake.objects` PENDING. `ingest.sources.last_success_at=2026-07-14 17:13:09`, `consecutive_failures=0`, 20 `fetch_log` rows all `http_status=200`. Residual: the sweep has only completed ~20 securities and shows sporadic per-ticker `errorClass:'NETWORK'` failures (AGTHIA, AIPOWR) — but those same pages return **200 in 0.25–0.43s from the VPS via curl**, so they are transient socket/timeout drops, not a systemic block. ADX just needs the full 93-ticker sweep to run to completion.

- **MSX (source 26, `msx-company-chart`): STILL 100% BROKEN.** Zero bars, zero staging rows, `last_success_at=NULL`, **zero `fetch_log` rows**. Every one of the 68 symbols fails with `FetchError: 400 client error for https://www.msx.om/company-chart-data.aspx?s=…`. The job still finishes `status='ok'` because per-ticker isolation (`fetchOneTicker` returns `null` on non-2xx) swallows all 68 failures.

## ROOT CAUSE (MSX — confirmed by live probes)
**A duplicate `User-Agent` request header, produced by a case-mismatched header merge in `ingestion/src/core/fetcher.ts`, is rejected with HTTP 400 by MSX's Imperva/Incapsula WAF.**

Evidence chain (all live, 2026-07-14):
1. `ingestion/src/core/fetcher.ts:129-133` builds the request header object as:
   ```js
   const headers = { 'user-agent': ua, 'accept-encoding': 'gzip, deflate', ...(options.headers ?? {}) };
   ```
   `ua` = the hardcoded lowercase default `DEFAULT_UA = 'MarsadIngestBot/1.0 (+https://marsad.example; …)'` (fetcher.ts:82). The spread `options.headers` comes from the seed's `endpoint_config.headers`, which carries **`User-Agent`** (capital U/A) = the Chrome UA. The two keys differ only in case, so **both survive as distinct object properties** — the fetcher never lowercases incoming `options.headers` (the only `toLowerCase()` at line 377 is in `flattenHeaders` for the *response*).
2. undici combines same-name (case-insensitive) header values: with `{ 'user-agent':'BOT/1.0', 'User-Agent':'Chrome/124' }` the server receives `User-Agent: "BOT/1.0,Chrome/124"` (verified against httpbin.org from `ingestion/` with the installed undici).
3. From the VPS (91.99.99.85): `curl … -H "user-agent: MarsadIngestBot/1.0" -H "User-Agent: Mozilla/5.0 Chrome/124" https://www.msx.om/company-chart-data.aspx?s=BKMB` → **HTTP 400** (size 445). Either UA **alone** (Chrome, marsad-bot, or none) → **HTTP 200, 963574 bytes**. So the duplicate/combined UA is the exact trigger.
4. Why ADX escaped it: the identical bug hits the Mubasher stock-page GET too, but `english.mubasher.info` is a permissive host — `curl` with the same duplicated UA → **HTTP 200**. MSX's Imperva WAF is strict → 400. Same code path, different origin tolerance.

Secondary (NOT the MSX blocker, but worth noting): the seed's raw MSX tickers ARE correct — `?s=BKMB` returns the full 963KB series from both a local IP and the VPS. So the `use_proxy=false` note in migration 0034 ("flip to true if the VPS IP gets 403'd") is a **red herring** for this failure — the VPS IP is NOT blocked; the request shape is.

## THE FIX
Primary fix is one code change (benefits every source, and is the correct general behavior). Two config touch-ups make the seeds self-documenting and let MSX backfill immediately without waiting on a redeploy.

### Fix 1 (REQUIRED, code) — case-insensitive header merge in `fetcher.ts`
In `ingestion/src/core/fetcher.ts`, replace the naive spread at lines 129-133 with a merge that lowercases **all** header keys so a caller-supplied `User-Agent`/`Accept-Encoding`/etc. **overrides** (not duplicates) the defaults. Concretely:
```ts
// Lowercase every key so caller headers override defaults (undici concatenates
// same-name headers case-insensitively → a capital 'User-Agent' from
// endpoint_config would otherwise DUPLICATE the default 'user-agent' and some
// WAFs (MSX/Imperva) 400 the combined value). See build ticket / fetcher.test.ts.
const headers: Record<string, string> = { 'user-agent': ua, 'accept-encoding': 'gzip, deflate' };
for (const [k, v] of Object.entries(options.headers ?? {})) {
  headers[k.toLowerCase()] = v;
}
```
Keep the two conditional `if-none-match` / `if-modified-since` sets below unchanged (already lowercase). This makes the seed's Chrome `User-Agent` cleanly replace the default `user-agent`, so undici sends exactly one UA.

### Fix 2 (config, data-only — unblocks MSX before/without redeploy) — lowercase the seeded header keys
Because Fix 1 requires a worker redeploy, also normalize the two seed rows so the header keys are already lowercase (undici still concatenates case-insensitively, but a lowercase `user-agent` in `endpoint_config` collides with the default's lowercase key and **overrides** it instead of duplicating — verified: single UA → 200). This makes MSX work the instant the migration applies, even on the currently-deployed worker. New migration `20260713000042_ohlcv_backfill_header_keys.sql`:
```sql
-- 0042_ohlcv_backfill_header_keys — normalize seeded header keys to lowercase so they OVERRIDE
-- (not duplicate) the fetcher's default 'user-agent'. undici concatenates same-name headers
-- case-insensitively; the capital 'User-Agent' in the 0033/0034 seeds combined with the default
-- into 'MarsadIngestBot/1.0,Mozilla/…' which MSX's Imperva WAF rejects with HTTP 400 (zero MSX
-- bars). Lowercasing the key makes it collide-and-replace the default. Data fix, effective with no
-- redeploy on the currently-live worker; fetcher.ts is also being hardened (case-insensitive merge)
-- so future seeds cannot reintroduce this. Idempotent (jsonb rebuild is deterministic).
update ingest.sources
   set endpoint_config = endpoint_config
       - 'headers'
       || jsonb_build_object('headers', jsonb_build_object(
            'user-agent', endpoint_config #>> '{headers,User-Agent}',
            'accept', endpoint_config #>> '{headers,Accept}'))
 where data_type = 'ohlcv_backfill'
   and endpoint_config->>'provider' in ('mubasher_csv','msx-company-chart')
   and endpoint_config #> '{headers,User-Agent}' is not null;
```
(Confirm the exact existing header keys with the probe SQL below before finalizing — sources 25/26 currently carry `{"User-Agent":…,"Accept":…}`.)

### Fix 3 (config, optional, ONLY IF ADX residual NETWORK drops persist) 
The ADX transient `errorClass:'NETWORK'` drops are already handled by the retry ladder (`BACKOFF_BASE_MS=[5s,25s,120s]`, 4 attempts) + per-ticker isolation. No change needed unless a full re-sweep still leaves ADX securities with zero bars — in which case lower `fetch_concurrency` from 4 → 2 on source 25 to reduce socket pressure. Do NOT do this pre-emptively.

## BUILD ORDER
1. Apply **Fix 1** in `ingestion/src/core/fetcher.ts`.
2. Add/extend a case-insensitive-override unit test in `ingestion/src/core/fetcher.test.ts` (inject a fake `transport` capturing `opts.headers`; assert exactly one `user-agent` key and that a caller `User-Agent` wins). Zero network.
3. `cd ingestion && npm run typecheck && npm test`.
4. Author migration `20260713000042_ohlcv_backfill_header_keys.sql` (Fix 2). Apply via Supabase MCP `apply_migration` (project `yjsncnpbjuueaoeejrqj`) AND commit the `.sql`.
5. Deploy the worker (Fix 1) to the VPS per the standard deploy flow; restart `marsad-worker`.
6. Live-verify (below).
7. Docs: update `docs/BUILD-STATUS.md` (mark ADX/MSX OHLCV backfill live/green once bars land for both), tick the ≥2y daily-OHLCV exit criterion in `docs/architecture/01-ingestion.md §9`, and correct the misleading `use_proxy`/"403 under volume" note in `docs/architecture/07-lake-enrichment.md` + migration 0034's header — the failure was a duplicate-UA 400, not an IP block.

## TEST PLAN (zero-network, deterministic)
- `ingestion/src/core/fetcher.test.ts`: new case — construct client with `userAgent:'BOT/1.0'` and an injected `transport` that records the `headers` it receives. Call `client.get(url, { headers: { 'User-Agent':'Chrome/124', 'Accept':'application/json' } })`. Assert: `Object.keys(recorded).filter(k=>k.toLowerCase()==='user-agent').length === 1`; `recorded['user-agent'] === 'Chrome/124'`; `recorded['accept'] === 'application/json'`; `recorded['accept-encoding'] === 'gzip, deflate'` (default preserved when caller omits it).
- Regression: existing fetcher tests still pass (default UA applied when caller sends no UA).
- No change to `parseMubasherOhlcvCsv` / `parseMsxHistory` — parsers are unaffected; their existing golden tests (`fixtures/mubasher/adx-fab-ohlcv.csv`, `fixtures/msx/company-chart-BKMB.json`) must stay green.

## DEPLOY + LIVE-VERIFY
Pre-flight probe SQL (confirm seed header keys before writing the migration):
```sql
select id, endpoint_config->'headers' from ingest.sources where id in (25,26);
```
Trigger a fresh backfill for both (re-arm the schedule so `enqueue_due_jobs` inserts a new job, or directly enqueue):
```sql
-- Option A: enqueue directly (bypasses cadence wait) — one job per source.
insert into ingest.job_queue (source_id, run_after, priority, status, enqueued_at)
select id, now(), 0, 'queued', now()
from ingest.sources where id in (25,26);
```
Then, after the worker claims + drains (MSX 68 GETs @ concurrency 4; ADX 93 two-step fetches):
```sql
-- 1. bars landed for BOTH venues
select s.venue_code, count(*) bars, count(distinct o.security_id) secs,
       min(o.trade_date) first, max(o.trade_date) last
from public.ohlcv_daily o join public.securities s on s.id=o.security_id
where s.venue_code in ('ADX','MSX') group by s.venue_code;
-- EXPECT: MSX now non-zero (target ~all 68 listed secs, 24y depth for old names like BKMB);
--         ADX secs climbs from 20 toward 93.

-- 2. source health
select id, last_success_at, consecutive_failures from ingest.sources where id in (25,26);
-- EXPECT: MSX last_success_at now set, consecutive_failures 0.

-- 3. fetch_log now has MSX rows with 200s
select source_id, count(*), count(*) filter (where http_status=200) ok200,
       (array_agg(error order by fetched_at desc))[1] latest_err
from ingest.fetch_log where source_id in (25,26) group by source_id;
```
VPS journal check (should show 200s, not `400 client error`):
```
ssh -o ConnectTimeout=10 -o BatchMode=yes deploy@91.99.99.85 \
 'journalctl -u marsad-worker --since "-15min" --no-pager | grep -iE "msx history|company-chart|400 client|rowsEmitted" | tail -40'
```
Momentum then computes for these venues automatically on the next nightly run (nightly 02:00 GST → `KeyRatiosRecompute.momentum()` reads `public.ohlcv_daily` per security: ret3m needs ≥64 bars, ret6m ≥127, ret121 ≥253 — MSX's 24y history satisfies all). To verify without waiting, run key-ratios for a couple of MSX securities and check the columns:
```sql
select security_id, ret_3m, ret_6m, ret_12_1, computed_at
from public.key_ratios kr join public.securities s on s.id=kr.security_id
where s.venue_code='MSX' order by computed_at desc limit 10;
```

## IDEMPOTENCY / ROLLBACK
- Fix 1 is a pure header-normalization change; no data migration, trivially reversible by revert.
- Migration 0042 is idempotent (deterministic jsonb rebuild, guarded on `provider in (...)` and `headers.User-Agent is not null`). Rollback: re-set the capital-cased keys — but there is no reason to; lowercase keys are strictly correct.
- Re-triggering backfill is safe: snapshot dedupe + staging upsert on `(source_id, external_id, content_hash)` make re-runs no-ops for unchanged bars.

## RISKS
- MSX may 403/429 the VPS **under sustained volume** (Imperva). Not observed now (single-UA curl = 200), but if it appears post-fix, the real mitigation is `use_proxy=true`+`proxy_mode='rotate'` on source 26 (runtime `httpClientForSource` honors it, no redeploy) — NOT a UA change. Keep this as the documented escalation.
- ADX residual NETWORK drops: monitor that a full re-sweep gets ADX `secs` to ~93; if some tickers persistently drop, apply Fix 3 (lower concurrency) or accept per-ticker coverage gaps (per-ticker isolation is by design).
- Stale orphan queue rows: jobs 1246/1254/1255 (source 25/26) remain `status='queued', claimed_by=NULL` with past `run_after` — pre-restart orphans. Harmless (they'll be claimed on a poll tick or can be manually set `status='ok'`), but the direct-enqueue verify step supersedes them.


---

## #4 EOD accrual validation — effort M

**Title:** V-1 EOD Accrual Validation: prove ohlcv_accrual mints one correct bar/security/venue per live GCC session (ops.incidents #23)

**Files to create/edit:** `docs/BUILD-STATUS.md (mark V-1 result; log FM-1 dark-venue quotes gap and any residual FM-2 in §7 with trigger+home)`, `docs/architecture/07-lake-enrichment.md (§2.2: note board-accrued bars are close-only proxies open=high=low=close; accrual is additive fallback under path-a bulletin bars)`, `ops.incidents #23 (close with run evidence — DB row, not a repo file)`, `(conditional fix) worker/src/handlers/ohlcv-accrual.ts or migration only if V-1 surfaces a code defect — none expected; the SQL/wiring are correct as read`

**Dependencies:** A live GCC trading session (next: 2026-07-14 18:00 UTC first cron fire; else 2026-07-15 Wed); quotes_latest must be fresh through close for the venue under test — depends on the quote poller (FM-1: only TDWL+QE currently produce quotes; FM-2: QE poll frozen); VPS read access ssh deploy@91.99.99.85 for worker log evidence; Supabase MCP execute_sql for the SQL protocol

**Live probes needed:** V-2 quotes_latest per-venue freshness (distinct_asof, max_local_date) during the session, before each venue close; cron.job_run_details jobid=23 after 18:00 UTC to confirm first-ever fire + status; ops.job_heartbeats ohlcv_accrual last_ok_at after run; BEFORE/AFTER ohlcv_daily diff (pre_accrual temp table) to isolate accrual's unique bars; Correctness join accrual bar vs quotes_latest for a QE security; VPS journalctl marsad-worker grep ohlcv_accrual for barsWritten line; pgmq.metrics('q_pipeline') to confirm the enqueued message was consumed not stuck; public.market_holidays check for the run date/venues

**Open questions:** Why do DFM/ADX/MSX/BHB have zero quotes_latest rows — is the quote adapter unbuilt for these venues, or the schedule inactive, or objects not projecting? (FM-1 root cause needs its own investigation; blocks all-6-venue V-1.); Why did the QE poll freeze at 06:33Z (single as_of for all 49 securities)? Fetch error, session_only window, or worker crash? (FM-2); Does public.market_holidays have a row for 2026-07-14 for any venue (would legitimately zero out that venue's accrual)?; Is the same-day OHLCV.CLOSE bulletin source (398 PENDING objects for 2026-07-14) intended to fully supplant board accrual for TDWL/DFM/ADX, leaving accrual as a QE/thin-venue fallback only? If so, the incident-#23 success bar should be scoped to venues without a bulletin source.; Should the accrual date filter or handler consult market_sessions.close_local to only accrue after the specific venue's close, rather than relying on the single 18:00 UTC global fire? (Currently fine since 18:00Z > all closes.)


# V-1 — EOD ACCRUAL VALIDATION (P1.7a, ops.incidents #23)

## Objective
Prove — against a real GCC session — that the wired-but-never-run EOD accrual (`public.accrue_ohlcv_from_quotes` + `ohlcv_accrual` pg_cron jobid 23 @ 18:00 UTC + worker `ohlcv_accrual` handler) adds **exactly one correct bar per listed security per venue per trading day** to `public.ohlcv_daily`, with no duplicate vs the backfilled series and no gap, and that the intraday quote poll keeps `quotes_latest` fresh enough through the session to feed it. Then fix the failure modes this surfaces. This is a **TEST + FIX** ticket, not greenfield: the code is deployed and the wiring is intact. "Proven" = V-1 and V-2 below both pass on a live session date, `ops.job_heartbeats.last_ok_at` for `ohlcv_accrual` is non-null and recent, and ops.incidents #23 is closed with the run evidence attached.

## Ground truth established by live probes (project yjsncnpbjuueaoeejrqj, probed 2026-07-14 ~17:16 UTC)
- **Wiring is fully intact.** cron.job jobid 23 `schedule='0 18 * * *'`, `active=true`, command `select pgmq.send('q_pipeline', jsonb_build_object('handler','ohlcv_accrual'))`. Handler registered at `worker/src/handlers/register-ingestion-handlers.ts:36` (`['ohlcv_accrual', makeOhlcvAccrual()]`). Payload type `OhlcvAccrualPayload` in `worker/src/handlers/payloads.ts:53`.
- **Never run.** `cron.job_run_details where jobid=23` → **empty**. `ops.job_heartbeats where job_name='ohlcv_accrual'` → `last_run_at=null, last_ok_at=null, consecutive_failures=0`. Consistent with incident #23. Reason: today's 18:00 UTC had not yet arrived at probe time (17:16 UTC); the job simply has not had its first firing.
- **`quotes_latest` is populated and OHLCV-complete but only 2 venues.** 427 rows, all with non-null open/high/low/close/volume. But only **QE (49 rows) and TDWL (378 rows)** are present — DFM, ADX, MSX, BHB have **zero** `quotes_latest` rows despite having listed securities (ADX 93, DFM 55, MSX 68, BHB 8 listed). So today's accrual would only ever mint TDWL+QE bars.
- **`quotes_intraday` IS populated** (378 rows) but in a single 4.5-min window 16:29–16:34 UTC — i.e. it accrues going forward from `fn_quote_project` (migration 0031) and is irrelevant to the accrual, which reads **`quotes_latest`, not `quotes_intraday`** (confirmed: `accrue_ohlcv_from_quotes` body joins `public.quotes_latest` only).
- **QE poll is STALE.** All 49 QE `quotes_latest` rows share exactly one `as_of` = `2026-07-14 06:33:23Z` (distinct_asof=1). TDWL has 265 distinct as_of spanning 04:00–08:59Z. QE's poller ran once and stopped — a live V-2 failure for QE.
- **Board OHL is degenerate.** For every TDWL row, `open=high=low=last` (e.g. sec 332: all 44.96). The delayed quote board (or its parser) does not carry session-cumulative O/H/L; accrual bars will have OHLC all equal to the close.
- **`ohlcv_daily` already has 2026-07-14 bars via path (a)** BEFORE any accrual: ADX 12, DFM 47, TDWL 339 rows for trade_date 2026-07-14 (all `value_traded IS NULL`). Source: 398 `lake.objects` `OHLCV.CLOSE` rows for effective_date 2026-07-14, all PENDING, created 13:45–17:14 UTC — an EOD-bulletin/Yahoo backfill source is landing same-day bars through path (a) `fn_ohlcv_daily_project`.
- **Dry-run of today's accrual would INSERT only 92 new bars** (427 board rows, 335 already have a 2026-07-14 bar from path (a); `on conflict do nothing` skips them). So the accrual is now **largely additive-redundant with path (a) for TDWL/DFM/ADX**, and its unique contribution is venues/securities path (a) hasn't covered (mostly QE).
- **Close times (from `public.market_sessions`, regular session):** TDWL/DFM/ADX 15:00 local; QE 13:15; MSX 13:10; BHB 13:00. In UTC: TDWL(UTC+3)=12:00, DFM/ADX(UTC+4)=11:00, QE(UTC+3)=10:15, MSX(UTC+4)=09:10, BHB(UTC+3)=10:00. **The 18:00 UTC cron fires safely after every venue close.** (`public.venues` has NO market_open/close column — only trading_days, timezone ARRAY, delay_minutes; per-venue close lives in `public.market_sessions.close_local`.)
- **Trading calendar:** `public.venues.trading_days` (int[] day-of-week, 0=Sun): TDWL/QE/MSX/BHB = `{0,1,2,3,4}` (Sun–Thu); DFM/ADX = `{1,2,3,4,5}` (Mon–Fri). BK (Kuwait) `is_active=false` — ignore. `public.market_holidays` exists (schema unchecked — verify no holiday on the chosen run date).
- **Accrual date semantics:** handler `resolveTradeDate` defaults to `new Date().toISOString().slice(0,10)` = current UTC date; cron sends no `tradeDate`, so the job accrues **the UTC date at 18:00 UTC**, which equals the venue-local trade date for all GCC venues (UTC+3/+4). Correct for a same-day 18:00 run.

## NEXT GCC SESSION TO RUN THE VALIDATION
**Today, 2026-07-14 (Tuesday, DOW=2)** is a live session for all 6 active venues (in both `{0..4}` and `{1..5}` calendars). The **first-ever `ohlcv_accrual` cron firing is 2026-07-14 18:00 UTC** (~45 min after probe). If that window is missed, the next is **2026-07-15 (Wed) 18:00 UTC**; the last Sun–Thu session of this week for TDWL/QE/MSX/BHB is Thu 2026-07-16. First verify no `public.market_holidays` row for the chosen date/venues before treating a zero-bar result as a failure.

## Validation protocol

### V-2 (run DURING the session, before close) — poll freshness, the accrual dependency
The accrual can only mint a bar for a security whose `quotes_latest.as_of` (venue-local) = trade_date. Run this **before each venue's close** on the run date:
```sql
select s.venue_code, count(*) n, count(distinct q.as_of) distinct_asof,
       max(q.as_of) max_as_of,
       max((q.as_of at time zone v.timezone)::date) max_local_date
from public.quotes_latest q
join public.securities s on s.id=q.security_id and s.status='listed'
join public.venues v on v.code=s.venue_code
group by s.venue_code order by s.venue_code;
```
**PASS:** every active venue appears, `distinct_asof > 1` (poll advancing), `max_local_date = <today>`, `max_as_of` within ~poll-cadence of now. **Known live FAILs at probe time:** QE `distinct_asof=1` (frozen 06:33Z); DFM/ADX/MSX/BHB absent entirely.

### V-1 (run AFTER 18:00 UTC accrual) — one correct new bar/security/venue, no dup, no gap

**Step 1 — confirm the job actually fired and succeeded:**
```sql
select status, return_message, start_time, end_time from cron.job_run_details where jobid=23 order by start_time desc limit 3;
select job_name,last_run_at,last_ok_at,last_error,consecutive_failures from ops.job_heartbeats where job_name='ohlcv_accrual';
```
PASS: a run_detail row with `status='succeeded'` at ~18:00Z today; `last_ok_at` non-null and ≈ now; `consecutive_failures=0`, `last_error IS NULL`. Also confirm the worker consumed the enqueue (VPS log, Step 5).

**Step 2 — the bars the accrual actually added (isolate its unique contribution).** Because path (a) pre-populates most bars, capture a BEFORE snapshot at ~17:55 UTC and diff after 18:05 UTC:
```sql
-- BEFORE (17:55Z): 
create temp table pre_accrual as
  select security_id, trade_date from public.ohlcv_daily where trade_date = current_date;
-- AFTER (18:05Z):
select s.venue_code, count(*) as bars_added_by_accrual
from public.ohlcv_daily o
join public.securities s on s.id=o.security_id
where o.trade_date = current_date
  and not exists (select 1 from pre_accrual p where p.security_id=o.security_id and p.trade_date=o.trade_date)
group by s.venue_code order by s.venue_code;
```
PASS: rows appear only for venues/securities path (a) did not already cover (expected: QE + any board securities without a bulletin bar). `barsWritten` in the worker log (Step 5) must equal the total of this diff.

**Step 3 — exactly one bar/security/day (no duplicates):** the PK `(security_id, trade_date)` makes true dups impossible, but assert:
```sql
select security_id, trade_date, count(*) from public.ohlcv_daily
where trade_date = current_date group by security_id, trade_date having count(*) > 1;
```
PASS: **zero rows**.

**Step 4 — correctness of an accrual-minted bar (OHLCV+volume+trade_date match the board):** for a security that the accrual (not path a) inserted, the bar must equal that security's `quotes_latest` close/OHLV:
```sql
select o.security_id, o.trade_date, o.open,o.high,o.low,o.close,o.volume,o.value_traded,
       q.open qo,q.high qh,q.low ql,q.last qlast,q.volume qv
from public.ohlcv_daily o
join public.quotes_latest q on q.security_id=o.security_id
join public.securities s on s.id=o.security_id and s.venue_code='QE'
where o.trade_date=current_date
  and not exists (select 1 from pre_accrual p where p.security_id=o.security_id and p.trade_date=o.trade_date)
limit 20;
```
PASS: `close=qlast`, open/high/low/volume equal the board values, `value_traded IS NULL` (accrual never fabricates turnover — by design, migration 0028 lines 122–127), `trade_date=current_date`. Note: OHLC will be degenerate (open=high=low=close) given the board finding — that is EXPECTED and correct-for-source, not a bug.

**Step 5 — VPS worker log evidence:**
```
ssh -o ConnectTimeout=10 -o BatchMode=yes deploy@91.99.99.85 'journalctl -u marsad-worker --since "18:00 UTC" --no-pager | grep -i "ohlcv_accrual"'
```
PASS: a `ohlcv_accrual done {barsWritten: N}` line, N = Step 2 total. (Log line emitted at `worker/src/handlers/ohlcv-accrual.ts:56`.)

**Step 6 — no gap in the accrued series going forward:** after ≥2 consecutive session runs, confirm each active venue gained exactly one new trade_date per session with no missing trading day:
```sql
select s.venue_code, o.trade_date, count(*) from public.ohlcv_daily o
join public.securities s on s.id=o.security_id
where o.trade_date >= current_date - 5 group by s.venue_code,o.trade_date order by s.venue_code,o.trade_date;
```
PASS: one row per (venue, each trading day per its `trading_days`), no trading-day gaps.

## Predicted failure modes + fixes

**FM-1 (CONFIRMED, highest priority) — 4 of 6 venues never reach quotes_latest, so accrual mints zero bars for them.** DFM/ADX/MSX/BHB have listed securities but no `quotes_latest` rows. Root cause is upstream (quote poll not producing QUOTE.LAST objects → `fn_quote_project` never fires) — NOT in the accrual. **Fix path:** confirm `ingest.schedules` has active `quotes` rows for these venues; check the worker/adapter for these venues emits QUOTE.LAST staging → objects (grep `lake.objects where object_type='QUOTE.LAST'` per venue). If the venue quote adapter is unbuilt, that is a separate build item — log it in `docs/BUILD-STATUS.md` §7 with trigger "before V-1 can pass for all 6 venues" and home 07-lake-enrichment.md family B. **V-1 partial-pass criterion:** accept V-1 as proven for **venues that have live quotes** (TDWL, QE) and explicitly scope the 4 dark venues to FM-1.

**FM-2 (CONFIRMED) — QE poll freezes mid-session (distinct_asof=1 @ 06:33Z).** If frozen before QE's 10:15 UTC close, the accrual still mints a QE bar (as_of local date = today) but with a **mid-session, not closing, price** — a wrong close silently persisted. **Fix:** investigate why the QE poller stopped (worker log for the QE quotes job around 06:33Z; check `ingest.job_queue`/heartbeat for the QE quotes schedule; likely a fetch error or a `session_only` window mis-set). Until fixed, QE accrual close is unreliable. Do NOT "fix" by widening the accrual date filter — the bug is the poll, not the accrual.

**FM-3 (BY DESIGN, document — do not "fix") — degenerate OHLC (open=high=low=close).** The board carries only `last`; parser mirrors it into open/high/low. Accrual bars therefore have flat OHLC. This is acceptable because path (a) bulletin/Yahoo bars (real OHLC + turnover) overwrite via `fn_ohlcv_daily_project`'s `do update`. **Action:** note in `docs/architecture/07-lake-enrichment.md` §2.2 that board-accrued bars are close-only proxies; no code change. If the venue board genuinely exposes intraday high/low, that is a parser enhancement (separate item).

**FM-4 (BY DESIGN, verify not triggered) — accrual reads a single quotes_latest snapshot, not an intraday range.** `accrue_ohlcv_from_quotes` reads the one `quotes_latest` row per security (the last poll of the day), so high/low are that snapshot's, not the session's true range. Given FM-3 the point is moot for now. If/when the board carries real OHL, the snapshot-at-close IS the correct EOD figure — no fix needed. Documented so a future reader doesn't "fix" it into an intraday aggregation over `quotes_intraday`.

**FM-5 — redundancy with path (a) makes barsWritten small/zero, misread as failure.** 335/427 board securities already had a 2026-07-14 bar from the same-day bulletin source, so accrual `barsWritten` will be small. This is CORRECT (additive-only `on conflict do nothing`). **Guard:** V-1 Step 2 measures the accrual's *unique* additions, not raw `barsWritten`, and Step 4 verifies correctness of those. Do not treat low barsWritten as a failure.

**FM-6 — first-fire cron/queue plumbing.** Since jobid 23 has never fired, verify at 18:00Z: (a) `cron.job_run_details` gets a row (cron fired the `pgmq.send`), (b) `pgmq.metrics('q_pipeline')` shows the message consumed not stuck (queue_length was 4 at probe — a backlog could delay pickup), (c) worker routes `handler='ohlcv_accrual'` to the registered handler. If the message sits unconsumed, check worker consumer health on the VPS.

**FM-7 — market_holidays not consulted.** Neither the cron nor the handler checks `public.market_holidays`; on a holiday the board is stale-from-prior-session, and the accrual's `as_of local date = today` filter correctly yields zero bars (no bogus mint). Verify the run date is not a holiday so a legitimate zero isn't misdiagnosed. No code fix required (the date filter is the guard), but note it.

## Idempotency / rollback
`accrue_ohlcv_from_quotes` is idempotent (`on conflict do nothing` on PK). Re-running the handler for the same date is a no-op on existing bars — safe to re-fire manually via `select pgmq.send('q_pipeline', jsonb_build_object('handler','ohlcv_accrual'))` or directly `select public.accrue_ohlcv_from_quotes(current_date);`. No rollback needed for a bad accrual bar EXCEPT the FM-2 mid-session-close case: if a wrong QE close persisted, delete just those accrual bars (`value_traded IS NULL` and no path-(a) object exists) for the affected date, fix the poll, re-run. There is no per-row provenance column, so scope any delete tightly by `(security_id, trade_date)` from Step 2's diff set.

## Manual-trigger option (do not wait for 18:00 cron if validating out of band)
After the session closes and quotes_latest is settled, force a run: `select public.accrue_ohlcv_from_quotes(current_date);` (returns count). This exercises the SQL path but bypasses cron→pgmq→worker→heartbeat; to validate the FULL chain (and clear incident #23's heartbeat), enqueue via `pgmq.send` and let the worker handle it so `ops.job_heartbeats.last_ok_at` is written.

## Definition of "proven" (close incident #23 when all hold)
1. `cron.job_run_details` jobid 23 has a `succeeded` row for a real session date.
2. `ops.job_heartbeats.ohlcv_accrual.last_ok_at` non-null, recent, `consecutive_failures=0`.
3. V-1 Steps 2–4 pass for at least the live-quote venues (TDWL, QE): unique accrual bars are correct (close/OHLV/volume match board, value_traded null), zero duplicates.
4. V-2 poll-freshness passes for those venues (or FM-2 QE fix landed).
5. FM-1 (4 dark venues) and any residual FM-2/FM-3 logged in `docs/BUILD-STATUS.md` §7 with trigger + home, and `07-lake-enrichment.md` §2.2 updated with the board close-only-proxy note.
6. Incident #23 closed with the run_detail id + Step 2/4 output attached.


---

## #5 Set-based nightly recompute — effort M

**Title:** Set-based nightly key_ratios recompute — batch the DB I/O (Option B), keep the TS math

**Files to create/edit:** `/Users/ayushkbhatia/Marsad-Platform/ingestion/src/lake/key-ratios.ts (rewrite run() to set-based gatherAllInputs + persistAll; export/extract ttmFlow/priorTtmFlow/sumRows/numFrom helpers)`, `/Users/ayushkbhatia/Marsad-Platform/ingestion/src/lake/key-ratios.test.ts (add batch-query matchers to the rich fake; add the exact-equivalence regression test; port the 9 existing tests to the batch path)`, `/Users/ayushkbhatia/Marsad-Platform/docs/architecture/07-lake-enrichment.md (§3.6 / KEY RATIOS note: document set-based recompute + deferred Option A trigger)`, `/Users/ayushkbhatia/Marsad-Platform/docs/BUILD-STATUS.md (mark done; reconcile §7)`, `OPTIONAL /Users/ayushkbhatia/Marsad-Platform/supabase/migrations/20260713000042_key_ratios_recompute_indexes.sql (only if live EXPLAIN shows missing (security_id, trade_date desc) / (security_id, statement_type, period_end desc) indexes; apply via Supabase MCP apply_migration AND commit the .sql)`

**Dependencies:** Rebase this worktree onto origin/main HEAD (a489fe4 / 487ed99) so migrations 0039-0041 and the 0040 ohlcv_bulk_objectify reference pattern are present and next-free migration number is 0042; No new npm deps; uses existing postgres.js unnest array binding and node --import tsx --test

**Live probes needed:** EXPLAIN (ANALYZE) the batch Q2 (financial_statements ... security_id in (...) order by security_id, statement_type, period_end desc) and Q3 (ohlcv_daily row_number() over (partition by security_id order by trade_date desc)) against live to confirm index usage — ohlcv_daily has 250k rows; if seq-scanned add/verify index on (security_id, trade_date desc) and financial_statements (security_id, statement_type, period_end desc); Confirm postgres.js unnest array binding with null elements in a ::numeric[] round-trips correctly via the 20-security live enqueue probe (compare key_ratios rows to a pre-deploy snapshot); Confirm the exact GST-vs-UTC cron offset assumption: nightly_omnibus=0 22 * * * and score_batch=0 0 * * * are UTC (=02:00 and 04:00 GST) — the 2h window is between these two UTC times; Time a full live run post-deploy (log elapsedMs at considered≈660) to confirm it is well under the ~40min baseline and the 2h window

**Open questions:** financial_statements is currently EMPTY (0 rows) live — so the perf win is latent until the financials-ingestion family lands and back-loads ~660 securities. Confirm with the owner whether to build this now (pre-emptive, low risk) or defer until the statement-population trigger fires (count(*) financial_statements > ~2000).; Tie-break policy on equal period_end within the same (security_id, statement_type, period_kind): the current per-family queries have no secondary sort, so batch equivalence assumes no duplicate period_ends. Confirm this holds in real venue data or add a deterministic tie-break (e.g. id desc) and accept it as a documented, harmless divergence.; Should the batched COMPUTED.RATIOS write use one parse_run for the whole batch (matches 0040 ohlcv_bulk pattern) or one per security (matches current)? One-per-batch is recommended for throughput; confirm lineage granularity is acceptable (COMPUTED objects still carry per-security natural_key + security_id, only parse_run_id is shared).


## Objective

Cut the wall-clock time of the nightly `public.key_ratios` recompute (`ingestion/src/lake/key-ratios.ts` `KeyRatiosRecompute.run`) from RTT-bound (~40 min for 660 securities) to a small number of bulk round-trips, WITHOUT changing a single computed number. Today `run()` loops per-security and issues **~10 sequential round-trip queries per security** inside `gatherInputs` (quote, income quarterly, cashflow quarterly, income ttm, cashflow ttm, income annual, cashflow annual, balance, momentum ohlcv, trailingDps) plus a 2–4 statement transaction in `persist`. At ~140 ms Mumbai↔EU RTT that is ~12–14 round-trips × 660 = ~8–9k serial round-trips ≈ the observed ~40 min. It runs at `nightly_omnibus` 22:00 UTC (= 02:00 GST) and MUST finish before `score_batch` 00:00 UTC (= 04:00 GST) — a 2 h window.

**Recommendation: Option B — keep the pure math in TS, batch the DB I/O.** Load ALL inputs for all securities in a handful of set-based queries (one per input family, window-functioned where needed), compute in-memory with the existing `computeKeyRatios`, and write with one bulk multi-row UPSERT to `public.key_ratios` + a batched COMPUTED.RATIOS object write. Math is byte-for-byte unchanged → lowest risk, and a regression test can assert identical output against the current impl. Option A (pure-SQL `fn_recompute_key_ratios()`) is rejected below with justification.

## Why B over A (justification — required)

Option A (a SQL `fn_recompute_key_ratios()` doing TTM assembly + ratio math set-based, the 07 §3.6 original intent) would move ALL of the following into plpgsql/SQL, each of which is non-trivial and error-prone to re-derive:
- **TTM assembly** (`ttmFlow`/`priorTtmFlow`/`sumRows` in key-ratios.ts:468-499): element-wise sum of *every numeric key present in any of the trailing 4 quarters* of a `jsonb line_items`, with a 3-level fallback (Σ4Q → explicit `ttm` row → latest `annual`). In SQL this is a `jsonb_each` → `jsonb_object_agg(sum())` over a lateral, replicated for the 5..8 prior-year window and the 3y-ago anchor. Every jsonb-number-vs-string coercion (`numFrom`, key-ties `Number.isFinite`) must match TS exactly.
- **Sector-aware nulling** (`sectorValidity`, ratios-compute.ts:143-151): `/bank/i` and `/insur/i` regex on `securities.sector` nulls gross_margin / ev_ebitda / net_debt_ebitda. Portable to `~*` but must match the regex semantics.
- **Momentum from ohlcv** (key-ratios.ts:261-277): needs the ordered close array and index-based lookups `close[0]/close[63]`, `close[0]/close[126]`, `close[21]/close[252]` with null-on-missing-bar. In SQL this is `row_number()` windowing to pick specific ordinal bars — doable but every off-by-one is a silent wrong number.
- **Growth/CAGR** (`growth`, `cagr3y`): `cbrt`, positivity guards (`ttm>0 && ago>0`), `prior≠0` guards — SQL has `||/` / `power` but the guard branches must be replicated.
- **eps/ebitda/net_debt fallbacks** (ratios-compute.ts:175-184): "explicit line wins else derive" precedence.

Re-implementing all of this in SQL means maintaining the exact math in **two** languages forever, and the regression test can only assert equivalence at a coarse grain. **Option B keeps `computeKeyRatios` as the single source of truth**, so the regression test is exact and future ratio changes touch one file. B removes the RTT bottleneck just as effectively (the bottleneck is round-trip COUNT, not compute — mirroring exactly what PR#2 / migration `20260713000040_ohlcv_bulk_objectify.sql` did for OHLCV: it did not move math into SQL, it collapsed 8 round-trips/key into one `INSERT … SELECT`). Adopt A only if a future profiling shows the in-memory TS compute (not I/O) is the bottleneck — it will not be at 660×508 rows.

## Live-grounded scale + the urgency trigger (state as of 2026-07-14, project yjsncnpbjuueaoeejrqj)

- `public.securities` listed = **660**; `public.key_ratios` = **196** rows.
- `public.ohlcv_daily` = **250,381** rows across **495** securities, avg **508** bars/security (max 3847) — comfortably > the 260 momentum needs.
- **`public.financial_statements` = 0 rows. `public.dividends` live = 0 rows.** So TODAY the recompute only ever produces momentum-driven ratios (that's the 196 rows).
- Cron (UTC): `nightly_omnibus` = `0 22 * * *`, `score_batch` = `0 0 * * *`, `ohlcv_bulk_objectify` = `* * * * *`.

**Urgency trigger (this is a SCALING item, not urgent yet):** the per-security cost is dominated by the ohlcv momentum read (508 bars) and the statement reads. With statements empty, the statement round-trips return fast/empty and the real load is 495 ohlcv reads. **Pick this up the moment `financial_statements` starts populating at scale** — i.e. once the statement-ingestion path (P1.7 financials family) lands and back-loads income/balance/cashflow for the ~660 names. At that point every security incurs the full ~12 round-trips and the run approaches/exceeds the measured ~40 min, eating into the 2 h → 04:00 window; a slow night (RTT spike, pool contention) then risks `score_batch` reading stale `key_ratios`. Concretely: **trigger = `select count(*) from public.financial_statements > ~2000` (≈ >3 statement rows/security) OR a nightly `key_ratios.recompute` log line with `considered≈660` and wall-clock > 30 min.** Until then it runs off-hours and 40 min fits 2 h.

## Approach (Option B) — exact shape

Rewrite `KeyRatiosRecompute.run()` to a set-based pipeline. Keep `computeKeyRatios`/`hasAnyRatio`/`RatioInputs`/`KeyRatios` (ratios-compute.ts) **untouched**. Replace `gatherInputs` (per-security) with `gatherAllInputs()` (whole-batch) that returns `Map<securityId, RatioInputs>`, then loop in-memory (pure, no I/O) calling `computeKeyRatios`, then one batched persist.

### Query shapes for `gatherAllInputs(securityIds?)`

All queries filter to the batch: `where s.status='listed'` (+ `and s.id = any(${ids})` when a slice is passed), ordered by `security_id` so results zip deterministically. postgres.js returns arrays; group in JS by `security_id`.

**Q1 — securities + latest quote (1 query):**
```sql
select s.id, s.venue_code, s.shares_outstanding, s.sector, s.currency, q.last
from public.securities s
left join public.quotes_latest q on q.security_id = s.id
where s.status='listed' [and s.id = any($1)]
order by s.id
```

**Q2 — statements, ALL rows for the batch, one query (replaces quarterly/annual/ttm/balance × income/cashflow — currently 7 queries/security):**
```sql
select security_id, statement_type, period_kind, period_end, line_items
from public.financial_statements
where is_estimate = false
  and security_id in (select id from public.securities where status='listed' [and id = any($1)])
  and statement_type in ('income','cashflow','balance')
order by security_id, statement_type, period_end desc
```
Then in TS, per security, slice exactly as the current code does:
- income quarters (period_kind='quarter') newest-first → `sumRows(slice(0,4))` for TTM, `slice(4,8)` for prior (reuse the EXISTING `ttmFlow`/`priorTtmFlow`/`sumRows`/`numFrom` helpers verbatim — export them from key-ratios.ts or move to a shared module),
- income annual newest-first → `[0]` proxy, `[1]` prior, `[3]` 3y-ago,
- income ttm row (period_kind='ttm') `[0]`,
- same for cashflow,
- balance: newest row of statement_type='balance' (any period_kind) — matches current `balanceStatement` which does NOT filter period_kind.
  ⚠️ Match current ordering: current per-family queries `order by period_end desc limit N`. The batch query orders `period_end desc` globally per (security,type); TS slicing by period_kind preserves identical newest-first order. Verify tie-break: current SQL has no secondary sort key on `period_end` ties — keep the batch query's ordering stable by adding `, id desc` as a deterministic tie-break ONLY IF the current impl is also deterministic; the current impl relies on DB order for equal period_end, so document this as an accepted equivalence (ties on period_end across the same statement_type/period_kind are not expected in real data).

**Q3 — momentum closes via window function (replaces the per-security 260-row ohlcv read):**
```sql
select security_id, close, rn
from (
  select security_id, close,
         row_number() over (partition by security_id order by trade_date desc) as rn
  from public.ohlcv_daily
  where security_id in (select id from public.securities where status='listed' [and id = any($1)])
) t
where rn <= 253   -- need index 252 (ret121 denominator); current impl limit 260, but only 0,21,63,126,252 are read
order by security_id, rn
```
Keep `limit 260`-equivalent (`rn <= 260`) to be byte-identical to the current `limit 260`; the extra bars are inert. Build the per-security `close[]` array (index = rn-1) in TS and reuse the EXACT `ret(numIdx,denIdx)` logic (ret3m=ret(0,63), ret6m=ret(0,126), ret121=ret(21,252)) from momentum(). Missing bar ⇒ null, identical.

**Q4 — trailing DPS, set-based (replaces per-security sum):**
```sql
select security_id, sum(dps)::text as dps_sum
from public.dividends
where state='live' and ex_date is not null
  and ex_date >= (now() at time zone 'utc')::date - 365
  and security_id in (select id from public.securities where status='listed' [and id = any($1)])
group by security_id
```
⚠️ **Preserve the `now()` semantics.** Current impl computes the 365-day window inside SQL per call. Keep it in SQL (Q4) — do NOT move to JS `Date.now()` (parse-purity/replay concerns don't apply here since this is the impure gather side, but keeping it in SQL preserves identical `now()` truncation). Securities with no live dividends simply won't appear in Q4 → null trailingDps, matching current `rows[0]?.dps_sum ?? null`.

### In-memory assembly

For each security in Q1, build `RatioInputs` exactly as `gatherInputs` does (same key lists `revenueKeys`, `epsKeys`, same `numFrom(incomeTtm, ...)` calls), from the grouped Q2/Q3/Q4 data. Call `computeKeyRatios(inputs)`; skip if `!hasAnyRatio`. Accumulate `{sec, ratios}` for the write phase and the summary counters (`rowsWritten`, `rowsSkippedAllNull`, `securitiesConsidered`).

### Bulk write

Two writes, both batched:

**(a) COMPUTED.RATIOS lake objects — batched.** The current `writeComputedObject` does a per-security supersede (select live → retire → insert PENDING → update VERIFIED) plus a `parse_runs` insert. Rewrite as ONE transaction (`sql.begin`) doing set-based statements:
1. one `insert into lake.parse_runs (agent_id, parser_key, parser_version, status) values ($agent,'key_ratios','1','running') returning id` (one run for the whole batch, matching the 0040 `ohlcv_bulk` pattern which uses one parse_run/batch).
2. Bulk-retire prior live objects for the batch's natural_keys: `update lake.objects set superseded_by = <new>, state='RETIRED' where natural_key = any(...) and superseded_by is null`. ⚠️ The self-FK `superseded_by` is DEFERRABLE (0004) and resolves at COMMIT, so within one transaction you can insert the new rows first, then point the old ones at them. Simplest faithful port: use a VALUES-list / `unnest` insert of all new COMPUTED.RATIOS rows (state PENDING, revision = prior+1 or 1), then a single UPDATE retiring prior live rows setting `superseded_by` to the matching new id (join on natural_key), then a single `update … set state='VERIFIED', verified_by=$agent where parse_run_id = <run>`. Revisions: compute per-key `revision = coalesce(prior.revision,0)+1` via a left join to the pre-retire live set.
   - Payload = `ratiosPayload(r)` (unchanged), numeric_value = `r.marketCap`, source_rank = 10, object_type='COMPUTED.RATIOS' — all identical to current.
   - **Preserve the no-`metric_key` invariant** (key-ratios.ts:427-433 comment): the payload must NOT contain `metric_key` so the 0007 `fn_datapoint_fanout` AFTER-UPDATE trigger short-circuits on PENDING→VERIFIED. Unchanged since `ratiosPayload` is reused.
3. `update lake.parse_runs set status='succeeded', finished_at=now() where id=<run>`.

Use `unnest($1::text[], $2::jsonb[], …)` arrays for the bulk insert (postgres.js passes JS arrays as PG arrays). This collapses 660×(≈4 statements) into ≈4 statements total.

**(b) `public.key_ratios` bulk UPSERT — one statement.** Replace the per-row `upsertKeyRatios` with one multi-row insert using `unnest` of parallel typed arrays for every column (security_id, market_cap, pe, … currency_computed, computed_at=now(), source_object_id=the matching new object id), and the SAME `on conflict (security_id) do update set … = excluded.…` block (all 26 columns, verbatim from key-ratios.ts:384-411). One round-trip for the whole batch.

Wrap (a)+(b) in ONE `sql.begin` so the key_ratios rows always reference committed COMPUTED objects (lineage integrity preserved, matching the current per-security transaction that couples writeComputedObject+upsertKeyRatios).

## Build order

1. **Refactor helpers** (key-ratios.ts): export `ttmFlow`, `priorTtmFlow`, `sumRows`, `numFrom` (or extract to `key-ratios-assembly.ts`) so both the old per-security path (kept temporarily for the regression test) and the new batch path use them. No behavior change.
2. **Add `gatherAllInputs(securityIds?)`** returning `Map<number, RatioInputs>` via Q1–Q4 + in-memory grouping. Unit-testable against the existing `createRichDb` fake by teaching it to answer the 4 new batch query shapes (the fake in key-ratios.test.ts already pattern-matches on SQL substrings — add matchers for the `in (select id …)`/`row_number()`/`group by security_id` shapes).
3. **Add batched `persistAll(rows, agentId)`** doing the (a)+(b) bulk writes in one `sql.begin`.
4. **Rewrite `run()`** to: resolveAgent → gatherAllInputs → in-memory compute loop → persistAll. Keep the exact summary shape (`RecomputeSummary`) and the `this.log.info('key_ratios.recompute', {considered, written, skipped})` line (add `elapsedMs` for the urgency-trigger observability).
5. **Keep the old per-security methods** only if needed by the regression test; otherwise delete them and have the regression test drive both a golden fixture and assert against `computeKeyRatios` directly.
6. **No migration required for the happy path** — Option B is pure worker code. OPTIONAL perf migration (see filesToCreateOrEdit): add composite indexes if live `explain` shows seq scans (see Live probes).

## Test plan (zero-network, exact assertions)

Extend `ingestion/src/lake/key-ratios.test.ts` (node --import tsx --test):

1. **Equivalence/regression test (the load-bearing one):** seed the `RichState` fake with a multi-security fixture covering every branch — a bank (sector nulling), a name with 8 quarters (TTM + prior + growth), a name with <4 quarters (annual proxy), a name with 253 ohlcv bars (momentum), a name with only 64 bars (null ret6m/ret121), a name with live dividends (trailingDps), an all-null name (skipped). Run the NEW batch `run()`. For EACH security independently reconstruct `RatioInputs` and call `computeKeyRatios` directly, then assert the persisted `key_ratios`/COMPUTED payload equals `computeKeyRatios(inputs)` field-for-field (deep-equal the payload). This proves math unchanged.
2. **Port the existing 9 tests** (lineage/supersede, all-null skip, second-run supersede revision=2, securityIds slice, 4Q TTM sums, annual proxy, momentum, missing-bar null, bank nulling) to the batch path — they should pass with identical assertions (same `market_cap=50000`, `ps=2000/4000`, `rev_growth_yoy=1`, `ret_3m=300/(300-63)-1`, `nim=0.03`, etc.).
3. **Batch-specific assertions:** (a) two securities in one run each get their OWN COMPUTED.RATIOS live object with correct `security_id`/`natural_key` (`COMPUTED.RATIOS:<venue>:<id>`) and revision; (b) a second full run supersedes ALL prior live objects (bulk retire) and every new one is VERIFIED revision=2; (c) `securityIds` slice restricts both the queries and the writes.
4. **`npm run typecheck`** clean; **`npm test`** green.

## Deploy + live verification

Option B is worker code — deploys with the worker (no pg_cron change; `nightly_omnibus`/`nightly` handler wiring in `worker/src/handlers/nightly.ts` + `register-ingestion-handlers.ts` unchanged, still calls `runtime.recomputeKeyRatios()`).

1. Branch off `main` (worktree is behind origin/main HEAD `487ed99`/`a489fe4` — rebase first so migrations 0039–0041 and the 0040 pattern are present locally).
2. Land the code, `npm test` + `npm run typecheck` green, PR, merge.
3. **Manual live probe before trusting the nightly:** enqueue a bounded slice — `select pgmq.send('q_pipeline', jsonb_build_object('handler','key_ratios_recompute','securityIds', array(select id from public.securities where status='listed' order by id limit 20)))` — then read the worker log for `key_ratios.recompute {considered:20, written:…, elapsedMs:…}` and compare `select security_id, market_cap, pe, ret_3m from public.key_ratios where security_id = any(<those 20>)` to a pre-deploy snapshot of the same 20 rows (must be identical, since math is unchanged and momentum is deterministic from ohlcv).
4. **First full nightly:** after 22:00 UTC, confirm the log `considered≈660`, `elapsedMs` << 40 min (expect low single-digit minutes), and `select count(*), max(computed_at) from public.key_ratios` advanced. Confirm `score_batch` (00:00 UTC) reads fresh ratios (no `StaleKeyRatiosError`).
5. VPS log read: `ssh -o ConnectTimeout=10 -o BatchMode=yes deploy@91.99.99.85 'journalctl -u marsad-worker --since "22:00" | grep key_ratios.recompute'` (single-quote the remote command).

## Idempotency / rollback

- **Idempotent by construction:** the recompute is a full rebuild keyed by `security_id` (upsert) + one-live-per-natural-key supersede — re-running produces the same rows and supersedes its own prior COMPUTED objects, exactly like today.
- **Rollback:** pure worker code — revert the commit and redeploy; the DB shape is unchanged (no migration in the happy path), so no down-migration needed. The prior per-security impl is a drop-in.

## Risks

- **Ordering equivalence** (Q2/Q3 tie-breaks on equal `period_end`/`trade_date`): low real-world risk (no dup period_end per statement_type expected), but add a deterministic secondary sort and note the assumption; the regression test uses distinct period_ends so it won't catch a tie regression — call this out in the PR.
- **`unnest` array typing** with postgres.js (numeric vs text, nulls in numeric arrays): use `::numeric[]`, `::text[]`, `::jsonb[]`, `::uuid[]` casts explicitly; nulls in a numeric array need `$1::numeric[]` with JS `null` elements — verify in the live 20-row probe.
- **Memory:** 660 securities × (≈16 statement rows + ≤260 closes) is a few MB — trivially fits worker RAM.
- **Transaction size:** one big transaction holding the bulk retire+insert+upsert. At 660 rows this is small; if the batch ever grows to thousands, chunk `run()` into slices of ~500 (the handler already supports `securityIds` slicing) — but do NOT chunk prematurely (adds round-trips back).
- **Migrations drift:** this worktree is behind origin/main (last local migration 0038; origin has 0039–0041). Rebase before starting so the 0040 bulk-objectify reference pattern and next-free-number 0042 are correct.

## Docs to update in the same change (per AGENTS.md discipline)

- `docs/BUILD-STATUS.md`: mark the set-based key_ratios recompute done; remove from §7 deferred if parked there.
- `docs/architecture/07-lake-enrichment.md` §3.6 (the "recomputed nightly" note near line 107, "KEY RATIOS — recomputed nightly"): document that the recompute is now set-based (batched I/O, TS math retained), and that a pure-SQL `fn_recompute_key_ratios` was deliberately deferred (record the trigger for Option A).


---

## #6 Dividends (+earnings,ownership) — effort L

**Title:** Scope Item 6 — Dividends Researcher (Mubasher /corporate-action → public.dividends pending_confirm)

**Files to create/edit:** `ingestion/src/adapters/mubasher/corporate-action.ts (NEW — TaskSpec<NormalizedDividend>: fetch + PURE parse + DPS regex + divType classifier)`, `ingestion/src/adapters/mubasher/index.ts (EDIT — export the new adapter from the barrel; add to mubasherTasks if routing via provider)`, `ingestion/src/adapters/tdwl/index.ts (EDIT — mount mubasherCorporateAction on the TDWL VenueAdapter.dividends slot)`, `ingestion/src/adapters/adx/index.ts (EDIT — mount on the ADX VenueAdapter.dividends slot)`, `ingestion/src/adapters/mubasher/__tests__/corporate-action.test.ts (NEW — golden parse tests, zero network)`, `ingestion/fixtures/mubasher/corpaction-tdwl-2222.json (NEW — real captured bytes; .html if HTML path)`, `ingestion/fixtures/mubasher/corpaction-adx-fab.json (NEW — real captured bytes)`, `ingestion/src/config/sources.seed.ts (EDIT — add the 2 dividends source specs, CONTRACT §8)`, `supabase/migrations/20260713000042_dividend_project.sql (NEW — lake.fn_dividend_project + 2 triggers + one-time backfill + seed 2 ingest.sources + 2 ingest.schedules active=false)`, `worker/src/ingest-poller.ts (EDIT — add dividends:'quote_poll' to DATA_TYPE_TO_HANDLER, line 40-51)`, `ingestion/src/runtime.ts (EDIT — ONLY if routing via provider or if per-ticker symbol injection is needed: add withMubasherCorpActionSymbols branch to withInjectedSymbols; otherwise no change)`, `docs/BUILD-STATUS.md (EDIT — mark H/dividends progress, tick 07 §1.1 H, update §7 backlog)`, `docs/architecture/07-lake-enrichment.md (EDIT — update §4 P1.7d dividends bullet to reflect the shipped Mubasher /corporate-action path)`

**Dependencies:** Pull origin/main to sync migrations 0039-0041 into the worktree (next free number is 20260713000042, verified against live supabase_migrations.schema_migrations); Live probe of Mubasher /corporate-action shape (JSON vs Angular HTML) for TDWL 2222 + ADX FAB from the VPS — gates the parser design; public.dividends schema + fn_dividend_confirm_guard + dividends_uni already shipped (20260713000006_fundamentals.sql); crosscheck_sweep fair-rotation (live 0039) drives single-source dividend staging → PENDING lake.objects — confirmed dividend keys are not excluded; key-ratios.ts trailingDps already reads public.dividends where state='live' — no change needed, consumes this ticket's output once Desk confirms; mapDividend staging path + isDividend discriminator + tasksForDataType 'dividends' case already exist in runtime.ts

**Live probes needed:** Mubasher /corporate-action endpoint + response shape for english.mubasher.info, TDWL 2222 and ADX FAB, from the VPS (ssh deploy@91.99.99.85) — determine JSON API vs HTML-table + capture real bytes for fixtures; Confirm how ingest.schedules/enqueue_due_jobs pins a wall-clock 15:00 UTC daily cadence (or accept cadence drift) — inspect an existing daily source (ipo @05:00 UTC) live; Confirm TDWL raw ticker '2222' and ADX raw slug 'FAB' exactly match public.securities.ticker for the (venue_code, ticker) resolveSecurityId lookup (spot-checked: securities show numeric TDWL codes + ADX slugs — verify the specific probe tickers); Post-deploy: confirm worker no longer emits 'no handler for data_type dividends', staging DIVIDEND.DPS rows appear, crosscheck_sweep creates PENDING price_sensitive lake.objects, and public.dividends gets pending_confirm rows with zero state='live'

**Open questions:** Does Mubasher expose a clean JSON /corporate-action API (like the /api/1/stocks/prices board tdwl-quotes uses) or only Angular-rendered HTML requiring per-ticker page scraping? Determines responseKind and whether the symbol-injection seam (withMubasher…Symbols) is needed.; How is the CONTRACT §8 'dividends daily 15:00 UTC' expressed in ingest.schedules (which has cadence_minutes + offset_minutes but no absolute wall-clock column)? Options: cadence 1440 + accept drift, or a dedicated pg_cron like ohlcv_accrual. Confirm before seeding.; Should the ON CONFLICT DO UPDATE carry the `where public.dividends.state <> 'live'` guard so a Desk-confirmed live row survives re-projection, or should live rows be allowed to be superseded lake-side? (Recommend the guard.); Is fiscalRef derivable deterministically from Mubasher's ANNOUNCEMENT DATE/EFFECTIVE FROM/TYPE, or should it be null? It is part of the DIVIDEND.DPS natural_key and dividends_uni conflict target — non-determinism causes duplicate rows.; Should the event-on-DIVIDEND-filing re-poll ship in this PR or be deferred (daily poll alone populates the table)? If deferred, log DEF row in BUILD-STATUS §7.; Route the adapter via a provider='mubasher_corpaction' discriminant (tasksForProvider) or mount directly on ADAPTERS.TDWL/ADX.dividends? Recommend direct mount (route b) — zero runtime.ts change since tasksForDataType already handles the dividends case.


# Build Ticket — Item 6: Dividends Researcher (TDWL + ADX via Mubasher /corporate-action)

## Objective
Populate `public.dividends` (currently **0 rows, verified live**) so that `key_ratios.dividend_yield` + `payout_ratio` (already computed by `ingestion/src/lake/key-ratios.ts::trailingDps`, which reads `public.dividends where state='live'`) and the reader dividend card have data. Ship the full path: a **dividends TaskSpec** (Mubasher `/corporate-action` for TDWL + ADX), **seed sources + schedules**, a **NEW projection `lake.fn_dividend_project`** that writes `state='pending_confirm'` and NEVER auto-`live`, a **backfill** of corporate-action history to 2019, and **fixtures + tests + live-verify**.

The 33b human-confirm gate is enforced by two independent mechanisms and this ticket must respect both:
1. `public.fn_dividend_confirm_guard` (migration `20260713000006_fundamentals.sql` lines 178-192) — a BEFORE UPDATE trigger that raises `dividend go-live requires a HUMAN confirmer (33b)` unless `new.confirmed_by` is an `iam.principals` row with `kind='human'`. Go-live is a **Desk action, explicitly OUT OF SCOPE** — our projection only ever writes `pending_confirm`.
2. `lake.fn_object_state_guard` (migration `20260713000004_lake.sql` lines 106-137) — because every dividend staging row is stamped `priceSensitive: true` (see `runtime.ts::mapDividend` line 498), the lake object can never reach `VERIFIED` without a HUMAN `verified_by`. It stays `PENDING` in `lake.objects` forever until a human intervenes — which is fine, because our projection fires on `PENDING` (see below).

## CRITICAL PRECONDITION — migration numbering
The local worktree has migrations only through `20260713000038_company_people.sql`, but the **live DB ledger (`supabase_migrations.schema_migrations`, probed live) has 0039/0040/0041 applied** (`crosscheck_sweep_fair_rotation`, `ohlcv_bulk_objectify`, `ohlcv_backfill_coverage_flag`) that are NOT in this worktree. **The next free migration number is `20260713000042`.** Do NOT reuse 0039-0041. Pull `origin/main` first to get 0039-0041 into the worktree, or at minimum author the new file as `20260713000042_dividend_project.sql`. Apply via Supabase MCP `apply_migration` AND commit the `.sql` (the migration-workflow trap: MCP-apply without committing causes repo drift — see MEMORY marsad-migration-workflow).

## How the data flows (grounded end-to-end)
```
pg_cron ingest-tick → ingest.enqueue_due_jobs() scans ingest.schedules → INSERT ingest.job_queue row
  → worker ingest-poller.ts claims (FOR UPDATE SKIP LOCKED), joins ingest.sources for data_type='dividends'
  → DATA_TYPE_TO_HANDLER['dividends'] = 'quote_poll'  (MUST ADD — gap, see below)
  → quote_poll → runtime.runTask → withInjectedSymbols (MUST ADD dividends branch) → fetch (Mubasher)
     → snapshot-first → PURE parse → NormalizedDividend[] → mapRowsToStaging → mapDividend
     → lake.staging_rows (objectType 'DIVIDEND.DPS', natural_key 'DIVIDEND.DPS:{venue}:{ticker}:{divType}:{fiscal}', priceSensitive=true)
  → quote_poll enqueueCrossCheckForKeys: countStagingSources < 2 for single-source dividends ⇒ NOT enqueued here
  → minutely pg_cron crosscheck_sweep (ops.enqueue_crosscheck_sweep, live 0039 def) picks up the unconsumed
     single-source staging row (dividend keys are NOT excluded — only OHLCV.CLOSE backfill is) → pgmq cross_check
  → LakeCrossCheck.resolve: single source ⇒ decide()=PENDING(single_source); price_sensitive stays PENDING;
     INSERT lake.objects (object_type='DIVIDEND.DPS', state=PENDING, price_sensitive=true, security_id resolved
     via resolveSecurityId → public.securities (venue_code, ticker))
  → NEW TRIGGER lake.fn_dividend_project fires AFTER INSERT/UPDATE on lake.objects for DIVIDEND.DPS,
     state in ('PENDING','VERIFIED') → UPSERT public.dividends (state='pending_confirm')
  → Desk later flips state='live' with confirmed_by=<human principal> (fn_dividend_confirm_guard enforces) — OUT OF SCOPE
  → nightly key_ratios recompute reads public.dividends where state='live' → dividend_yield/payout_ratio
```

**Consequence to document loudly:** until a human Desk confirms each dividend to `live`, `key_ratios.dividend_yield`/`payout_ratio` remain null (trailingDps filters `state='live'`). This is by design (33b). The projection landing `pending_confirm` rows is this ticket's deliverable; the Desk confirm UI is a separate item.

## Exact adapter / parse shape (Mubasher /corporate-action)
Per `07-lake-enrichment.md §2.2`: **Mubasher `/corporate-action`** columns = `ANNOUNCEMENT DATE | EFFECTIVE FROM | TYPE | DESCRIPTION`, history back to 2019, for TDWL + ADX only (DFM/QE Mubasher pages are empty shells — do NOT seed them). Reachability: `english.mubasher.info` is **200 plain HTTP, no auth, no WAF** from the VPS (§2.1) — use `transport: 'http'` + `ctx.http` (same as `mubasher/tdwl-quotes.ts` and `mubasher/ohlcv-csv.ts`), NOT the BrowserClient.

**LIVE PROBE NEEDED (P0 before coding parse):** §2.1 warns Mubasher deep pages are **Angular client-rendered HTML, not clean JSON** and must be scraped with a **content-poll on the table selector, NOT networkidle** (ad scripts keep the network busy → false empty 4/6 times). BUT `mubasher/tdwl-quotes.ts` discovered a clean JSON board at `english.mubasher.info/api/1/stocks/prices?country=sa`. **Probe whether `/corporate-action` has an analogous JSON API endpoint** (e.g. `english.mubasher.info/api/1/stocks/{market}/{ticker}/corporate-actions` or similar) before committing to HTML-table scraping. Capture the real endpoint + shape live from the VPS (`ssh -o ConnectTimeout=10 -o BatchMode=yes deploy@91.99.99.85`, single-quote the remote command) for 2222 (TDWL) and FAB (ADX). Two outcomes:
- **JSON found** → `responseKind: 'json'`, plain `ctx.http.get`, parse the JSON array. Mirror `tdwl-quotes.ts` exactly (single GET per ticker OR per market). Preferred.
- **Only HTML** → the CSV-adapter 2-step page-scrape pattern (`mubasher/ohlcv-csv.ts`): GET the stock page `english.mubasher.info/markets/{VENUE}/stocks/{ticker}`, then either scrape an embedded data URL or parse the `/corporate-action` HTML table. `responseKind: 'html'`. This is per-ticker (loop the venue's tickers via the symbol-injection seam, exactly like `withMubasherCsvSymbols`).

Design the adapter **config-driven** (URL/selectors/field map in `endpoint_config`, read via a local cast — never hardcode URLs; CONTRACT §0.6). Follow the ohlcv-csv adapter's per-ticker isolation (a 404/parse-fail on one ticker skips it, never aborts the sweep) if per-ticker.

### NormalizedDividend mapping (CONTRACT §6.4, `core/types.ts` lines 371-382)
```ts
interface NormalizedDividend {
  venue: VenueCode; ticker: string;        // TDWL raw numeric code '2222'; ADX raw slug 'FAB' — both match public.securities.ticker (verified live)
  divType: 'FINAL'|'INTERIM'|'SPECIAL';    // classify from Mubasher TYPE/DESCRIPTION text (see classifier below)
  fiscalRef?: string | null;               // e.g. '2025-FY' / '2026-Q1' — derive from EFFECTIVE FROM year + type; nullable
  dps: number; currency: string;           // DPS per share; currency char(3) — SAR (TDWL) / AED (ADX) by venue
  exDate?: string|null;                     // 'YYYY-MM-DD' from EFFECTIVE FROM (ex-date); recordDate/payDate often absent on Mubasher → null
  recordDate?: string|null; payDate?: string|null;
  verification: 'registrar'|'disclosure';  // Mubasher is an aggregator, NOT a registrar → ALWAYS 'disclosure'
}
```
- **Parse purity (CONTRACT §2):** `parse()` must be PURE — no `Date.now()`, no `new Date()` for "now", no I/O. venue+ticker come from `snapshot.meta` (stamped by fetch, round-tripped through the snapshot store — see ohlcv-csv.ts meta pattern) when per-ticker; the row TYPE/DESCRIPTION/dates come from the bytes. Malformed/empty → zero rows (PARSE_DRIFT signal, CONTRACT §10), NEVER throw for the per-ticker path (ohlcv-csv style); the market-JSON path may throw on non-JSON like tdwl-quotes.ts.
- **DPS extraction:** Mubasher DESCRIPTION is free text (e.g. "Cash dividend of SAR 1.40 per share"). Write a deterministic regex extractor for the per-share amount + a `divType` classifier: `interim` → INTERIM, `special`/`one-time`/`bonus-cash` → SPECIAL, else FINAL. A row with no extractable DPS (bonus-share, split, capital action) → skip (not a cash dividend; the M-family corporate-actions like splits are DEF, see §1.2 M — out of scope here).
- **currency:** derive by venue (TDWL→'SAR', ADX→'AED'); do not trust Mubasher currency text. `public.dividends.currency` is `char(3) NOT NULL`.
- **Do NOT set `yield_at_announce` / `payout_ratio`** in the parser — those are DERIVED columns (07 §1.1 H, R/D=D); the projection leaves them null and the nightly ratio job / a future derive step fills them.

## Migration DDL sketch — `supabase/migrations/20260713000042_dividend_project.sql`
Mirror `20260713000037_filing_project.sql` (FILING.REF→public.filings) and `20260713000028_ohlcv_daily.sql` (OHLCV.CLOSE→public.ohlcv_daily) exactly — same PENDING+VERIFIED gate, same INSERT+UPDATE trigger pair, same one-time backfill of pre-existing objects, `security definer set search_path=''`.

```sql
-- 0042_dividend_project — project DIVIDEND.DPS lake.objects → public.dividends (state='pending_confirm').
-- Mirrors fn_filing_project (0037) and fn_ohlcv_daily_project (0028). Fires on PENDING and VERIFIED:
-- dividends are price_sensitive so cross-check NEVER auto-VERIFIES them (they stay PENDING in the lake,
-- enforced by lake.fn_object_state_guard 33b HUMAN-verifier rule) — a VERIFIED-only trigger would miss
-- every dividend. The projection ALWAYS writes state='pending_confirm' and NEVER 'live': go-live is a
-- Desk action gated by public.fn_dividend_confirm_guard (requires a HUMAN confirmed_by). OUT OF SCOPE here.
set search_path = '';

create or replace function lake.fn_dividend_project() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_venue    text := coalesce(new.venue_code, new.payload ->> 'venue');
  v_ticker   text := new.payload ->> 'ticker';
  v_divtype  text := new.payload ->> 'divType';
  v_fiscal   text := nullif(new.payload ->> 'fiscalRef','');
  v_dps      numeric := coalesce(new.numeric_value, nullif(new.payload ->> 'dps','')::numeric);
  v_ccy      text := new.payload ->> 'currency';
  v_ex       date := nullif(new.payload ->> 'exDate','')::date;
  v_rec      date := nullif(new.payload ->> 'recordDate','')::date;
  v_pay      date := nullif(new.payload ->> 'payDate','')::date;
  v_verif    text := coalesce(nullif(new.payload ->> 'verification',''),'disclosure');
begin
  if new.object_type <> 'DIVIDEND.DPS' then return null; end if;
  if new.state not in ('PENDING','VERIFIED') then return null; end if;
  if new.security_id is null then return null; end if;         -- securities not yet resolved: re-projects on later revision
  -- public.dividends NOT-NULL: div_type, dps, currency, source_object_id. Skip a malformed object, don't fail the tx.
  if v_divtype is null or v_divtype not in ('FINAL','INTERIM','SPECIAL') then return null; end if;
  if v_dps is null then return null; end if;
  if v_ccy is null or length(v_ccy) <> 3 then return null; end if;

  insert into public.dividends (
    security_id, div_type, fiscal_ref, dps, currency,
    ex_date, record_date, pay_date, verification, state, source_object_id
  ) values (
    new.security_id, v_divtype, v_fiscal, v_dps, v_ccy,
    v_ex, v_rec, v_pay, v_verif, 'pending_confirm', new.id
  )
  on conflict (security_id, div_type, coalesce(fiscal_ref,''), coalesce(ex_date, date '9999-12-31'))
  do update set
    dps              = excluded.dps,
    currency         = excluded.currency,
    record_date      = coalesce(excluded.record_date, public.dividends.record_date),
    pay_date         = coalesce(excluded.pay_date, public.dividends.pay_date),
    verification     = excluded.verification,
    source_object_id = excluded.source_object_id
    -- NEVER touch state or confirmed_by/confirmed_at: a Desk 'live' confirm must survive re-projection.
    where public.dividends.state <> 'live';   -- guard: once a human confirms live, projection stops overwriting
  return null;
end $$;

drop trigger if exists objects_dividend_project_ins on lake.objects;
create trigger objects_dividend_project_ins after insert on lake.objects
  for each row when (new.object_type = 'DIVIDEND.DPS')
  execute function lake.fn_dividend_project();

drop trigger if exists objects_dividend_project_upd on lake.objects;
create trigger objects_dividend_project_upd after update on lake.objects
  for each row when (new.object_type = 'DIVIDEND.DPS')
  execute function lake.fn_dividend_project();

-- One-time backfill of DIVIDEND.DPS objects that already exist (idempotent via the same conflict target).
insert into public.dividends (security_id, div_type, fiscal_ref, dps, currency, ex_date, record_date, pay_date, verification, state, source_object_id)
select o.security_id, o.payload->>'divType', nullif(o.payload->>'fiscalRef',''),
       coalesce(o.numeric_value, nullif(o.payload->>'dps','')::numeric), o.payload->>'currency',
       nullif(o.payload->>'exDate','')::date, nullif(o.payload->>'recordDate','')::date, nullif(o.payload->>'payDate','')::date,
       coalesce(nullif(o.payload->>'verification',''),'disclosure'), 'pending_confirm', o.id
from lake.objects o
where o.object_type = 'DIVIDEND.DPS' and o.state in ('PENDING','VERIFIED') and o.superseded_by is null
  and o.security_id is not null and o.payload->>'divType' in ('FINAL','INTERIM','SPECIAL')
  and coalesce(o.numeric_value, nullif(o.payload->>'dps','')::numeric) is not null
  and length(o.payload->>'currency') = 3
on conflict (security_id, div_type, coalesce(fiscal_ref,''), coalesce(ex_date, date '9999-12-31')) do nothing;
```
**Verify the conflict target exactly matches `dividends_uni`** (0006 line 171-172): `(security_id, div_type, coalesce(fiscal_ref,''), coalesce(ex_date, date '9999-12-31'))`. It does. Note `source_object_id` is `NOT NULL` on `public.dividends` — always supply `new.id`.
**Open question to confirm at build:** the `where public.dividends.state <> 'live'` clause on the `do update` — Postgres allows a `WHERE` on `ON CONFLICT DO UPDATE`; a matching-live row simply skips the update (no error). Confirm this is the desired semantics (a re-projection of a fact a human already promoted to live must not revert it). Alternatively drop the state guard if Desk-confirmed rows are expected to be superseded lake-side.

## Seed sources + schedules
Add to `ingestion/src/config/sources.seed.ts` (the seed spec, CONTRACT §8) AND author the seed as part of the migration (only `supabase/migrations/` may write `ingest.sources`/`ingest.schedules`). Two source rows + two schedule rows:

| venue | data_type | transport | entry_url (probe-confirmed) | endpoint_config | cadence_min | session_only | offset |
|---|---|---|---|---|---|---|---|
| TDWL | dividends | http | (probe) `english.mubasher.info/...corporate-action...` | `{ responseKind, urlTemplate/pageUrlTemplate, provider?:'mubasher_corpaction', field map, headers }` | 1440 (daily) | false | 0 |
| ADX | dividends | http | (probe) ADX Mubasher corporate-action | same shape | 1440 (daily) | false | 2 |

- **Cadence law (CONTRACT §8):** dividends **daily 15:00 UTC**. `ingest.schedules` uses `cadence_minutes` + `offset_minutes` (there is no absolute-time column; 15:00 UTC is achieved by the daily cadence + the tick alignment — confirm how existing daily jobs like `ipo` express 05:00 UTC; if schedules can't pin wall-clock, document that "daily" fires on the first tick after `last_enqueued_at + 1440min` and accept drift, OR add a dedicated cron like `ohlcv_accrual` used). **Open question:** confirm the 15:00-UTC pin mechanism against the live `ingest.schedules`/`enqueue_due_jobs` semantics before seeding.
- `session_only = false` (dividends are not session-gated).
- `active`: seed **`active=false`** initially (mirrors how ADX/MSX OHLCV backfill were seeded inactive in 0033/0034 then activated in 0035), then flip `active=true` in the same or a follow-up migration once the live probe confirms the parser works. Owner sign-off pattern.
- **Symbol injection:** if the adapter is per-ticker (HTML path), add a `withMubasherCorpActionSymbols` branch to `runtime.ts::withInjectedSymbols` (line 290) mirroring `withMubasherCsvSymbols` (raw listed tickers, no suffix) so `endpoint_config.symbols` is populated from `public.securities` at runtime. If the adapter is market-level JSON (one GET per venue), no symbol injection needed.

### Event trigger (dividends daily + event on a DIVIDEND filing)
CONTEXT asks for "dividends daily 15:00 UTC + event on a DIVIDEND filing". The daily poll is the schedule above. The **event-on-DIVIDEND-filing** path: when `filings_poll`/`fn_classify_filing_type` classifies a new filing as `filing_type='DIVIDEND'` (0037 classifier, line 28), enqueue a dividends refresh. **Scope note:** parsing the DIVIDEND filing's own `extracted_facts` for DPS needs the deferred full-text/PDF pipeline (07 §4 P1.7d, DEF; the CONTEXT explicitly says the primary path is Mubasher /corporate-action *because* filing-facts extraction is deferred). So for v1 the "event" is a **trigger to re-poll Mubasher /corporate-action for that ticker**, not a filing-facts parse. Wire this as a lightweight follow-up: on a new DIVIDEND-classified `FILING.REF` object (or in the filings_poll handler), `pgmq.send` / job_queue a dividends poll scoped to that venue. **Flag as optional for the first PR** — the daily poll alone populates the table; the event path is a latency optimization. If deferred, log it in `BUILD-STATUS.md §7` with trigger "when DIVIDEND-filing latency matters" and home "07 §4 P1.7d".

## Worker wiring (the routing gap — REQUIRED)
`worker/src/ingest-poller.ts` line 40-51 `DATA_TYPE_TO_HANDLER` has **no `dividends` entry** — a `dividends` job today is marked `failed` with `no handler for data_type 'dividends'` (line 141-143). Add:
```ts
dividends: "quote_poll",   // dividends ride quote_poll (source-scoped {sourceId}, provider-agnostic — mirrors ohlcv_backfill line 48)
```
`quote_poll` (`worker/src/handlers/quote-poll.ts`) is already generic: it loads the source, calls `runtime.tasksForSource` (→ `resolveTasksForSource` → `tasksForDataType` which ALREADY has a `case 'dividends'` returning `adapter.dividends`, runtime.ts line 338-340), runs `runTask` (stages via `mapDividend`), and enqueues cross_check only for ≥2-source keys — single-source dividends fall through to the minutely `crosscheck_sweep` (correct). **No new worker handler needed.** No change to `register-ingestion-handlers.ts`.

## Adapter mounting
- Create `ingestion/src/adapters/mubasher/corporate-action.ts` exporting a `TaskSpec<NormalizedDividend>` (`dataType: 'dividends'`, `parserVersion: 1`, `fetch`, PURE `parse`).
- Mount it on the TDWL and ADX `VenueAdapter.dividends` slot. **Decision needed:** Mubasher is a cross-venue aggregator with no VenueAdapter (like ohlcv-csv). Two options mirroring the existing codebase:
  - (a) Route via a provider discriminant `provider='mubasher_corpaction'` on `endpoint_config` and add a branch in `runtime.ts::tasksForProvider` (line 160) — cleanest, matches `mubasher_csv`. Preferred if the adapter is aggregator-shaped.
  - (b) Mount `mubasherCorporateAction` directly on `ADAPTERS.TDWL.dividends` and `ADAPTERS.ADX.dividends` (adapters/tdwl/index.ts, adapters/adx/index.ts) — matches how `tdwl-quotes` is re-exported onto the TDWL quotes slot. Since `tasksForDataType` already handles the `dividends` case off the ADAPTERS map, (b) needs NO runtime change. **Recommend (b)** for least churn (the venue travels on the row regardless).
- Export from `adapters/mubasher/index.ts` (add to the barrel + `mubasherTasks` if going route (a)).

## Build order
1. Pull origin/main (get 0039-0041 locally). Confirm next migration = 0042.
2. **LIVE PROBE** Mubasher /corporate-action for 2222 + FAB from the VPS — capture real endpoint + response bytes → save as fixtures. Decide JSON vs HTML path.
3. Write `ingestion/src/adapters/mubasher/corporate-action.ts` (fetch + PURE parse + DPS regex + divType classifier + fiscalRef derivation).
4. Mount on TDWL+ADX dividends slots (route b); export from barrel.
5. Golden tests (below) — get them green offline first.
6. Migration `0042_dividend_project.sql`: projection fn + 2 triggers + one-time backfill + seed 2 sources + 2 schedules (active=false). Apply via MCP; commit the .sql.
7. Worker: add `dividends: "quote_poll"` to `DATA_TYPE_TO_HANDLER`. (Optional) event-on-DIVIDEND-filing enqueue.
8. Flip sources `active=true` (migration or MCP + committed .sql).
9. Live-verify (below).
10. Docs: `BUILD-STATUS.md` (mark H/dividends progress, tick 07 §1.1 H, remove any parked dividend row from §7), `07-lake-enrichment.md §4 P1.7d` dividends bullet.

## Test plan (ingestion `npm test` = node --import tsx --test; zero network)
- Fixtures: `ingestion/fixtures/mubasher/corpaction-tdwl-2222.{json|html}` + `corpaction-adx-fab.{json|html}` — REAL captured bytes from the VPS probe.
- `ingestion/src/adapters/mubasher/__tests__/corporate-action.test.ts` (golden, PURE parse against fixtures):
  - Parses a known cash dividend → exact assertions: `venue`, `ticker`, `divType`, `dps` (exact numeric), `currency` (SAR/AED), `exDate` (YYYY-MM-DD), `verification='disclosure'`, `parserVersion=1`.
  - divType classifier: interim→INTERIM, special/bonus-cash→SPECIAL, else→FINAL (table-driven).
  - DPS regex: extracts amount from representative DESCRIPTION strings; a bonus-share/split row → skipped (0 dividend rows for it).
  - Empty/garbage snapshot → `{ rows: [], parserVersion: 1 }`, no throw (per-ticker path).
  - Purity: parse called twice on the same snapshot yields byte-identical rows (no Date.now).
  - meta round-trip: venue+ticker recovered from `snapshot.meta` (per-ticker path), not from bytes.
- `ingestion/src/__tests__/runtime` (or staging-map.test.ts): a `NormalizedDividend` through `mapRowsToStaging` → `mapDividend` yields `objectType='DIVIDEND.DPS'`, `naturalKey='DIVIDEND.DPS:{venue}:{ticker}:{divType}:{fiscal}'`, `priceSensitive=true`, `numericValue=dps`, `unit=currency`, `sourceRank=20` (disclosure→exchange rank; registrar would be 10 but Mubasher is always disclosure), `effectiveDate=exDate`. (`isDividend` discriminator, runtime.ts line 591, requires `ticker`+`dps`+`divType` — assert the shape triggers it.)
- Typecheck: `npm run typecheck` clean.
- (Optional) a SQL-level projection test if a pg test harness exists: INSERT a DIVIDEND.DPS lake.object PENDING with a resolved security_id → assert one `public.dividends` row `state='pending_confirm'`; UPDATE it to VERIFIED-impossible so also assert PENDING-only path; assert re-INSERT is idempotent (upsert); assert a manually `state='live'` row is NOT reverted by re-projection.

## Deploy + live-verification (Supabase MCP project yjsncnpbjuueaoeejrqj; VPS read-only)
1. `apply_migration` 0042; confirm `select version from supabase_migrations.schema_migrations where version='20260713000042'`.
2. Confirm triggers exist: `select tgname from pg_trigger where tgrelid='lake.objects'::regclass and tgname like 'objects_dividend%'` → 2 rows.
3. Confirm sources seeded: `select id,venue,data_type,active from ingest.sources where data_type='dividends'` → TDWL+ADX. Confirm schedules.
4. Flip active=true. Manually enqueue one job to force a run (or wait for the daily tick): `insert into ingest.job_queue (source_id, status, run_after) select id,'queued',now() from ingest.sources where data_type='dividends' and venue='TDWL'`.
5. Watch the worker pick it up (VPS: `ssh -o ConnectTimeout=10 -o BatchMode=yes deploy@91.99.99.85 'journalctl -u marsad-worker --since "-10 min" | grep -i dividend'`). Confirm no `no handler for data_type 'dividends'`.
6. Confirm staging: `select count(*), object_type from lake.staging_rows where object_type='DIVIDEND.DPS' group by object_type`.
7. Wait ≤2 min for `crosscheck_sweep`; confirm lake objects: `select state, price_sensitive, count(*) from lake.objects where object_type='DIVIDEND.DPS' group by 1,2` → expect PENDING, price_sensitive=true.
8. **Confirm the deliverable:** `select state, count(*), min(ex_date), max(ex_date) from public.dividends group by state` → expect `pending_confirm` rows, **zero `live`** (33b respected). Spot-check DPS/currency against the Mubasher page for 2222.
9. Confirm no accidental go-live: `select count(*) from public.dividends where state='live'` → 0. Confirm `fn_dividend_confirm_guard` still blocks agent go-live (attempt an UPDATE state='live' with a non-human confirmed_by in a throwaway tx → expect the 33b exception, then ROLLBACK).
10. Trailing-DPS check (will be null until Desk confirms — document): `select count(*) from public.key_ratios where dividend_yield is not null` — expect unchanged (0/low) because trailingDps needs state='live'. This proves the human gate is load-bearing, as designed.

## Idempotency / rollback
- Fetch idempotent: snapshot dedup on normalized hash; staging upsert on `(source_id, external_id, content_hash)`.
- Projection idempotent: upsert on `dividends_uni`; one-time backfill `on conflict do nothing`.
- Rollback: `drop trigger objects_dividend_project_ins/upd on lake.objects; drop function lake.fn_dividend_project();` + `delete from ingest.schedules/sources where data_type='dividends'` + revert `DATA_TYPE_TO_HANDLER`. `public.dividends` rows written as pending_confirm can be deleted safely (nothing downstream consumes pending_confirm — trailingDps filters state='live').

## Risks
- **Mubasher /corporate-action shape unknown until probed** — the single biggest unknown; the whole parser depends on JSON-vs-HTML. Do the probe first.
- **DPS free-text extraction fragility** — DESCRIPTION is prose; the regex will miss edge cases. Skip-on-no-match keeps it safe (no bad rows), and the daily re-poll re-attempts. Log skips for Desk visibility.
- **fiscalRef determinism** — natural_key includes fiscalRef; if the parser derives it inconsistently, the same dividend could double-insert under two keys. Make fiscalRef derivation deterministic and documented, or set it null (the `coalesce(fiscal_ref,'')` conflict target handles null consistently).
- **15:00-UTC schedule pin** — confirm `ingest.schedules` can express wall-clock or accept cadence drift.

---
## Follow-on sub-tickets (outline)

### (6b) EARNINGS actuals → earnings_events + DEF-SCORE-EVENTS-TRIGGER
Parse RESULTS-classified filings' `extracted_facts` (needs the deferred PDF/full-text pipeline, 07 §4 P1.7d — this is the real blocker) into `public.earnings_events` (0006, lines 76-104: `eps_actual`, `revenue_actual`, `verdict BEAT/IN_LINE/MISS/HELD`, `surprise_pct`, `rvc_table`, unique on `(security_id, fiscal_period)`). Add an `earnings_events` projection mirroring fn_dividend_project (source object e.g. `FILING.RESULTS`/`EARNINGS.ACTUAL`). Then wire the **event-driven single-name score recompute** (07 §3.5 "Event-driven recompute" + §4 P1.7c): on `earnings_events.verdict` being set (AFTER UPDATE trigger on `public.earnings_events`), `pgmq.send('q_maintenance', {handler:'score_batch', securityIds:[<id>]})` — the score engine already accepts a `securityIds` slice (`KeyRatiosPayload.securityIds`, `runScoreBatch(securityIds)` in runtime.ts line 756, `ScoresRecompute.run(securityIds)`), so no engine change is needed, only the trigger + a `score_batch` handler that reads `securityIds`. This is **DEF-SCORE-EVENTS-TRIGGER**. Delivers "BEAT +4.2% → Revisions B→B+ overnight" without a nightly-scale job. Effort: M (mostly the filing-facts extraction, which is the shared deferred PDF pipeline).

### (6c) OWNERSHIP → ownership_snapshots / holders / holder_positions (quarterly)
Scrape Mubasher `/major-shareholders` (07 §2.2: `OWNER | CURRENT % | PREVIOUS % | CHANGE | LAST UPDATE`, with history, TDWL+ADX only) into `public.holders` (0006 line 294: name, holder_type, country), `public.holder_positions` (line 305: holder_id, security_id, as_of, stake_pct, qoq_change_pp, unique `(holder_id, security_id, as_of)`), and `public.ownership_snapshots` (line 318: security_id, as_of, categories jsonb, foreign_ownership_pct, is_fol_record, PK `(security_id, as_of)`). New `NormalizedOwnership`-style shapes + staging objectType (e.g. `OWNERSHIP.HOLDER` / `OWNERSHIP.SNAPSHOT`) + a projection trigger family. **Quarterly cadence → very low scrape volume** (07 §1.1 J). Holder identity resolution (matching a Mubasher owner-name string to a `holders` row, creating one on first sight) is the fiddly part. Not price-sensitive → can VERIFY normally once a 2nd source (venue >5% filings) lands. Effort: M. Mount as a new `dividends`-style aggregator TaskSpec on TDWL+ADX.
