#!/usr/bin/env node
/**
 * MSX (Muscat Stock Exchange) financial-report ARCHIVER — the cheapest researcher in the fleet.
 * Unlike Tadawul (Akamai-walled → headed Chromium through a residential proxy) MSX serves both its
 * statement index and its artifacts as plain, cold, unauthenticated HTTP — so there is NO browser, NO
 * proxy, NO xvfb, and (unlike bhb-financials) NO `claude` and NO OCR here. Per company:
 *
 *   1. POST snapshot.aspx/FinancialsReports {"Symbol":X,"Year":""} → the ENTIRE filing history, one call.
 *   2. window to the last MSX_YEARS_BACK years by UploadDate, then skip any report already owned
 *      (public.filings source_ref MSX-FS-<ReportID>) — the skip happens BEFORE any download.
 *   3. GET the report's English artifact. It is a ZIP (verify 'PK'), not a PDF.
 *   4. unzip → the members are a PRE-SEGMENTED statement set (FilingInformation / BalanceSheet /
 *      IncomeStatement / CashFlowStatements / StockHolderEquity / Notes / CompanyReport), each digital
 *      text rendered from XBRL.
 *   5. upload every member PDF to the `filings` bucket under msx/<ticker>/<reportId>/ and catalogue ONE
 *      public.filings row per report, with the member manifest in extracted_facts.
 *
 * SCOPE: this lands FILINGS ONLY. It deliberately does NOT extract statements — no lake.objects
 * FILING.FINANCIALS, no public.financial_statements. The fundamentals projection is deferred
 * (DEF-MSX-STMT-EXTRACT, docs/BUILD-STATUS.md §7); the archived PDFs are its input. See
 * docs/architecture/08-worker-fleet.md.
 *
 * HOST DEP: `unzip` (added to infra/cloud-init.yaml alongside poppler-utils). preflight() exits 1 if it is
 * missing — a silent absence would otherwise re-download the whole universe every fire, forever.
 *
 *   ACQUIRE_SYMBOLS=BKMB,AAIC node msx-financials.mjs
 *   CHUNK_START=0 CHUNK_SIZE=12 node msx-financials.mjs
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ING = '/opt/marsad/ingestion';
const { parseMsxFinancialReports, msxFinancialsReportsUrl, msxFinancialsReportsBody, withinUploadWindow } =
  await import(`${ING}/dist/adapters/msx/financials.js`);
const postgres = (await import('/opt/marsad/worker/node_modules/postgres/src/index.js').then((m) => m.default ?? m));

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL } = process.env;
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL }))
  if (!v) { console.error(`missing env ${k}`); process.exit(1); }

const ZIP_MAX = Number(process.env.ZIP_MAX || 40); // DOWNLOAD ATTEMPTS per run (bandwidth budget, not $)
const YEARS_BACK = Number(process.env.MSX_YEARS_BACK || 5); // owner-set backfill horizon
const RUN_BUDGET_MS = Number(process.env.RUN_BUDGET_MS || 680000); // self-stop before the cron SIGTERM
const MAX_ZIP_BYTES = Number(process.env.MAX_ZIP_BYTES || 60e6); // refuse absurd compressed artifacts
const MAX_UNZIPPED_BYTES = Number(process.env.MAX_UNZIPPED_BYTES || 120e6); // decompressed cap (zip-bomb)
const MAX_MEMBERS = Number(process.env.MAX_MEMBERS || 40); // real sets are ~7-11 files
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 60000); // node fetch has NO default timeout
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/**
 * Fail LOUD on a missing `unzip` rather than silently forever.
 * spawnSync on an absent binary returns status:null (NOT a non-zero exit), which any
 * `status !== 0` guard reads as "the zip had no PDFs" — every report would then be left un-owned and
 * re-downloaded on every fire, forever, with zero progress. `unzip` is NOT part of the base image
 * (infra/cloud-init.yaml ships poppler-utils only), so this preflight is load-bearing, not paranoia.
 */
function preflight() {
  const r = spawnSync('unzip', ['-v']);
  if (r.error?.code === 'ENOENT' || r.status === null) {
    console.error('FATAL: `unzip` not found on PATH. Install it (apt-get install -y unzip) — see infra/cloud-init.yaml.');
    process.exit(1);
  }
}

// Calendar-anchored so the horizon never drifts mid-year: 5 years back ⇒ Jan 1 of (thisYear-5). Anchoring
// to Jan 1 (rather than today-5y) guarantees the whole of the oldest fiscal year is in range, including an
// annual report uploaded months after its period end.
const SINCE = `${new Date().getUTCFullYear() - YEARS_BACK}-01-01`;

/** POST the ScriptService index. Cold — no cookie/session needed (verified live 2026-07-17).
 *  Node's fetch has NO default timeout: without the signal a stalled MSX socket hangs past the cron's
 *  `timeout 800` (the RUN_BUDGET_MS checks only run BETWEEN iterations and cannot interrupt an in-flight
 *  request), the run is SIGTERM'd mid-request and never prints its DONE line. */
async function fetchIndex(symbol) {
  try {
    const r = await fetch(msxFinancialsReportsUrl(), {
      method: 'POST',
      headers: { 'user-agent': UA, 'content-type': 'application/json; charset=utf-8', accept: 'application/json' },
      body: msxFinancialsReportsBody(symbol, ''),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) return { err: `http ${r.status}` };
    return { body: await r.text() };
  } catch (e) { return { err: String(e).slice(0, 80) }; }
}

/** Download an artifact. `permanent` marks a miss that will NEVER succeed on retry (MSX served a non-zip),
 *  as opposed to a transient network/5xx miss worth retrying next run. */
async function fetchZip(url) {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: '*/*' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!r.ok) return { err: `http ${r.status}`, permanent: r.status === 404 || r.status === 410 };
    // Refuse before buffering when the server declares an absurd size (fetch would otherwise materialize
    // the whole body into RSS before any length check could run — this VPS is memory-tight, OOM history).
    const declared = Number(r.headers.get('content-length') || 0);
    if (declared > MAX_ZIP_BYTES) return { err: `oversize (content-length ${declared})`, permanent: true };
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_ZIP_BYTES) return { err: `oversize ${buf.length}`, permanent: true };
    // ZIP local-file-header magic. MSX 404s render as HTML with a 200 in some edge cases, so sniff bytes.
    if (buf.subarray(0, 2).toString('latin1') !== 'PK') {
      return { err: `not a zip (${JSON.stringify(buf.subarray(0, 4).toString('latin1'))})`, permanent: true };
    }
    return { buf };
  } catch (e) { return { err: String(e).slice(0, 80), permanent: false } }
}

/**
 * Statement kind from an MSX member filename: `{seq}_{SYM}_{Kind}_{DDMMYYYY}_{id}[_U].pdf` (the trailing
 * _U appears on some un-audited sets). Quarterly zips carry the 7 core documents; annual zips add the
 * auditor's report, corporate governance and MD&A. Metadata only — an unrecognised member is still
 * archived, just tagged 'other'.
 *
 * NB: the misspellings are MSX's own, in the real filenames ("Cooporate", "Dicussion"). Match verbatim.
 */
function memberKind(name) {
  const m = /^\d+_[^_]+_([A-Za-z]+)_/.exec(name);
  const kind = (m?.[1] ?? '').toLowerCase();
  const map = {
    filinginformation: 'filing_information',
    balancesheet: 'balance_sheet',
    incomestatement: 'income_statement',
    cashflowstatements: 'cash_flow',
    stockholderequity: 'stockholder_equity',
    notes: 'notes',
    companyreport: 'company_report',
    auditorsreport: 'auditors_report',
    cooporategovernancereport: 'governance_report',
    auditorsreportcooporategovernance: 'governance_auditors_report',
    managementdicussion: 'management_discussion',
  };
  return map[kind] ?? 'other';
}

/**
 * Extract the zip's PDF members via the `unzip` CLI (the repo carries no zip npm package; the researchers
 * already shell out for pdftotext/pdftoppm/tesseract). `-j` flattens directory nesting so a crafted member
 * path cannot escape the temp dir.
 *
 * ZIP-BOMB GUARD: the manifest is inspected with `unzip -l` and the DECLARED total uncompressed size +
 * member count are checked BEFORE a single byte is written to disk. Extracting first and capping after
 * would be no guard at all — DEFLATE reaches ~1000:1, so a zip sized just under MAX_ZIP_BYTES can expand
 * to tens of GB, filling /tmp and OOM-killing a memory-tight VPS long before any post-hoc cap ran.
 *
 * Returns { members } on success, or { err, permanent } — `permanent: true` means retrying can never help
 * (the artifact itself is malformed/hostile), so the caller records it instead of re-downloading forever.
 */
function unzipPdfs(buf) {
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'msxzip-'));
    const zip = join(dir, 'in.zip');
    writeFileSync(zip, buf);

    // 1. Read the manifest ONLY. `unzip -l` prints a trailing "<total> <count> files" summary line.
    const list = spawnSync('unzip', ['-l', zip], { maxBuffer: 2e7, encoding: 'utf8' });
    if (list.error?.code === 'ENOENT') return { err: 'unzip missing', permanent: false };
    if (list.status !== 0) return { err: `unzip -l status ${list.status}`, permanent: true };
    const summary = /^\s*(\d+)\s+(\d+)\s+files?\s*$/m.exec(list.stdout || '');
    const declared = summary ? Number(summary[1]) : 0;
    const count = summary ? Number(summary[2]) : 0;
    if (declared > MAX_UNZIPPED_BYTES) return { err: `zip-bomb: declares ${declared}b unzipped`, permanent: true };
    if (count > MAX_MEMBERS) return { err: `too many members: ${count}`, permanent: true };

    // 2. Only now extract.
    const out = join(dir, 'out');
    const r = spawnSync('unzip', ['-o', '-qq', '-j', zip, '*.pdf', '-d', out], { maxBuffer: 2e7 });
    if (r.error?.code === 'ENOENT') return { err: 'unzip missing', permanent: false };
    // exit 11 = "no matching files" — a real, successful read of a zip that simply holds no PDFs.
    if (r.status === 11) return { err: 'zip contains no pdfs', permanent: true };
    if (r.status !== 0) return { err: `unzip status ${r.status}`, permanent: true };

    let names;
    try { names = readdirSync(out); } catch { return { err: 'no output dir', permanent: true }; }

    // 3. Belt-and-braces: verify the ACTUAL bytes on disk against the cap the manifest claimed, since a
    //    crafted zip can under-report its sizes.
    let total = 0;
    for (const name of names) {
      try { total += statSync(join(out, name)).size; } catch { /* */ }
    }
    if (total > MAX_UNZIPPED_BYTES) return { err: `zip-bomb: expanded to ${total}b`, permanent: true };

    const members = [];
    for (const name of names) {
      if (!/\.pdf$/i.test(name)) continue;
      const body = readFileSync(join(out, name));
      if (body.subarray(0, 5).toString('latin1') !== '%PDF-') continue; // not a real PDF
      members.push({ name, kind: memberKind(name), body, sha256: createHash('sha256').update(body).digest('hex') });
    }
    if (members.length === 0) return { err: 'no pdf members', permanent: true };
    return { members };
  } catch (e) {
    return { err: String(e).slice(0, 80), permanent: false };
  } finally {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
  }
}

/** Sweep temp dirs stranded by a previous SIGTERM/SIGKILL. spawnSync blocks the event loop, so a signal
 *  landing mid-extract kills the process without unwinding the `finally` above — and the cron does both
 *  `timeout 800` (SIGTERM) and `pkill -9`. Without this they accumulate forever. */
function sweepTemp() {
  try {
    for (const d of readdirSync(tmpdir())) {
      if (d.startsWith('msxzip-')) { try { rmSync(join(tmpdir(), d), { recursive: true, force: true }); } catch { /* */ } }
    }
  } catch { /* */ }
}

async function uploadPdf(key, buf) {
  try {
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/filings/${key}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'content-type': 'application/pdf', 'x-upsert': 'true' },
      body: buf,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return r.ok;
  } catch { return false; }
}

/** Storage keys are ASCII-safe: MSX member names are already `{seq}_{SYM}_{Kind}_{date}_{id}.pdf`, but a
 *  stray space/paren would break the REST path. */
const safeName = (n) => n.replace(/[^A-Za-z0-9._-]/g, '_');

/**
 * Catalogue ONE public.filings row per report. The artifact is a SET of PDFs, so pdf_storage_key points at
 * the richest single document (the full CompanyReport, else the FilingInformation sheet) and the complete
 * manifest — every member, its statement kind, storage key and hash — goes in extracted_facts for the
 * deferred extractor to consume without re-downloading.
 */
async function catalogue(sql, secId, rep, members, keys, zipSha, archiveError = null) {
  const primary =
    members.find((m) => m.kind === 'company_report') ??
    members.find((m) => m.kind === 'filing_information') ??
    members[0];
  const facts = {
    msx_report: {
      report_id: rep.reportId,
      category_id: rep.categoryId,
      name_en: rep.nameEn,
      report_year: rep.reportYear, // FISCAL, not calendar — see adapters/msx/financials.ts
      file_name_en: rep.fileNameEn,
      period_end: rep.periodEnd,
      period_kind: rep.periodKind,
      audited: rep.audited,
      zip_sha256: zipSha,
      // Set ONLY on a permanently-unarchivable artifact. Greppable:
      //   select source_ref from public.filings
      //   where venue_code='MSX' and extracted_facts->'msx_report'->>'archive_error' is not null;
      ...(archiveError ? { archive_error: archiveError } : {}),
    },
    documents: members.map((m) => ({
      name: m.name, kind: m.kind, storage_key: keys.get(m.name), sha256: m.sha256, bytes: m.body.length,
    })),
  };
  // filed_at: the report's UploadDate (the real publication date). Falls back to now() only if MSX ever
  // ships an unparseable date — never silently backdated.
  const filedAt = rep.uploadDate ? `${rep.uploadDate}T00:00:00Z` : new Date().toISOString();
  await sql`insert into public.filings
              (security_id, venue_code, source_ref, filing_type, title, filed_at,
               pdf_storage_key, pdf_sha256, extracted_facts)
            values (${secId}, 'MSX', ${rep.sourceRef}, 'RESULTS',
                    ${(rep.titleEn || rep.nameEn || rep.sourceRef).slice(0, 200)}, ${filedAt},
                    ${keys.get(primary?.name) ?? null}, ${primary?.sha256 ?? null}, ${sql.json(facts)})
            on conflict (venue_code, source_ref) do update
              set pdf_storage_key = excluded.pdf_storage_key,
                  pdf_sha256      = excluded.pdf_sha256,
                  extracted_facts = excluded.extracted_facts`;
}

// ── main ──
const t0 = Date.now();
preflight();
sweepTemp();
const sql = postgres(SUPABASE_DB_URL, { max: 2, prepare: false });

let rows;
if (process.env.ACQUIRE_SYMBOLS) {
  const want = process.env.ACQUIRE_SYMBOLS.split(',').map((s) => s.trim()).filter(Boolean);
  rows = await sql`select id, ticker from public.securities where venue_code='MSX' and ticker = any(${want}) order by ticker`;
} else {
  const start = Number(process.env.CHUNK_START || 0), size = Number(process.env.CHUNK_SIZE || 12);
  rows = await sql`select id, ticker from public.securities
                   where venue_code='MSX' and status='listed'
                   order by ticker offset ${start} limit ${size}`;
}
const ownedRefs = new Set(
  (await sql`select source_ref from public.filings where venue_code='MSX' and source_ref like 'MSX-FS-%'`).map((r) => r.source_ref),
);
log(`msx-financials — ${rows.length} companies, ${ownedRefs.size} reports owned, since ${SINCE}, ZIP_MAX ${ZIP_MAX}/run`);

let companies = 0, newReports = 0, pdfs = 0, budget = ZIP_MAX;
for (const { id: secId, ticker } of rows) {
  if (budget <= 0) { log('  ZIP_MAX budget exhausted — stopping'); break; }
  if (Date.now() - t0 > RUN_BUDGET_MS) { log('  run budget reached — stopping'); break; }
  try {
    const idx = await fetchIndex(ticker);
    if (idx.err) { log(`  ${ticker} index fail: ${idx.err}`); companies++; continue; }
    const all = parseMsxFinancialReports(idx.body);
    const windowed = withinUploadWindow(all, SINCE);
    const gaps = windowed.filter((r) => !ownedRefs.has(r.sourceRef));
    log(`  ${ticker}: ${all.length} reports, ${windowed.length} in ${YEARS_BACK}y, ${gaps.length} new`);

    for (const rep of gaps) {
      if (budget <= 0 || Date.now() - t0 > RUN_BUDGET_MS) break;

      // Spend the budget on the ATTEMPT, not the success. ZIP_MAX is a BANDWIDTH cap: if it only counted
      // successes, a deterministically-failing report would re-download unthrottled until RUN_BUDGET_MS,
      // every fire, forever.
      budget--;

      const got = await fetchZip(rep.zipUrl);
      const zipSha = got.buf ? createHash('sha256').update(got.buf).digest('hex') : null;
      const un = got.buf ? unzipPdfs(got.buf) : null;
      const fail = got.err ? got : un?.err ? un : null;

      if (fail) {
        if (fail.permanent) {
          // The artifact itself is broken/hostile — retrying can never help. Record an owned marker with
          // NO documents so it never burns another slot, and leave a greppable archive_error.
          await catalogue(sql, secId, rep, [], new Map(), zipSha, fail.err);
          ownedRefs.add(rep.sourceRef);
          log(`    ! ${rep.reportId} PERMANENT: ${fail.err} — marked owned, not retried`);
        } else {
          log(`    · ${rep.reportId} transient: ${fail.err} — left un-owned to retry`);
        }
        continue;
      }

      const members = un.members;
      const keys = new Map();
      for (const m of members) {
        const key = `msx/${ticker}/${rep.reportId}/${safeName(m.name)}`;
        if (await uploadPdf(key, m.body)) keys.set(m.name, key);
      }
      // ALL-OR-NOTHING. A partial upload must NOT be catalogued: the manifest would list only the members
      // that happened to land, be internally self-consistent, and be marked owned — so a momentary storage
      // 5xx would silently become a permanently incomplete filing that nothing downstream could detect.
      if (keys.size !== members.length) {
        log(`    · ${rep.reportId} partial upload ${keys.size}/${members.length} — left un-owned to retry`);
        continue;
      }

      await catalogue(sql, secId, rep, members, keys, zipSha);
      ownedRefs.add(rep.sourceRef);
      newReports++; pdfs += keys.size;
      log(`    ✓ ${rep.nameEn} ${rep.periodEnd ?? '(period n/a)'} → ${keys.size} pdfs (budget ${budget})`);
    }
    companies++;
  } catch (e) { log(`  ${ticker} err ${String(e).slice(0, 70)}`); companies++; }
}
await sql.end();
log(`DONE ${((Date.now() - t0) / 1000) | 0}s | companies ${companies}/${rows.length} | new reports ${newReports} | pdfs ${pdfs} | budget left ${budget}`);
