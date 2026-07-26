#!/usr/bin/env node
/**
 * Tadawul financials GAP-FILL — the hybrid's LLM half ($0 via the Claude Code SUBSCRIPTION). For periods
 * the free XBRL path doesn't cover (older years, quarters some filers skip in XBRL), download the profile's
 * fsPdf, extract with `claude -p` (sonnet), gate, and persist at source_rank 20 — the XBRL objects
 * (rank 10) WIN via a downgrade guard, so this only FILLS gaps, never overwrites exact XBRL data.
 *
 * Nav = market-watch → in-page click `?companySymbol=` → "Financial Statements and Reports" → fsPdf list
 * (same as the XBRL researcher). Throttled: FSPDF_MAX new PDFs per run (subscription rate limits).
 *   ACQUIRE_SYMBOLS=2381  FSPDF_MAX=6  node tadawul-gapfill.mjs
 *   CHUNK_START=0 CHUNK_SIZE=6 node tadawul-gapfill.mjs
 */
import { spawnSync } from 'node:child_process';
import { upsertLakeObject } from './lib/lake-objects.mjs';
import { makeGuards } from './scrape-guardrails.mjs';
const ING = '/opt/marsad/ingestion';
const { chromium } = await import(`${ING}/node_modules/playwright/index.js`).then(m => m.default ?? m);
const { extractToStatements, EXTRACTION_SYSTEM, buildExtractionUserMessage } = await import(`${ING}/dist/lake/statement-extraction.js`);
const postgres = (await import('/opt/marsad/worker/node_modules/postgres/src/index.js').then(m => m.default ?? m));

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL, PROXY_SERVER, PROXY_USERNAME, PROXY_PASSWORD } = process.env;
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL, PROXY_SERVER, PROXY_USERNAME, PROXY_PASSWORD }))
  if (!v) { console.error(`missing env ${k}`); process.exit(1); }
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'haiku';
const FSPDF_MAX = Number(process.env.FSPDF_MAX || 6); // new PDFs per run (rate-limit budget)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const mkSession = () => String(Date.now()).slice(-8) + Math.floor(Math.random() * 1e4);
function buildProxy(s) { const host = PROXY_SERVER.replace(/^https?:\/\//, ""); const user = /-session-/.test(PROXY_USERNAME) ? PROXY_USERNAME : `${PROXY_USERNAME}-lifetime-30-session-${s}`; return { server: `http://${host}`, username: user, password: PROXY_PASSWORD }; }
const MW_URL = 'https://www.saudiexchange.sa/wps/portal/saudiexchange/ourmarkets/main-market-watch?locale=en';
const FS_BTN = /financial statements.*(report|document|pdf)|statements? (and|&) reports?|financial reports?/i;

// fsPdf filing date → the period it most likely reports (Saudi statutory windows). Pre-filter only —
// the extraction reads the REAL periods from the PDF; the persist guard prevents any bad overwrite.
function fsPdfPeriod(fname) {
  const m = fname.match(/_(\d{4})-(\d{2})-\d{2}_/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]);
  if (mo <= 4) return String(y - 1);      // annual filed Q1 → prior FY
  if (mo <= 6) return `Q1 ${y}`;
  if (mo <= 8) return `Q2 ${y}`;
  if (mo <= 11) return `Q3 ${y}`;
  return String(y);                        // Dec → that FY (rare)
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
  return extractToStatements(parsed, 'TDWL', '0');
}

async function uploadPdf(key, buf) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/filings/${key}`, { method: 'POST', headers: { authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'content-type': 'application/pdf', 'x-upsert': 'true' }, body: buf });
  return r.ok;
}

async function downloadPdf(key) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/filings/${key}`, { headers: { authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } });
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-' ? buf : null;
}

// Record the owned-PDF filing marker up-front (before extraction). `ownedPdf` is seeded from public.filings
// each run, so persisting the marker at STORE time — not only inside persist() after a successful extract —
// is what lets a later run pull the PDF from storage instead of re-fetching it from Tadawul over the proxy.
async function recordFilingOwned(sql, cs, key, sourceRef) {
  const sec = await sql`select id from public.securities where venue_code='TDWL' and ticker=${cs} limit 1`;
  if (!sec[0]) return;
  await sql`insert into public.filings (security_id, venue_code, source_ref, filing_type, title, filed_at, pdf_storage_key)
            values (${sec[0].id}, 'TDWL', ${sourceRef}, 'RESULTS', ${sourceRef.slice(0, 200)}, now(), ${key})
            on conflict (venue_code, source_ref) do update set pdf_storage_key=excluded.pdf_storage_key`;
}

async function persist(sql, cs, statements, storageKey, sourceRef) {
  const sec = await sql`select id from public.securities where venue_code='TDWL' and ticker=${cs} limit 1`;
  if (!sec[0]) return 0;
  const secId = sec[0].id;
  const agent = await sql`select id from iam.principals where handle='SYSTEM' limit 1`;
  const pr = await sql`insert into lake.parse_runs (agent_id, parser_key, parser_version, status) values (${agent[0].id}, 'tadawul_fspdf_llm', '1', 'succeeded') returning id`;
  let n = 0;
  for (const p of statements.periods) {
    const nk = `FINANCIALS:TDWL:${cs}:${p.statementType}:${p.fiscalPeriod}`;
    const live = await sql`select id, revision, state, source_rank from lake.objects where natural_key=${nk} and superseded_by is null limit 1`;
    // Downgrade guard: never replace a better/equal source (XBRL rank 10) with this LLM PDF (rank 20).
    if (live[0] && live[0].source_rank <= 20) continue;
    const payload = { statement_type: p.statementType, period_kind: p.periodKind, fiscal_period: p.fiscalPeriod, period_end: p.periodEnd, currency: p.currency, basis: 'consolidated', line_items: p.lineItems };
    await upsertLakeObject(sql, {
      naturalKey: nk, objectType: 'FILING.FINANCIALS', securityId: secId, venueCode: 'TDWL',
      payload, parseRunId: pr[0].id, sourceRank: 20,
    });
    n++;
  }
  // Always record the filing (owned marker) — even a 0-statement board report, so it isn't re-extracted
  // (and re-charged to the subscription budget) every run.
  await sql`insert into public.filings (security_id, venue_code, source_ref, filing_type, title, filed_at, pdf_storage_key)
            values (${secId}, 'TDWL', ${sourceRef}, 'RESULTS', ${sourceRef.slice(0, 200)}, now(), ${storageKey})
            on conflict (venue_code, source_ref) do update set pdf_storage_key=excluded.pdf_storage_key`;
  return n;
}

async function scrapePdf(page, nav, cs) {
  if (!await nav(MW_URL)) return null;
  await page.waitForSelector(`a[href*="companySymbol=${cs}"]`, { timeout: 40000 }).catch(() => {});
  const found = await page.evaluate((c) => { const a = document.querySelector(`a[href*="companySymbol=${c}"]`); if (!a) return false; a.scrollIntoView(); a.click(); return true; }, cs);
  if (!found) return [];
  const hasFsBtn = async () => { for (const f of page.frames()) { if (await f.evaluate((reSrc) => { const re = new RegExp(reSrc, 'i'); return [...document.querySelectorAll('a,button,li,span,div')].some((e) => re.test((e.textContent || '').replace(/\s+/g, ' ').trim()) && (e.textContent || '').length < 80); }, FS_BTN.source).catch(() => false)) return true; } return false; };
  for (let w = 0; w < 8 && !(await hasFsBtn()); w++) await page.waitForTimeout(4000);
  let clicked = false;
  for (const f of page.frames()) {
    const ok = await f.evaluate((reSrc) => { const re = new RegExp(reSrc, 'i'); const el = [...document.querySelectorAll('a,button,li,span,div')].find((e) => re.test((e.textContent || '').replace(/\s+/g, ' ').trim()) && (e.textContent || '').length < 80); if (el) { el.scrollIntoView(); el.click(); return true; } return false; }, FS_BTN.source).catch(() => false);
    if (ok) { clicked = true; break; }
  }
  if (!clicked) return [];
  const scrape = async () => { const pdf = new Set(); for (const f of page.frames()) { const ls = await f.evaluate(() => [...document.querySelectorAll('a')].map((a) => a.href || '')).catch(() => []); for (const u of ls) if (/\/Resources\/fsPdf\/.*\.pdf$/i.test(u)) pdf.add(u); } return [...pdf]; };
  let pdfs = [];
  for (let w = 0; w < 7; w++) { await page.waitForTimeout(3000); pdfs = await scrape(); if (pdfs.length) break; }
  return pdfs;
}

async function fetchPdf(page, url) {
  return page.evaluate(async (u) => { try { const r = await fetch(u, { headers: { Accept: 'application/pdf' } }); const b = new Uint8Array(await r.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return { status: r.status, len: b.length, magic: String.fromCharCode(...b.slice(0, 5)), b64: btoa(s) }; } catch (e) { return { err: String(e).slice(0, 80) }; } }, url);
}

// ── main ──
const t0 = Date.now();
const sql = postgres(SUPABASE_DB_URL, { max: 2, prepare: false });
let symbols;
if (process.env.ACQUIRE_SYMBOLS) symbols = process.env.ACQUIRE_SYMBOLS.split(',').map((s) => s.trim()).filter(Boolean);
else { const start = Number(process.env.CHUNK_START || 0), size = Number(process.env.CHUNK_SIZE || 6); symbols = (await sql`select ticker from public.securities where venue_code='TDWL' and status='listed' order by ticker offset ${start} limit ${size}`).map((r) => r.ticker); }
const ownedPdf = new Set((await sql`select pdf_storage_key from public.filings where venue_code='TDWL' and pdf_storage_key like 'tdwl/%' and pdf_storage_key not like '%/xbrl/%'`).map((r) => r.pdf_storage_key));
log(`gapfill — ${symbols.length} companies, ${ownedPdf.size} PDFs owned, FSPDF_MAX ${FSPDF_MAX}/run`);

let companies = 0, pdfNew = 0, rowsW = 0, budget = FSPDF_MAX;
// Proxy-bandwidth guardrails (shared): block image/font/media + trackers, account bytes, hard per-run
// budget (safety net; the real control is the 6h systemd cadence). 800MB/run default.
const guards = makeGuards({ maxBytes: Number(process.env.MAX_RUN_BYTES || 800) * 1e6 });
for (let attempt = 0; attempt < 3 && budget > 0 && !guards.over(); attempt++) {
  const session = mkSession();
  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'], proxy: buildProxy(session) });
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', timezoneId: 'Asia/Riyadh', viewport: { width: 1366, height: 900 } });
  await guards.install(ctx); // block image/font/media + trackers; account proxy bytes
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); window.chrome = { runtime: {} }; });
  const page = await ctx.newPage();
  const nav = async (url, tries = 2) => { for (let i = 0; i < tries; i++) { try { await page.goto(url, { waitUntil: "commit", timeout: 45000 }); await page.waitForFunction(() => document.body && document.body.innerText.length > 500, { timeout: 40000 }).catch(() => {}); return 200; } catch { /* retry (Geonode Akamai is slow: commit then wait for real content, not domcontentloaded which the challenge-reload never fires) */ } } return 0; };
  try {
    if (!await nav('https://www.saudiexchange.sa/wps/portal/saudiexchange')) { log(`  warm failed — rotating (${attempt + 1}/3)`); await browser.close(); continue; }
    await page.waitForTimeout(6000);
    for (const cs of symbols.slice(companies)) {
      if (budget <= 0) break;
      if (guards.over()) { log(`  byte budget ${guards.stats().maxMb}MB reached — stopping (${guards.stats().mb}MB)`); break; }
      try {
        const pdfs = await scrapePdf(page, nav, cs);
        if (pdfs === null) { log(`  ${cs} mw nav failed — rotating`); break; }
        const covered = new Set((await sql`select distinct fiscal_period from public.financial_statements fs join public.securities s on s.id=fs.security_id where s.venue_code='TDWL' and s.ticker=${cs}`).map((r) => r.fiscal_period));
        // Gate on PERIOD coverage (financial_statements), not PDF-owned — the researcher archives every
        // fsPdf, so file-ownership no longer signals "extracted". A period covered by XBRL or a prior
        // successful extract is skipped; uncovered (typically pre-XBRL) periods get LLM-extracted.
        const gaps = pdfs.filter((u) => { const per = fsPdfPeriod(u.split('/').pop()); return per && !covered.has(per); });
        log(`  ${cs}: ${pdfs.length} pdf, ${gaps.length} gap-candidates (covered ${covered.size} periods)`);
        for (const u of gaps) {
          if (budget <= 0) break;
          const fn = u.split('/').pop();
          const key = `tdwl/${cs}/${fn}`;
          const sourceRef = `TDWL-FSPDF-${fn.replace(/\.pdf$/i, '')}`;
          // Reuse an already-archived PDF (a prior run stored it but a claude miss left the period
          // uncovered, so it's STILL a gap candidate): pull from storage, NOT Tadawul, so a claude
          // outage never re-burns proxy bytes on the same file.
          let buf = null;
          if (ownedPdf.has(key)) { buf = await downloadPdf(key); if (buf) log(`    ${fn} reuse stored PDF (no proxy)`); }
          if (!buf) {
            const got = await fetchPdf(page, u);
            if (got.err || got.status !== 200 || !got.magic?.startsWith('%PDF')) { log(`    ${fn} fetch fail`); continue; }
            buf = Buffer.from(got.b64, 'base64');
            // Store + mark owned BEFORE extraction so a claude miss below can't force a re-fetch next run.
            await uploadPdf(key, buf);
            await recordFilingOwned(sql, cs, key, sourceRef);
            ownedPdf.add(key); pdfNew++;
          }
          const ex = extractViaClaude(buf);
          budget--;
          if (ex.error) { log(`    ${fn} extract: ${ex.error} — PDF stored, retry from storage next run`); continue; }
          const nrows = await persist(sql, cs, ex.statements, key, sourceRef);
          rowsW += nrows;
          log(`    ${nrows ? '✓' : '·'} ${fn} → ${ex.statements.periods.length}p → ${nrows} new rows (budget ${budget})`);
        }
        companies++;
      } catch (e) { log(`  ${cs} err ${String(e).slice(0, 70)}`); companies++; }
    }
    await browser.close();
    if (companies >= symbols.length) break;
  } catch (e) { log(`  gapfill err ${String(e).slice(0, 80)} — rotating`); try { await browser.close(); } catch { /* */ } }
}
await sql.end();
log(`DONE ${(Date.now() - t0) / 1000 | 0}s | companies ${companies}/${symbols.length} | new PDFs ${pdfNew} | rows ${rowsW} | budget left ${budget} | proxy ${guards.stats().mb}MB (blocked ${guards.stats().blocked} reqs)`);
