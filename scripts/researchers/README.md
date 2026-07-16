# Financial-statement researchers

Researchers that fetch **financial-statement PDFs** and LLM-extract them to `financial_statements`, split
by whether the venue is WAF-walled (only Tadawul still needs the heavy browser+proxy):

- **Tadawul** (`tadawul-*.mjs`) — Akamai blocks `saudiexchange.sa` from our IPs, so these run a real headed
  Chromium through the Geonode **residential proxy**. They are the platform's **only heavy proxy
  consumers** — see `docs/architecture/08-worker-fleet.md` for the fleet map + guardrails, and `§5/§6` there
  for the 9 GB incident + the event-driven redesign spec.
- **DFM** (`dfm-backfill.mjs`) — Dubai is **not** WAF-walled: the eFsah `financial_reports` list is plain
  JSON and its statement PDFs download direct from `feeds.dfm.ae/documents`. So this one runs **direct HTTP,
  NO browser and NO proxy** (not even a cookie-seat) — see the [DFM section](#dfm-backfill-class-a-no-browser) below.
- **BHB** (`bhb-financials.mjs`) — Bahrain Bourse is **not** WAF-walled: its CompanyProfile "Statements"
  tab is a plain JSON webapi and its statement PDFs download direct. So this one runs **direct HTTP, NO
  browser and NO proxy** — see the [BHB section](#bhb-financials-direct-http--no-browser-no-proxy) below.
- **ADX** (`adx-gapfill.mjs`) — Abu Dhabi is Akamai-fronted but (unlike Tadawul) a **headless** Chromium
  loads it fine from the datacenter IP. So it seats the WAF cookies with **one** headless nav then
  `ctx.request.get`s the apigateway JSON feed + PDFs directly — **NO proxy, NO xvfb**. ADX has no XBRL, so
  the LLM/PDF path is the **primary** source. See the [ADX section](#adx-financials-headless-cookie-seat--no-proxy) below.

| Script | Purpose | Persist | source_rank |
|---|---|---|---|
| `tadawul-researcher.mjs` | TDWL free XBRL path: scrape `XBRL_DOCS/*.html`, parse deterministically → `financial_statements`; archive the source HTML + statement PDFs to the `filings` bucket | XBRL objects | 10 (wins) |
| `tadawul-gapfill.mjs` | TDWL LLM path (`claude -p`, $0 via subscription): for periods XBRL doesn't cover, download `fsPdf/*.pdf`, LLM-extract → `financial_statements` | fsPdf-LLM objects | 20 (gap-fill only; a downgrade guard never overwrites XBRL) |
| `dfm-backfill.mjs` | **DFM** LLM path, **Class-A (no browser/proxy)**: per name, GET the eFsah `financial_reports` list → download the statement PDF from `feeds.dfm.ae/documents` → `claude -p` extract → `financial_statements`; catalogue the PDF in the `filings` bucket. DFM is PDF-only (no issuer XBRL), so this is its sole statements producer. | fsPdf-LLM objects | 20 |
| `scrape-guardrails.mjs` | **Shared bandwidth guardrails** the TDWL scrapers import: resource interception (abort image/font/media + trackers) + byte accounting + a hard per-run byte budget. (DFM doesn't use a browser, so it doesn't need these.) | — | — |

## Guardrails (why the proxy bill is bounded)

1. **Cadence** — `systemd` timers `marsad-{researcher,gapfill}.timer`, `OnUnitActiveSec=6h` (a throttle
   drop-in over the original 15/20 min). Financial statements are quarterly — 6 h is already generous;
   the event-driven redesign (`08 §6`) will make steady state ~free.
2. **Resource interception** — `scrape-guardrails.makeGuards().install(ctx)` blocks images/fonts/media +
   analytics/ad hosts on every context. Keeps document/script/stylesheet/xhr so the SPA renders and the
   Akamai sensor JS still clears (validated live: Aramco scrape found 17 XBRL / 21 PDF, 137 reqs blocked,
   no extra challenge). Each run logs `proxy <N>MB (blocked <k> reqs)` at DONE.
3. **Hard byte budget** — `MAX_RUN_BYTES` (MB, default 800) self-stops a run before a misconfiguration can
   burn GBs. Safety net; cadence is the real control.
4. **Incremental / skip-owned** — both skip already-`owned` storage keys / already-covered periods, so a
   steady-state pass ships ~0 rows (but still pays page-load bandwidth — the §6 redesign fixes that).
5. **Run budget** — `RUN_BUDGET_MS` + chunk cursor bound each run; a shared `flock` keeps the two from
   running concurrently.

## Config (env — all overridable, config-over-code)

`CHUNK_START/CHUNK_SIZE` (universe slice), `CONCURRENCY` (parallel sticky-IP browsers), `RUN_BUDGET_MS`,
`PDF_ARCHIVE_MAX` (researcher) / `FSPDF_MAX` (gapfill), `MAX_RUN_BYTES`, `ACQUIRE_SYMBOLS` (explicit list),
`CLAUDE_MODEL` (gapfill). Proxy + Supabase creds from `/etc/marsad/worker.env`.

## Deploy note (repo ↔ VPS)

These run on the VPS from `/home/deploy/` (the `systemd` units → `*-cron.sh` → `node *.mjs`), **not** via the
worker's CI deploy. This repo copy under `scripts/researchers/` is the canonical, reviewable version — keep
the two in sync. To deploy an edit: `scp scripts/researchers/*.mjs deploy@<vps>:/home/deploy/`. The systemd
units + cron wrappers are mirrored under `systemd/` for reference. **Follow-up (DEF-RESEARCHER-GUARDRAILS):**
point the units at `/opt/marsad/scripts/researchers/` so they track the git checkout and this manual sync goes
away.

## DFM backfill (Class-A, no browser)

`dfm-backfill.mjs` + `dfm-backfill-cron.sh` need **no** proxy/Xvfb/Chromium — just `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` (from `worker.env`) + the `claude` CLI + `pdftotext`. The
wrapper **`unset ANTHROPIC_API_KEY`** so `claude -p` uses the $0 subscription seat (same as gapfill). Env:
`CHUNK_START/CHUNK_SIZE` (universe slice) or `ACQUIRE_SYMBOLS`, `FSPDF_MAX` (LLM extractions/run),
`EFSAH_TAKE` (list depth, default 50 ≈ 5y), `CLAUDE_MODEL`, `DFM_WINDOW_GATE=1` (steady-state filing-window
gate; off = backfill mode). Coverage-gated + resumable (skips periods already in `financial_statements`).
A ticker absent from `public.securities` is skipped + logged — see DEF-DFM-SECURITIES-RECONCILE (55→68).

## BHB financials (direct HTTP — no browser, no proxy)

`bhb-financials.mjs` is the cheap-HTTP analogue of `tadawul-gapfill.mjs`. BHB has no XBRL, so the LLM/PDF
path is the **primary** statements source (not a gap-filler). Per company it:

1. GETs `webapi.bahrainbourse.com/api/data/GetCompanyFinancialStatements` with the dynamic public APIKey
   Bearer (scraped from the homepage, cached, re-scraped once on 401 — same auth as BHB quotes/filings);
2. parses the index with `ingestion/dist/adapters/bhb/financials.js` (`parseCompanyFinancialStatements` —
   the pure, tested parser in `ingestion/src/adapters/bhb/financials.ts`);
3. skips any PDF already owned (`public.filings` `source_ref = BHB-FS-<fileId>`) — incremental;
4. downloads each new PDF **direct** (verify `%PDF`), `pdftotext -layout` → `claude -p` →
   `extractToStatements(parsed, 'BHB', …)` → archive to the `filings` bucket + `lake.objects`
   (`FILING.FINANCIALS`, `source_rank 20`) + catalogue `public.filings`. The `lake.fn_financials_project`
   trigger lands the `public.financial_statements` rows.

| Script | Purpose | Persist | source_rank |
|---|---|---|---|
| `bhb-financials.mjs` | direct-HTTP statements index → PDF → LLM-extract → `financial_statements` | FILING.FINANCIALS objects + archived PDFs | 20 (primary; no XBRL competitor) |

**Guardrails (why this is cheap):** direct VPS egress (no metered proxy bytes), `FSPDF_MAX` new PDFs/run
(subscription rate-limit budget), `RUN_BUDGET_MS` self-stop before the cron SIGTERM, incremental
skip-owned **before** any download, chunk cursor + its **own** `flock` (`.bhb-financials.lock` — never
contends with the Tadawul chrome flock), and `unset ANTHROPIC_API_KEY` in the wrapper so `claude -p` uses
the $0 subscription seat. Cadence: `marsad-bhb-financials.timer` `OnUnitActiveSec=6h`.

**Config (env):** `CHUNK_START/CHUNK_SIZE` (BHB universe slice), `ACQUIRE_SYMBOLS` (explicit CSV, e.g.
`ALBH,KHALEEJI`), `FSPDF_MAX`, `RUN_BUDGET_MS`, `CLAUDE_MODEL`. Supabase creds from
`/etc/marsad/worker.env`. **No proxy env.**

**Prereqs on the VPS:** the compiled `ingestion/dist/adapters/bhb/financials.js` +
`ingestion/dist/lake/statement-extraction.js` must exist (build the ingestion package), plus `pdftotext`
(poppler) and the `claude` CLI logged into the subscription seat.

**Deploy:** `scp scripts/researchers/bhb-financials.mjs bhb-financials-cron.sh deploy@<vps>:/home/deploy/`
and install `systemd/marsad-bhb-financials.{service,timer}`. Backfill first-pass: run over the whole
41-symbol BHB universe (`ACQUIRE_SYMBOLS` in chunks, or let the chunk cursor walk it) with a higher
`FSPDF_MAX`; steady state (6 h cadence) then ships ~0 new PDFs and only re-visits for newly-published
statements.

## ADX financials (headless cookie-seat — no proxy)

`adx-gapfill.mjs` is the cheap-browser analogue of the BHB script: it needs a headless Chromium to seat the
Akamai/bpm WAF cookies, but **no proxy and no xvfb**, and it never renders a per-company SPA page. ADX has
no XBRL, so this LLM/PDF path is the **primary** statements source. Full endpoint recipe:
`docs/architecture/adx-browser-bypass.md`. Per run it:

1. Navigates `www.adx.ae` **once** to seat the WAF cookies on the browser context (`www.adx.ae/api/bpm/get-cookie`);
2. per company GETs the `efid` financial-disclosure feed
   `apigateway.adx.ae/adx/tradings/1.1/news?categoryName=efid&categoryValue=<SYM>&recordCount=<N>` through
   the cookie-seated context with the `adx-gateway-apikey` + `channel-id: OSS WEB` headers — full history,
   uncapped, in ONE request (`response.news[]`);
3. keeps rows whose `subCategoryNameEn` sub-type ∈ `ADX_FIN_TYPES` (default `Financial Report`) and skips any
   PDF already owned (`public.filings` `source_ref = <exPara>`) — incremental;
4. downloads each new PDF (`urlEn` → `.../adx/cdn/1.0/content/download/<id>`) **through the context** (verify
   `%PDF`), `pdftotext -layout` → `claude -p` → `extractToStatements(parsed, 'ADX', …)` → archive to the
   `filings` bucket + `lake.objects` (`FILING.FINANCIALS`, `source_rank 20`) + catalogue `public.filings`.
   The `lake.fn_financial_statement_project` trigger lands the `public.financial_statements` rows.

| Script | Purpose | Persist | source_rank |
|---|---|---|---|
| `adx-gapfill.mjs` | headless cookie-seat → efid feed → PDF → LLM-extract → `financial_statements` | FILING.FINANCIALS objects + archived PDFs | 20 (primary; no XBRL competitor) |

**Guardrails (why this is cheap):** direct VPS egress (no metered proxy bytes, only ~1-3 MB/PDF), headless
(no xvfb), `ADX_PDF_MAX` new PDFs/run (subscription rate-limit budget), incremental skip-owned **before** any
download, chunk cursor + its **own** `flock` (`.adx-scrape.lock` — never contends with the Tadawul/BHB
flocks), reporting-window gate (UAE calendar, `WINDOW_DAYS=60`/`ANNUAL_WINDOW_DAYS=120`), and `unset
ANTHROPIC_API_KEY` in the wrapper so `claude -p` uses the $0 subscription seat. Cadence:
`marsad-adx-gapfill.timer` `OnUnitActiveSec=6h`.

**Config (env):** `CHUNK_START/CHUNK_SIZE` (ADX universe slice), `ACQUIRE_SYMBOLS` (explicit CSV, e.g.
`ALDAR,IHC`), `ADX_PDF_MAX`, `ADX_FIN_TYPES` (widen to add e.g. `Integrated Report`), `ADX_GATEWAY_APIKEY`
(re-capture if it rotates), `ADX_RECORD_COUNT`, `CLAUDE_MODEL`, `ADX_USE_PROXY=1` (fallback if the VPS IP is
ever challenged). Supabase creds from `/etc/marsad/worker.env`. `LIST_SYMBOLS=1` prints the listed ADX
tickers and exits (used by the one-shot).

**Prereqs on the VPS:** the compiled `ingestion/dist/lake/statement-extraction.js` must exist, plus Playwright
+ Chromium (`/opt/marsad/.playwright`), `pdftotext` (poppler), and the `claude` CLI logged into the
subscription seat.

**Deploy:** `scp scripts/researchers/adx-gapfill.mjs adx-gapfill-cron.sh adx-oneshot.sh deploy@<vps>:/home/deploy/`
and install `systemd/marsad-adx-gapfill.{service,timer}`. Backfill first-pass: `adx-oneshot.sh` (DB-enumerated
universe, full history depth) via `systemd-run`; steady state (6 h cadence) then re-visits only for
newly-published statements.

## Run manually (test)

Tadawul (browser + proxy):

```sh
cd /home/deploy && set -a; source /etc/marsad/worker.env; set +a
# TDWL (browser):
PLAYWRIGHT_BROWSERS_PATH=/opt/marsad/.playwright \
  ACQUIRE_SYMBOLS=2222 CONCURRENCY=1 PDF_ARCHIVE_MAX=0 RUN_BUDGET_MS=150000 \
  xvfb-run -a node tadawul-researcher.mjs
# DFM (Class-A, no browser):
unset ANTHROPIC_API_KEY
ACQUIRE_SYMBOLS=EMAAR FSPDF_MAX=2 node dfm-backfill.mjs
```

BHB (direct HTTP — no xvfb, no proxy):

```sh
cd /home/deploy && set -a; source /etc/marsad/worker.env; set +a
unset ANTHROPIC_API_KEY   # so `claude -p` uses the $0 subscription seat
ACQUIRE_SYMBOLS=ALBH FSPDF_MAX=2 node bhb-financials.mjs
```

ADX (headless cookie-seat — no xvfb, no proxy):

```sh
cd /home/deploy && set -a; source /etc/marsad/worker.env; set +a
unset ANTHROPIC_API_KEY   # so `claude -p` uses the $0 subscription seat
PLAYWRIGHT_BROWSERS_PATH=/opt/marsad/.playwright \
  ACQUIRE_SYMBOLS=ALDAR ADX_PDF_MAX=2 node adx-gapfill.mjs
```
