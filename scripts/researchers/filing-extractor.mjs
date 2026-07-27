#!/usr/bin/env node
/**
 * FILING-FACTS EXTRACTOR (Phase C1) — the consumer of `ops.filing_extract_queue`, the seam the
 * filing_detail chain has been filling since 2026-07-16 with NOTHING draining it (DEF-FILING-FACTS).
 * The one bounded LLM cost of the filings domain, on the $0 Claude Code subscription seat.
 *
 * Per queued PDF (claimed with FOR UPDATE SKIP LOCKED, so runs can overlap safely):
 *   1. storage GET the PDF (`filings` bucket, key on the queue row) — no scraping, the detail chain
 *      already owns the bytes.
 *   2. pdftotext -layout; if no text layer, page-by-page OCR fallback (pdftoppm → tesseract, the
 *      bhb-financials #43 pattern). Still empty ⇒ state='failed' (permanent, never re-charged).
 *   3. full_text → public.filings.full_text (capped 400k; search_tsv generates from the first 200k).
 *   4. `claude -p` (sonnet) → {doc_type, ai_summary, is_market_moving, facts} → filings.ai_summary /
 *      is_market_moving / extracted_facts.ai (MERGED — MSX rows carry their archive manifest under
 *      extracted_facts.msx_report; never clobber it). filing_type upgraded from doc_type only when the
 *      venue classifier left it 'OTHER'.
 *   5. queue row → state='done'. A transient LLM miss leaves it pending (attempts++, retried next run;
 *      3 strikes ⇒ 'failed' with the error kept).
 *
 * Budgeted + self-stopping: EXTRACT_MAX per run, CONCURRENCY parallel claude calls, RUN_BUDGET_MS
 * before the wrapper timeout so the DONE line always prints.
 *
 *   EXTRACT_MAX=12 CONCURRENCY=2 node filing-extractor.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const postgres = (await import('/opt/marsad/worker/node_modules/postgres/src/index.js').then(m => m.default ?? m));

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL } = process.env;
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL }))
  if (!v) { console.error(`missing env ${k}`); process.exit(1); }

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'haiku';
const EXTRACT_MAX = Number(process.env.EXTRACT_MAX || 12);
const CONCURRENCY = Number(process.env.CONCURRENCY || 2);
const RUN_BUDGET_MS = Number(process.env.RUN_BUDGET_MS || 1000000);
const MAX_ATTEMPTS = 3;
const OCR_MAX_PAGES = Number(process.env.OCR_MAX_PAGES || 40);
const OCR_DPI = Number(process.env.OCR_DPI || 200);
const FULLTEXT_CAP = 400000;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const FACTS_SYSTEM = [
  'You are an exchange-disclosure analyst for GCC stock exchanges. You are given the extracted text of ONE',
  'listed-company filing (announcement, results note, dividend notice, AGM notice, etc.).',
  'Return ONLY a JSON object — no prose, no code fences — of the exact shape:',
  '{"doc_type":"results|dividend|agm|egm|ipo|contract|rating|governance|ops_update|board|capex|other",',
  ' "ai_summary":"2-3 tight sentences: what happened, the concrete numbers, why a shareholder cares",',
  ' "is_market_moving":bool,',
  ' "facts":{',
  '   "dividend":{"dps":num|null,"currency":"ISO3"|null,"ex_date":"YYYY-MM-DD"|null,"record_date":"YYYY-MM-DD"|null,"pay_date":"YYYY-MM-DD"|null}|null,',
  '   "earnings":{"fiscal_period":"e.g. Q1 2026 or 2025"|null,"revenue":num|null,"net_income":num|null,"eps":num|null,"currency":"ISO3"|null,"scale":"units|thousands|millions"|null}|null,',
  '   "event_date":"YYYY-MM-DD"|null,',
  '   "key_points":["...", "..."]}}',
  'RULES: numbers EXACTLY as printed (note the scale separately); a fact not printed is null — NEVER invent;',
  'is_market_moving=true only for results, dividends, M&A, major contracts, profit warnings, delistings;',
  'ai_summary must quote at least one concrete number when the filing contains any.',
].join('\n');

// ── pdf → text (with OCR fallback, page-by-page to bound memory) ──
function pdfToText(buf) {
  const r = spawnSync('pdftotext', ['-layout', '-', '-'], { input: buf, maxBuffer: 6e7 });
  return r.status === 0 ? r.stdout.toString() : '';
}
function ocrToText(buf) {
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'filex-'));
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
      if (text.length > FULLTEXT_CAP) break;
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

async function factsViaClaude(text) {
  const userMsg = `Filing text:\n\n${text.slice(0, 100000)}`;
  const args = ['-p', FACTS_SYSTEM, '--output-format', 'json', '--model', CLAUDE_MODEL];
  let r = await runProc('claude', args, userMsg, 180000);
  if (r.code !== 0) {
    await new Promise((res) => setTimeout(res, 3000 + Math.floor(Math.random() * 5000)));
    r = await runProc('claude', args, userMsg, 180000);
  }
  // Non-zero claude exit = infra/exhaustion (rate-limit exit 1, timeout, network) — NOT a content
  // problem. Flag transient so the queue never 3-strikes a good PDF into permanent 'failed' during an
  // outage. Content failures below ('no json'/'bad json'/'no summary') are real and DO count.
  if (r.code !== 0) return { error: `claude ${r.code}${r.err ? ' — ' + r.err : ''}`, transient: true };
  let out = r.out.toString(); try { const env = JSON.parse(out); if (typeof env.result === 'string') out = env.result; } catch { /* raw */ }
  const mm = out.match(/\{[\s\S]*\}/); if (!mm) return { error: 'no json' };
  try {
    const parsed = JSON.parse(mm[0]);
    if (typeof parsed.ai_summary !== 'string' || !parsed.ai_summary.trim()) return { error: 'no summary' };
    return { parsed };
  } catch { return { error: 'bad json' }; }
}

// doc_type → the public.filings.filing_type CHECK enum. Upgrade only from 'OTHER'.
const DOCTYPE_TO_FILING_TYPE = {
  results: 'RESULTS', dividend: 'DIVIDEND', agm: 'GOVERNANCE', egm: 'GOVERNANCE', ipo: 'PROSPECTUS',
  contract: 'CONTRACT', rating: 'RATING', governance: 'GOVERNANCE', ops_update: 'OPS', board: 'GOVERNANCE', capex: 'CAPEX',
};

async function fetchStoredPdf(key) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/filings/${key}`, { headers: { authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } });
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-' ? buf : null;
}

// ── main ──
const t0 = Date.now();
const deadline = t0 + RUN_BUDGET_MS;
const sql = postgres(SUPABASE_DB_URL, { max: CONCURRENCY + 1, prepare: false });

// Claim a batch: TIER-2 work only — rows whose text `tier0-triage.mjs` already recovered
// (state='text_ready'), not raw 'pending' rows (PE.1, 20260727134500). Tier 0 is deterministic and
// free; this lane is the paid `claude -p` seat, so it must never re-do work Tier 0 does better.
// A row still at 'pending' has not been triaged; a row at 'needs_ocr' has no text layer and belongs
// to Tier 1. Claims expire after 30 min so a crashed run's rows return to the pool.
const claimed = await sql`
  update ops.filing_extract_queue q
     set picked_at = now(), attempts = attempts + 1
   where q.id in (
     select id from ops.filing_extract_queue
      where state = 'text_ready' and (picked_at is null or picked_at < now() - interval '30 minutes')
      order by enqueued_at
      limit ${EXTRACT_MAX}
      for update skip locked)
  returning q.id, q.filing_id, q.venue_code, q.pdf_storage_key, q.attempts,
            (select f.full_text from public.filings f where f.id = q.filing_id) as full_text`;
log(`filing-extractor — claimed ${claimed.length} of queue (max ${EXTRACT_MAX}, conc ${CONCURRENCY})`);

let done = 0, failed = 0, retried = 0, ocrUsed = 0;
let cursor = 0;

async function worker(wid) {
  while (true) {
    if (Date.now() > deadline) return;
    const i = cursor++;
    if (i >= claimed.length) return;
    const q = claimed[i];
    const fail = async (err, permanent, transient) => {
      if (transient) {
        // Infra/exhaustion (e.g. claude exit 1): keep pending AND roll back the claim's attempts++ so a
        // prolonged outage can never accumulate toward the 3-strike cap. Never marked 'failed'.
        await sql`update ops.filing_extract_queue set error=${String(err).slice(0, 300)}, attempts=greatest(attempts - 1, 0) where id=${q.id}`;
        retried++;
        return;
      }
      if (permanent || q.attempts >= MAX_ATTEMPTS) {
        await sql`update ops.filing_extract_queue set state='failed', error=${String(err).slice(0, 300)}, done_at=now() where id=${q.id}`;
        failed++;
      } else {
        await sql`update ops.filing_extract_queue set error=${String(err).slice(0, 300)} where id=${q.id}`; // stays pending → retried
        retried++;
      }
    };
    try {
      // TIER-2 FAST PATH (PE.1): Tier 0 already parsed this document deterministically and wrote
      // public.filings.full_text. Re-downloading ~1.5MB and re-running pdftotext to recover text we
      // already hold would be pure waste — across the corpus that is ~16GB of needless egress. The
      // download/OCR path below survives only as the fallback for rows Tier 0 never reached (e.g. a
      // row hand-inserted, or an older deploy that predates the split).
      let text = (q.full_text ?? '').trim();
      if (text.replace(/\s+/g, '').length < 200) {
        const buf = await fetchStoredPdf(q.pdf_storage_key);
        if (!buf) { await fail('storage fetch failed / not a pdf', q.attempts >= MAX_ATTEMPTS); continue; }
        text = pdfToText(buf);
        if (text.replace(/\s+/g, '').length < 200) { const o = ocrToText(buf); if (o.replace(/\s+/g, '').length >= 200) { text = o; ocrUsed++; } }
        if (text.replace(/\s+/g, '').length < 200) { await fail('no text layer and OCR empty', true); continue; }
      }
      text = text.slice(0, FULLTEXT_CAP);

      const fx = await factsViaClaude(text);
      if (fx.error) { await fail(`extract: ${fx.error}`, false, fx.transient === true); continue; }
      const p = fx.parsed;
      const docType = String(p.doc_type || 'other').toLowerCase();
      const ftype = DOCTYPE_TO_FILING_TYPE[docType] || null;
      const aiFacts = { doc_type: docType, extracted_at: new Date().toISOString(), model: CLAUDE_MODEL, ...(p.facts && typeof p.facts === 'object' ? p.facts : {}) };

      await sql`update public.filings
                   set full_text        = ${text},
                       ai_summary       = ${String(p.ai_summary).slice(0, 2000)},
                       ai_summary_model = ${CLAUDE_MODEL},
                       is_market_moving = ${p.is_market_moving === true},
                       extracted_facts  = coalesce(extracted_facts, '{}'::jsonb) || jsonb_build_object('ai', ${sql.json(aiFacts)}),
                       filing_type      = case when filing_type = 'OTHER' and ${ftype}::text is not null then ${ftype} else filing_type end
                 where id = ${q.filing_id}`;
      await sql`update ops.filing_extract_queue set state='done', done_at=now(), error=null where id=${q.id}`;
      done++;
      log(`  [w${wid}] ✓ ${q.venue_code} filing ${q.filing_id} — ${docType}${p.is_market_moving ? ' ⚡market-moving' : ''} (${done}/${claimed.length})`);
    } catch (e) {
      await fail(String(e).slice(0, 200), false).catch(() => {});
      log(`  [w${wid}] ${q.pdf_storage_key} err ${String(e).slice(0, 90)}`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, claimed.length) }, (_, i) => worker(i)));
await sql.end();
log(`DONE ${(Date.now() - t0) / 1000 | 0}s | extracted ${done} | failed-permanent ${failed} | left-for-retry ${retried} | ocr ${ocrUsed} | claimed ${claimed.length}`);
