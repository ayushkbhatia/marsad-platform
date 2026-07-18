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
 * gets us throttled takes QE quotes down with it. Hence: >=QE_RPS_MS spacing, QE_DOC_MAX per run,
 * low concurrency, and a timer scheduled OUTSIDE the 09:30-13:15 Asia/Qatar session.
 */
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
// Politeness on a host that also serves live quotes. undici's default 10s connect ceiling is too
// tight for QE's slow TLS (BUILD-STATUS §79b), so timeouts are generous and explicit.
const RPS_MS = Number(process.env.QE_RPS_MS || 1000);
const HTTP_TIMEOUT_MS = Number(process.env.QE_HTTP_TIMEOUT_MS || 45000);
const DOC_MAX = Number(process.env.QE_DOC_MAX || 40);
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);

const t0 = Date.now();
// Self-terminate before the wrapper's SIGTERM so DONE always prints — the cron advances the cursor
// by the completed count, and a killed run with no DONE resets it to 0 and loses the chunk.
const runDeadline = t0 + Number(process.env.RUN_BUDGET_MS || 680000);
const outOfTime = () => Date.now() > runDeadline;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastReq = 0;
/** Serialize a minimum gap between ALL outbound QE requests, across workers. */
async function pace() {
  const wait = lastReq + RPS_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastReq = Date.now();
}

async function qeGet(url, kind = 'json') {
  await pace();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: kind === 'pdf' ? 'application/pdf' : 'application/json' }, signal: ac.signal });
    if (!r.ok) return { ok: false, status: r.status };
    if (kind === 'pdf') return { ok: true, status: r.status, buf: Buffer.from(await r.arrayBuffer()), cd: r.headers.get('content-disposition') || '' };
    const text = await r.text();
    try { return { ok: true, status: r.status, json: JSON.parse(text) }; }
    catch { return { ok: false, status: r.status, err: 'non-json' }; }
  } catch (e) {
    return { ok: false, err: String(e).slice(0, 100) };
  } finally {
    clearTimeout(timer);
  }
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
  for (const period of PERIODS) {
    if (outOfTime() || aborted) return found;

    // Cheap skip: if we already hold all three statement types for this period AND both PDFs, this
    // cell is done — no request at all. (Balance/income/cashflow share the period label.)
    const fp = /-12-31$/.test(period) ? period.slice(0, 4) : `Q${Math.floor((Number(period.slice(5, 7)) - 1) / 3) + 1} ${period.slice(0, 4)}`;
    const haveStmts = ['balance', 'income', 'cashflow'].every((t) => ownedPeriods.has(`FINANCIALS:QE:${sym}:${t}:${fp}`));
    const havePdfs = ATTACHMENTS.every((a) => ownedPdfs.has(`qe/${sym}/${a.seg}/${period}.pdf`));
    if (haveStmts && havePdfs) continue;

    // Does a filing exist for this cell at all? One call answers that AND gives filedAt.
    const det = await qeGet(detailsUrl(sym, period)); reqs++;
    if (!det.ok) { noteErr(`${sym} ${period} details`, det); continue; } // unknown, NOT "absent"
    const filedAt = parseQeFilingDetail(det.json);
    const hasFiling = Array.isArray(det.json) && det.json.length > 0;

    if (!haveStmts && hasFiling) {
      const payloads = [];
      let sectionErr = false;
      for (const section of QE_SECTIONS) {
        const r = await qeGet(sectionUrl(sym, period, section)); reqs++;
        if (!r.ok) { noteErr(`${sym} ${period} ${section}`, r); sectionErr = true; continue; }
        if (Array.isArray(r.json) && r.json.length > 0) payloads.push({ section, rows: r.json });
      }
      // Persisting a partial filing would land an incomplete statement set and then be skipped
      // forever by the `owned` check. Better to leave the cell untouched and retry next run.
      if (sectionErr) { log(`  ${sym} ${period}: partial fetch — skipping, will retry`); continue; }
      if (payloads.length > 0) {
        const raw = parseQeFinancials(payloads, 'QAR');
        const { statements, validation } = extractToStatements(raw, 'QE', sym);
        gateRej += validation.rejected.length;
        if (validation.rejected.length > 0) {
          log(`  ${sym} ${period}: ${validation.rejected.length} rejected — ${validation.rejected[0].reasons.map((x) => x.check).join(',')}`);
        }
        if (statements.periods.length > 0) {
          found++; periodsNew++;
          if (!DRY) rowsW += await persist(sql, sym, statements, filedAt);
          else rowsW += statements.periods.length;
        }
      }
    }

    // PDFs. Independent of the JSON — QATI, for one, has a PDF but no structured data.
    for (const a of ATTACHMENTS) {
      if (outOfTime() || docBudget <= 0) break;
      const key = `qe/${sym}/${a.seg}/${period}.pdf`;
      if (ownedPdfs.has(key)) continue;
      const chk = await qeGet(checkUrl(sym, period, a.type)); reqs++;
      if (!chk.ok) { noteErr(`${sym} ${period} check(${a.type})`, chk); continue; }
      if (String(chk.json).trim() !== '1') continue; // a genuine 0 — no such attachment
      docBudget--; // reserve the slot BEFORE the fetch so parallel workers respect the cap
      const pdf = await qeGet(attachUrl(sym, period, a.type), 'pdf'); reqs++;
      if (!pdf.ok) { noteErr(`${sym} ${period} ${a.seg}`, pdf); continue; }
      // Verify the magic bytes: an error page served with a 200 must never be archived as a filing.
      if (!pdf.buf || pdf.buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
        log(`  ${sym} ${period} ${a.seg}: 200 but not a PDF — skipping`);
        continue;
      }
      bytes += pdf.buf.length;
      if (!DRY) {
        if (!(await uploadPdf(key, pdf.buf))) { log(`  ${sym} ${period} ${a.seg}: upload failed`); continue; }
        await catalogPdf(sql, sym, period, key, a.label, filedAt);
      }
      ownedPdfs.add(key);
      pdfArchived++;
    }
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
