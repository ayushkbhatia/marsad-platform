#!/usr/bin/env node
/**
 * Tadawul financials RESEARCHER (productionized, $0 XBRL-first). For each company: construct the profile
 * URL (fixed WebSphere token + ?companySymbol=), click "Financial Statements and Reports", scrape the
 * XBRL_DOCS list, then for each NOT-yet-owned XBRL: in-page fetch → parseTadawulXbrl → validation gate →
 * FILING.FINANCIALS lake objects → fn_financials_project → public.financial_statements. Owns the source
 * html in the `filings` bucket. Deterministic, no LLM. (Pre-XBRL older filings are the LLM path's job.)
 *
 * Incremental: skips XBRL whose storage key is already in public.filings (steady state ships ~0).
 * Chunked: process a slice of the universe per run (CHUNK_START/CHUNK_SIZE) — keep runs < ~15 min.
 *   ACQUIRE_SYMBOLS=2381,2010   node tadawul-researcher.mjs      # explicit list
 *   CHUNK_START=0 CHUNK_SIZE=20 node tadawul-researcher.mjs      # slice of all TDWL securities
 */
import { spawnSync } from 'node:child_process';
import { upsertLakeObject } from './lib/lake-objects.mjs';
import { makeGuards } from './scrape-guardrails.mjs';
const ING = '/opt/marsad/ingestion';
const { chromium } = await import(`${ING}/node_modules/playwright/index.js`).then(m => m.default ?? m);
const { parseTadawulXbrl, parseTadawulProfile } = await import(`${ING}/dist/adapters/tadawul/xbrl.js`);
const { extractToStatements } = await import(`${ING}/dist/lake/statement-extraction.js`);
const postgres = (await import('/opt/marsad/worker/node_modules/postgres/src/index.js').then(m => m.default ?? m));

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL, PROXY_SERVER, PROXY_USERNAME, PROXY_PASSWORD } = process.env;
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL, PROXY_SERVER, PROXY_USERNAME, PROXY_PASSWORD }))
  if (!v) { console.error(`missing env ${k}`); process.exit(1); }
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const mkSession = () => String(Date.now()).slice(-8) + Math.floor(Math.random() * 1e4);
function buildProxy(s) { const host = PROXY_SERVER.replace(/^https?:\/\//, ""); const user = /-session-/.test(PROXY_USERNAME) ? PROXY_USERNAME : `${PROXY_USERNAME}-lifetime-30-session-${s}`; return { server: `http://${host}`, username: user, password: PROXY_PASSWORD }; }

// Fixed profile-portlet state token (harvested from main-market-watch; identical for every company —
// the company is chosen by ?companySymbol=). If profile nav ever stops resolving, re-harvest via
// tadawul-marketwatch.mjs. NOT company-specific, NOT a secret.
const PROFILE_BASE = 'https://www.saudiexchange.sa/wps/portal/saudiexchange/hidden/company-profile-main/!ut/p/z0/04_Sj9CPykssy0xPLMnMz0vMAfIjo8ziTR3NDIw8LAz83d2MXA0C3SydAl1c3Q0NvE30C7IdFQHvzClr';
const profileUrl = (cs) => `${PROFILE_BASE}/?companySymbol=${cs}`;
const FS_BTN = /financial statements.*(report|document|pdf)|statements? (and|&) reports?|financial reports?/i;

async function uploadHtml(key, buf) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/filings/${key}`, {
    method: 'POST', headers: { authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'content-type': 'text/html', 'x-upsert': 'true' }, body: buf,
  });
  return r.ok;
}

async function persist(sql, cs, statements, storageKey, sourceRef) {
  const sec = await sql`select id from public.securities where venue_code='TDWL' and ticker=${cs} limit 1`;
  if (!sec[0]) { log(`  no security cs=${cs}`); return 0; }
  const secId = sec[0].id;
  const agent = await sql`select id from iam.principals where handle='SYSTEM' limit 1`;
  const pr = await sql`insert into lake.parse_runs (agent_id, parser_key, parser_version, status) values (${agent[0].id}, 'tadawul_xbrl', '1', 'succeeded') returning id`;
  let n = 0;
  for (const p of statements.periods) {
    const nk = `FINANCIALS:TDWL:${cs}:${p.statementType}:${p.fiscalPeriod}`;
    // Phase B: presentation (printed labels, document order) + filing_source_ref (→ projection resolves
    // financial_statements.source_filing_id against public.filings). Both optional in the v3 contract.
    const payload = { statement_type: p.statementType, period_kind: p.periodKind, fiscal_period: p.fiscalPeriod, period_end: p.periodEnd, currency: p.currency, basis: 'consolidated', line_items: p.lineItems,
      ...(p.presentation && p.presentation.length ? { presentation: p.presentation } : {}),
      ...(sourceRef ? { filing_source_ref: sourceRef } : {}) };
    await upsertLakeObject(sql, {
      naturalKey: nk, objectType: 'FILING.FINANCIALS', securityId: secId, venueCode: 'TDWL',
      payload, parseRunId: pr[0].id, sourceRank: 10,
    });
    n++;
  }
  await sql`insert into public.filings (security_id, venue_code, source_ref, filing_type, title, filed_at, pdf_storage_key)
            values (${secId}, 'TDWL', ${sourceRef}, 'RESULTS', ${sourceRef.slice(0, 200)}, now(), ${storageKey})
            on conflict (venue_code, source_ref) do update set pdf_storage_key=excluded.pdf_storage_key`;
  return n;
}

// Entity profile (ISIN + sector/industry) → the securities identity columns, Mubasher-free (DEF-SECTOR-DATA).
// Mirrors persist(): one PROFILE.SECURITY object per (venue,ticker); the fn_security_profile_project trigger
// projects PENDING inserts into public.securities (coalesce — a null field never wipes the Mubasher-scraped
// shares_outstanding, so the two producers compose). One-time backfill: only fires while profile_scraped_at IS NULL.
async function persistProfile(sql, cs, prof) {
  const sec = await sql`select id from public.securities where venue_code='TDWL' and ticker=${cs} limit 1`;
  if (!sec[0]) return;
  const secId = sec[0].id;
  const agent = await sql`select id from iam.principals where handle='SYSTEM' limit 1`;
  const pr = await sql`insert into lake.parse_runs (agent_id, parser_key, parser_version, status) values (${agent[0].id}, 'tadawul_xbrl_profile', '1', 'succeeded') returning id`;
  const nk = `PROFILE.SECURITY:TDWL:${cs}`;
  const payload = { venue: 'TDWL', ticker: cs, sector: prof.sector, rawSector: prof.rawSector, isin: prof.isin, sharesOutstanding: prof.sharesOutstanding, industry: prof.industry };
  await upsertLakeObject(sql, {
    naturalKey: nk, objectType: 'PROFILE.SECURITY', securityId: secId, venueCode: 'TDWL',
    payload, parseRunId: pr[0].id, sourceRank: 10,
  });
}

const MW_URL = 'https://www.saudiexchange.sa/wps/portal/saudiexchange/ourmarkets/main-market-watch?locale=en';

// Reach a company's profile the ONLY way that renders it: market-watch → in-page click the company
// anchor (SPA nav; a direct goto of the z0 url does NOT render the profile, and the grid virtualizes
// rows so elementHandle.click isn't actionable) → click "Financial Statements and Reports" → scrape the
// document list. Returns {xbrl:[.html urls], pdf:[fsPdf urls]}, or null to force an IP rotation.
async function scrapeDocs(page, nav, cs) {
  const hasFsBtn = async () => { for (const f of page.frames()) { if (await f.evaluate((reSrc) => { const re = new RegExp(reSrc, 'i'); return [...document.querySelectorAll('a,button,li,span,div')].some((e) => re.test((e.textContent || '').replace(/\s+/g, ' ').trim()) && (e.textContent || '').length < 80); }, FS_BTN.source).catch(() => false)) return true; } return false; };
  const scrape = async () => { const xbrl = new Set(), pdf = new Set(); for (const f of page.frames()) { const ls = await f.evaluate(() => [...document.querySelectorAll('a')].map((a) => a.href || '')).catch(() => []); for (const u of ls) { if (/\/Resources\/XBRL_DOCS\/.*\.html$/i.test(u)) xbrl.add(u); else if (/\/Resources\/fsPdf\/.*\.pdf$/i.test(u)) pdf.add(u); } } return { xbrl: [...xbrl], pdf: [...pdf] }; };
  // Geonode is flaky through the WebSphere SPA — retry the whole market-watch→click→FS→scrape flow before
  // giving up, so a transient empty isn't misread as "company has no filings" (which advances the cursor).
  let sawAnchor = false;
  for (let att = 0; att < 2; att++) {
    if (!await nav(MW_URL)) return null;
    await page.waitForSelector(`a[href*="companySymbol=${cs}"]`, { timeout: 40000 }).catch(() => {});
    const found = await page.evaluate((c) => { const a = document.querySelector(`a[href*="companySymbol=${c}"]`); if (!a) return false; a.scrollIntoView(); a.click(); return true; }, cs);
    if (!found) continue; // grid may not have rendered — retry; if never, it's genuinely off-board
    sawAnchor = true;
    for (let w = 0; w < 8 && !(await hasFsBtn()); w++) await page.waitForTimeout(4000);
    let clicked = false;
    for (const f of page.frames()) {
      const ok = await f.evaluate((reSrc) => {
        const re = new RegExp(reSrc, 'i');
        const el = [...document.querySelectorAll('a,button,li,span,div')].find((e) => re.test((e.textContent || '').replace(/\s+/g, ' ').trim()) && (e.textContent || '').length < 80);
        if (el) { el.scrollIntoView(); el.click(); return true; }
        return false;
      }, FS_BTN.source).catch(() => false);
      if (ok) { clicked = true; break; }
    }
    if (!clicked) continue; // FS control didn't render — retry
    let docs = { xbrl: [], pdf: [] };
    for (let w = 0; w < 7; w++) { await page.waitForTimeout(3000); docs = await scrape(); if (docs.xbrl.length || docs.pdf.length) break; }
    if (docs.xbrl.length || docs.pdf.length) return docs;
  }
  return { xbrl: [], pdf: [] }; // genuinely no docs (fund/delisted) or never rendered even on retry
}

async function fetchHtml(page, url) {
  return page.evaluate(async (u) => {
    try { const r = await fetch(u, { headers: { Accept: '*/*' } }); const b = new Uint8Array(await r.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return { status: r.status, len: b.length, b64: btoa(s) }; }
    catch (e) { return { err: String(e).slice(0, 80) }; }
  }, url);
}

// ── PDF archiving (own the actual statement PDFs as downloadable premium content) ──
async function uploadPdf(key, buf) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/filings/${key}`, { method: 'POST', headers: { authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'content-type': 'application/pdf', 'x-upsert': 'true' }, body: buf });
  return r.ok;
}
async function fetchPdf(page, url) {
  return page.evaluate(async (u) => {
    try { const r = await fetch(u, { headers: { Accept: 'application/pdf' } }); const b = new Uint8Array(await r.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return { status: r.status, len: b.length, magic: String.fromCharCode(...b.slice(0, 5)), b64: btoa(s) }; }
    catch (e) { return { err: String(e).slice(0, 80) }; }
  }, url);
}
// fsPdf filename `{issuer}_0_{YYYY-MM-DD}_{HH-MM-SS}_En.pdf` → catalogue metadata (Saudi statutory windows).
function fsPdfMeta(fname) {
  const m = fname.match(/_(\d{4})-(\d{2})-(\d{2})_/);
  const filedAt = m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  let period = null;
  if (m) { const y = Number(m[1]), mo = Number(m[2]); period = mo <= 4 ? String(y - 1) : mo <= 6 ? `Q1 ${y}` : mo <= 8 ? `Q2 ${y}` : mo <= 11 ? `Q3 ${y}` : String(y); }
  return { filedAt, period };
}
// Catalogue the archived PDF in public.filings (venue-scoped; pdf_storage_key → the bucket object).
async function catalogPdf(sql, cs, key, fname) {
  const sec = await sql`select id from public.securities where venue_code='TDWL' and ticker=${cs} limit 1`;
  if (!sec[0]) return;
  const { filedAt, period } = fsPdfMeta(fname);
  const title = `Financial statements PDF${period ? ` — ${period}` : ''}`;
  await sql`insert into public.filings (security_id, venue_code, source_ref, filing_type, title, filed_at, pdf_storage_key)
            values (${sec[0].id}, 'TDWL', ${`TDWL-FSPDF-${fname.replace(/\.pdf$/i, '')}`}, 'RESULTS', ${title.slice(0, 200)}, ${filedAt ? filedAt : sql`now()`}, ${key})
            on conflict (venue_code, source_ref) do update set pdf_storage_key=excluded.pdf_storage_key`;
}

// ── main ──
const t0 = Date.now();
// Self-terminate before the cron's 800s SIGTERM so DONE always prints (the wrapper advances the cursor by
// the completed count; a killed run with no DONE line holds the cursor at its current offset and retries).
const runDeadline = t0 + Number(process.env.RUN_BUDGET_MS || 680000);
const sql = postgres(SUPABASE_DB_URL, { max: 6, prepare: false });
let symbols;
if (process.env.ACQUIRE_SYMBOLS) symbols = process.env.ACQUIRE_SYMBOLS.split(',').map((s) => s.trim()).filter(Boolean);
else {
  const start = Number(process.env.CHUNK_START || 0), size = Number(process.env.CHUNK_SIZE || 20);
  const rows = await sql`select ticker from public.securities where venue_code='TDWL' and status='listed' order by ticker offset ${start} limit ${size}`;
  symbols = rows.map((r) => r.ticker);
}
// Incremental: already-owned XBRL + PDF storage keys.
const owned = new Set((await sql`select pdf_storage_key from public.filings where venue_code='TDWL' and pdf_storage_key like 'tdwl/%/xbrl/%'`).map((r) => r.pdf_storage_key));
const ownedPdf = new Set((await sql`select pdf_storage_key from public.filings where venue_code='TDWL' and pdf_storage_key like 'tdwl/%' and pdf_storage_key not like '%/xbrl/%'`).map((r) => r.pdf_storage_key));
// One-time entity-profile backfill set: TDWL companies whose identity (sector/isin) hasn't landed yet.
// Stamped by fn_security_profile_project on first land, so a company drops out after one successful scrape.
const needProfile = new Set((await sql`select ticker from public.securities where venue_code='TDWL' and profile_scraped_at is null`).map((r) => r.ticker));
log(`researcher — ${symbols.length} companies, ${owned.size} XBRL + ${ownedPdf.size} PDF filings already owned, ${needProfile.size} profiles to backfill`);

let companies = 0, docsNew = 0, rowsW = 0, gateRej = 0, pdfArchived = 0, profilesW = 0;
// Bound the one-time profile backfill's extra html GETs per run (fresh-filing htmls are reused for free).
let profileBudget = Number(process.env.PROFILE_MAX || 30);
// Proxy-bandwidth guardrails (shared): block image/font/media + trackers, account bytes, hard per-run
// budget (safety net; the real control is the 6h systemd cadence). Default 800MB/run — well above a
// normal 16-company chunk after interception, so it only trips on a runaway.
const guards = makeGuards({ maxBytes: Number(process.env.MAX_RUN_BYTES || 800) * 1e6 });
// PDF archiving is slow (~15-20s/file through the residential proxy) — bound it per run.
let pdfBudget = Number(process.env.PDF_ARCHIVE_MAX || 20);
// Throughput = PARALLEL browsers, each on its OWN Geonode sticky IP (each keeps the same gentle ~N-company
// per-IP load, so no single IP shows Akamai a higher request rate — we scale by adding IPs, not by hammering).
const CONCURRENCY = Number(process.env.CONCURRENCY || 2);

// Process one contiguous slice of the universe on its own browser/IP, rotating the IP on nav failure.
async function processGroup(group, gid) {
  let done = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const browser = await chromium.launch({ headless: false, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'], proxy: buildProxy(mkSession()) });
    const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', timezoneId: 'Asia/Riyadh', viewport: { width: 1366, height: 900 } });
    await guards.install(ctx); // block image/font/media + trackers; account proxy bytes
    await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); window.chrome = { runtime: {} }; });
    const page = await ctx.newPage();
    const nav = async (url, tries = 2) => { for (let i = 0; i < tries; i++) { try { await page.goto(url, { waitUntil: 'commit', timeout: 45000 }); await page.waitForFunction(() => document.body && document.body.innerText.length > 500, { timeout: 40000 }).catch(() => {}); return 200; } catch { /* Geonode Akamai is slow: commit then wait for real content */ } } return 0; };
    try {
      if (!await nav('https://www.saudiexchange.sa/wps/portal/saudiexchange')) { log(`  [g${gid}] warm failed — rotating (${attempt + 1}/3)`); await browser.close(); continue; }
      await page.waitForTimeout(6000);
      for (const cs of group.slice(done)) {
        if (Date.now() > runDeadline) { log(`  [g${gid}] run budget reached — stopping (${done} done)`); await browser.close(); return done; }
        if (guards.over()) { log(`  [g${gid}] byte budget ${guards.stats().maxMb}MB reached — stopping (${done} done, ${guards.stats().mb}MB)`); await browser.close(); return done; }
        try {
          let profileHtml = null; // reuse a fetched XBRL html for the one-time profile backfill (free)
          const docs = await scrapeDocs(page, nav, cs);
          if (docs === null) { log(`  [g${gid}] ${cs} market-watch nav failed — rotating`); break; } // fresh IP
          const fresh = docs.xbrl.filter((u) => !owned.has(`tdwl/${cs}/xbrl/${u.split('/').pop()}`));
          log(`  [g${gid}] ${cs}: ${docs.xbrl.length} xbrl / ${docs.pdf.length} pdf, ${fresh.length} new xbrl`);
          for (const u of fresh) {
            const fname = u.split('/').pop();
            const got = await fetchHtml(page, u);
            if (got.err || got.status !== 200 || !got.len) { log(`    ${fname} fetch fail: ${got.err || got.status}`); continue; }
            const html = Buffer.from(got.b64, 'base64').toString('utf8');
            profileHtml = html; // the [100010] identity block is filing-invariant — any fetched html works
            const { statements, validation } = extractToStatements(parseTadawulXbrl(html), 'TDWL', cs);
            gateRej += validation.rejected.length;
            if (!statements.periods.length) { log(`    ${fname} — no accepted periods`); continue; }
            const key = `tdwl/${cs}/xbrl/${fname}`;
            await uploadHtml(key, Buffer.from(html));
            const nrows = await persist(sql, cs, statements, key, `TDWL-XBRL-${fname.replace(/\.html$/i, '')}`);
            owned.add(key); docsNew++; rowsW += nrows;
            log(`    ✓ ${fname} → ${statements.periods.length}p → ${nrows} rows`);
          }
          // Archive the actual statement PDFs (download + store + catalogue — fetch only, no LLM).
          const freshPdf = docs.pdf.filter((u) => !ownedPdf.has(`tdwl/${cs}/${u.split('/').pop()}`));
          let archivedHere = 0;
          for (const u of freshPdf) {
            if (pdfBudget <= 0) break;
            const fname = u.split('/').pop();
            const got = await fetchPdf(page, u);
            if (got.err || got.status !== 200 || !got.magic?.startsWith('%PDF')) { log(`    pdf ${fname} fetch fail: ${got.err || got.status}`); continue; }
            const key = `tdwl/${cs}/${fname}`;
            if (!(await uploadPdf(key, Buffer.from(got.b64, 'base64')))) { log(`    pdf ${fname} upload fail`); continue; }
            await catalogPdf(sql, cs, key, fname);
            ownedPdf.add(key); pdfArchived++; archivedHere++; pdfBudget--;
          }
          if (freshPdf.length) log(`    [g${gid}] archived ${archivedHere}/${freshPdf.length} PDFs (budget ${pdfBudget})`);
          // One-time entity-profile backfill (ISIN + sector/industry → securities). Free from a fresh html;
          // else one owned-html GET (budget-bounded). Skipped once profile_scraped_at is set (needProfile miss).
          if (needProfile.has(cs)) {
            if (!profileHtml && docs.xbrl.length && profileBudget > 0) {
              const got = await fetchHtml(page, docs.xbrl[0]);
              if (!got.err && got.status === 200 && got.len) profileHtml = Buffer.from(got.b64, 'base64').toString('utf8');
              profileBudget--;
            }
            if (profileHtml) {
              const prof = parseTadawulProfile(profileHtml, cs);
              if (prof) { await persistProfile(sql, cs, prof); needProfile.delete(cs); profilesW++; log(`    ⌘ [g${gid}] ${cs} profile → ${prof.sector}${prof.isin ? ' / ' + prof.isin : ''}`); }
            }
          }
          done++; companies++;
        } catch (e) { log(`  [g${gid}] ${cs} err ${String(e).slice(0, 70)}`); done++; companies++; }
      }
      await browser.close();
      if (done >= group.length) break;
    } catch (e) { log(`  [g${gid}] err ${String(e).slice(0, 80)} — rotating`); try { await browser.close(); } catch { /* */ } }
  }
  return done;
}

// Contiguous slices so the cursor's advance-by-completed stays sensible; incremental (skip-owned) self-corrects any gaps.
const per = Math.ceil(symbols.length / CONCURRENCY);
const groups = [];
for (let i = 0; i < symbols.length; i += per) groups.push(symbols.slice(i, i + per));
await Promise.all(groups.map((g, i) => processGroup(g, i)));
await sql.end();
log(`DONE ${(Date.now() - t0) / 1000 | 0}s | companies ${companies}/${symbols.length} | new XBRL docs ${docsNew} | financial_statements rows ${rowsW} | profiles ${profilesW} | PDFs archived ${pdfArchived} | gate-rejected ${gateRej} | conc ${CONCURRENCY} | proxy ${guards.stats().mb}MB (blocked ${guards.stats().blocked} reqs)`);
