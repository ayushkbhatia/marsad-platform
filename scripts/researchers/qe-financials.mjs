#!/usr/bin/env node
/**
 * QE (Qatar Exchange) financials RESEARCHER — $0, XBRL-native, deterministic, no LLM.
 *
 * Mirrors tadawul-researcher.mjs's contract (incremental `owned` skip, chunked universe walk, run
 * deadline, DONE line for the cron cursor) but is MUCH cheaper: QE serves its XBRL facts as plain
 * JSON over plain HTTP, so this is a **Class-A-cheap** job —
 *   NO Playwright, NO headful chrome, NO xvfb, NO residential proxy, NO scrape-guardrails.
 * That is the whole point: none of the 9GB/night Class-B bandwidth exposure applies here
 * (docs/architecture/08-worker-fleet.md §6). If you ever find yourself adding a browser to this
 * file, stop — the endpoint does not need one.
 *
 * TRANSPORT — read the curlBatch() comment before touching it. From the VPS datacenter IP, QE
 * TARPITS every new TCP connection (~15s to establish; a residential IP gets ~100ms) AND resets
 * node/undici's TLS handshake outright (fingerprint block, same shape as TDWL's Akamai). So we fetch
 * via **curl** (its OpenSSL handshake is accepted) and reuse ONE keep-alive connection per company,
 * paying the 15s tarpit once per company instead of once per request. This is also why the live QE
 * quote board (id 10, undici) has been failing since it started being reset — a separate incident.
 *
 * Per (company, period):
 *   getFilingDetails=1 -> exists? + filedAt
 *   3 × sectionName    -> parseQeFinancials -> extractToStatements (gate) -> FILING.FINANCIALS
 *                         lake objects -> fn_financials_project -> public.financial_statements
 *   2 × attachmentType -> archive the Detailed report + Detailed XBRL PDFs to the `filings` bucket
 *
 * The PDFs are ARCHIVED, never parsed. QE's "Detailed XBRL" (attachmentType=3) is a *rendered PDF*,
 * not an instance document — the JSON above is the machine-readable form, so extracting a PDF would
 * cost an LLM/OCR pass to reproduce data we already have exactly. Pre-2020 history has no XBRL at
 * all and is out of scope here (DEF-STMT-LLM-PDF).
 *
 *   ACQUIRE_SYMBOLS=QIBK,DOHI  node qe-financials.mjs     # explicit list
 *   CHUNK_START=0 CHUNK_SIZE=16 node qe-financials.mjs    # slice of the QE universe
 *   QE_DRY_RUN=1 …                                        # fetch + parse + report, ZERO writes
 *
 * ⚠ SHARED HOST. www.qe.com.qa also serves the LIVE quote board (source id 10). A rude backfill that
 * gets us throttled takes QE quotes down with it. Hence: CONCURRENCY=1 (one keep-alive connection at
 * a time), QE_DOC_MAX per run, and a timer scheduled OUTSIDE the 09:30-13:15 Asia/Qatar session. The
 * per-request pacing is now implicit — the 15s connect tarpit is itself the rate limit.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ING = '/opt/marsad/ingestion';
const { parseQeFinancials, parseQeFilingDetail, QE_SECTIONS } = await import(`${ING}/dist/adapters/qe/financials.js`);
const { extractToStatements } = await import(`${ING}/dist/lake/statement-extraction.js`);
const postgres = await import('/opt/marsad/worker/node_modules/postgres/src/index.js').then((m) => m.default ?? m);

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL } = process.env;
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL }))
  if (!v) { console.error(`missing env ${k}`); process.exit(1); }

const API = 'https://www.qe.com.qa/qdisclosure/api/XBRL';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const DRY = process.env.QE_DRY_RUN === '1';
// QE's XBRL era starts in 2020 — verified 0 for 2016-2019 across every company sampled. Probing
// below the floor is pure waste against a shared host. (Mirrors ADX_MIN_YEAR.)
const MIN_YEAR = Number(process.env.QE_MIN_YEAR || 2020);
const DOC_MAX = Number(process.env.QE_DOC_MAX || 40);
// ONE company at a time by default. The VPS datacenter IP is TARPITTED by QE — every *new* TCP
// connection to www.qe.com.qa costs ~15s to establish (a residential IP gets ~100ms; this is
// IP-reputation throttling), and node/undici is RESET outright (TLS-fingerprint block, like TDWL's
// Akamai — curl's OpenSSL handshake is accepted, undici's is not). So we (a) fetch via curl, never
// undici, and (b) reuse ONE keep-alive connection per company across all its requests — a batch of
// 100+ requests then pays the 15s tarpit ONCE. Running companies in parallel would open N
// simultaneous tarpitted connections to a host that also serves the LIVE quote board (id 10); keep
// it to 1 unless you have a specific reason.
const CONCURRENCY = Number(process.env.CONCURRENCY || 1);
// Generous per-batch ceiling: a full-backfill company batch is ~150 requests behind one 15s connect,
// and PDF batches move 1-2 MB files; well clear of the wrapper's 800s SIGTERM.
const BATCH_TIMEOUT_S = Number(process.env.QE_BATCH_TIMEOUT_S || 300);
const CONNECT_TIMEOUT_S = Number(process.env.QE_CONNECT_TIMEOUT_S || 40);

const t0 = Date.now();
// Self-terminate before the wrapper's SIGTERM so DONE always prints — the cron advances the cursor
// by the completed count, and a killed run with no DONE resets it to 0 and loses the chunk.
const runDeadline = t0 + Number(process.env.RUN_BUDGET_MS || 680000);
const outOfTime = () => Date.now() > runDeadline;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch many URLs through ONE curl process (keep-alive) so the 15s connect tarpit is paid once.
 * Bodies are written to files — this handles binary PDFs cleanly and avoids stdout-splitting — while
 * per-transfer HTTP status comes back on stdout, one `<i> <code>` line per --next segment.
 * reqs: [{ id, url }]. Returns Map id -> { status, file|null }, plus a hidden _dir to clean up.
 */
function curlBatch(reqs) {
  return new Promise((resolve) => {
    if (reqs.length === 0) { const m = new Map(); m._dir = null; return resolve(m); }
    const dir = mkdtempSync(join(tmpdir(), 'qe-'));
    const args = ['-sS', '--compressed', '-m', String(BATCH_TIMEOUT_S), '--connect-timeout', String(CONNECT_TIMEOUT_S), '-A', UA];
    reqs.forEach((r, i) => {
      if (i > 0) args.push('--next');
      args.push('-o', join(dir, String(i)), '-w', `${i} %{http_code}\\n`, r.url);
    });
    execFile('curl', args, { maxBuffer: 5e6 }, (_err, stdout) => {
      const codes = new Map();
      for (const line of String(stdout || '').split('\n')) {
        const m = /^(\d+) (\d+)$/.exec(line.trim());
        if (m) codes.set(Number(m[1]), Number(m[2]));
      }
      const out = new Map();
      reqs.forEach((r, i) => {
        const f = join(dir, String(i));
        out.set(r.id, { status: codes.get(i) ?? 0, file: existsSync(f) ? f : null });
      });
      out._dir = dir;
      resolve(out);
    });
  });
}

/** Read a batch entry as parsed JSON, or null (non-200, missing, or unparseable). */
function readJson(entry) {
  if (!entry || entry.status !== 200 || !entry.file) return null;
  try { return JSON.parse(readFileSync(entry.file, 'utf8')); } catch { return null; }
}
/** Read a batch entry as a Buffer, or null. */
function readBuf(entry) {
  if (!entry || entry.status !== 200 || !entry.file) return null;
  try { return readFileSync(entry.file); } catch { return null; }
}
function cleanup(batch) {
  if (batch && batch._dir) { try { rmSync(batch._dir, { recursive: true, force: true }); } catch { /* ignore */ } }
}

const q = (o) => new URLSearchParams(o).toString();
const detailsUrl = (sym, d) => `${API}/GetFinancialStatementsAPIData?${q({ symCode: sym, reportEndDate: d, sectionName: '', getFilingDetails: '1' })}`;
const sectionUrl = (sym, d, s) => `${API}/GetFinancialStatementsAPIData?${q({ symCode: sym, reportEndDate: d, sectionName: s, getFilingDetails: '0' })}`;
const checkUrl = (sym, d, t) => `${API}/CheckFSAttachmentExistAPI?${q({ symCode: sym, reportEndDate: d, lang: '1', attachmentType: String(t) })}`;
const attachUrl = (sym, d, t) => `${API}/GetFSAttachmentAPI?${q({ symCode: sym, reportEndDate: d, lang: '1', attachmentType: String(t) })}`;

/** attachmentType -> (storage segment, human label). 1 = the issuer's own PDF; 3 = QE's rendered
 *  XBRL (a PDF, despite the "Detailed XBRL" label on the site). */
const ATTACHMENTS = [
  { type: 1, seg: 'report', label: 'Detailed report' },
  { type: 3, seg: 'xbrl-render', label: 'Detailed XBRL (rendered)' },
];

/** The candidate period grid, newest first so a deadline-truncated run banks recent data. */
function candidatePeriods() {
  const now = new Date();
  const maxYear = now.getUTCFullYear();
  const out = [];
  for (let y = maxYear; y >= MIN_YEAR; y--) for (const md of ['12-31', '09-30', '06-30', '03-31']) out.push(`${y}-${md}`);
  return out;
}

/** 'YYYY-12-31' -> 'YYYY' (annual); 'YYYY-06-30' -> 'Q2 YYYY'. Matches canonicalFiscalPeriod so the
 *  owned-set keys built here line up with what persist() writes. */
function fpOf(period) {
  const y = period.slice(0, 4), mm = Number(period.slice(5, 7));
  return mm === 12 ? y : `Q${Math.floor((mm - 1) / 3) + 1} ${y}`;
}

async function uploadPdf(key, buf) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/filings/${key}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'content-type': 'application/pdf', 'x-upsert': 'true' },
    body: buf,
  });
  return r.ok;
}

/** Lake objects + the filings catalogue row for one (company, period). Mirrors tadawul-researcher's
 *  persist() natural_key shape verbatim — `FINANCIALS:{venue}:{ticker}:{type}:{period}` at
 *  source_rank 10, straight to lake.objects. That differs from the framework's
 *  `FILING.FINANCIALS:{venue}:{ticker}:{type}:{basis}:{period}` at rank 20 via staging; the split is
 *  pre-existing and survivable while QE has ONE producer (both project the same
 *  financial_statements row). Do not invent a third shape — see DEF-QE-NATKEY-CONVERGE. */
async function persist(sql, sym, statements, filedAt) {
  const sec = await sql`select id from public.securities where venue_code='QE' and ticker=${sym} limit 1`;
  if (!sec[0]) { log(`  no security for ${sym}`); return 0; }
  const secId = sec[0].id;
  const agent = await sql`select id from iam.principals where handle='SYSTEM' limit 1`;
  const pr = await sql`insert into lake.parse_runs (agent_id, parser_key, parser_version, status)
                       values (${agent[0].id}, 'qe_xbrl', '1', 'succeeded') returning id`;
  let n = 0;
  for (const p of statements.periods) {
    const nk = `FINANCIALS:QE:${sym}:${p.statementType}:${p.fiscalPeriod}`;
    const payload = {
      statement_type: p.statementType, period_kind: p.periodKind, fiscal_period: p.fiscalPeriod,
      period_end: p.periodEnd, currency: p.currency, basis: 'consolidated', line_items: p.lineItems,
    };
    const live = await sql`select id, revision, state from lake.objects where natural_key=${nk} and superseded_by is null limit 1`;
    if (live[0] && live[0].state === 'VERIFIED') {
      // A restatement of already-verified numbers: supersede rather than mutate, so the projection's
      // version counter + financial_statement_history capture the revision.
      const nid = (await sql`select gen_random_uuid() as id`)[0].id;
      await sql`update lake.objects set superseded_by=${nid}, state='RETIRED' where id=${live[0].id}`;
      await sql`insert into lake.objects (id,object_type,natural_key,security_id,venue_code,payload,state,revision,parse_run_id,source_rank)
                values (${nid},'FILING.FINANCIALS',${nk},${secId},'QE',${sql.json(payload)},'PENDING',${live[0].revision + 1},${pr[0].id},10)`;
    } else if (live[0]) {
      await sql`update lake.objects set payload=${sql.json(payload)}, revision=${live[0].revision + 1}, parse_run_id=${pr[0].id}, source_rank=10 where id=${live[0].id}`;
    } else {
      await sql`insert into lake.objects (object_type,natural_key,security_id,venue_code,payload,state,revision,parse_run_id,source_rank)
                values ('FILING.FINANCIALS',${nk},${secId},'QE',${sql.json(payload)},'PENDING',1,${pr[0].id},10)`;
    }
    n++;
  }
  void filedAt;
  return n;
}

async function catalogPdf(sql, sym, period, key, label, filedAt) {
  const sec = await sql`select id from public.securities where venue_code='QE' and ticker=${sym} limit 1`;
  if (!sec[0]) return;
  const sourceRef = `QE-FS-${sym}-${period}-${key.includes('/xbrl-render/') ? 'XBRL' : 'RPT'}`;
  const title = `${label} — ${period}`;
  // filed_at: QE's approvedDate when we have it, else the period end. NEVER a JS Date compared to a
  // string in JS (postgres.js returns timestamptz as a Date — the eod_bulletin 0-fetch trap, PR #25).
  await sql`insert into public.filings (security_id, venue_code, source_ref, filing_type, title, filed_at, pdf_storage_key)
            values (${sec[0].id}, 'QE', ${sourceRef}, 'RESULTS', ${title.slice(0, 200)},
                    ${filedAt ? filedAt : `${period}T00:00:00Z`}, ${key})
            on conflict (venue_code, source_ref) do update set pdf_storage_key=excluded.pdf_storage_key`;
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────
const sql = postgres(SUPABASE_DB_URL, { max: 6, prepare: false });

let symbols;
if (process.env.ACQUIRE_SYMBOLS) {
  symbols = process.env.ACQUIRE_SYMBOLS.split(',').map((s) => s.trim()).filter(Boolean);
} else {
  const start = Number(process.env.CHUNK_START || 0), size = Number(process.env.CHUNK_SIZE || 16);
  const rows = await sql`select ticker from public.securities where venue_code='QE' and status='listed' order by ticker offset ${start} limit ${size}`;
  symbols = rows.map((r) => r.ticker);
}

// Incremental: the periods we already hold statements for, and the PDFs already archived. Both are
// read ONCE, up front, and consulted BEFORE any fetch — the stop condition has to precede the
// expensive work, not follow it (08-worker-fleet.md §4).
const ownedPeriods = new Set(
  (await sql`select natural_key from lake.objects
             where venue_code='QE' and object_type='FILING.FINANCIALS' and superseded_by is null`).map((r) => r.natural_key),
);
const ownedPdfs = new Set(
  (await sql`select pdf_storage_key from public.filings
             where venue_code='QE' and pdf_storage_key like 'qe/%'`).map((r) => r.pdf_storage_key),
);
log(`qe-financials — ${symbols.length} companies, ${ownedPeriods.size} statement objects + ${ownedPdfs.size} PDFs already owned${DRY ? ' [DRY RUN]' : ''}`);

const PERIODS = candidatePeriods();
let companies = 0, periodsNew = 0, rowsW = 0, gateRej = 0, pdfArchived = 0, bytes = 0, reqs = 0, errs = 0;
let docBudget = DOC_MAX;

// A transport failure and "this period has no filing" both produce zero rows, so they MUST NOT be
// conflated: a silently-swallowed error looks exactly like a clean backfill that found nothing, and
// the cursor advances over data we never actually fetched. (This bit during development — node's
// undici gets ECONNRESET from QE on some hosts while curl succeeds, and the first run reported a
// tidy "0 periods, correct skip" for every company.) So: count errors, log the first few, and abort
// the run if the origin is clearly refusing us rather than hammering it 1,296 times.
const ERR_ABORT = Number(process.env.QE_ERR_ABORT || 25);
let aborted = false;
function noteErr(what, r) {
  errs++;
  if (errs <= 5) log(`  ! ${what}: ${r.err ?? `HTTP ${r.status}`}`);
  if (errs >= ERR_ABORT && !aborted) {
    aborted = true;
    log(`  !! ${errs} transport errors — aborting run (origin refusing?). Reporting 0 completed so the cursor does not skip this chunk.`);
  }
}

async function doCompany(sym) {
  let found = 0;
  if (outOfTime() || aborted) return found;

  // Which cells still need work? Skip a period only when we already hold all three statement types
  // AND both PDFs — the stop condition precedes any fetch (08-worker-fleet.md §4).
  const todo = PERIODS.filter((period) => {
    const fp = fpOf(period);
    const haveStmts = ['balance', 'income', 'cashflow'].every((t) => ownedPeriods.has(`FINANCIALS:QE:${sym}:${t}:${fp}`));
    const havePdfs = ATTACHMENTS.every((a) => ownedPdfs.has(`qe/${sym}/${a.seg}/${period}.pdf`));
    return !(haveStmts && havePdfs);
  });
  if (todo.length === 0) return found;

  // ── PHASE 1: one keep-alive connection for ALL of this company's details + sections + checks.
  const need = new Map(); // period -> { haveStmts }
  const p1 = [];
  for (const period of todo) {
    const fp = fpOf(period);
    const haveStmts = ['balance', 'income', 'cashflow'].every((t) => ownedPeriods.has(`FINANCIALS:QE:${sym}:${t}:${fp}`));
    need.set(period, { haveStmts });
    p1.push({ id: `det|${period}`, url: detailsUrl(sym, period) });
    if (!haveStmts) for (const s of QE_SECTIONS) p1.push({ id: `sec|${period}|${s}`, url: sectionUrl(sym, period, s) });
    for (const a of ATTACHMENTS) {
      if (!ownedPdfs.has(`qe/${sym}/${a.seg}/${period}.pdf`)) p1.push({ id: `chk|${period}|${a.type}`, url: checkUrl(sym, period, a.type) });
    }
  }
  reqs += p1.length;
  const b1 = await curlBatch(p1);
  // If the whole batch failed to connect (tarpit refused / reset), every entry is status 0. Treat as
  // a transport failure — do NOT read it as "this company has no data".
  if ([...b1.values()].every((e) => e.status === 0)) {
    cleanup(b1);
    noteErr(`${sym} phase1 (all ${p1.length} req failed)`, { status: 0 });
    return found;
  }

  const pdfWanted = []; // { period, a, filedAt }
  for (const period of todo) {
    const { haveStmts } = need.get(period);
    const det = readJson(b1.get(`det|${period}`));
    const filedAt = parseQeFilingDetail(det);
    const hasFiling = Array.isArray(det) && det.length > 0;

    if (!haveStmts && hasFiling) {
      const payloads = [];
      let sectionErr = false;
      for (const section of QE_SECTIONS) {
        const e = b1.get(`sec|${period}|${section}`);
        if (!e || e.status === 0) { sectionErr = true; continue; }
        const rows = readJson(e);
        if (Array.isArray(rows) && rows.length > 0) payloads.push({ section, rows });
      }
      // A partial fetch would land an incomplete statement set that the owned-check then skips
      // forever. Leave the cell untouched and let a later run retry it.
      if (sectionErr) { log(`  ${sym} ${period}: partial section fetch — skipping, will retry`); }
      else if (payloads.length > 0) {
        const raw = parseQeFinancials(payloads, 'QAR');
        const { statements, validation } = extractToStatements(raw, 'QE', sym);
        gateRej += validation.rejected.length;
        if (validation.rejected.length > 0) log(`  ${sym} ${period}: ${validation.rejected.length} rejected — ${validation.rejected[0].reasons.map((x) => x.check).join(',')}`);
        if (statements.periods.length > 0) {
          found++; periodsNew++;
          if (!DRY) rowsW += await persist(sql, sym, statements, filedAt);
          else rowsW += statements.periods.length;
          // Reflect the write in the in-run owned-set so a re-fetch this run is impossible.
          for (const p of statements.periods) ownedPeriods.add(`FINANCIALS:QE:${sym}:${p.statementType}:${p.fiscalPeriod}`);
        }
      }
    }

    // Queue the PDFs that exist and we don't already own. Existence comes from the check in b1.
    for (const a of ATTACHMENTS) {
      const key = `qe/${sym}/${a.seg}/${period}.pdf`;
      if (ownedPdfs.has(key)) continue;
      const chk = b1.get(`chk|${period}|${a.type}`);
      if (!chk || chk.status === 0) continue; // transport-failed check: retry next run, don't guess
      if (String((readJson(chk) ?? readBuf(chk)?.toString() ?? '')).trim() !== '1') continue; // genuine 0
      pdfWanted.push({ period, a, filedAt, key });
    }
  }
  cleanup(b1);

  // ── PHASE 2: one keep-alive connection for the PDFs that exist, bounded by the doc budget.
  const p2 = [];
  for (const w of pdfWanted) {
    if (docBudget <= 0) break;
    docBudget--; // reserve BEFORE the fetch so the cap holds even if a later company also wants PDFs
    p2.push({ id: `${w.period}|${w.a.type}`, url: attachUrl(sym, w.period, w.a.type), w });
  }
  if (p2.length > 0 && !outOfTime()) {
    reqs += p2.length;
    const b2 = await curlBatch(p2.map(({ id, url }) => ({ id, url })));
    for (const { id, w } of p2) {
      const buf = readBuf(b2.get(id));
      // Verify magic bytes: a 200 error-page must never be archived as a filing.
      if (!buf || buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
        const st = b2.get(id)?.status ?? 0;
        if (st === 0) noteErr(`${sym} ${w.period} ${w.a.seg}`, { status: 0 });
        else log(`  ${sym} ${w.period} ${w.a.seg}: 200 but not a PDF — skipping`);
        continue;
      }
      bytes += buf.length;
      if (!DRY) {
        if (!(await uploadPdf(w.key, buf))) { log(`  ${sym} ${w.period} ${w.a.seg}: upload failed`); continue; }
        await catalogPdf(sql, sym, w.period, w.key, w.a.label, w.filedAt);
      }
      ownedPdfs.add(w.key);
      pdfArchived++;
    }
    cleanup(b2);
  }
  return found;
}

const queue = [...symbols];
async function worker() {
  for (;;) {
    if (outOfTime() || aborted) return;
    const sym = queue.shift();
    if (!sym) return;
    try {
      const n = await doCompany(sym);
      companies++;
      log(`  ${sym}: ${n} new period(s) — companies ${companies}/${symbols.length}`);
    } catch (e) {
      companies++; // still count it: a permanently-broken company must not wedge the cursor forever
      log(`  ${sym}: ERROR ${String(e).slice(0, 140)}`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length || 1) }, () => worker()));

// The wrapper parses `companies N/M` to advance the cursor; DONE must always print, or the cursor
// resets to 0 and the chunk is re-walked. On an abort we report 0 completed ON PURPOSE: the wrapper
// treats 0 as "wrap to 0", which is the safe outcome — we would rather re-walk a chunk than record
// progress over periods we never successfully fetched.
const completed = aborted ? 0 : companies;
log(`DONE companies ${completed}/${symbols.length} periods ${periodsNew} rows ${rowsW} pdfs ${pdfArchived} rejected ${gateRej} errors ${errs} reqs ${reqs} bytes ${(bytes / 1e6).toFixed(1)}MB in ${((Date.now() - t0) / 1000).toFixed(0)}s${DRY ? ' [DRY RUN — no writes]' : ''}${aborted ? ' [ABORTED — transport errors]' : ''}`);
await sql.end({ timeout: 5 });
if (aborted) process.exit(1);
