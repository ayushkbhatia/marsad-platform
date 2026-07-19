#!/usr/bin/env node
/**
 * MSX statement EXTRACTOR (Phase C2, DEF-MSX-STMT-EXTRACT) — projects the ALREADY-ARCHIVED MSX
 * financial-report PDFs into public.financial_statements. Zero scraping: `msx-financials.mjs` owns
 * the artifacts (2,251+ filings rows `MSX-FS-<ReportID>` with pdf_storage_key + a full member manifest
 * in extracted_facts.msx_report/documents). This is the deferred extractor that manifest was built for.
 *
 * Per uncovered report (newest first — recent periods are the reader-valuable ones):
 *   1. storage GET filings.pdf_storage_key (the richest member — CompanyReport, else FilingInformation).
 *   2. pdftotext -layout (MSX PDFs are XBRL-rendered → text layer is normally good); page-by-page OCR
 *      fallback for the scanned stragglers.
 *   3. `claude -p` EXTRACTION_SYSTEM → validation gate → extractToStatements('MSX', ticker).
 *   4. persist at source_rank 20 (natural key FINANCIALS:MSX:<t>:<type>:<fp>, the fleet contract) with
 *      `filing_source_ref` so projection v3.1 links financial_statements.source_filing_id → the filing.
 *
 * Incremental via the COVERAGE GATE (like dfm-backfill): a report whose candidate fiscal period is
 * already served costs zero LLM. The msx_report metadata gives period_kind + period_end + FISCAL
 * report_year up front, so the pre-filter is sharp. Budgeted: MSX_MAX extractions/run, CONCURRENCY
 * parallel, RUN_BUDGET_MS self-stop.
 *
 *   ACQUIRE_SYMBOLS=BKMB,OQGN MSX_MAX=6 node msx-stmt-extract.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ING = '/opt/marsad/ingestion';
const { extractToStatements, EXTRACTION_SYSTEM, buildExtractionUserMessage } = await import(`${ING}/dist/lake/statement-extraction.js`);
const postgres = (await import('/opt/marsad/worker/node_modules/postgres/src/index.js').then(m => m.default ?? m));

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL } = process.env;
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL }))
  if (!v) { console.error(`missing env ${k}`); process.exit(1); }

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'sonnet';
const MSX_MAX = Number(process.env.MSX_MAX || 14);
const CONCURRENCY = Number(process.env.CONCURRENCY || 2);
const RUN_BUDGET_MS = Number(process.env.RUN_BUDGET_MS || 1000000);
const OCR_MAX_PAGES = Number(process.env.OCR_MAX_PAGES || 60);
const OCR_DPI = Number(process.env.OCR_DPI || 200);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function pdfToText(buf) {
  const r = spawnSync('pdftotext', ['-layout', '-', '-'], { input: buf, maxBuffer: 6e7 });
  return r.status === 0 ? r.stdout.toString() : '';
}
function ocrToText(buf) {
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'msxocr-'));
    const pdf = join(dir, 'in.pdf');
    writeFileSync(pdf, buf);
    let text = '';
    for (let pg = 1; pg <= OCR_MAX_PAGES; pg++) {
      const rp = spawnSync('pdftoppm', ['-png', '-r', String(OCR_DPI), '-f', String(pg), '-l', String(pg), pdf, join(dir, 'pg')], { maxBuffer: 6e7 });
      if (rp.status !== 0) break;
      const imgs = readdirSync(dir).filter((f) => f.startsWith('pg') && f.endsWith('.png'));
      if (imgs.length === 0) break;
      const abs = join(dir, imgs[0]);
      const t = spawnSync('tesseract', [abs, 'stdout', '-l', 'eng', '--psm', '6'], { maxBuffer: 4e7 });
      if (t.status === 0) text += (t.stdout?.toString() || '') + '\n';
      try { unlinkSync(abs); } catch { /* */ }
      if (text.length > 400000) break;
    }
    return text;
  } catch { return ''; } finally {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
  }
}
function runProc(cmd, args, input, timeoutMs) {
  return new Promise((resolve) => {
    const ch = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = []; let killed = false;
    const to = timeoutMs ? setTimeout(() => { killed = true; ch.kill('SIGKILL'); }, timeoutMs) : null;
    ch.stdout.on('data', (d) => out.push(d));
    ch.stderr.on('data', (d) => err.push(d));
    ch.on('error', (e) => { if (to) clearTimeout(to); resolve({ code: -1, out: Buffer.concat(out), err: String(e) }); });
    ch.on('close', (code) => { if (to) clearTimeout(to); resolve({ code: killed ? 124 : code, out: Buffer.concat(out), err: Buffer.concat(err).toString().slice(0, 200).replace(/\s+/g, ' ').trim() }); });
    if (input != null) ch.stdin.write(input);
    ch.stdin.end();
  });
}

async function extractViaClaude(buf, cs) {
  let full = pdfToText(buf);
  if (full.replace(/\s+/g, '').length < 400) full = ocrToText(buf);
  if (full.replace(/\s+/g, '').length < 400) return { error: 'no text layer (OCR empty)', permanent: true };
  const userMsg = buildExtractionUserMessage(full, 120000);
  const prompt = `${EXTRACTION_SYSTEM}\n\nThe filing text is on stdin. Return ONLY the JSON object of shape {"currency","scale","statements":[...]} — no prose, no code fences.`;
  const args = ['-p', prompt, '--output-format', 'json', '--model', CLAUDE_MODEL];
  let r = await runProc('claude', args, userMsg, 240000);
  if (r.code !== 0) {
    await new Promise((res) => setTimeout(res, 3000 + Math.floor(Math.random() * 5000)));
    r = await runProc('claude', args, userMsg, 240000);
  }
  if (r.code !== 0) return { error: `claude ${r.code}${r.err ? ' — ' + r.err : ''}` };
  let out = r.out.toString(); try { const env = JSON.parse(out); if (typeof env.result === 'string') out = env.result; } catch { /* raw */ }
  const mm = out.match(/\{[\s\S]*\}/); if (!mm) return { error: 'no json' };
  let parsed; try { parsed = JSON.parse(mm[0]); } catch { return { error: 'bad json' }; }
  if (!Array.isArray(parsed.statements)) return { error: 'no statements' };
  return extractToStatements(parsed, 'MSX', cs);
}

async function fetchStoredPdf(key) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/filings/${key}`, { headers: { authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } });
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-' ? buf : null;
}

// msx_report metadata → the fiscal period this report covers ('Q1 2026' | '2025'). MSX report_year is
// FISCAL; quarters derive from period_end. null ⇒ can't tell ⇒ include (the extractor reads real periods).
function candidatePeriod(rep) {
  const kind = String(rep?.period_kind || '').toLowerCase();
  const pe = String(rep?.period_end || '');
  const m = /^(\d{4})-(\d{2})/.exec(pe);
  if (kind === 'annual') return String(rep?.report_year || (m ? m[1] : '')) || null;
  if (kind === 'quarter' && m) return `Q${Math.floor((Number(m[2]) - 1) / 3) + 1} ${m[1]}`;
  return null;
}

async function persist(sql, cs, secId, statements, sourceRef) {
  const agent = await sql`select id from iam.principals where handle='SYSTEM' limit 1`;
  const pr = await sql`insert into lake.parse_runs (agent_id, parser_key, parser_version, status) values (${agent[0].id}, 'msx_pdf_llm', '1', 'succeeded') returning id`;
  let n = 0;
  for (const p of statements.periods) {
    const nk = `FINANCIALS:MSX:${cs}:${p.statementType}:${p.fiscalPeriod}`;
    const live = await sql`select id, revision, state, source_rank from lake.objects where natural_key=${nk} and superseded_by is null limit 1`;
    if (live[0] && live[0].source_rank <= 20) continue; // never downgrade a better source
    const payload = { statement_type: p.statementType, period_kind: p.periodKind, fiscal_period: p.fiscalPeriod, period_end: p.periodEnd, currency: p.currency, basis: 'consolidated', line_items: p.lineItems,
      ...(sourceRef ? { filing_source_ref: sourceRef } : {}) };
    if (live[0] && live[0].state === 'VERIFIED') {
      const nid = (await sql`select gen_random_uuid() as id`)[0].id;
      await sql`update lake.objects set superseded_by=${nid}, state='RETIRED' where id=${live[0].id}`;
      await sql`insert into lake.objects (id,object_type,natural_key,security_id,venue_code,payload,state,revision,parse_run_id,source_rank) values (${nid},'FILING.FINANCIALS',${nk},${secId},'MSX',${sql.json(payload)},'PENDING',${live[0].revision + 1},${pr[0].id},20)`;
    } else if (live[0]) {
      await sql`update lake.objects set payload=${sql.json(payload)}, revision=${live[0].revision + 1}, parse_run_id=${pr[0].id}, source_rank=20 where id=${live[0].id}`;
    } else {
      await sql`insert into lake.objects (object_type,natural_key,security_id,venue_code,payload,state,revision,parse_run_id,source_rank) values ('FILING.FINANCIALS',${nk},${secId},'MSX',${sql.json(payload)},'PENDING',1,${pr[0].id},20)`;
    }
    n++;
  }
  return n;
}

// ── main ──
const t0 = Date.now();
const deadline = t0 + RUN_BUDGET_MS;
const sql = postgres(SUPABASE_DB_URL, { max: CONCURRENCY + 2, prepare: false });

// Owned-marker: reports already extracted (or permanently unreadable) — extracted_facts.stmt_extract.
// Candidates: archived MSX reports with a pdf, not yet marked, newest first.
const wantSyms = process.env.ACQUIRE_SYMBOLS ? process.env.ACQUIRE_SYMBOLS.split(',').map((s) => s.trim()).filter(Boolean) : null;
const reports = await sql`
  select f.id, f.source_ref, f.pdf_storage_key, f.security_id, s.ticker,
         f.extracted_facts -> 'msx_report' as rep
    from public.filings f
    join public.securities s on s.id = f.security_id
   where f.venue_code = 'MSX' and f.source_ref like 'MSX-FS-%'
     and f.pdf_storage_key is not null
     and (f.extracted_facts -> 'stmt_extract') is null
     ${wantSyms ? sql`and s.ticker = any(${wantSyms})` : sql``}
   order by f.filed_at desc`;

// Coverage gate: candidate period already served for that security ⇒ mark covered, spend nothing.
const covered = new Map(); // secId → Set(fiscal_period)
async function coveredSet(secId) {
  if (!covered.has(secId)) {
    covered.set(secId, new Set((await sql`select distinct fiscal_period from public.financial_statements where security_id=${secId}`).map((r) => r.fiscal_period)));
  }
  return covered.get(secId);
}

log(`msx-stmt-extract — ${reports.length} unprocessed archived reports, budget ${MSX_MAX}/run, conc ${CONCURRENCY}`);

let extracted = 0, rowsW = 0, skippedCovered = 0, failedPerm = 0, budget = MSX_MAX;
let cursor = 0;

async function worker(wid) {
  while (true) {
    if (budget <= 0 || Date.now() > deadline) return;
    const i = cursor++;
    if (i >= reports.length) return;
    const f = reports[i];
    try {
      const per = candidatePeriod(f.rep);
      const cov = await coveredSet(f.security_id);
      if (per && cov.has(per)) {
        // Served already — mark so it never re-enters the candidate list (no LLM spent).
        await sql`update public.filings set extracted_facts = coalesce(extracted_facts,'{}'::jsonb) || jsonb_build_object('stmt_extract', jsonb_build_object('state','covered','period',${per})) where id=${f.id}`;
        skippedCovered++;
        continue;
      }
      budget--;
      const buf = await fetchStoredPdf(f.pdf_storage_key);
      if (!buf) {
        await sql`update public.filings set extracted_facts = coalesce(extracted_facts,'{}'::jsonb) || jsonb_build_object('stmt_extract', jsonb_build_object('state','failed','error','storage fetch / not a pdf')) where id=${f.id}`;
        failedPerm++;
        continue;
      }
      const ex = await extractViaClaude(buf, f.ticker);
      if (ex.error) {
        if (ex.permanent) {
          await sql`update public.filings set extracted_facts = coalesce(extracted_facts,'{}'::jsonb) || jsonb_build_object('stmt_extract', jsonb_build_object('state','failed','error',${ex.error})) where id=${f.id}`;
          failedPerm++;
        } else {
          log(`  [w${wid}] ${f.source_ref} extract: ${ex.error} (transient — retry next run)`);
        }
        continue;
      }
      const n = await persist(sql, f.ticker, f.security_id, ex.statements, f.source_ref);
      for (const p of ex.statements.periods) cov.add(p.fiscalPeriod);
      await sql`update public.filings set extracted_facts = coalesce(extracted_facts,'{}'::jsonb) || jsonb_build_object('stmt_extract', jsonb_build_object('state','done','periods',${ex.statements.periods.length},'rows',${n},'rejected',${ex.validation.rejected.length})) where id=${f.id}`;
      extracted++; rowsW += n;
      log(`  [w${wid}] ✓ ${f.ticker} ${f.source_ref} → ${ex.statements.periods.length}p → ${n} rows (budget ${budget})`);
    } catch (e) { log(`  [w${wid}] ${f.source_ref} err ${String(e).slice(0, 80)}`); }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
await sql.end();
log(`DONE ${(Date.now() - t0) / 1000 | 0}s | extracted ${extracted} | rows ${rowsW} | covered-skips ${skippedCovered} | failed-permanent ${failedPerm} | budget left ${budget}`);
