#!/usr/bin/env node
/**
 * BHB (Bahrain Bourse) financial-statement backfill — the cheap-HTTP analogue of tadawul-gapfill.mjs.
 * $0 via the Claude Code SUBSCRIPTION. Unlike Tadawul (Akamai-walled → headed Chromium through a
 * residential proxy), BHB serves its CompanyProfile "Statements" tab as a plain JSON webapi and its
 * statement PDFs as direct static downloads — so there is NO browser, NO proxy, NO xvfb here. Per company:
 *
 *   1. GET webapi.bahrainbourse.com/api/data/GetCompanyFinancialStatements  (dynamic public APIKey Bearer)
 *      → the index of statement filings, each with direct PDF link(s) (View / View (PDF) / Annual Report).
 *   2. skip any PDF already owned (public.filings source_ref BHB-FS-<fileId>) — incremental, cheap.
 *   3. download each new PDF DIRECT (verify %PDF) → pdftotext → `claude -p` → extractToStatements('BHB').
 *   4. archive the PDF to the `filings` bucket + persist statements to lake.objects (FILING.FINANCIALS,
 *      source_rank 20) + catalogue public.filings. The lake.fn_financials_project trigger lands the
 *      public.financial_statements rows (restatement-versioned).
 *
 * BHB has no XBRL, so this LLM/PDF path is the PRIMARY statements source (not a gap-filler). Throttled by
 * FSPDF_MAX new PDFs/run (the subscription rate-limits). Chunk-cursored + flock'd by bhb-financials-cron.sh.
 *   ACQUIRE_SYMBOLS=ALBH,KHALEEJI FSPDF_MAX=6 node bhb-financials.mjs
 *   CHUNK_START=0 CHUNK_SIZE=8 node bhb-financials.mjs
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdtempSync, readdirSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ING = '/opt/marsad/ingestion';
const { parseCompanyFinancialStatements, companyFinancialStatementsUrl } = await import(`${ING}/dist/adapters/bhb/financials.js`);
const { extractToStatements, EXTRACTION_SYSTEM, buildExtractionUserMessage } = await import(`${ING}/dist/lake/statement-extraction.js`);
const postgres = (await import('/opt/marsad/worker/node_modules/postgres/src/index.js').then(m => m.default ?? m));

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL } = process.env;
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL }))
  if (!v) { console.error(`missing env ${k}`); process.exit(1); }
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'sonnet';
const FSPDF_MAX = Number(process.env.FSPDF_MAX || 6); // new PDFs per run (subscription rate-limit budget)
const RUN_BUDGET_MS = Number(process.env.RUN_BUDGET_MS || 680000); // self-stop before the cron SIGTERM
const OCR_MAX_PAGES = Number(process.env.OCR_MAX_PAGES || 60); // scanned-PDF OCR page cap (bounds time/mem)
const OCR_DPI = Number(process.env.OCR_DPI || 200); // rasterization DPI for OCR
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TOKEN_PAGE = 'https://www.bahrainbourse.com/en';
const API_KEY_RE = /APIKey['"]?\s*[:=]\s*['"]([a-fA-F0-9]{32,})['"]/;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── BHB webapi auth: scrape the rotating PUBLIC APIKey from the homepage; cache; re-scrape once on 401 ──
let apiKey = null;
async function scrapeKey() {
  try {
    const r = await fetch(TOKEN_PAGE, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    return API_KEY_RE.exec(await r.text())?.[1] ?? null;
  } catch { return null; }
}
async function webapiGet(url) {
  if (!apiKey) apiKey = await scrapeKey();
  if (!apiKey) return { ok: false, err: 'no APIKey' };
  const hdr = () => ({ 'user-agent': UA, accept: 'application/json', authorization: `Bearer ${apiKey}` });
  let r = await fetch(url, { headers: hdr() });
  if (r.status === 401 || r.status === 403 || r.status === 400) {
    const fresh = await scrapeKey();
    if (fresh && fresh !== apiKey) { apiKey = fresh; r = await fetch(url, { headers: hdr() }); }
  }
  if (!r.ok) return { ok: false, err: `http ${r.status}` };
  return { ok: true, body: await r.text() };
}

async function fetchPdf(url) {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/pdf' } });
    if (!r.ok) return { err: `http ${r.status}` };
    const buf = Buffer.from(await r.arrayBuffer());
    return { buf, magic: buf.subarray(0, 5).toString('latin1') };
  } catch (e) { return { err: String(e).slice(0, 80) }; }
}

/** Text layer via pdftotext (digital PDFs). '' if none. */
function pdfToText(buf) {
  const t = spawnSync('pdftotext', ['-layout', '-', '-'], { input: buf, maxBuffer: 30e6 });
  return t.stdout?.toString() || '';
}

/** OCR fallback for SCANNED (image-only) PDFs: rasterize ONE page at a time (pdftoppm) → tesseract →
 *  concat, unlinking each page image immediately. Page-by-page keeps peak memory/disk ~one page (this VPS
 *  is memory-tight — OOM history). Bounded by OCR_MAX_PAGES + a 400k-char cap. '' on any failure. */
function ocrToText(buf) {
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'bhbocr-'));
    const pdf = join(dir, 'in.pdf');
    writeFileSync(pdf, buf);
    let text = '';
    for (let pg = 1; pg <= OCR_MAX_PAGES; pg++) {
      const rp = spawnSync('pdftoppm', ['-png', '-r', String(OCR_DPI), '-f', String(pg), '-l', String(pg), pdf, join(dir, 'pg')], { maxBuffer: 6e7 });
      if (rp.status !== 0) break; // rasterization error
      const imgs = readdirSync(dir).filter((f) => f.startsWith('pg') && f.endsWith('.png'));
      if (imgs.length === 0) break; // page past end of document
      const abs = join(dir, imgs[0]);
      const t = spawnSync('tesseract', [abs, 'stdout', '-l', 'eng', '--psm', '6'], { maxBuffer: 4e7 });
      if (t.status === 0) text += (t.stdout?.toString() || '') + '\n';
      try { unlinkSync(abs); } catch { /* */ }
      if (text.length > 400000) break;
    }
    return text;
  } catch {
    return '';
  } finally {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
  }
}

// error.permanent=true ⇒ the PDF is genuinely unreadable (image-only AND OCR yielded nothing) — the loop
// archives + owned-marks it so it is NEVER re-downloaded/re-attempted. permanent=false ⇒ a transient miss
// (claude timeout / malformed JSON) — left un-owned so it retries next run.
function extractViaClaude(buf) {
  let full = pdfToText(buf);
  if (full.length < 400) {
    // scanned image PDF — no embedded text layer. OCR it (slow; bounded by OCR_MAX_PAGES).
    full = ocrToText(buf);
    if (full.length < 400) return { error: 'no text (ocr failed)', permanent: true };
    log(`      ocr recovered ${full.length} chars`);
  }
  const userMsg = buildExtractionUserMessage(full, 120000);
  const prompt = `${EXTRACTION_SYSTEM}\n\nThe filing text is on stdin. Return ONLY the JSON object of shape {"currency","scale","statements":[...]} — no prose, no code fences.`;
  const r = spawnSync('claude', ['-p', prompt, '--output-format', 'json', '--model', CLAUDE_MODEL], { input: userMsg, encoding: 'utf8', maxBuffer: 60e6, timeout: 240000 });
  if (r.error || r.status !== 0) return { error: `claude ${r.error?.code || r.status}`, permanent: false };
  let out = r.stdout || ''; try { const env = JSON.parse(out); if (typeof env.result === 'string') out = env.result; } catch { /* raw */ }
  const mm = out.match(/\{[\s\S]*\}/); if (!mm) return { error: 'no json', permanent: false };
  let parsed; try { parsed = JSON.parse(mm[0]); } catch { return { error: 'bad json', permanent: false }; }
  if (!Array.isArray(parsed.statements)) return { error: 'no statements', permanent: false };
  return extractToStatements(parsed, 'BHB', '0');
}

async function uploadPdf(key, buf) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/filings/${key}`, { method: 'POST', headers: { authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'content-type': 'application/pdf', 'x-upsert': 'true' }, body: buf });
  return r.ok;
}

async function persist(sql, cs, statements, storageKey, doc) {
  const sec = await sql`select id from public.securities where venue_code='BHB' and ticker=${cs} limit 1`;
  if (!sec[0]) return 0;
  const secId = sec[0].id;
  const agent = await sql`select id from iam.principals where handle='SYSTEM' limit 1`;
  const pr = await sql`insert into lake.parse_runs (agent_id, parser_key, parser_version, status) values (${agent[0].id}, 'bhb_fs_llm', '1', 'succeeded') returning id`;
  let n = 0;
  for (const p of statements.periods) {
    const nk = `FINANCIALS:BHB:${cs}:${p.statementType}:${p.fiscalPeriod}`;
    const live = await sql`select id, revision, state, source_rank from lake.objects where natural_key=${nk} and superseded_by is null limit 1`;
    // BHB is PDF-LLM only (no XBRL competitor). The guard keeps the FIRST source for a period (the audited
    // "View" statements, listed before the glossy "Annual Report" in the index) and avoids re-writing a
    // period another BHB PDF already landed. A future higher-fidelity BHB source (rank < 20) would win.
    if (live[0] && live[0].source_rank <= 20) continue;
    const payload = { statement_type: p.statementType, period_kind: p.periodKind, fiscal_period: p.fiscalPeriod, period_end: p.periodEnd, currency: p.currency, basis: 'consolidated', line_items: p.lineItems };
    if (live[0] && live[0].state === 'VERIFIED') {
      const nid = (await sql`select gen_random_uuid() as id`)[0].id;
      await sql`update lake.objects set superseded_by=${nid}, state='RETIRED' where id=${live[0].id}`;
      await sql`insert into lake.objects (id,object_type,natural_key,security_id,venue_code,payload,state,revision,parse_run_id,source_rank) values (${nid},'FILING.FINANCIALS',${nk},${secId},'BHB',${sql.json(payload)},'PENDING',${live[0].revision + 1},${pr[0].id},20)`;
    } else if (live[0]) {
      await sql`update lake.objects set payload=${sql.json(payload)}, revision=${live[0].revision + 1}, parse_run_id=${pr[0].id}, source_rank=20 where id=${live[0].id}`;
    } else {
      await sql`insert into lake.objects (object_type,natural_key,security_id,venue_code,payload,state,revision,parse_run_id,source_rank) values ('FILING.FINANCIALS',${nk},${secId},'BHB',${sql.json(payload)},'PENDING',1,${pr[0].id},20)`;
    }
    n++;
  }
  // Always record the filing (owned marker) — even a 0-statement report — so it isn't re-downloaded and
  // re-extracted (re-charged) every run. title = the period label; filed_at unknown here → now().
  await sql`insert into public.filings (security_id, venue_code, source_ref, filing_type, title, filed_at, pdf_storage_key)
            values (${secId}, 'BHB', ${doc.sourceRef}, 'RESULTS', ${doc.periodTitle.slice(0, 200) || doc.sourceRef}, now(), ${storageKey})
            on conflict (venue_code, source_ref) do update set pdf_storage_key=excluded.pdf_storage_key`;
  return n;
}

/** Write ONLY the public.filings owned-marker (no statement rows) for a genuinely-unreadable PDF, so it is
 *  not re-downloaded + re-attempted (burning an FSPDF_MAX slot) on every run. */
async function markOwned(sql, cs, d, storageKey) {
  const sec = await sql`select id from public.securities where venue_code='BHB' and ticker=${cs} limit 1`;
  if (!sec[0]) return;
  await sql`insert into public.filings (security_id, venue_code, source_ref, filing_type, title, filed_at, pdf_storage_key)
            values (${sec[0].id}, 'BHB', ${d.sourceRef}, 'RESULTS', ${d.periodTitle.slice(0, 200) || d.sourceRef}, now(), ${storageKey})
            on conflict (venue_code, source_ref) do update set pdf_storage_key=excluded.pdf_storage_key`;
}

// ── main ──
const t0 = Date.now();
const sql = postgres(SUPABASE_DB_URL, { max: 2, prepare: false });
let symbols;
if (process.env.ACQUIRE_SYMBOLS) symbols = process.env.ACQUIRE_SYMBOLS.split(',').map((s) => s.trim()).filter(Boolean);
else { const start = Number(process.env.CHUNK_START || 0), size = Number(process.env.CHUNK_SIZE || 8); symbols = (await sql`select ticker from public.securities where venue_code='BHB' and status='listed' order by ticker offset ${start} limit ${size}`).map((r) => r.ticker); }
const ownedRefs = new Set((await sql`select source_ref from public.filings where venue_code='BHB' and source_ref like 'BHB-FS-%'`).map((r) => r.source_ref));
log(`bhb-financials — ${symbols.length} companies, ${ownedRefs.size} PDFs owned, FSPDF_MAX ${FSPDF_MAX}/run`);

let companies = 0, pdfNew = 0, rowsW = 0, budget = FSPDF_MAX;
for (const cs of symbols) {
  if (budget <= 0) { log('  FSPDF_MAX budget exhausted — stopping'); break; }
  if (Date.now() - t0 > RUN_BUDGET_MS) { log('  run budget reached — stopping'); break; }
  try {
    const res = await webapiGet(companyFinancialStatementsUrl(cs));
    if (!res.ok) { log(`  ${cs} index fetch fail: ${res.err}`); companies++; continue; }
    const docs = parseCompanyFinancialStatements(res.body);
    const gaps = docs.filter((d) => !ownedRefs.has(d.sourceRef));
    log(`  ${cs}: ${docs.length} statement pdfs, ${gaps.length} new (owned ${docs.length - gaps.length})`);
    for (const d of gaps) {
      if (budget <= 0) break;
      if (Date.now() - t0 > RUN_BUDGET_MS) break;
      const got = await fetchPdf(d.url);
      if (got.err || got.magic !== '%PDF-') { log(`    ${d.fileId} pdf fetch fail: ${got.err || got.magic}`); continue; }
      const ex = extractViaClaude(got.buf);
      budget--;
      if (ex.error) {
        log(`    ${d.fileId} extract: ${ex.error}`);
        if (ex.permanent) {
          // unreadable even after OCR — archive + owned-mark so it never burns a budget slot again.
          const key = `bhb/${cs}/${createHash('sha256').update(got.buf).digest('hex')}.pdf`;
          await uploadPdf(key, got.buf);
          await markOwned(sql, cs, d, key);
          ownedRefs.add(d.sourceRef); pdfNew++;
        }
        continue; // transient (non-permanent) → left un-owned, retries next run
      }
      const key = `bhb/${cs}/${createHash('sha256').update(got.buf).digest('hex')}.pdf`;
      await uploadPdf(key, got.buf);
      const nrows = await persist(sql, cs, ex.statements, key, d);
      ownedRefs.add(d.sourceRef); pdfNew++; rowsW += nrows;
      log(`    ${nrows ? '✓' : '·'} ${d.periodTitle.slice(0, 48)} → ${ex.statements.periods.length}p → ${nrows} rows (budget ${budget})`);
    }
    companies++;
  } catch (e) { log(`  ${cs} err ${String(e).slice(0, 70)}`); companies++; }
}
await sql.end();
log(`DONE ${(Date.now() - t0) / 1000 | 0}s | companies ${companies}/${symbols.length} | new PDFs ${pdfNew} | rows ${rowsW} | budget left ${budget}`);
