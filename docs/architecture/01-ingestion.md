# 01 — Scraper & Ingestion Fleet Architecture

> Domain: acquisition of all market data, filings, corporate actions, and calendars for the six
> GCC venues under the locked scrape-only / delayed / cheapest-possible constraints.
> Companion to `docs/design-analysis.md` (read that first). This document is the build spec for
> everything upstream of the data lake: sources, adapters, scheduling, runtime, failure handling,
> backfill, and dedup. Downstream (lake object typing, verification, cross-check) is owned by the
> Data Lake domain; the handoff boundary is defined in §10.
>
> Status: v1 design, 2026-07-13. Decisions marked **DEFAULTED** are pragmatic choices the owner
> may override; decisions marked **LOCKED** restate platform-level constraints.

---

## 1. Scope, constraints, and posture

**LOCKED constraints this design honors:**

1. **Scrape-only, stay delayed.** No vendor feeds, no exchange market-data licenses. Every quote
   we serve is sourced from what the exchanges themselves publish on their public websites —
   which is already 15-minute delayed on every GCC exchange site. Our added polling latency sits
   on top of that, so reader-facing data is honestly labeled `DELAYED` (15 min + up to one poll
   interval). We never claim, imply, or accidentally produce a real-time redistribution surface.
2. **All six venues day one:** TDWL, DFM, ADX, QE, MSX, BHB. (Boursa Kuwait appears in reader
   copy — see design-analysis open question #6 — and is explicitly **out of scope** for the v1
   fleet. The adapter interface makes adding `BK` a new directory, not a redesign.)
3. **Cheapest possible run cost.** The entire fleet runs on one €3.79/mo Hetzner VPS plus the
   Supabase Pro project we already pay for. Full cost analysis in §6. No proxies, no scraping
   SaaS, no per-request APIs.
4. **English only.** We ingest EN pages and EN PDFs. Where an exchange publishes AR-first with EN
   lagging (common on MSX and QE), we take the EN version and record `lang: 'en'` on the
   snapshot; the schema notes where an `_ar` sibling column would later attach but we do not
   build it.
5. **Snapshot-first, immutably.** Raw bytes are stored before any parsing, every time content
   changes. Lake objects carry lineage to a snapshot ID (design requirement: "lineage to raw HTML
   snapshot", screen 29a). A parser bug can always be replayed against history.

**What the reader-facing freshness vocabulary means under scrape-only:** the 6-state machine
(live / reconnecting / delayed / offline / halted / auction) still exists, but "LIVE" at the
pipeline level means *our scraper loop is healthy and data is as fresh as the strategy allows* —
the reader badge for quotes always renders the `DELAYED · 15-MIN` class. The state machine's real
job for us is degradation signaling: RECONNECTING/DELAYED/OFFLINE when scrapes fail, HALTED and
AUCTION per ticker from parsed exchange flags and the session clock. Mapping in §8.

**One factual correction to the design analysis (important):** the design doc states a
"Sun–Thu trading week" globally. That is true for TDWL, QE, MSX, and BHB — but **DFM and ADX have
traded Monday–Friday since January 2022** when the UAE moved its weekend to Sat–Sun. The venue
calendar tables in §5 encode this per venue; nothing in the platform may hardcode Sun–Thu.
Flagged to the owner; the market-hours screen (33a) already models per-venue sessions so no
design change is needed, only correct seed data.

---

## 2. Per-venue source inventory

General note on URLs: exchange sites are portal/SPA builds whose internal XHR endpoints churn
without notice. The table below names the stable public entry pages (which are the contractual
"source of record" for provenance) and describes the data endpoints behind them. **Exact XHR
paths are captured during adapter implementation and pinned in the `ingest.sources` registry
(§4.4), never hardcoded in adapter code**, so an endpoint change is a data fix, not a deploy.

Transport legend: **HTTP** = plain fetch of HTML/JSON/XLSX works; **HTTP+bootstrap** = plain
fetch works after a Playwright session establishes cookies/tokens (rotated on a schedule);
**Headless** = full browser render required.

**Proxy-egress policy (the residential proxy is metered — treat it as a scarce, paid resource).**
Provider is **Geonode** (`proxy.geonode.io:9000`, migrated off IPRoyal 2026-07-15 after the IPRoyal
account was exhausted). Creds live in the VPS `worker.env` (`PROXY_SERVER/USERNAME/PASSWORD`); Geonode
puts geo/session selectors on the **username** (`geonode_<id>-type-residential-country-bh`), and its
`:9000` gateway is rotate-only (sticky needs a separate Geonode sticky port). `core/proxy.ts` resolves
it per source. `endpoint_config.use_proxy=true` routes a source through the residential proxy and is
**billed per outbound byte**; everything else egresses the VPS's own IP for free. The rule:
**only proxy a host that genuinely CANNOT be reached from the VPS's direct IP** — a hard
IP-geofence or WAF IP-block (e.g. BHB / `bahrainbourse.com`, Radware-blocked from datacenter
IPs). Before ever setting `use_proxy`, **test the host direct first** (`curl` from the VPS); if
it returns 200 direct, it must stay `use_proxy=false`. A high-volume host that merely *rate-limits*
(HTTP 429, e.g. Yahoo under a many-symbol backfill) does **not** qualify — mitigate with lower
cadence / throttling / chunking, not the proxy; reach for proxy only if direct is genuinely blocked.
All live board/quote polling (TDWL/DFM/QE/ADX/MSX — single-fetch native boards) is **direct**.
Audit periodically: `select id, venue, data_type, active from ingest.sources where
(endpoint_config->>'use_proxy')::bool` — every row must justify *why direct fails*, or be flipped
to `use_proxy=false`. See `docs/architecture/06-infra-cost.md` and memory `marsad-bandwidth-attribution`.

### 2.1 TDWL — Saudi Exchange (Tadawul), `saudiexchange.sa`

The largest venue (~230 main-market listings + Nomu) and the highest-churn source. The site is an
IBM WebSphere portal; page URLs are long `/wps/portal/...` paths, but the data behind them is
served by XHR endpoints returning JSON, which can be replayed with plain HTTP once portal cookies
are established.

| Data | Where | Transport | Notes |
|---|---|---|---|
| Quotes (all listings) | Market watch page under `saudiexchange.sa/wps/portal/saudiexchange/ourmarkets/main-market-watch` (+ Nomu equivalent) | HTTP+bootstrap | Backing XHR returns full market table as JSON (last, chg, volume, value, trades). 15-min delayed on site. One request covers the whole board. |
| Indices (TASI, sector indices) | Indices page under `ourmarkets` | HTTP+bootstrap | JSON; includes sector index levels used for heatmap weights. |
| Filings/disclosures | Issuer news: `saudiexchange.sa/wps/portal/saudiexchange/newsandreports/issuer-news` | HTTP+bootstrap | Paginated JSON list with announcement ID (e.g. the `CG-1-2026-4471` style IDs in the designs), category, timestamp; per-item detail page + attached AR/EN PDFs. Archive searchable back ~2 decades. |
| Financial statements | Per-company profile → financial statements tab | HTTP+bootstrap | Structured quarterly/annual line items rendered from JSON; also FS-1 PDFs via the disclosure feed. |
| Dividends / corporate actions | Per-company corporate actions + a market-wide corporate actions report | HTTP+bootstrap | DPS, ex-date, record, pay date. Cross-checks the `DISCLOSURE.DPS` lake objects extracted from filings. |
| IPO announcements | `newsandreports` news + CMA-linked announcements on the site | HTTP+bootstrap | Prospectus PDFs linked. (Regulator-direct source `cma.org.sa` deferred, §12.) |
| Market calendar / holidays | Trading calendar page under market information | HTTP | Annual holiday list; Ramadan session changes announced via circulars → also caught by filings poller. |
| Historical prices | "Market reports" (daily/weekly/monthly/yearly XLSX bulletins) + per-company chart XHR (multi-year daily OHLC JSON) | HTTP+bootstrap | Best backfill source in the GCC. |

Session: Sun–Thu, opening auction 09:30–10:00 AST, continuous 10:00–15:00, closing auction
15:00–15:10 (AST = UTC+3). Risk note: Tadawul sells market data commercially, so this is the
venue with the most redistribution sensitivity — our delayed-only + no-tick-data posture (§7) is
calibrated to it.

### 2.2 DFM — Dubai Financial Market, `dfm.ae`

Modern SPA; the cleanest machine-readable venue. Data comes from a JSON API host used by the
site itself (historically `api.dfm.ae`). The site sits behind Imperva/Incapsula, so the adapter
runs in HTTP+bootstrap mode with the Playwright cookie refresh.

| Data | Where | Transport | Notes |
|---|---|---|---|
| Quotes | `dfm.ae/the-exchange/market-information` (SPA over JSON API) | HTTP+bootstrap | Full board in one JSON call; 15-min delayed. |
| Index (DFMGI + sector indices) | Same market-information API | HTTP+bootstrap | |
| Disclosures | `dfm.ae/the-exchange/news-disclosures/disclosures` (JSON list + PDF attachments, "eFsah" system) | HTTP+bootstrap | Typed categories map well onto our filing taxonomy. Archive back to ~2007. |
| Financials | Per-security page financial tabs + FS PDFs via disclosures | HTTP+bootstrap | |
| Dividends | Corporate actions section per security + market-wide dividends page | HTTP+bootstrap | |
| IPO / new listings | News + dedicated IPO pages when live | HTTP+bootstrap | |
| Calendar | Trading calendar page | HTTP | |
| Historical | Market reports (daily bulletins, XLSX/PDF) + per-security price-history API (multi-year daily) | HTTP+bootstrap | |

Session: **Mon–Fri**, pre-open 09:30–10:00, continuous 10:00–14:45, close ~15:00 GST (UTC+4).

### 2.3 ADX — Abu Dhabi Securities Exchange, `adx.ae`

Similar profile to DFM: SPA over JSON services, WAF in front.

| Data | Where | Transport | Notes |
|---|---|---|---|
| Quotes + FADGI index | Market watch on `adx.ae` (JSON services) | HTTP+bootstrap | Full board JSON. |
| Disclosures | ADX news & disclosures section (JSON list + PDFs) | HTTP+bootstrap | |
| Financials | Per-security pages + FS PDFs | HTTP+bootstrap | |
| Dividends | Corporate actions per security | HTTP+bootstrap | |
| IPO | News + listing announcements | HTTP+bootstrap | ADX has had the region's busiest listing pipeline; the IPO sweep (§5) runs daily here. |
| Historical | Daily trading reports (downloadable) + price-history services | HTTP+bootstrap | |

Session: **Mon–Fri**, 10:00–15:00 GST (UTC+4).

### 2.4 QE — Qatar Stock Exchange, `qe.com.qa`

Older ASP.NET-era site; mostly server-rendered HTML with some JSON widgets. No aggressive WAF
observed historically — plain HTTP is the default mode, headless not expected.

| Data | Where | Transport | Notes |
|---|---|---|---|
| Quotes + QSI index | Market watch page on `qe.com.qa` | HTTP | Server-rendered table / lightweight data feed; parse HTML. ~50 listings so page is small. |
| Disclosures | Company news / announcements section | HTTP | HTML list, per-company filters; PDFs attached. |
| Financials | Company pages + FS PDFs via news | HTTP | |
| Dividends | Announcements (typed) + company pages | HTTP | Registrar detail (Edaa Qatar) not scraped v1 — disclosure is the source. |
| IPO | News section | HTTP | |
| Historical | Daily bulletins / market reports archive (PDF/XLS) | HTTP | |

Session: Sun–Thu, 09:30–13:15 AST (UTC+3). Smallest data surface of the six after BHB.

### 2.5 MSX — Muscat Stock Exchange, `msx.om`

Rebranded from MSM; Angular-style frontend over JSON endpoints. EN content sometimes lags AR.
The design fixture's running incident (MSX timeout since 09:19) reflects reality: this is the
least reliable site of the six and gets the most conservative retry budget and the loudest
failure escalation (it maps to the `DATA-MSX` agent that screen 31a shows ERRORING).

| Data | Where | Transport | Notes |
|---|---|---|---|
| Quotes + MSX30 | Market watch on `msx.om` (JSON endpoints behind the SPA) | HTTP+bootstrap | Full board JSON. |
| Disclosures | News/announcements section | HTTP+bootstrap | Mixed HTML/JSON; PDFs. EN availability spotty — we take EN, flag gaps. |
| Financials | Company pages + disclosure PDFs | HTTP+bootstrap | The design's "MSX estimates 41% coverage gap" is a consensus problem, not ours, but financials extraction here leans hardest on the PDF pipeline. |
| Dividends | AGM announcements (dividends approved at AGM in Oman) + company pages | HTTP+bootstrap | Ex-date discipline weaker; cross-check rules must tolerate later confirmation. |
| Historical | Daily/monthly bulletins archive | HTTP | |

Session: Sun–Thu, pre-open from 09:00, continuous ~09:30–13:00 GST (UTC+4).

### 2.6 BHB — Bahrain Bourse, `bahrainbourse.com`

Small venue (~40 active listings), friendly source: publishes a **daily trading bulletin in
Excel/PDF** — the easiest EOD ingestion in the GCC.

| Data | Where | Transport | Notes |
|---|---|---|---|
| Quotes + BASI index | Market watch on `bahrainbourse.com` | HTTP | Simple page; also the intraday need here is lowest (thin trading). |
| Daily bulletin (EOD source of record) | Trading bulletins page, XLSX/PDF per day, deep archive | HTTP | Parse the XLSX directly — no HTML fragility. |
| Disclosures | News & announcements section | HTTP | HTML list + PDFs. |
| Dividends / corporate actions | Corporate actions page + announcements | HTTP | |
| Financials | Announcement PDFs | HTTP | |
| Historical | Bulletin archive (years of daily XLSX) | HTTP | Backfill is nearly free here. |

Session: Sun–Thu, 09:30–13:00 AST (UTC+3).

### 2.7 Cross-venue summary

| Venue | Listings (approx) | Quotes transport | Filings transport | EOD gold source | Local session | Days |
|---|---|---|---|---|---|---|
| TDWL | ~230 + Nomu | HTTP+bootstrap (JSON XHR) | HTTP+bootstrap | Market reports XLSX | 10:00–15:10 AST | Sun–Thu |
| DFM | ~65 | HTTP+bootstrap (JSON API) | HTTP+bootstrap | Daily bulletin | 10:00–14:45 GST | **Mon–Fri** |
| ADX | ~90 | HTTP+bootstrap (JSON API) | HTTP+bootstrap | Daily trading report | 10:00–15:00 GST | **Mon–Fri** |
| QE | ~52 | HTTP (HTML) | HTTP | Daily bulletin | 09:30–13:15 AST | Sun–Thu |
| MSX | ~110 | HTTP+bootstrap (JSON) | HTTP+bootstrap | Daily bulletin | 09:30–13:00 GST | Sun–Thu |
| BHB | ~40 | HTTP (HTML) | HTTP | **Daily bulletin XLSX** | 09:30–13:00 AST | Sun–Thu |

No venue requires *persistent* headless rendering for steady-state polling. Playwright is used
only for (a) periodic cookie/token bootstrap on WAF-fronted venues, (b) one-time endpoint
discovery when a site redesign breaks an adapter, and (c) rare pages that genuinely never emit
replayable XHR. This is the single biggest cost lever: plain HTTP polls cost ~nothing; a
continuously running browser would dictate a bigger box.

---

## 3. Scraper architecture

### 3.1 Repository layout

The fleet lives in the same repo as the app but as an independent workspace that Next.js never
bundles — it deploys to the VPS, not Vercel.

```
/Users/ayushkbhatia/Marsad-Platform/
  ingestion/
    package.json              # own deps: undici, playwright, cheerio, zod, xlsx, pino
    tsconfig.json
    src/
      worker.ts               # entrypoint: claim jobs from ingest.job_queue, run, heartbeat
      core/
        queue.ts              # claim/complete/fail semantics against Postgres (SKIP LOCKED)
        fetcher.ts            # HTTP client: retries, conditional GET, robots cache, rate limiter
        browser.ts            # Playwright bootstrap sessions (cookie jar per venue, refresh cadence)
        snapshot.ts           # normalize → hash → dedup check → store (Supabase Storage + row)
        parse-harness.ts      # runs a parser against a snapshot, records ingest.parse_runs
        calendar.ts           # is-venue-open(venue, ts) from market.venue_sessions/holidays
        heartbeat.ts          # writes market.feed_status inputs after every job
        killswitch.ts         # checks agent service-account run toggle before each job
      adapters/
        types.ts              # VenueAdapter + TaskSpec interfaces (below)
        tdwl/  { quotes.ts, indices.ts, filings.ts, financials.ts, dividends.ts, calendar.ts, backfill.ts }
        dfm/   { ...same shape }
        adx/   { ... }
        qe/    { ... }
        msx/   { ... }
        bhb/   { quotes.ts, bulletin.ts, filings.ts, dividends.ts, backfill.ts }
      parsers/
        pdf/                  # filing PDF text extraction (pdftotext via poppler on the VPS)
        xlsx/                 # bulletin workbook parsers
    deploy/
      marsad-ingest.service   # systemd unit (Restart=always, MemoryMax=2G)
      setup-vps.sh            # node 22 + playwright chromium + poppler-utils
```

Supabase access (corrected post-review — the service-role key cannot be narrowed per agent):
the worker opens **direct Postgres connections as a dedicated `marsad_worker` role** (via the
Supavisor session pooler, which the queue's `FOR UPDATE SKIP LOCKED` claiming requires anyway —
PostgREST cannot express it). `marsad_worker` holds grants on `ingest.*`, `lake.*`, `ops.*`,
`comms.*`, and the `public` market tables, and **zero grants on `billing.*` or `iam` mutation
paths** — "agents never touch billing" is a database fact at the role level. Agent identity
(DATA-TDWL etc.) is attribution: the worker sets `app.principal_id` per task (transaction-local
GUC) and checks `iam.agent_accounts.run_enabled` before every job. Storage uploads use
Supabase Storage with the service-role key held by the worker for bucket writes only
(`raw-snapshots`, `filings-pdf`) — an accepted, documented exception to least-privilege; the
relational layer, where billing lives, never sees that key path.

### 3.2 The adapter contract

Every venue implements the same interface; the worker, queue, snapshot store, and freshness
logic know nothing venue-specific.

```ts
// ingestion/src/adapters/types.ts
export type VenueCode = 'TDWL' | 'DFM' | 'ADX' | 'QE' | 'MSX' | 'BHB';

export type DataType =
  | 'quotes' | 'indices' | 'filings_list' | 'filing_detail'
  | 'financials' | 'dividends' | 'ipo' | 'calendar'
  | 'eod_bulletin' | 'ohlcv_backfill';

export interface FetchContext {
  source: SourceRecord;            // pinned URL/endpoint config from ingest.sources
  http: Fetcher;                   // rate-limited, retrying, robots-aware client
  browser: BrowserBootstrap;       // lazy Playwright session (cookie refresh only)
  logger: Logger;
}

export interface RawPayload {
  externalId?: string;             // e.g. announcement ID — used for list-diff dedup
  url: string;                     // exact URL fetched (provenance)
  contentType: string;
  body: Buffer;
  meta?: Record<string, unknown>;  // e.g. list page number, ticker
}

export interface TaskSpec<T> {
  dataType: DataType;
  fetch(ctx: FetchContext): Promise<RawPayload[]>;
  // parse is PURE: snapshot bytes in, typed rows out. Never fetches. Replayable forever.
  parse(snapshot: StoredSnapshot): ParseResult<T>;
  parserVersion: number;           // bump ⇒ replay eligibility for old snapshots
}

export interface VenueAdapter {
  venue: VenueCode;
  agentAccount: 'DATA-TDWL' | 'DATA-GULF' | 'DATA-MSX' | 'DATA-FILINGS';
  tasks: Partial<Record<DataType, TaskSpec<unknown>>>;
}
```

**Agent account mapping** (matches the 12-account roster on 31a): `DATA-TDWL` owns all TDWL
tasks; `DATA-GULF` owns DFM/ADX/QE/BHB quotes+indices+corporate actions; `DATA-MSX` owns MSX
(isolated because it's the flakiest — its kill switch must not affect other venues);
`DATA-FILINGS` owns filings list/detail/PDF tasks across all venues (it is the account whose
output feeds the T+9-min parse SLA). `DATA-NEWS` (external news) is out of this domain's scope.

### 3.3 Snapshot-first pipeline

Every job runs the same four stages; parsing is decoupled from fetching so a parser crash never
loses data.

```
FETCH → NORMALIZE+HASH → STORE (only if changed) → ENQUEUE PARSE → PARSE → EMIT lake.staging rows
```

1. **Fetch** via `core/fetcher.ts`: undici with per-host token-bucket (≤1 req/s, §7),
   `If-None-Match`/`If-Modified-Since` when the server supports it (DFM/ADX APIs do), gzip
   accepted, 20s timeout, UA string from §7.
2. **Normalize + hash**: strip volatile bytes before hashing — server timestamps, CSRF/viewstate
   tokens, request IDs — via a per-source normalization regex list stored in `ingest.sources`
   (so a new volatile field is a data fix). Then `sha256`. JSON payloads are key-sorted before
   hashing.
3. **Store if changed**: compare against `ingest.sources.last_content_hash`. Unchanged ⇒ write a
   heartbeat (`ingest.fetch_log` row with `changed = false`, no body stored) and stop — this is
   the dominant case off-hours and for thin venues, and it is what keeps storage near zero.
   Changed ⇒ gzip body to Supabase Storage bucket `raw-snapshots` at
   `{venue}/{data_type}/{yyyy}/{mm}/{dd}/{sha256}.{ext}.gz` and insert `ingest.raw_snapshots`.
4. **Parse** in `parse-harness.ts`: run `TaskSpec.parse`, validate output with zod, insert typed
   rows into the lake staging tables with `snapshot_id` lineage, record `ingest.parse_runs`
   (status, rows emitted, duration, parser_version). Zero-rows-from-changed-snapshot is a
   **PARSE_DRIFT** signal (§8), not a silent success.

**Retry/backoff** (in-job): 3 attempts at 5s → 25s → 120s with ±30% jitter, only for network
errors and 5xx/429 (429 also respects `Retry-After`). 4xx other than 429 fails immediately
(endpoint moved — that's a drift alert, retrying won't help). Job-level failures are recorded in
`ingest.job_runs` and drive the consecutive-failure escalation in §8. Backoff across *runs* is
handled by the scheduler: after 3 consecutive failed runs of a source, its effective cadence
doubles (cap 4×) until a success — polite to a struggling site, and exactly the "retry 4, 90s
fallback" behavior screen 33a displays.

**LLM usage in this layer: near zero by design.** Quotes, indices, bulletins, dividends tables,
and filings *lists* are parsed deterministically (cheerio/zod/xlsx). The only LLM touchpoint is
unstructured filing PDF fact-extraction and classification, and that belongs to the lake's
extraction service, which calls the shared provider-agnostic gateway (`src/lib/llm/gateway.ts`,
OpenAI-compatible interface, env-driven routing per the platform LOCKED decision). Nothing in the
hot polling path ever calls a model.

### 3.4 Core Postgres schema (schema `ingest`, plus `market` reference tables)

```sql
-- Registry: one row per (venue, data_type, endpoint). URLs/config live here, not in code.
create table ingest.sources (
  id                bigint generated always as identity primary key,
  venue             text not null,            -- 'TDWL'…'BHB'
  data_type         text not null,            -- 'quotes','filings_list',…
  entry_url         text not null,            -- human-auditable page of record
  endpoint_config   jsonb not null,           -- XHR url template, method, headers, pagination
  normalize_rules   jsonb not null default '[]', -- volatile-byte strip regexes
  transport         text not null,            -- 'http' | 'http_bootstrap' | 'headless'
  robots_status     text not null default 'allowed', -- 'allowed'|'disallowed'|'override' (§7)
  active            boolean not null default true,
  last_content_hash text,
  last_changed_at   timestamptz,
  last_success_at   timestamptz,
  consecutive_failures int not null default 0,
  unique (venue, data_type, entry_url)
);

-- Immutable raw store. Bodies live in Storage; this is the index + lineage anchor.
create table ingest.raw_snapshots (
  id            bigint generated always as identity primary key,
  source_id     bigint not null references ingest.sources,
  fetched_at    timestamptz not null default now(),
  url           text not null,
  http_status   int not null,
  content_type  text not null,
  content_hash  text not null,               -- sha256 of normalized body
  storage_path  text not null,               -- raw-snapshots bucket key
  bytes_stored  int not null,
  external_id   text,                        -- announcement id etc., when known
  meta          jsonb not null default '{}'
);
create index on ingest.raw_snapshots (source_id, fetched_at desc);
-- NULLS NOT DISTINCT (PG17, confirmed on the live project) so NULL external_id sources
-- (quote boards, bulletins, calendar pages — the highest-volume sources) still dedupe:
create unique index on ingest.raw_snapshots (source_id, content_hash, external_id)
  nulls not distinct;
-- Inserts use ON CONFLICT DO NOTHING: an A→B→A content flip (last_content_hash remembers only B)
-- conflicts silently, logs a changed=false heartbeat, and never double-emits staging rows.

-- Every fetch, changed or not (heartbeat trail; 30-day retention, pg_cron pruned).
create table ingest.fetch_log (
  id          bigint generated always as identity primary key,
  source_id   bigint not null references ingest.sources,
  fetched_at  timestamptz not null default now(),
  http_status int,
  changed     boolean not null,
  duration_ms int,
  error       text
);

create table ingest.parse_runs (
  id             bigint generated always as identity primary key,
  snapshot_id    bigint not null references ingest.raw_snapshots,
  parser_version int not null,
  started_at     timestamptz not null default now(),
  status         text not null,             -- 'ok' | 'error' | 'drift_zero_rows'
  rows_emitted   int,
  error          text
);

-- List-diff memory for item feeds (filings, IPO announcements).
create table ingest.seen_items (
  source_id    bigint not null references ingest.sources,
  external_id  text not null,
  first_seen   timestamptz not null default now(),
  detail_state text not null default 'pending', -- 'pending'|'fetched'|'failed'
  primary key (source_id, external_id)
);

-- Job queue (scheduler writes, VPS worker claims with FOR UPDATE SKIP LOCKED).
create table ingest.job_queue (
  id           bigint generated always as identity primary key,
  source_id    bigint not null references ingest.sources,
  enqueued_at  timestamptz not null default now(),
  run_after    timestamptz not null default now(),
  priority     int not null default 5,       -- filings detail > quotes > backfill
  claimed_by   text,                         -- worker instance id
  claimed_at   timestamptz,
  finished_at  timestamptz,
  status       text not null default 'queued' -- 'queued'|'running'|'ok'|'failed'|'skipped_closed'
);

create table ingest.schedules (
  id               bigint generated always as identity primary key,
  source_id        bigint not null references ingest.sources,
  cadence_minutes  int not null,
  session_only     boolean not null default false, -- gate on venue open (quotes)
  offset_minutes   int not null default 0,         -- stagger venues off the tick
  last_enqueued_at timestamptz,                    -- scheduler state: enqueue_due_jobs() compares now()-this >= cadence
  active           boolean not null default true
);

-- Venue reference (schema `market`), seeds the calendar service and screen 33a.
create table market.venues (
  code text primary key, name text not null, tz text not null,   -- 'Asia/Riyadh', 'Asia/Dubai'…
  trading_days int[] not null,          -- ISO dow: TDWL '{7,1,2,3,4}' (Sun–Thu), DFM '{1,2,3,4,5}'
  delay_class text not null default 'delayed_15m'
);
create table market.venue_sessions (
  venue text references market.venues, session_kind text,        -- 'preopen'|'continuous'|'close_auction'
  starts_local time not null, ends_local time not null,
  effective_from date, effective_to date,                        -- Ramadan rows use these
  primary key (venue, session_kind, effective_from)
);
create table market.venue_holidays (
  venue text references market.venues, holiday_date date, label text,
  hijri_estimated boolean not null default false,                -- requires human confirm (33a)
  confirmed_by text, primary key (venue, holiday_date)
);
-- NOTE (post-review): the canonical venue freshness table is public.venue_feed_status as
-- defined in 02-data-lake.md §7 (world-readable for badge propagation). The sweep below is
-- its single writer. State vocabulary includes 'closed':
--   live|reconnecting|delayed|offline|closed (+halted/auction per ticker on security_status).
-- 'closed' is written by the sweep whenever the calendar says the venue is out of session —
-- venues render the 16c market-closed treatment overnight/weekends, never a false OFFLINE.
```

(AR note per LOCKED decision 4: `market.venues.name` and future instrument tables would gain
`name_ar` siblings later; columns intentionally not created now.)

### 3.5 The filing_detail chain (list-diff → PDF → bucket → extraction seam)

Built 2026-07-16 (DEF-VENUE-FILINGS). This is the concrete "a new quarterly disclosure PDF appears on
a venue → the PDF lands in our bucket → it is queued for extraction" path. It was verified dead via
three independent gaps, fixed as one design:

1. **Handler mapping** — `filing_detail` had no `DATA_TYPE_TO_HANDLER` entry (`worker/src/ingest-poller.ts`),
   so every detail wake-up row failed "no handler for data_type". Added `filing_detail → filings_detail_poll`.
2. **Sources** — no `ingest.sources` rows of `data_type='filing_detail'` existed, so
   `filingDetailSourceId(venue)` was always null and the wake-up had nowhere to enqueue. Seeded one
   `filing_detail` source + a 60-min backstop schedule per venue (`20260716090500`).
3. **List-diff** — the runtime surfaced new ids from the fetch-level `FetchResult.externalId`, which is
   always empty for a single list-page fetch, so **nothing ever triggered a detail fetch — even on the
   working DFM/ADX/MSX venues**. `RunTaskResult` now carries `filingRefs` (every parsed
   `NormalizedFilingRef`); the handler list-diffs those against `ingest.seen_items` (the ON-CONFLICT
   insert returns the genuinely-new ones).

**Flow.** `filings_poll` parses the list → records each new announcement as a pending `seen_items` row
carrying its `detail_url`/`pdf_url`/`title`/`filed_at` (new columns, `20260716090000`) → enqueues ONE
priority-1 `job_queue` row against the venue's `filing_detail` source. The poller routes it to
`filings_detail_poll`, which drains a **chunk** (≤10, oldest-first) of the venue's pending targets:
`runtime.fetchFilingPdfs` seats WAF cookies once per chunk, downloads each PDF (direct `pdfUrl`, or the
detail page → a per-venue resolver extracts the PDF href — only BHB needs one), and stores it in the
public **`filings`** Storage bucket, content-addressed: `{venue}/{ticker|_unmapped}/{sha256}.{ext}`
(mirroring the 295 objects already there; the list feed carries no security id, so the ticker segment is
`_unmapped` pending a later resolution pass). The handler then, per stored PDF: upserts the
`public.filings` linkage (`pdf_storage_key` + the new `pdf_sha256`) on `(venue_code, source_ref)` —
self-sufficient whether or not the `fn_filing_project` (0037) row exists yet — enqueues an
`ops.filing_extract_queue` placeholder (idempotent on `content_sha256`), and flips `seen_items.detail_state`
to `fetched` (or `nopdf`/`failed`, both terminal — no poison). A full chunk **self-chains** a 2-min
cooldown follow-up so a burst of new disclosures is worked in bounded chunks that never starve the quote
lanes or the per-host ≤1 req/s budget.

**Extraction seam.** `ops.filing_extract_queue (filing_id, venue_code, source_ref, content_sha256 UNIQUE,
pdf_storage_key, content_type, state)` is the clean, sha256-keyed hand-off. The extraction **service**
(PDF → `full_text`/`extracted_facts`/`ai_summary`, the one bounded LLM cost) is a later phase
(DEF-FILING-FACTS / §9); this chain only fills the queue. Because the key is the content sha256, a
re-announced identical PDF enqueues exactly once, and a re-fetch of the same bytes is a Storage upsert
no-op — snapshot-first immutability holds end to end.

**Per-venue transport.** DFM/MSX/ADX carry a direct per-announcement `pdfUrl` on the list ref
(api2.dfm.ae CDN, msx.om RSS `<Link>`, ADX `urlEn`) → the drain downloads it directly (no resolver);
TDWL/ADX attachment hosts sit behind Akamai → `http_bootstrap` with an `actionDiscovery` `direct`
cookie-seat. **BHB is list-only**: its AnnouncementDetail page serves the real attachment only via
client-side SharePoint JS (`spsdisco.aspx`) — the static HTML carries just site-chrome `.pdf` links — so
its `filing_detail` source is deactivated and no resolver is wired (per-announcement PDF is deferred to
the BHB webapi attachment endpoint). Live reactivation status is tracked in BUILD-STATUS §7 (BHB list
done; BHB PDF, TDWL, QE parked with precise triggers).

**Live validation (2026-07-16).** The chain is proven end-to-end on **MSX**: 3 distinct per-announcement
PDFs downloaded into the `filings` bucket, linked on `public.filings`, and queued for extraction — zero
failures, zero poison. The chain MECHANISM is thus proven; the remaining work is per-venue PDF **resource
URL** correctness, which varies by venue: MSX ✓; **DFM** `filing_detail` is deactivated (its eFsah
`r_path` 404s from `api2.dfm.ae` — that host serves the list feed, not the download; DEF-VENUE-FILINGS-
DFM-PDF); **ADX** is left active but unproven (its apigateway CDN download is WAF-gated — may pass via the
http_bootstrap browser context; DEF-VENUE-FILINGS-ADX-PDF); **BHB** is list-only (JS attachment).

---

## 4. Scheduling strategy

### 4.1 One tick, calendar-aware enqueue — not fifty cron entries

pg_cron (already available on Supabase) runs **one** frequent tick plus a handful of daily
housekeeping entries. The tick calls a SQL function that consults `ingest.schedules`,
`market.venue_sessions`, and `market.venue_holidays`, and enqueues only what is actually due —
so Sun–Thu vs Mon–Fri weeks, holidays, and Ramadan reduced sessions (10:00–13:00, per design)
are data, and a Hijri holiday confirmation on screen 33a instantly reshapes the schedule with no
deploy.

```sql
-- pg_cron entries (all times UTC; GST = UTC+4, AST = UTC+3)
select cron.schedule('ingest-tick',        '*/5 * * * *',  $$select ingest.enqueue_due_jobs()$$);
select cron.schedule('feed-status-sweep',  '* * * * *',    $$select ingest.sweep_feed_status()$$);
select cron.schedule('fetch-log-prune',    '20 1 * * *',   $$delete from ingest.fetch_log where fetched_at < now() - interval '30 days'$$);
select cron.schedule('queue-reaper',       '*/10 * * * *', $$select ingest.requeue_stuck_jobs('15 minutes')$$);
```

`enqueue_due_jobs()` logic: for each active schedule, if `now() - last_enqueue >= cadence` and
(`session_only = false` OR the venue is open at `now()` per calendar, with a grace window of
−10/+20 min around the session to catch auction and closing prints), insert a queue row. The VPS
worker long-polls the queue every 15s (a single indexed `SELECT ... FOR UPDATE SKIP LOCKED`
against Supabase — negligible load). If the worker is dead, jobs accumulate and the sweep flips
freshness states (§8) — the scheduler doubles as the dead-man's switch.

### 4.2 Cadence per data type

| Data type | During venue session | Outside session | Rationale |
|---|---|---|---|
| Quotes (full board) | **every 10 min** per venue | none (plus one close sweep) | Product is labeled 15-min delayed; source is already 15-min delayed; 10-min polling gives worst-case ~25 min data age, honest under the DELAYED badge. 6 venues × ~30 polls/day ≈ 180 board fetches/day. **DEFAULTED** — owner can tighten TDWL to 5 min for ~2× TDWL request volume. |
| Indices | every 10 min (same job as quotes where the endpoint is shared) | close sweep | Heatmap + front-page rail. |
| Filings list | **every 5 min, 04:00–19:00 UTC daily** (all venues, incl. non-trading days for the venue — disclosures drop on weekends); every 30 min overnight | GCC disclosures cluster pre-open and post-close; evening drops are common. This poller is what makes the T+9-min parse SLA achievable: 5-min list poll + immediate detail fetch + parse ≈ well inside 9 min median. |
| Filing detail + PDFs | event-driven: enqueued at priority 1 the moment list-diff sees a new `external_id` | — | |
| EOD close sweep | venue close + 30 min: final board snapshot + official bulletin/report (BHB XLSX, TDWL market report, DFM/ADX daily report, QE/MSX bulletin) | — | Bulletin is the EOD source of record; the intraday board is provisional. Must land before the 04:00 GST (00:00 UTC) score batch — worst case close+30 is 12:45 UTC, 11+ hours of slack. |
| Dividends / corporate-action pages | daily sweep at 15:00 UTC | — | Primary discovery is the filings poller (a DPS change arrives as a disclosure — the stc 0.50→0.55 fixture); the page sweep is the cross-check that feeds registrar-style verification (33b) and catches silent page edits. |
| IPO pipeline pages | daily sweep at 05:00 UTC + event-driven from filings poller | — | Coverage multiples during live subscriptions: bump to hourly for venues with an open book (schedule row toggled by the lake's IPO object state — "TRACKS IPO CENTER LIVE"). |
| Financial-statement pages | weekly sweep (Sat 09:00 UTC, all venues closed) + event-driven on FS-type filings | — | Statements only change on results; results arrive as filings. |
| Market calendar / holidays | weekly (Sat 10:00 UTC) | — | New rows with `hijri_estimated = true` are held for human confirm per 33a. |
| Playwright cookie bootstrap | per WAF venue: on 401/403/challenge response, plus a preemptive refresh every 6 h | — | Keeps steady state browserless. |

Concrete effective windows the tick produces (UTC): TDWL quotes fire 06:50–12:20 Sun–Thu;
DFM/ADX 05:50–11:20 Mon–Fri; QE 06:20–10:35 Sun–Thu; MSX 05:20–09:20 Sun–Thu; BHB 06:20–10:20
Sun–Thu. Staggered `offset_minutes` (TDWL +0, DFM +1, ADX +2, QE +3, MSX +4, BHB +5 within each
10-min slot) so the worker never bursts and per-host politeness is trivially maintained.

Reader quiet hours (22:00–07:00 GST) are a **notification** throttle and do not affect
scraping; overnight filings still ingest and parse — only downstream push delivery is held.

### 4.3 Daily request budget (honesty check — recomputed post-review)

Correct arithmetic: filings-list at 5-min cadence over 04:00–19:00 UTC = 180 polls/venue/day
× 6 venues = **1,080**, plus overnight 30-min polls (9 h × 2 × 6) ≈ **108**; quotes ≈ 180
board fetches; filing detail/PDF ≈ 50–250; daily/weekly sweeps ≈ 30. Total ≈ **1,450–1,650
HTTP requests/day across six hosts** — roughly 220–280/day on the busiest single host, mean
interval ≈ 5–6 minutes per host. Still objectively polite (a human with the site open in a tab
generates more), still far below any abuse threshold, and this corrected number is the one the
§7 etiquette argument cites. If an exchange ever objects, the first lever is relaxing the
overnight filings cadence to 60 min (−54 req/day/host) before anything else.

### 4.4 Config over code

Everything that varies — URLs, XHR templates, cadences, normalization rules, robots status,
active flags — lives in `ingest.sources` / `ingest.schedules` and is editable from Marsad Desk
(market data ops, 33a). Adapter code contains parsing logic and endpoint *shapes* only.

---

## 5. Where the fleet runs — evaluation and recommendation

### 5.1 Options evaluated

| Option | Monthly cost | Headless capable | Scheduling fidelity | Verdict |
|---|---|---|---|---|
| **Hetzner VPS** (CX22: 2 vCPU, 4 GB, 40 GB, Falkenstein) | €3.79 + €0.50 IPv4 ≈ **$4.90** | Yes (Playwright Chromium fits in 4 GB with room) | Exact — long-running worker, 15s queue poll | **PRIMARY — chosen** |
| GitHub Actions cron (private repo) | $0 up to 2,000 min/mo, then $0.008/min | Yes but ~45–60s cold start per run | Poor: cron jitter routinely 5–15+ min, runs occasionally dropped — fatal for a 5-min filings SLA | **DR fallback only** (§5.3) |
| Supabase Edge Functions + pg_cron | $0 marginal (inside existing Pro $10/mo; 2M invocations included) | **No** (Deno isolate, no Chromium) | Good (pg_cron → HTTP trigger) | **Secondary**: hosts the SQL scheduler + sweeps (already does); could host plain-HTTP pollers for QE/BHB if the VPS is down, but not the WAF venues |
| Owner's Mac (Ollama host) | $0 | Yes | None guaranteed (sleep, network, travel) | **Dev + one-time backfills only** |
| Fly.io / Railway / Render workers | $5–7 realistic for always-on 512 MB–1 GB | Cramped for Playwright at the cheap tier | Good | Dominated by Hetzner on price/RAM — rejected |
| Scraping SaaS (Browserless, ScrapingBee, Zyte) | $30–100+ | Yes | n/a | Violates cheapest-possible — rejected |

Cost math on GitHub Actions as primary (why it loses despite "$0"): the filings poller alone is
~230 runs/day; at ~1.5 min billable per run (checkout + setup-node + run) that is ~10,000
min/mo — $64/mo in overage, *worse* than the VPS, with worse latency guarantees. Free minutes
only work if you batch to ~4 runs/hour, which breaks the 5-min filings cadence and the T+9-min
SLA. A public repo would make minutes unlimited but publishes our adapters and endpoints to the
exchanges — poor legal/etiquette optics for marginal gain. Rejected as primary.

### 5.2 Recommended topology (total incremental cost ≈ $5/mo)

```
Supabase (existing, $10/mo Pro — Postgres, Storage, pg_cron)
  ├─ pg_cron: ingest-tick / feed-status sweep / retention  (scheduler of record)
  ├─ ingest.* schema: sources, schedules, job_queue, raw_snapshots index
  ├─ Storage bucket raw-snapshots (gzip; ~1–3 GB/mo growth, 100 GB included)
  └─ market.feed_status → consumed by Desk 33a + reader FreshnessBadge

Hetzner CX22 (~$4.90/mo, Ubuntu LTS, systemd)              (the entire compute fleet)
  └─ marsad-ingest.service : Node 22 worker (ingestion/src/worker.ts)
       ├─ claims ingest.job_queue, runs venue adapters
       ├─ Playwright Chromium (bootstrap only) + poppler pdftotext
       ├─ writes snapshots → Supabase Storage, rows → Postgres
       └─ identifies as DATA-* service accounts; obeys per-agent kill switches

GitHub Actions (free tier)                                  (DR + deploy)
  ├─ deploy workflow: push to main → rsync ingestion/ to VPS, restart unit
  └─ eod-fallback.yml: nightly 20:00 UTC — if today's EOD bulletins are missing
     from ingest.raw_snapshots, fetch them from the runner (~10 min/day ≈ 300 min/mo, free)

Owner's Mac                                                 (dev + backfill, $0)
  └─ same worker binary, --backfill mode, throttled, off-peak
```

Why one box and not two for redundancy: a second VPS doubles cost for a failure mode (Hetzner
node death) that the DR fallback + freshness machine already degrade gracefully — readers see
DELAYED badges, the owner gets an incident, and the EOD record still lands via Actions. At this
budget, redundancy is the freshness state machine, not a second server. **DEFAULTED** — owner
may add a €3.79 twin later; the queue's `SKIP LOCKED` claiming already supports N workers with
zero code change.

Storage budget: quote-board snapshots only stored on change (~30 KB gz × ~180/day ≈ 6 MB/day);
filings PDFs dominate (~50–200/day × ~500 KB ≈ 1–3 GB/mo worst case). Supabase Pro includes
100 GB — multi-year runway. Retention: **filings/PDF/bulletin snapshots kept forever** (lineage +
ZATCA-grade auditability instincts); quote-board raw snapshots older than 24 months may be
compacted to their parsed rows + hash manifest — **DEFERRED**, revisit when storage passes 50 GB.

### 5.3 Failure of the primary runtime

If the VPS misses its worker heartbeat for 10 minutes (heartbeat row in `ingest.fetch_log` via a
`worker-alive` pseudo-source), the sweep flips all venues to RECONNECTING → DELAYED/OFFLINE per
§8 timings, raises a Desk needs-attention item, and (during the 20:00 UTC check) GitHub Actions
captures the EOD record. Recovery is `systemctl restart` or a fresh `setup-vps.sh` on a new box —
the fleet is stateless; all state is in Supabase.

---

## 6. Cost summary table

| Line item | Monthly | Notes |
|---|---|---|
| Supabase Pro | $25.00 (already paid — sunk; the "$10/mo" in the brief maps to no real Supabase SKU; the live org is verified on Pro) | DB 8 GB, Storage 100 GB, pg_cron |
| Hetzner CX22 + IPv4 | ~$4.90 — **requires explicit owner sign-off**: the one deviation from "existing Supabase + Vercel" (all cheaper alternatives cost more or fail the SLA, §5.1) | Entire scraper fleet, Playwright, PDF tooling |
| GitHub Actions | $0.00 | Deploy + ~300 min/mo DR fallback, inside 2,000 free |
| Vercel | $0 marginal | No ingestion code runs on Vercel |
| Proxies / scraping SaaS / vendor data | $0.00 | Deliberately none (§7 mitigations instead) |
| LLM in ingestion hot path | $0.00 | Deterministic parsers; LLM only in lake extraction via shared gateway |
| **Total incremental for this domain** | **≈ $4.90/mo** | |

---

## 7. Etiquette, robots, and legal posture

**Etiquette (enforced in `core/fetcher.ts`, not left to discipline):**

- Per-host token bucket ≤ 1 request/second, global concurrency ≤ 4; venue polls staggered so
  bursts cannot occur. Real budget: <120 req/day/host (§4.3).
- Identifying User-Agent: `MarsadBot/1.0 (+https://marsad.com/bot; data@marsad.com)` with a
  `/bot` page describing purpose, cadence, and contact. **DEFAULTED** — cheap goodwill; the
  alternative (browser-mimicking UA) is only used where a WAF blocks honest bots outright, and
  each such override is recorded in `ingest.sources.robots_status = 'override'` with owner
  sign-off. Honest by default, pragmatic by exception, always audited.
- `robots.txt` fetched and cached 24 h per host; a `Disallow` matching one of our paths flips
  the source to `robots_status = 'disallowed'` and pauses it pending owner review — pause is
  automatic, resumption is human.
- Conditional GET everywhere supported; `Retry-After` honored; automatic cadence-doubling on
  consecutive failures (§3.3) means a struggling site sees *less* traffic from us, not more.
- Backfills (§9) run overnight venue-local time, ≤ 0.5 req/s, from the owner's Mac.
- We never bypass logins, paywalls, CAPTCHAs-as-consent walls, or fetch anything not served to
  an anonymous public visitor. Playwright bootstrap only replicates what a human browser does to
  load a public page.

**Legal posture, per source class:**

- **Overall:** Marsad FZ-LLC (DIFC/DFSA) republishes *delayed, factual market data* (prices,
  volumes, corporate action facts, filing metadata) sourced from public exchange websites, with
  attribution and freshness labeling. Facts are not protected expression in the relevant
  jurisdictions' copyright regimes; the acknowledged risk is **contractual** (website terms of
  use) and **regulatory relationship** risk, not realistically copyright over a closing price.
- **Real-time redistribution is the bright line every exchange actually polices.** We are
  structurally incapable of crossing it: sources are already 15-min delayed, we poll at 10-min
  cadence, we store no tick data, and every quote surface carries the DELAYED badge. This is the
  core mitigation and it is a LOCKED product decision, not just a legal one.
- **Filings/disclosures:** issuer disclosures are regulatory publications meant for maximum
  dissemination; extracting facts and linking to source PDFs (we deep-link and store private
  lineage copies; the reader's "View PDF" points at the exchange where stable, our copy as
  fallback) is the industry norm (Argaam, Mubasher, Zawya all do this unlicensed for delayed
  data). **DEFAULTED:** serve our stored PDF copy when exchange links rot; owner may flip to
  link-only.
- **Per-venue sensitivity ranking:** TDWL highest (active commercial market-data business —
  keep etiquette pristine, be responsive to any contact, and treat a future modest EOD license
  as the first thing we'd ever pay for if approached); DFM/ADX moderate (data-friendly,
  API-shaped sites); QE/MSX/BHB low (thin sites, publish bulletins for exactly this purpose).
- **Takedown/contact protocol:** any communication from an exchange → immediate pause of that
  venue's affected sources via `active = false` (owner-level action, audited), respond within
  1 business day, negotiate. The per-venue kill switch in the agent roster (31a) is the same
  mechanism, so the capability is already surfaced in the Desk.
- **What we deliberately do NOT do:** no scraping of third-party aggregators' *value-added*
  content (Argaam articles, analyst estimates from brokers), no consensus-estimates scraping
  (design open question #10 — consensus is a licensed dataset everywhere; v1 ships
  Marsad-internal estimates only, **DEFAULTED**), no mobile-app API abuse where the web page
  suffices.

---

## 8. Failure detection → the freshness state machine

Two loops produce the states screen 33a and every reader FreshnessBadge consume.

**Loop A — per-fetch signals (worker).** Every job outcome updates `ingest.sources`
(`last_success_at`, `consecutive_failures`) and writes `ingest.fetch_log`. Error taxonomy:
`NETWORK` (timeout/reset), `HTTP_5XX`, `HTTP_4XX` (endpoint moved), `WAF_CHALLENGE` (triggers
bootstrap refresh, one free immediate retry), `PARSE_DRIFT` (fetch OK, parse emitted zero rows or
zod-failed on a *changed* snapshot — the "site redesigned under us" detector). `PARSE_DRIFT` and
`HTTP_4XX` skip retries and go straight to the agent error queue (27a) as quality errors — a
human or a code fix is needed, and confidence-style auto-retry would just hammer the site.

**Loop B — the sweep (`ingest.sweep_feed_status()`, pg_cron, every minute).** Pure SQL over
`ingest.sources` + calendar; writes `market.feed_status`. During a venue's session, for its
quotes source with cadence C (10 min):

| Condition | Venue state | Reader rendering |
|---|---|---|
| last success ≤ 1.5×C (15 min) | `live` | Normal `DELAYED · 15-MIN` badge (pipeline healthy; "live" tier = our freshest delayed data, per LOCKED decision) |
| 1.5×C – 3×C (15–30 min) | `reconnecting` | Amber `RETRYING · LAST SYNC hh:mm` (amber = degraded-not-broken; never red, per color law) |
| > 3×C (30 min) | `delayed` | `DELAYED · SYNCED hh:mm` with stale timestamp — matches the 1e "MSX DELAYED · SYNCED 14:26" specimen |
| > 45 min | `offline` | `OFFLINE · LAST hh:mm`; Desk needs-attention item auto-created; incident banner composer pre-filled (33a); banner auto-expires on recovery |

(Post-review: the former "≥ 6 consecutive failures" clause was dead logic — at 10-min cadence
the 45-min clock always fires first; it is dropped. If cadence is ever tightened below 7 min,
reintroduce a failure-count clause explicitly.)

Outside sessions the sweep itself writes `state = 'closed'` from the calendar (the state is now
part of the machine, not an implied default), surfaced as the market-closed treatment
(16c/m4f); the sweep additionally guards the filings poller, whose failure past 30 min raises
a Desk item without touching quote badges.

**Ticker-level states** are parse outputs, not fetch outputs: exchanges mark suspended
securities on the board (⇒ `HALTED`, suppress change %, auto-draft a halt wire for the newsroom
— halt alerts bypass quiet hours per platform rules); `AUCTION` is derived from the session
clock (pre-open/close windows) plus indicative-price fields where the venue publishes them;
a ticker absent from a fresh board snapshot goes `STALE` (dim, suppress chg+score). These land
on the lake's instrument-state table — this domain emits the facts, the lake owns the object.

**Escalation to humans:** state transitions to `offline`, any `PARSE_DRIFT`, and
`robots_status` flips notify the owner (email + Desk queue). Recovery is automatic on next
success — states flip back, incident banners expire, no human action needed (matching the
MSX-incident choreography in the design fixture: retry 4, fallback cadence, auto-recovery).

---

## 9. Historical backfill

Backfill is a one-time, owner's-Mac, off-peak workload (`worker.ts --backfill`), writing through
the identical snapshot-first pipeline (so historical objects have lineage too). Realistic depth
per venue, in priority order:

**Prices (daily OHLCV) — target 10 years where free, minimum 5:**

| Venue | Method | Realistic depth |
|---|---|---|
| TDWL | Per-company chart XHR (multi-year daily series JSON, one request per ticker ≈ 230 requests) + market-report XLSX archive for validation | 10y+ |
| DFM / ADX | Per-security price-history API + daily report archive | 10y |
| QE | Daily bulletin archive + per-company history where exposed | 5–10y |
| MSX | Bulletin archive (MSM-era included) | 5–10y, some gaps around the MSM→MSX rebrand |
| BHB | Daily bulletin XLSX archive — the easiest of all | 10y+ |

**DEFAULTED policy:** store unadjusted closes plus a corporate-actions event table; compute
adjusted series server-side at read time. Scraped "adjusted" histories mix conventions across
venues; unadjusted + events is the only reproducible ground truth.

**Filings archives — target 2018→present (matches the advertised AI corpus "filings since
2018"):** TDWL and DFM archives comfortably reach 2018 and beyond; ADX and QE reach it with
patience; MSX is the weak link (EN coverage thins pre-2020 — accept gaps, record coverage stats
so the lake's coverage board (29a) shows honest numbers). Volume estimate: low tens of thousands
of PDFs, ~10–20 GB — within storage budget; throttled to ~4 weeks of overnight runs.

**Financials — target 8 quarters + 10 annual years (the 3b display contract):** structured
history from TDWL statement pages directly; other venues assembled from FS filings in the
backfilled archive by the lake's extraction service (the one LLM-assisted consumer). Pre-2018
annuals from annual-report PDFs are **best-effort, DEFERRED** — bounded by extraction cost, not
scraping.

**Dividends history — target 10 years:** TDWL corporate-actions pages are comprehensive;
DFM/ADX good; QE/MSX/BHB reconstructed from announcement archives + bulletin ex-date markers.
Needed for the "raises-5y" screener field and yield history.

**Explicitly deferred backfills:** intraday/minute bars (unobtainable retroactively without a
vendor — the 1-min debut chart (22c) is captured *live* on listing days by a temporary
high-frequency schedule row, 1-min cadence for that ticker's debut session only); historical
ownership/FOL snapshots (only current state is published; our own time series starts at launch);
historical index constituent weights (start accumulating at launch).

---

## 10. Dedup, change detection, and the lake handoff

**Layer 1 — body hash (every source):** normalized sha256 vs `last_content_hash`; unchanged ⇒
heartbeat only, no storage, no parse. During closed hours this reduces the fleet to a trickle of
tiny fetch-log rows.

**Layer 2 — list diffing (item feeds):** filings lists and IPO news parse to `external_id` sets
and diff against `ingest.seen_items`. Only genuinely new items enqueue detail fetches; re-listed
or edited items (same ID, changed content hash on the detail page) parse as **revisions**, which
is what lets the lake represent the stc DPS 0.50→0.55 correction as a revision pair rather than
a duplicate object.

**Layer 3 — semantic dedup is the lake's job, not ours.** The same dividend arrives from a
disclosure PDF, a corporate-actions page, and an EOD bulletin: ingestion emits all three typed
rows to `lake.staging_*` tables, each carrying `(venue, source_id, snapshot_id, external_id,
extracted_at)`. The lake's cross-check service merges them into one `DIVIDEND.EXDATE` object
(state PENDING → VERIFIED on 2-source agreement, → CONFLICT on disagreement, primary source wins
unless overridden — exactly the 29a contract). **Handoff boundary: this domain guarantees typed,
lineage-bearing, at-least-once staging rows with stable external IDs; everything from
cross-check to VERIFIED is the Data Lake domain.** Staging inserts are idempotent on
`(source_id, external_id, content_hash)` so retried jobs cannot double-emit.

**Parser replay:** because parse is pure and snapshots are immutable, bumping
`TaskSpec.parserVersion` makes old snapshots re-parse-eligible; a maintenance command
(`worker.ts --replay --source=… --since=…`) re-emits staging rows, and lake-side idempotency +
revision pairs absorb the outcome. This is the recovery story for every "we parsed it wrong for
three weeks" incident, and the reason snapshot-first is non-negotiable.

---

## 11. DEFAULTED decisions (owner may override) — consolidated

1. Quote cadence 10 min all venues (tighten TDWL to 5 min at ~2× TDWL request cost).
2. Honest bot UA + `/bot` page, with audited browser-UA override per WAF-blocked source.
3. Single VPS, no hot standby; DR = freshness degradation + GitHub Actions EOD fallback.
4. Serve stored filing PDFs when exchange links rot (vs link-only).
5. Unadjusted prices + corporate-action events; adjustment computed at read time.
6. No consensus-estimates scraping; v1 estimates are Marsad-internal (open question #10).
7. Filings backfill horizon 2018; MSX gaps accepted and surfaced on the coverage board.
8. Quote-snapshot compaction after 24 months (deferred until storage > 50 GB).
9. Boursa Kuwait excluded from v1 fleet despite reader copy (open question #6).

## 12. Deliberately deferred (cheapest-possible casualties, with triggers to revisit)

- **Second worker / proxy pool** — revisit on first sustained IP block (route the affected venue
  via GitHub Actions runners as the free interim fix).
- **Regulator-direct sources** (CMA `cma.org.sa`, UAE SCA, QFMA) — exchange sites carry the same
  disclosures; add only if a coverage gap is demonstrated.
- **Concall audio ingestion** — no exchange publishes it; transcripts/audio come from issuer IR
  pages, a per-issuer long tail. The T+40-min transcript SLA is **not deliverable** for issuers
  who don't post promptly; ship with "coverage where available" honesty.
- **Realtime anything** — WebSocket sniffing of exchange sites is technically feasible on some
  venues and is deliberately, permanently out: it is the one thing that converts our posture
  from "polite delayed aggregator" to "unlicensed redistributor".
- **Pre-2018 filings, pre-2018 structured financials, historical ownership series** — §9.
- **Arabic ingestion** — LOCKED out for now; snapshot store and `seen_items` are
  language-agnostic, so AR arrives later as new parser versions, not new plumbing.

---

## Revisions (post-review)

Adversarial review found six blocking issues and several improvements. All are resolved; where
the reviewer was right the fix is applied above or stated here as binding.

1. **Auth mechanism rewritten (§3.1).** The reviewer was right: a per-agent-scoped
   service-role key is not a thing. The worker now connects as a dedicated `marsad_worker`
   Postgres role (Supavisor session pooler; also what `FOR UPDATE SKIP LOCKED` claiming needs),
   with zero grants on `billing.*`; agent identity is per-task GUC attribution + kill-switch
   checks. Storage uploads keep the service key as a documented, bucket-write-only exception.
2. **Request budget recomputed (§4.3).** Reviewer right; true total ≈ 1,450–1,650 req/day,
   ~220–280/day on the busiest host. Etiquette argument updated to cite honest numbers.
3. **WAF fetch fingerprinting (§2/§4.2) — accepted.** Incapsula binds cookies to the TLS/JA3
   fingerprint; replaying them through undici's Node TLS stack invites re-challenges. Binding
   fix: for sources with `transport = 'http_bootstrap'`, steady-state fetches are issued
   through the **persistent Playwright request context** (`context.request.get(...)` —
   Chromium's network stack, same fingerprint that earned the cookies, no page render). The
   CX22 is sized for one persistent browser context (~300 MB); undici remains for QE/BHB and
   any venue that proves unchallenged. The 6 h preemptive refresh cadence stays as backstop.
4. **CLOSED state (§3.4/§8) — accepted.** `closed` is now an explicit state written by the
   sweep from the calendar; the canonical table is `public.venue_feed_status` (02 owns the
   DDL). No venue can render OFFLINE overnight.
5. **NULL external_id idempotency (§3.4/§10) — accepted.** Unique index now
   `NULLS NOT DISTINCT` (PG17 confirmed live); inserts are `ON CONFLICT DO NOTHING`, which also
   defines the A→B→A flip behavior (silent conflict + heartbeat, no duplicate emission).
6. **Scheduler state (§4.1) — accepted.** `ingest.schedules.last_enqueued_at` added; the
   spec is now implementable without inventing state.

Improvements adopted:

- **GitHub Actions EOD DR honestly scoped (§5.2/§5.3):** the fallback is *reliable* for
  QE/MSX/BHB (plain HTTP); for the Imperva-fronted venues (TDWL/DFM/ADX) the workflow runs full
  Playwright and is **best-effort** — Azure runner IPs are challenged far more aggressively
  than our stable Hetzner IP. The real DR for WAF venues is VPS rebuild (~10 min via
  setup-vps.sh); the freshness machine communicates the gap honestly meanwhile.
- **TDWL first poll moved to 06:20 UTC** so the 09:30–10:00 AST opening auction (06:30 UTC) is
  inside the −10 min grace window; concrete windows in §4.2 adjusted accordingly.
- **Sun–Thu framing softened (§1):** design-analysis line 496 already records staggered
  weekends; only its compliance summary says "Sun–Thu" flatly. The correction stands (DFM/ADX
  Mon–Fri since Jan 2022) without claiming the design got it wrong globally.
- **Vercel build hygiene (§3.1):** `ingestion/` is excluded from the Next.js/Vercel build via
  `.vercelignore` + turborepo ignore so Playwright's postinstall (Chromium download) never runs
  on Vercel build minutes.
- **Multi-item sources (§3.4):** `last_content_hash` is meaningful only for single-URL sources;
  `filing_detail`-class sources dedupe via `seen_items` + the snapshot unique index. Stated as
  a contract on `ingest.sources`.
- **Accepted owner-toil ledger (per the no-employees audit):** (a) PARSE_DRIFT / HTTP_4XX on
  six SPA portals will need a human devtools session roughly monthly — `ingest.sources` makes
  it a data fix, not a deploy, but a human still captures the new endpoint; (b) the VPS needs
  OS care — `setup-vps.sh` mandates unattended-upgrades and a disk-usage Healthchecks ping;
  (c) a robots.txt `Disallow` auto-pauses a source and **resumption is human** — the pause
  raises a Desk needs-attention item and an email so a broad robots change cannot silently
  halt a venue. All three are inherent to scrape-only-with-no-employees and are owned, not
  hidden.
- **Cost table** updated: Supabase Pro $25 (sunk, verified live), Hetzner flagged for explicit
  owner approval as the single deviation from "existing Supabase + Vercel".

Reviewer points **not** adopted: none rejected outright; the "6 consecutive failures" clause
was removed rather than documented as dominated (simpler machine).
