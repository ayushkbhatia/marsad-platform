# ADX browser WAF-bypass — recipe & handoff

**Purpose.** Source ADX (Abu Dhabi Securities Exchange) data — quotes, filings, financial statements —
directly from ADX's own apigateway, bypassing its Akamai/CDN WAF. This is the concrete, proven recipe;
a fresh session can execute the remaining work (filings linking, financials) from this doc alone.

Status (2026-07-16): **quotes DONE + live**; **filings PARTIAL** (general news feed works, per-security
linking TODO); **financials DONE + smoke-validated live** — the document→extract backfill is built
(`scripts/researchers/adx-gapfill.mjs` + `adx-oneshot.sh` + `adx-gapfill-cron.sh` +
`systemd/marsad-adx-gapfill.{service,timer}`) and **deployed to `marsad-worker-1`**; the ALDAR smoke test
landed 6 real rows in `public.financial_statements` (§5). Remaining: run the full-universe one-shot + enable
the timer. Same bypass covers all three.

---

## 1. The bypass (why it works)

ADX blocks plain HTTP: `curl`/`undici` → **403** (an Akamai HTML challenge page), even through a
residential UAE proxy. But a **real headless Chromium loads `www.adx.ae` fine from the datacenter VPS**
(NAV 200, real page) — unlike TDWL, whose Akamai reputation-blocks even the VPS browser (→ TDWL uses
Mubasher). The mechanism:

1. Navigate `https://www.adx.ae/english/pages/marketinformation/marketwatch.aspx` in Chromium.
2. The page runs `www.adx.ae/api/bpm/get-cookie` + `set-cookie` → seats the Akamai/bpm WAF cookies.
3. Fetch `apigateway.adx.ae/...` **through the same browser context** (`context.request.get`, so
   TLS/JA3 + cookies match) **with the headers the page's own XHR sends** → **200**.

**So: probe ADX with the browser, never curl.** curl 403s because it has no bpm cookies + wrong JA3.

## 2. Required request headers (captured live from the board XHR)

The apigateway checks these on every call — cookies alone aren't enough:

| Header | Value |
|---|---|
| `adx-gateway-apikey` | `1863a94c-582b-46f9-b4f0-0d02c0cc5307` — **note the header NAME**; the venue's own site uses `adx-gateway-apikey`, not `apikey` (a plain `apikey:` probe 403s) |
| `channel-id` | `OSS WEB` |
| `referer` | `https://www.adx.ae/` |
| `Accept` | `application/json` |

(The apikey has been stable since the P1 filings work; if it ever rotates, re-capture it from the board
XHR request headers — see §6.)

## 3. Known endpoints (all 200 via the browser context + headers)

| Data | Path (base `https://apigateway.adx.ae`) | Shape |
|---|---|---|
| **Full market board (quotes)** | `/adx/marketwatch/1.1/securityBoards/mainMarket` | `response.results[]`, 90 rows: `companySymbol,last,previousClose,changePrice`(abs Δ)`,change`(Δ %)`,open,high,low,volume,bid,ask,value,trades,marketCap,tradingState`; **no per-row timestamp** |
| **FTSE index** | `/adx/marketwatch/1.1/FTSEIndex` | index level |
| **News / disclosures (general)** | `/adx/tradings/1.1/news` (opt `?categoryName=cd&recordCount=N`) | `response.news[]`: `exPara`(id)`,titleEn,publishedDate,urlEn`(PDF)`,categoryNameEn,entity`(issuer symbol) |
| **Company profile** | `/adx/marketwatch/1.1/listedCompanyProfileData/{SYMBOL}` | `response.companyProfileData{...}` (ID, symbol, logo, profile fields — inspect for key figures) |
| **Security overview** | `/adx/marketwatch-delayed/1.1/securityOverview/{SYMBOL}` | delayed per-security snapshot |
| **Recent trades** | `/adx/marketwatch/1.1/recentTrades/{SYMBOL}` | tape |
| **PDF / content** | `/adx/cdn/1.0/content/download/{ID}` | the filing PDF bytes (id from `urlEn`) |
| **Financials (key figures)** | `/adx/listed-companies/1.1/balance-sheet/data?symbol={SYM}&startYear={Y}&endYear={Y}` | `response.data[]` (per year/quarter): `netProfit,shareCapital,totalEquity,earningsPerShare,priceToBookValue,financialYear,financialQuarter` |
| **Filings — per company** | ✅ **use** `/adx/tradings/1.1/news?categoryName={efid\|cdc}&categoryValue={SYM}&recordCount={N}` → rows under **`response.news[]`** — returns the issuer's **FULL history uncapped in ONE request** (verified live 2026-07-16: ALDAR → 117 rows, `recordCount=1000`). Each row: `entity`(symbol)`,titleEn/simpleTitleEn,urlEn`(PDF)`,subCategoryNameEn`(**doc type**, e.g. `Financial Reports \| Financial Report` — the segment after `\|` is the sub-type)`,publishedDate,exPara`(id)`,aiJsonDataEn`(pre-extracted mini table — numeric cross-check bonus). ⚠️ The alternate `/news/category?…&fromDate&toDate` (→ `response.results[]`, fields `engUrl`/`engFinancialType`) **400s on a range over ~1 yr** (`"Date range should not exceed …"`), forcing year-paging — avoid it. `adx-gapfill.mjs` reads **either** shape. `efid`=financial disclosures, `cdc`=corporate disclosures. |
| **Board + management** | `/adx/listed-companies/1.1/board-members/{SYM}` | `response.results[]`: `symbolCode,nameEnglish,nameArabic,englishJobTitle,arabicJobTitle,jobTitleOrder` → `public.company_people` |
| **Major shareholders** | `/adx/marketwatch/1.1/listedCompanyShareholderInfo/{SYM}` | `response.results[]`: `name,listedCompanyID,id,percentage` → ownership |

`{SYMBOL}`/`{SYM}` = our `securities.ticker` for ADX (alpha, e.g. `IHC`, `2POINTZERO`, `ADIB`).

**Discovered via the company-profile tabs (2026-07-15)** — the Financial/Assembly/Shareholder tabs on
`www.adx.ae/en/main-market/company-profile/overview?symbols={SYM}&secCode={SYM}` fire these. `income-
statement/data` + `cash-flow/data` under `/adx/listed-companies/1.1/` **404'd** (wrong slug or ADX only
exposes the balance-sheet/data summary, which already carries netProfit/EPS/equity) — capture the exact
Income/Cash-flow sub-tab XHR if the full 3-statement is needed. Issuers list (all ADX tickers) at
`www.adx.ae/issuers/issuers-information/issuers-directory` (our `securities` master already has them).

## 4. Adapter pattern (the reference impl = ADX quotes, now working)

Two moving parts, both config-driven so a field/endpoint change is a data edit, not a deploy:

- **Adapter** (`ingestion/src/adapters/adx/quotes.ts`, mirror for filings/financials): `bootstrap`
  seats cookies, then fetch a **pinned `endpoint_config.urlTemplate`** via `browser.get` — prefer the
  urlTemplate over the flaky `network_capture` (the board XHR fires seconds after the cookie flow, so
  pattern-capture is unreliable → "action discovery found no URL"). Same shape as
  `adapters/adx/filings.ts::fetchAdxFilingsList` (`cfg.urlTemplate ?? boot.resolvedUrl`).
- **Source config** (`ingest.sources.endpoint_config`): `actionDiscovery.extract='direct'` (bootstrap
  just seats cookies, no capture) + `actionDiscovery.navigateUrl` (the marketwatch page) + `urlTemplate`
  (the apigateway feed) + `headers` (§2) + a `fieldMap` for the response shape. Migrations 0043 (repoint)
  + 0044 (headers) did this for quotes.

**Gotcha — timestamp fallback (fixed 2026-07-15):** the board has no per-row `asOf`, so
`runtime.ts::mapQuote` falls back to the snapshot fetch time (`q.asOf || snapshotExtractedAtIso`) for
both `extractedAt` and the natural-key session. Any timestamp-less feed needs this — already handled.

## 5. Remaining work — the DOCUMENT pipeline (the fresh-chat plan)

**The deliverable is the PDFs + extracted data, not just the raw JSON figures.** For every tracked ADX
security (~93, `securities` where `venue_code='ADX' and status='listed'`) we want the **financial-
statement PDFs, annual/integrated report PDFs, and all filing PDFs stored, then data extracted from
them** — exactly the Tadawul model (see memory `marsad-financials-sourcing`: the proprietary Tadawul
scraper stores PDFs and extracts full Income Statement + Balance Sheet + Cash-Flow, proven on SABIC).
**Reuse that Tadawul document→extract pipeline for ADX; do not rebuild it.** The raw JSON endpoints in §3
(balance-sheet/data, shareholderInfo, board-members) are a *supplementary cross-check / structured
bonus*, NOT the primary source.

### The pipeline (all steps PROVEN reachable via the browser bypass, 2026-07-15)
1. **Per-company filing list** — `GET /adx/tradings/1.1/news?categoryName={efid|cdc}&categoryValue={SYM}
   &recordCount={N}` (paginate/date-range for full history). Each `response.news[]` row →
   `entity`(symbol), `titleEn`, `publishedDate`, **`subCategoryNameEn`** (the document TYPE), `urlEn`
   (the PDF), `exPara` (stable filing id for dedupe). Do this for both `efid` (financial disclosures) and
   `cdc` (corporate disclosures) per symbol. Link to `securities` via `entity` (= our ticker).
2. **Document-type routing** via `subCategoryNameEn`: e.g. **"Financial Report"** (quarterly financial
   statements), **"Integrated Report"** (annual report), **"Corporate Governance Report"**, etc. —
   route the financial-statement + annual-report PDFs into the statement-extraction path; keep the rest
   as filing refs.
3. **Download the PDF** — `urlEn` = `https://apigateway.adx.ae/adx/cdn/1.0/content/download/{ID}`. Fetch
   it **through the cookie-seated browser context** with the §2 headers (`ctx.request.get`). Verified:
   200, `content-type: application/pdf`, ~2 MB, `%PDF-` magic. curl 403s — must be the browser context.
4. **Store** the raw PDF bytes to the filings-PDF store (the same raw-snapshot / `filings-pdf` storage
   TDWL uses), keyed by `exPara`, snapshot-first + dedup.
5. **Extract** — run the stored PDF through the SHARED Tadawul extraction pipeline (PDF→text→structured
   IS/BS/CFS + `extracted_facts` + `ai_summary`). Wire into `public.financial_statements` / `key_ratios`
   / `filings.full_text` — the lake targets already exist (P1.7b `statement-normalizer.ts` +
   `normalizeViaLlm` seam; see deferred `DEF-FILING-FACTS`, `DEF-STMT-LLM-PDF`). This is the same code as
   Tadawul — point it at the ADX PDFs.

### Build order
- **A.** ADX filings adapter: per-company `efid`+`cdc` news lists → `NormalizedFilingRef` (link via
  `entity`), then the filing-detail step downloads + stores each `urlEn` PDF (mirror TDWL's list→detail
  filings flow; ADX quotes/filings adapters are the browser-context reference). Also fixes the current
  gap: `public.filings` has 45 ADX rows but 0 linked (`security_id` null) because the general news feed
  had no `entity` link wired.
- **B.** PDF-extraction wiring — **DONE-IN-CODE** (`scripts/researchers/adx-gapfill.mjs`). Bootstraps
  cookies once, loops symbols, GETs the `efid` feed, filters `engFinancialType='Financial Report'`,
  downloads `engUrl` PDFs through the context, and runs them through the SHARED Tadawul extractor
  (`dist/lake/statement-extraction.js` → `extractToStatements(parsed,'ADX','0')`) → `FILING.FINANCIALS`
  (rank 20) → `lake.fn_financial_statement_project` → `public.financial_statements`. Extract-once via the
  `exPara` owned marker in `public.filings`; re-bootstraps only on a 401/403.
- **C.** Backfill all listed ADX securities — **DONE-IN-CODE** (`adx-oneshot.sh`, DB-enumerated universe,
  full-history depth) + steady-state cadence (`adx-gapfill-cron.sh` + `marsad-adx-gapfill.timer`, 6h,
  reporting-window-gated). **Heeds the worker-agent safeguards** (memory `marsad-worker-agent-safeguards`):
  chunked by symbol cursor, `ADX_PDF_MAX` LLM budget/run, one bootstrap serves many companies, `MemoryHigh`
  cap. NOTE — lighter than TDWL: **no metered proxy** (datacenter Chromium loads ADX fine) and **no xvfb**
  (headless), so only the ~1-3 MB statement PDFs transit, direct + unmetered.

### Open items (first VPS run)
**Smoke test PASSED live 2026-07-16** (`ACQUIRE_SYMBOLS=ALDAR ADX_PDF_MAX=1` on `marsad-worker-1`): efid 200 →
117 disclosures / 47 statement PDFs → 1 downloaded + extracted → **6 rows** into `public.financial_statements`
(IS/BS/CFS Q1 2026 + comparatives, AED). Revenue 8.734B + EPS 0.254 reconcile exactly to ADX's own figures;
`net_income` = profit attributable-to-parent (EPS-consistent), not the NCI-inclusive headline. Status of the items:
1. ~~**WAF from VPS IP**~~ ✅ **resolved** — cookie-seat + apikey GET passes Cloudflare from the datacenter IP, **no proxy** (`ADX_USE_PROXY` off).
2. ~~**efid depth/cap**~~ ✅ **resolved** — the `/news?categoryValue={SYM}&recordCount={N}` form returns full history uncapped in ONE request (ALDAR 117 rows). (The dated `/news/category` form 400s past ~1 yr — not used.)
3. **apikey lifetime** — worked today; monitor. If `adx-gateway-apikey` ever rotates, re-capture from the board XHR (§6) and set `ADX_GATEWAY_APIKEY`.
4. **doc-type coverage (banks/insurers)** — validated on ALDAR (real estate). Confirm `subCategoryNameEn` sub-type `Financial Report` is the full-statement PDF for bank/insurer filers too; widen `ADX_FIN_TYPES` (e.g. `+Integrated Report`) if any issuer only files audited statements inside the annual report. (Will surface in the one-shot run.)

**Next:** run `adx-oneshot.sh` (full universe, `systemd-run`) then enable `marsad-adx-gapfill.timer` for steady-state.

### Supplementary structured JSON (bonus, same bypass)
`board-members/{SYM}` → `public.company_people` (board + management); `listedCompanyShareholderInfo/{SYM}`
→ ownership; `balance-sheet/data` → numeric key figures. Nice-to-have alongside the PDFs, not instead.

## 6. Reusable discovery snippet (run on the VPS)

The VPS has Playwright + Chromium at `/opt/marsad/.playwright`; `playwright` is in
`/opt/marsad/ingestion/node_modules` (NOT pruned). Write the script **into the ingestion dir** (module
resolution) and run it. This captures the apigateway XHRs a page fires (find endpoints) and can dump
response shapes (build the fieldMap):

```bash
ssh deploy@91.99.99.85    # key: the deploy key; sudo NOPASSWD
cd /opt/marsad/ingestion
cat > /opt/marsad/ingestion/probe.mjs <<'JS'
import { chromium } from 'playwright';
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const b=await chromium.launch({headless:true,args:['--no-sandbox','--disable-blink-features=AutomationControlled']});
const ctx=await b.newContext({userAgent:UA,locale:'en-US'});
const page=await ctx.newPage();
const seen=new Map();
page.on('response', r=>{ const u=r.url(); if(/apigateway\.adx\.ae/i.test(u)){ const k=u.split('?')[0]; if(!seen.has(k)) seen.set(k, r.status()); } });
// to capture REQUEST headers of a specific XHR: page.on('request', r=>{ if(/PATTERN/.test(r.url())) console.log(r.headers()); });
for (const u of [
  'https://www.adx.ae/en/main-market/company-profile/overview?symbols=IHC&secCode=IHC',
  // add the Financials / Disclosures tab URLs here once you find their routes
]) { try { await page.goto(u,{waitUntil:'domcontentloaded',timeout:35000}); await page.waitForTimeout(7000); } catch {} }
for (const [k,v] of seen) console.log(v+'  '+k.replace('https://apigateway.adx.ae',''));
// direct probe with headers (after cookies are seated on this ctx):
const H={Accept:'application/json','adx-gateway-apikey':'1863a94c-582b-46f9-b4f0-0d02c0cc5307','channel-id':'OSS WEB',referer:'https://www.adx.ae/'};
// const res=await ctx.request.get('https://apigateway.adx.ae/PATH',{headers:H}); console.log(res.status(), (await res.text()).slice(0,400));
await b.close();
JS
PLAYWRIGHT_BROWSERS_PATH=/opt/marsad/.playwright node /opt/marsad/ingestion/probe.mjs
rm -f /opt/marsad/ingestion/probe.mjs
```

## 7. References
- Working impl: `ingestion/src/adapters/adx/{quotes,filings}.ts`, `core/browser.ts` (`bootstrap`,
  `extract:'direct'`), migrations `0043`/`0044`.
- Memory: `marsad-vps` (full ADX bypass details), `marsad-price-history-sourcing`,
  `marsad-worker-agent-safeguards` (chunk/lane rules for the backfill).
- Contrast: TDWL is Akamai-hard-blocked even via the VPS browser → uses Mubasher (`tdwl/quotes.ts`
  header). ADX is softer → use ADX directly.
