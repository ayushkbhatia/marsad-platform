#!/usr/bin/env node
/**
 * DFM (Dubai Financial Market) financials BACKFILL — Class-A, $0, no browser / proxy / Xvfb.
 *
 * Unlike the Tadawul researcher (headed Chromium through the metered Geonode proxy, because
 * saudiexchange.sa is Akamai-blocked from VPS IPs), DFM is reachable with a plain HTTP GET from any IP
 * (verified 2026-07-16: eFsah list 200/~235ms, PDF host 200; no WAF challenge). So there is NO proxy,
 * NO OOM ceiling, NO IP rotation here — it is a lightweight direct-fetch worker.
 *
 * DFM publishes financial statements as **PDF only** (no issuer XBRL, verified), so this LLM path is the
 * SOLE statements producer for DFM — there is no XBRL-researcher twin. Per company:
 *   1. GET eFsah `types=financial_reports&symbol=<CS>&take=N`  → list of statement filings (5y deep).
 *   2. For each period NOT already covered in public.financial_statements: download the PDF from
 *      feeds.dfm.ae/documents (the real document host — api2.dfm.ae 404s, see adapters/dfm/filings.ts).
 *   3. Extract with `claude -p` (sonnet, $0 on the Claude Code subscription seat — the wrapper unsets
 *      ANTHROPIC_API_KEY), gate, persist at source_rank 20 → lake.objects FILING.FINANCIALS →
 *      lake.fn_financials_project → public.financial_statements.
 *   4. Archive + catalogue the PDF in the 'filings' bucket (pdf_storage_key = dfm/<CS>/<sha-ish name>).
 *
 * Incremental + resumable: gates on PERIOD coverage (financial_statements.fiscal_period), so a re-run
 * (or a fresh filing) only spends LLM budget on genuinely-uncovered periods. A ticker absent from
 * public.securities is skipped + logged (the names the DFM securities reconciliation must add).
 *
 * PARALLEL: CONCURRENCY (default 4) `claude -p` extractions run at once (async spawn), so a run clears
 * several names instead of ~1. FSPDF_MAX is the GLOBAL per-run extraction budget; RUN_BUDGET_MS self-stops
 * before the wrapper's `timeout` so the DONE line always prints (a SIGKILLed run with no DONE holds the
 * chunk cursor at its current offset and retries). Bounded by the Claude subscription rate limit — a throttled call logs `extract: claude …`
 * and retries next run (no data loss). Watch the box: CONCURRENCY parallel claude+pdftotext on the 3.8 GB
 * VPS — the systemd unit caps it with MemoryHigh so it can't OOM the co-resident marsad-worker.
 *
 *   ACQUIRE_SYMBOLS=EMAAR,DIB  FSPDF_MAX=8  node dfm-backfill.mjs               # explicit list
 *   CHUNK_START=0 CHUNK_SIZE=12 CONCURRENCY=4 FSPDF_MAX=48 node dfm-backfill.mjs  # slice, 4-wide
 */
import { spawn } from 'node:child_process';
const ING = '/opt/marsad/ingestion';
const { extractToStatements, EXTRACTION_SYSTEM, buildExtractionUserMessage } = await import(`${ING}/dist/lake/statement-extraction.js`);
const postgres = (await import('/opt/marsad/worker/node_modules/postgres/src/index.js').then(m => m.default ?? m));

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL } = process.env;
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL }))
  if (!v) { console.error(`missing env ${k}`); process.exit(1); }

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'haiku';
const FSPDF_MAX = Number(process.env.FSPDF_MAX || 48);      // total LLM extractions/run (global budget) — rate-limit guard
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);   // parallel `claude -p` extractions (async spawn); 3 balances speed vs the subscription's concurrent-session throttle (4 saw ~37% claude exit-1)
const RUN_BUDGET_MS = Number(process.env.RUN_BUDGET_MS || 1000000); // self-stop ~16.7 min — well before the wrapper's timeout, so the DONE line always prints (a SIGKILLed run with no DONE holds the cursor at its current offset and retries)
const TAKE = Number(process.env.EFSAH_TAKE || 50);    // eFsah page size — 50 covers ~5y of quarterly+annual
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// eFsah disclosure list feed (JSON) + the real document (PDF) host. See adapters/dfm/filings.ts for the
// api2-vs-feeds split (api2 is the LIST host and 404s on a resource GET).
const EFSAH = 'https://api2.dfm.ae/efsah/v1/prototype_efsah';
const DOCS_ORIGIN = 'https://feeds.dfm.ae/documents';

function stripBom(s) { return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s; }

/** Absolute PDF url from an eFsah resources[].r_path (CDN-relative; spaces percent-encoded to match the portal). */
function resolvePdfUrl(rPath) {
  if (/^https?:\/\//i.test(rPath)) return rPath;
  const rel = (rPath.startsWith('/') ? rPath : `/${rPath}`).replace(/ /g, '%20');
  return `${DOCS_ORIGIN}${rel}`;
}

// report_interval / headline → the fiscal period it reports, in the same shape financial_statements stores
// ('Q1 2025' | '2024'). Pre-filter only — the extractor reads the REAL periods from the PDF; this just
// avoids re-charging the LLM for an already-covered period. null ⇒ can't tell ⇒ don't pre-skip.
function candidatePeriod(headline, interval) {
  const ym = /(20\d{2})/.exec(String(headline || ''));
  const y = ym ? ym[1] : null;
  if (!y) return null;
  const iv = String(interval || '').toLowerCase();
  if (iv === 'q1' || /1st\s*qtr/i.test(headline)) return `Q1 ${y}`;
  if (iv === 'q2' || /2n?d\s*qtr/i.test(headline)) return `Q2 ${y}`;
  if (iv === 'q3' || /3rd\s*qtr/i.test(headline)) return `Q3 ${y}`;
  if (iv === 'yearly' || /year of|annual/i.test(headline)) return y;
  return null; // 'Preliminary financial results' / unknown → let the extractor decide
}

/** GET the eFsah financial_reports list for one issuer. Returns [{id, headline, interval, filedRaw, pdfUrl, fname}]. */
async function efsahFinancials(cs) {
  const url = `${EFSAH}?types=financial_reports&announcement_type=Disclosure&symbol=${encodeURIComponent(cs)}&take=${TAKE}&lang=en&cms_resources=true`;
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': UA } });
  if (!r.ok) throw new Error(`efsah ${r.status}`);
  let payload;
  try { payload = JSON.parse(stripBom(await r.text())); } catch { return []; }
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.root) ? payload.root : [];
  const out = [];
  for (const row of rows) {
    const id = String(row?.id ?? '').trim();
    if (!id) continue;
    const resources = Array.isArray(row?.resources) ? row.resources : [];
    // Prefer the English PDF resource; fall back to the first .pdf resource.
    const en = resources.find((x) => String(x?.language).toLowerCase() === 'en' && /\.pdf$/i.test(String(x?.r_path || '')));
    const any = resources.find((x) => /\.pdf$/i.test(String(x?.r_path || '')));
    const res = en ?? any;
    if (!res) continue;
    const rPath = String(res.r_path);
    out.push({
      id,
      headline: String(row?.headline ?? '').trim(),
      interval: String(row?.report_interval ?? '').trim(),
      filedRaw: String(row?.publication_date ?? '').trim(),
      pdfUrl: resolvePdfUrl(rPath),
      fname: rPath.split('/').pop() || `${id}.pdf`,
    });
  }
  return out;
}

/** Plain HTTP download → Buffer, with a %PDF magic-byte check. */
async function fetchPdfBuf(url) {
  const r = await fetch(url, { headers: { accept: 'application/pdf', 'user-agent': UA } });
  if (!r.ok) return { err: `http ${r.status}` };
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 5 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') return { err: 'not a pdf' };
  return { buf };
}

// Async subprocess runner (spawn, not spawnSync — spawnSync blocks the single Node thread, so N of them
// can never overlap). Writes `input` to stdin, collects stdout, SIGKILLs after timeoutMs. Returns {code,out}.
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

// PDF text → `claude -p` (sonnet, seat credit) → normalized statements. Venue-agnostic extractor, DFM-tagged.
// ASYNC so CONCURRENCY of these run in parallel (the whole point of the speed-up).
async function extractViaClaude(buf, cs) {
  const t = await runProc('pdftotext', ['-layout', '-', '-'], buf, 60000);
  const full = t.out.toString();
  if (full.length < 400) return { error: 'no text layer' };
  const userMsg = buildExtractionUserMessage(full, 120000);
  const prompt = `${EXTRACTION_SYSTEM}\n\nThe filing text is on stdin. Return ONLY the JSON object of shape {"currency","scale","statements":[...]} — no prose, no code fences.`;
  const args = ['-p', prompt, '--output-format', 'json', '--model', CLAUDE_MODEL];
  let r = await runProc('claude', args, userMsg, 240000);
  if (r.code !== 0) {
    // One retry with a jittered backoff — smooths a transient throttle when several extractions overlap.
    await new Promise((res) => setTimeout(res, 3000 + Math.floor(Math.random() * 5000)));
    r = await runProc('claude', args, userMsg, 240000);
  }
  if (r.code !== 0) return { error: `claude ${r.code}${r.err ? ' — ' + r.err : ''}` };
  let out = r.out.toString(); try { const env = JSON.parse(out); if (typeof env.result === 'string') out = env.result; } catch { /* raw */ }
  const mm = out.match(/\{[\s\S]*\}/); if (!mm) return { error: 'no json' };
  let parsed; try { parsed = JSON.parse(mm[0]); } catch { return { error: 'bad json' }; }
  if (!Array.isArray(parsed.statements)) return { error: 'no statements' };
  return extractToStatements(parsed, 'DFM', cs);
}

async function uploadPdf(key, buf) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/filings/${key}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'content-type': 'application/pdf', 'x-upsert': 'true' },
    body: buf,
  });
  return r.ok;
}

// Sanitize one storage-path segment (mirrors adapters/filings-detail.ts sanitizeSeg).
function sanitizeSeg(s) {
  const cleaned = String(s).trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned === '' ? '_unmapped' : cleaned;
}

async function persist(sql, cs, secId, statements, storageKey, sourceRef, filedAtIso) {
  const agent = await sql`select id from iam.principals where handle='SYSTEM' limit 1`;
  const pr = await sql`insert into lake.parse_runs (agent_id, parser_key, parser_version, status) values (${agent[0].id}, 'dfm_fspdf_llm', '1', 'succeeded') returning id`;
  let n = 0;
  for (const p of statements.periods) {
    const nk = `FINANCIALS:DFM:${cs}:${p.statementType}:${p.fiscalPeriod}`;
    const live = await sql`select id, revision, state, source_rank from lake.objects where natural_key=${nk} and superseded_by is null limit 1`;
    // Downgrade guard: never replace a better/equal source with this LLM PDF (rank 20). DFM is PDF-only
    // today, so this mostly no-ops re-extractions of an already-persisted period.
    if (live[0] && live[0].source_rank <= 20) continue;
    const payload = { statement_type: p.statementType, period_kind: p.periodKind, fiscal_period: p.fiscalPeriod, period_end: p.periodEnd, currency: p.currency, basis: 'consolidated', line_items: p.lineItems };
    if (live[0] && live[0].state === 'VERIFIED') {
      const nid = (await sql`select gen_random_uuid() as id`)[0].id;
      await sql`update lake.objects set superseded_by=${nid}, state='RETIRED' where id=${live[0].id}`;
      await sql`insert into lake.objects (id,object_type,natural_key,security_id,venue_code,payload,state,revision,parse_run_id,source_rank) values (${nid},'FILING.FINANCIALS',${nk},${secId},'DFM',${sql.json(payload)},'PENDING',${live[0].revision + 1},${pr[0].id},20)`;
    } else if (live[0]) {
      await sql`update lake.objects set payload=${sql.json(payload)}, revision=${live[0].revision + 1}, parse_run_id=${pr[0].id}, source_rank=20 where id=${live[0].id}`;
    } else {
      await sql`insert into lake.objects (object_type,natural_key,security_id,venue_code,payload,state,revision,parse_run_id,source_rank) values ('FILING.FINANCIALS',${nk},${secId},'DFM',${sql.json(payload)},'PENDING',1,${pr[0].id},20)`;
    }
    n++;
  }
  // Always record the filing (owned marker) — even a 0-statement PDF, so it isn't re-fetched/re-charged.
  await sql`insert into public.filings (security_id, venue_code, source_ref, filing_type, title, filed_at, pdf_storage_key)
            values (${secId}, 'DFM', ${sourceRef}, 'RESULTS', ${sourceRef.slice(0, 200)}, ${filedAtIso ? filedAtIso : sql`now()`}, ${storageKey})
            on conflict (venue_code, source_ref) do update set pdf_storage_key=excluded.pdf_storage_key`;
  return n;
}

// DFM (Dubai) local offset — UTC+4, no DST. eFsah publication_date is a naive Dubai wall-clock.
const DFM_MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function filedIso(s) {
  const m = /^([A-Za-z]{3,})\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/.exec(String(s || '').trim());
  if (!m) return null;
  const mo = DFM_MONTHS[(m[1] || '').slice(0, 3).toLowerCase()];
  if (mo === undefined) return null;
  const utcMs = Date.UTC(Number(m[3]), mo, Number(m[2]), Number(m[4]), Number(m[5]), Number(m[6])) - 4 * 3600 * 1000;
  return Number.isFinite(utcMs) ? new Date(utcMs).toISOString() : null;
}

// ── main ──
const t0 = Date.now();
const sql = postgres(SUPABASE_DB_URL, { max: 8, prepare: false }); // headroom for CONCURRENCY parallel persists
let symbols;
if (process.env.ACQUIRE_SYMBOLS) symbols = process.env.ACQUIRE_SYMBOLS.split(',').map((s) => s.trim()).filter(Boolean);
else {
  const start = Number(process.env.CHUNK_START || 0), size = Number(process.env.CHUNK_SIZE || 10);
  symbols = (await sql`select ticker from public.securities where venue_code='DFM' and status='listed' order by ticker offset ${start} limit ${size}`).map((r) => r.ticker);
}
const runDeadline = t0 + RUN_BUDGET_MS;
log(`dfm-backfill — ${symbols.length} companies, FSPDF_MAX ${FSPDF_MAX}/run, conc ${CONCURRENCY}, take ${TAKE}`);

let companies = 0, pdfNew = 0, rowsW = 0, noSec = 0, budget = FSPDF_MAX;

// Extract a name's gap PDFs through a pool of CONCURRENCY parallel workers (download + claude + persist).
// JS is single-threaded, so the shared counters/budget mutate atomically between awaits — no locking needed.
async function extractGaps(gaps, cs, secId) {
  let gi = 0;
  async function worker() {
    while (true) {
      if (budget <= 0 || Date.now() > runDeadline) return;
      const i = gi++;
      if (i >= gaps.length) return;
      const f = gaps[i];
      budget--; // reserve a slot up front so parallel workers respect the global cap
      try {
        const got = await fetchPdfBuf(f.pdfUrl);
        if (got.err) { log(`    ${f.fname} fetch: ${got.err}`); continue; }
        const ex = await extractViaClaude(got.buf, cs);
        if (ex.error) { log(`    ${f.fname} extract: ${ex.error}`); continue; } // transient — retry next run
        const key = `dfm/${sanitizeSeg(cs)}/${sanitizeSeg(f.fname)}`;
        await uploadPdf(key, got.buf);
        const nrows = await persist(sql, cs, secId, ex.statements, key, `DFM-FSPDF-${f.id}`, filedIso(f.filedRaw));
        pdfNew++; rowsW += nrows;
        log(`    ${nrows ? '✓' : '·'} ${f.fname} → ${ex.statements.periods.length}p → ${nrows} new rows (budget ${budget})`);
      } catch (e) { log(`    ${f.fname} err ${String(e).slice(0, 70)}`); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, gaps.length) }, () => worker()));
}

for (const cs of symbols) {
  if (budget <= 0 || Date.now() > runDeadline) break;
  try {
    const sec = await sql`select id from public.securities where venue_code='DFM' and ticker=${cs} limit 1`;
    if (!sec[0]) { log(`  ${cs}: no security row — skipping (needs DFM universe reconciliation)`); noSec++; companies++; continue; }
    const secId = sec[0].id;
    const filings = await efsahFinancials(cs);
    const covered = new Set((await sql`select distinct fiscal_period from public.financial_statements where security_id=${secId}`).map((r) => r.fiscal_period));
    // Uncovered candidates: a candidatePeriod we don't yet have (null candidate ⇒ include — let the extractor judge).
    const gaps = filings.filter((f) => { const per = candidatePeriod(f.headline, f.interval); return per === null || !covered.has(per); });
    log(`  ${cs}: ${filings.length} reports, ${gaps.length} gap-candidates (covered ${covered.size} periods)`);
    await extractGaps(gaps, cs, secId);
    companies++;
  } catch (e) { log(`  ${cs} err ${String(e).slice(0, 80)}`); companies++; }
}
await sql.end();
log(`DONE ${(Date.now() - t0) / 1000 | 0}s | companies ${companies}/${symbols.length} | new PDFs ${pdfNew} | rows ${rowsW} | no-security ${noSec} | conc ${CONCURRENCY} | budget left ${budget}${Date.now() > runDeadline ? ' | deadline-cut' : ''}`);
