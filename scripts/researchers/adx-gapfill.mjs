#!/usr/bin/env node
/**
 * ADX financials BACKFILL — the document→extract half for Abu Dhabi Securities Exchange ($0 via the Claude
 * Code SUBSCRIPTION). ADX has NO XBRL, so unlike TDWL there is no free deterministic rank-10 path: every
 * financial-statement PDF is LLM-extracted at source_rank 20. First-writer-wins per (symbol × statement ×
 * period) via the downgrade guard; each PDF is extracted ONCE (exPara ownership marker in public.filings).
 *
 * DISCOVERY IS AN API, NOT AN SPA CLICK-THROUGH (this is why ADX is lighter than TDWL). Per symbol:
 *   1. Bootstrap: navigate www.adx.ae once → seats the Akamai/bpm WAF cookies on the browser context
 *      (fires www.adx.ae/api/bpm/get-cookie). See docs/architecture/adx-browser-bypass.md §1.
 *   2. GET apigateway.adx.ae/adx/tradings/1.1/news/category?categoryName=efid&symbol={SYM}&fromDate&toDate
 *      through the SAME context (ctx.request.get → TLS/JA3 + cookies match) with the §2 headers
 *      (adx-gateway-apikey + channel-id). Returns response.results[] — every financial disclosure in the
 *      window. Widen fromDate for full history — NO page-2 clicking, NO SPA render.
 *   3. Keep rows whose engFinancialType ∈ ADX_FIN_TYPES ('Financial Report' = the full IS/BS/CFS PDF).
 *   4. Download engUrl (apigateway.adx.ae/adx/cdn/1.0/content/download/{ID}) through the context → %PDF bytes.
 *   5. pdftotext -layout → `claude -p` (sonnet) → validate gate → persist FILING.FINANCIALS → the shared
 *      lake.fn_financial_statement_project trigger fans it into public.financial_statements.
 *
 * ADX needs NO metered proxy (datacenter Chromium loads www.adx.ae fine, unlike Akamai-hard-blocked TDWL),
 * and runs headless (no xvfb) by default — so it is far cheaper on bandwidth and RAM than the TDWL browser.
 *
 * Throttled: ADX_PDF_MAX new PDFs per run (subscription rate-limit budget). Chunked by symbol cursor.
 *   ACQUIRE_SYMBOLS=ALDAR,IHC  ADX_PDF_MAX=6  node adx-gapfill.mjs
 *   CHUNK_START=0 CHUNK_SIZE=6  node adx-gapfill.mjs
 *   LIST_SYMBOLS=1 node adx-gapfill.mjs           # print all listed ADX tickers (CSV) and exit
 */
import { spawnSync } from 'node:child_process';
import { upsertLakeObject } from './lib/lake-objects.mjs';
const ING = '/opt/marsad/ingestion';
const { chromium } = await import(`${ING}/node_modules/playwright/index.js`).then(m => m.default ?? m);
const { extractToStatements, EXTRACTION_SYSTEM, buildExtractionUserMessage } = await import(`${ING}/dist/lake/statement-extraction.js`);
const postgres = (await import('/opt/marsad/worker/node_modules/postgres/src/index.js').then(m => m.default ?? m));

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL, PROXY_SERVER, PROXY_USERNAME, PROXY_PASSWORD } = process.env;
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL }))
  if (!v) { console.error(`missing env ${k}`); process.exit(1); }
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'haiku';
const PDF_MAX = Number(process.env.ADX_PDF_MAX || 6); // new PDFs per run (rate-limit budget)
const HEADLESS = process.env.ADX_HEADLESS !== '0'; // ADX loads headless from the VPS (bypass doc §1); no xvfb needed
const USE_PROXY = process.env.ADX_USE_PROXY === '1' && !!PROXY_SERVER; // ADX does NOT need the metered proxy by default
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const mkSession = () => String(Date.now()).slice(-8) + Math.floor(Math.random() * 1e4);
function buildProxy(s) { const host = PROXY_SERVER.replace(/^https?:\/\//, ''); const user = /-session-/.test(PROXY_USERNAME) ? PROXY_USERNAME : `${PROXY_USERNAME}-lifetime-30-session-${s}`; return { server: `http://${host}`, username: user, password: PROXY_PASSWORD }; }

// ── ADX apigateway bypass (docs/architecture/adx-browser-bypass.md §2) ──
const SEED_URL = process.env.ADX_SEED_URL || 'https://www.adx.ae/en/all-equities'; // any ADX page seats the WAF cookies
const APIKEY = process.env.ADX_GATEWAY_APIKEY || '1863a94c-582b-46f9-b4f0-0d02c0cc5307'; // re-capture from the board XHR if it ever rotates
const JSON_HEADERS = { Accept: 'application/json', 'adx-gateway-apikey': APIKEY, 'channel-id': 'OSS WEB', referer: 'https://www.adx.ae/' };
const PDF_HEADERS = { Accept: 'application/pdf', 'adx-gateway-apikey': APIKEY, 'channel-id': 'OSS WEB', referer: 'https://www.adx.ae/' };
// Financial-disclosure feed. The `/news?categoryValue={SYM}&recordCount={N}` form returns the issuer's
// FULL history in ONE request with NO date-window cap (verified live 2026-07-16: ALDAR → 117 rows). The
// alternate `/news/category?...&fromDate&toDate` form 400s on a range over ~1yr ("Date range should not
// exceed …"), so it would force year-by-year paging — avoid it. Template env-overridable (a param rename
// is a config fix); the parser normalizes BOTH response shapes below so either template works.
const EFID_TMPL = process.env.ADX_EFID_TEMPLATE || 'https://apigateway.adx.ae/adx/tradings/1.1/news?categoryName=efid&categoryValue={SYM}&recordCount={N}';
const RECORD_COUNT = Number(process.env.ADX_RECORD_COUNT || 1000); // full history; ALDAR is 117
// Doc sub-type (the segment after 'Financial Reports | ') to route into statement extraction. 'Financial
// Report' = the full IS/BS/CFS PDF; press-release/governance/sustainability/preliminary excluded. Env-widen
// (e.g. add 'Integrated Report') if an issuer only files audited statements inside the annual report.
const FIN_TYPES = new Set((process.env.ADX_FIN_TYPES || 'Financial Report').split(',').map(s => s.trim()).filter(Boolean));
// Depth cap: 0 = full history. Else drop efid rows whose publishedDate year < ADX_MIN_YEAR. The recordCount
// feed returns full uncapped history, so the cap is applied client-side on publishedDate (a report published
// in year Y covers ~FY Y or Y-1) — e.g. ADX_MIN_YEAR=2022 keeps ~last 5 fiscal years, far fewer LLM calls.
const MIN_YEAR = Number(process.env.ADX_MIN_YEAR || 0);
const pubYear = (s) => Number(String(s || '').slice(0, 4)) || 0;
const mmddyyyy = (d) => `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
const FROM_DATE = process.env.ADX_FROM_DATE || mmddyyyy(new Date(Date.now() - 400 * 864e5)); // legacy dated form only
const TO_DATE = process.env.ADX_TO_DATE || mmddyyyy(new Date());
function efidUrl(sym) { return EFID_TMPL.replace('{SYM}', encodeURIComponent(sym)).replace('{N}', String(RECORD_COUNT)).replace('{FROM}', FROM_DATE).replace('{TO}', TO_DATE); }

// Naive ADX publishedDate ('YYYY-MM-DD HH:mm:ss.f', UTC+4, no DST) → ISO UTC (mirrors adapters/adx/filings.ts).
function adxPubToIso(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s || ''));
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m.map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi, se) - 4 * 3600e3).toISOString();
}

function extractViaClaude(buf) {
  const t = spawnSync('pdftotext', ['-layout', '-', '-'], { input: buf, maxBuffer: 30e6 });
  const full = t.stdout?.toString() || '';
  if (full.length < 400) return { error: 'no text layer' };
  const userMsg = buildExtractionUserMessage(full, 120000);
  const prompt = `${EXTRACTION_SYSTEM}\n\nThe filing text is on stdin. Return ONLY the JSON object of shape {"currency","scale","statements":[...]} — no prose, no code fences.`;
  const r = spawnSync('claude', ['-p', prompt, '--output-format', 'json', '--model', CLAUDE_MODEL], { input: userMsg, encoding: 'utf8', maxBuffer: 60e6, timeout: 240000 });
  if (r.error || r.status !== 0) return { error: `claude ${r.error?.code || r.status}` };
  let out = r.stdout || ''; try { const env = JSON.parse(out); if (typeof env.result === 'string') out = env.result; } catch { /* raw */ }
  const mm = out.match(/\{[\s\S]*\}/); if (!mm) return { error: 'no json' };
  let parsed; try { parsed = JSON.parse(mm[0]); } catch { return { error: 'bad json' }; }
  if (!Array.isArray(parsed.statements)) return { error: 'no statements' };
  return extractToStatements(parsed, 'ADX', '0');
}

async function uploadPdf(key, buf) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/filings/${key}`, { method: 'POST', headers: { authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'content-type': 'application/pdf', 'x-upsert': 'true' }, body: buf });
  return r.ok;
}

async function persist(sql, sym, statements, storageKey, sourceRef, title, filedIso) {
  const sec = await sql`select id from public.securities where venue_code='ADX' and ticker=${sym} limit 1`;
  if (!sec[0]) return 0;
  const secId = sec[0].id;
  const agent = await sql`select id from iam.principals where handle='SYSTEM' limit 1`;
  const pr = await sql`insert into lake.parse_runs (agent_id, parser_key, parser_version, status) values (${agent[0].id}, 'adx_fspdf_llm', '1', 'succeeded') returning id`;
  let n = 0;
  for (const p of statements.periods) {
    const nk = `FINANCIALS:ADX:${sym}:${p.statementType}:${p.fiscalPeriod}`;
    const live = await sql`select id, revision, state, source_rank from lake.objects where natural_key=${nk} and superseded_by is null limit 1`;
    // Downgrade guard: never replace an equal/better source. ADX is all rank 20 → first-writer-wins per
    // period (a later quarterly + the annual integrated report can both claim a FY; first extracted keeps it).
    if (live[0] && live[0].source_rank <= 20) continue;
    const payload = { statement_type: p.statementType, period_kind: p.periodKind, fiscal_period: p.fiscalPeriod, period_end: p.periodEnd, currency: p.currency, basis: 'consolidated', line_items: p.lineItems };
    await upsertLakeObject(sql, {
      naturalKey: nk, objectType: 'FILING.FINANCIALS', securityId: secId, venueCode: 'ADX',
      payload, parseRunId: pr[0].id, sourceRank: 20,
    });
    n++;
  }
  // Always record the filing (owned marker) keyed by exPara — even a 0-statement PDF — so it is not
  // re-downloaded + re-extracted (re-charging the subscription budget) on the next run.
  await sql`insert into public.filings (security_id, venue_code, source_ref, filing_type, title, filed_at, pdf_storage_key)
            values (${secId}, 'ADX', ${sourceRef}, 'RESULTS', ${(title || sourceRef).slice(0, 200)}, ${filedIso ?? sql`now()`}, ${storageKey})
            on conflict (venue_code, source_ref) do update set pdf_storage_key=excluded.pdf_storage_key`;
  return n;
}

// ── main ──
const t0 = Date.now();
const sql = postgres(SUPABASE_DB_URL, { max: 2, prepare: false });

if (process.env.LIST_SYMBOLS) {
  const rows = await sql`select ticker from public.securities where venue_code='ADX' and status='listed' order by ticker`;
  process.stdout.write(rows.map(r => r.ticker).join(','));
  await sql.end();
  process.exit(0);
}

let symbols;
if (process.env.ACQUIRE_SYMBOLS) symbols = process.env.ACQUIRE_SYMBOLS.split(',').map(s => s.trim()).filter(Boolean);
else { const start = Number(process.env.CHUNK_START || 0), size = Number(process.env.CHUNK_SIZE || 6); symbols = (await sql`select ticker from public.securities where venue_code='ADX' and status='listed' order by ticker offset ${start} limit ${size}`).map(r => r.ticker); }
// Owned = exPara filing ids we already stored (stable per-filing id) — the extract-once gate.
const owned = new Set((await sql`select source_ref from public.filings where venue_code='ADX' and pdf_storage_key like 'adx/%'`).map(r => r.source_ref));
log(`adx-gapfill — ${symbols.length} companies, ${owned.size} PDFs owned, ADX_PDF_MAX ${PDF_MAX}/run, recordCount ${RECORD_COUNT}, minYear ${MIN_YEAR || 'none'}, proxy=${USE_PROXY ? 'on' : 'OFF'}, headless=${HEADLESS}`);

let companies = 0, pdfNew = 0, rowsW = 0, budget = PDF_MAX;
for (let attempt = 0; attempt < 3 && budget > 0; attempt++) {
  const session = mkSession();
  const launchOpts = { headless: HEADLESS, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'] };
  if (USE_PROXY) launchOpts.proxy = buildProxy(session);
  const browser = await chromium.launch(launchOpts);
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', timezoneId: 'Asia/Dubai', viewport: { width: 1366, height: 900 } });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); window.chrome = { runtime: {} }; });
  const page = await ctx.newPage();
  // Seat the WAF cookies once; the request-context reuses them for every apigateway call below.
  const seat = async () => { try { await page.goto(SEED_URL, { waitUntil: 'commit', timeout: 45000 }); await page.waitForTimeout(6000); return true; } catch { return false; } };
  // Fetch JSON/PDF through the cookie-seated context. One free re-seat on a WAF challenge (401/403).
  const ctxGet = async (url, headers, reseated = false) => {
    const resp = await ctx.request.get(url, { headers, timeout: 60000 }).catch(() => null);
    if (resp && (resp.status() === 401 || resp.status() === 403) && !reseated) { if (await seat()) return ctxGet(url, headers, true); }
    return resp;
  };
  try {
    if (!await seat()) { log(`  seat failed — rotating (${attempt + 1}/3)`); await browser.close(); continue; }
    for (const sym of symbols.slice(companies)) {
      if (budget <= 0) break;
      try {
        const resp = await ctxGet(efidUrl(sym), JSON_HEADERS);
        if (!resp || !resp.ok()) { log(`  ${sym} efid ${resp ? resp.status() : 'no-resp'} — rotating`); break; }
        let doc; try { doc = await resp.json(); } catch { log(`  ${sym} efid bad json`); companies++; continue; }
        const rows = doc?.response?.results ?? doc?.response?.news ?? [];
        // Normalize the two efid shapes: /news → news[] (`urlEn`, `subCategoryNameEn`='Financial Reports |
        // Financial Report'); /news/category → results[] (`engUrl`, `engFinancialType`='Financial Report').
        // Doc sub-type = the segment after '|'. Keep only FIN_TYPES; press releases etc. excluded.
        const norm = rows
          .filter(r => r && typeof r === 'object')
          .map(r => ({
            exPara: r.exPara,
            pdfUrl: r.engUrl || r.urlEn,
            docType: (r.engFinancialType || String(r.subCategoryNameEn || '').split('|').pop() || '').trim(),
            title: r.simpleTitleEn || r.titleEn || r.title || r.exPara,
            publishedDate: r.publishedDate,
          }));
        const reports = norm.filter(r => FIN_TYPES.has(r.docType) && r.pdfUrl && r.exPara && (!MIN_YEAR || pubYear(r.publishedDate) >= MIN_YEAR));
        const fresh = reports.filter(r => !owned.has(r.exPara));
        log(`  ${sym}: ${rows.length} disclosures, ${reports.length} statement PDFs${MIN_YEAR ? ` (≥${MIN_YEAR})` : ''}, ${fresh.length} new`);
        for (const r of fresh) {
          if (budget <= 0) break;
          const exPara = r.exPara;
          const got = await ctxGet(r.pdfUrl, PDF_HEADERS);
          if (!got || !got.ok()) { log(`    ${exPara} pdf ${got ? got.status() : 'no-resp'}`); continue; }
          const buf = Buffer.from(await got.body());
          if (buf.slice(0, 5).toString() !== '%PDF-') { log(`    ${exPara} not a pdf`); continue; }
          const ex = extractViaClaude(buf);
          budget--;
          if (ex.error) { log(`    ${exPara} extract: ${ex.error}`); continue; } // transient — retry next run
          const key = `adx/${sym}/${exPara}.pdf`;
          await uploadPdf(key, buf);
          const nrows = await persist(sql, sym, ex.statements, key, exPara, r.title, adxPubToIso(r.publishedDate));
          owned.add(exPara); pdfNew++; rowsW += nrows;
          log(`    ${nrows ? '✓' : '·'} ${exPara} → ${ex.statements.periods.length}p → ${nrows} new rows (budget ${budget})`);
          await page.waitForTimeout(1200); // polite ≤1 req/s to the apigateway host
        }
        companies++;
      } catch (e) { log(`  ${sym} err ${String(e).slice(0, 70)}`); companies++; }
    }
    await browser.close();
    if (companies >= symbols.length) break;
  } catch (e) { log(`  adx-gapfill err ${String(e).slice(0, 80)} — rotating`); try { await browser.close(); } catch { /* */ } }
}
await sql.end();
log(`DONE ${(Date.now() - t0) / 1000 | 0}s | companies ${companies}/${symbols.length} | new PDFs ${pdfNew} | rows ${rowsW} | budget left ${budget}`);
