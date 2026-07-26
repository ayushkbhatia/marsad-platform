#!/usr/bin/env node
/**
 * Tadawul XBRL REPLAY (Phase B) — re-parse the OWNED XBRL archive with the Phase B parser
 * (oci + equity_change + presentation + snake-160 + combined-income rescue) and land the
 * enrichment. NO scraping, NO browser, NO proxy: source = the `filings` Storage bucket
 * (`tdwl/{ticker}/xbrl/*.html`, ~2,969 objects) that the researcher already owns.
 *
 * Per filing: storage GET → parseTadawulXbrl (NEW dist) → validation gate → persist:
 *   - existing income/balance/cashflow objects: payload refreshed (presentation +
 *     filing_source_ref added; new keys from snake-160/combined rescue). The v3 projection
 *     treats a metadata-only refresh as a quiet in-place update (no fake restatement).
 *   - NEW oci / equity_change objects: inserted, project into public.financial_statements.
 *
 * Natural keys MATCH the live researcher's shape (`FINANCIALS:TDWL:{cs}:{type}:{fp}`) so
 * replay hits the SAME lake rows — never a duplicate object per statement.
 *
 * Run on the VPS (DB RTT — never from a laptop), detached via systemd-run (NOT nohup):
 *   systemd-run --unit=marsad-xbrl-replay --property=MemoryHigh=1500M \
 *     --property=EnvironmentFile=/etc/marsad/worker.env \
 *     /usr/bin/node /opt/marsad/scripts/researchers/tadawul-xbrl-replay.mjs
 * Resume after an interruption with REPLAY_START=<n> (the log prints `next replay start: n`).
 * Env: CONCURRENCY (default 4), REPLAY_START (default 0), REPLAY_LIMIT (default all),
 *      RUN_BUDGET_MS (default none — one-shot runs to completion).
 */
import { upsertLakeObject } from './lib/lake-objects.mjs';
const ING = process.env.ING || '/opt/marsad/ingestion';
const { parseTadawulXbrl } = await import(`${ING}/dist/adapters/tadawul/xbrl.js`);
const { extractToStatements } = await import(`${ING}/dist/lake/statement-extraction.js`);
const postgres = (await import('/opt/marsad/worker/node_modules/postgres/src/index.js').then(m => m.default ?? m));

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL } = process.env;
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL }))
  if (!v) { console.error(`missing env ${k}`); process.exit(1); }
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function fetchStoredHtml(key) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/filings/${key}`, {
    headers: { authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!r.ok) return null;
  return r.text();
}

// Mirrors tadawul-researcher.mjs persist() — SAME natural-key shape, one shared parse_run,
// payload extended with presentation + filing_source_ref (v3 projection contract).
async function persist(sql, prId, cs, secId, statements, sourceRef) {
  let n = 0, added = 0;
  for (const p of statements.periods) {
    const nk = `FINANCIALS:TDWL:${cs}:${p.statementType}:${p.fiscalPeriod}`;
    const payload = {
      statement_type: p.statementType, period_kind: p.periodKind, fiscal_period: p.fiscalPeriod,
      period_end: p.periodEnd, currency: p.currency, basis: 'consolidated', line_items: p.lineItems,
      ...(p.presentation && p.presentation.length ? { presentation: p.presentation } : {}),
      ...(sourceRef ? { filing_source_ref: sourceRef } : {}),
    };
    const live = await sql`select id, revision, state, payload from lake.objects where natural_key=${nk} and superseded_by is null limit 1`;
    if (live[0] && JSON.stringify(live[0].payload) === JSON.stringify(payload)) continue; // no-op replay
    const { action } = await upsertLakeObject(sql, {
      naturalKey: nk, objectType: 'FILING.FINANCIALS', securityId: secId, venueCode: 'TDWL',
      payload, parseRunId: prId, sourceRank: 10,
    });
    // 'created' = the old no-live-row insert branch: a genuinely new oci/equity_change object.
    if (action === 'created' && (p.statementType === 'oci' || p.statementType === 'equity_change')) added++;
    n++;
  }
  return { n, added };
}

const t0 = Date.now();
const deadline = process.env.RUN_BUDGET_MS ? t0 + Number(process.env.RUN_BUDGET_MS) : Infinity;
const sql = postgres(SUPABASE_DB_URL, { max: Number(process.env.CONCURRENCY || 4) + 1, prepare: false });

const start = Number(process.env.REPLAY_START || 0);
const limit = Number(process.env.REPLAY_LIMIT || 1e9);
// The owned-archive catalogue is public.filings (pdf_storage_key = the bucket html key).
const files = await sql`
  select f.pdf_storage_key as key, f.source_ref, f.security_id, split_part(f.pdf_storage_key, '/', 2) as ticker
  from public.filings f
  where f.venue_code='TDWL' and f.pdf_storage_key like 'tdwl/%/xbrl/%'
  order by f.pdf_storage_key
  offset ${start} limit ${limit}`;
const agent = await sql`select id from iam.principals where handle='SYSTEM' limit 1`;
const pr = await sql`insert into lake.parse_runs (agent_id, parser_key, parser_version, status) values (${agent[0].id}, 'tadawul_xbrl_replay', '2', 'succeeded') returning id`;
const secIds = new Map((await sql`select ticker, id from public.securities where venue_code='TDWL'`).map((r) => [r.ticker, r.id]));
log(`replay — ${files.length} owned XBRL filings (offset ${start}), parse_run ${pr[0].id}`);

let done = 0, rowsW = 0, ociEq = 0, gateRej = 0, errs = 0;
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
let cursor = 0;
let stopped = false;

async function worker(wid) {
  while (true) {
    if (Date.now() > deadline) { stopped = true; return; }
    const i = cursor++;
    if (i >= files.length) return;
    const f = files[i];
    try {
      const secId = f.security_id ?? secIds.get(f.ticker);
      if (!secId) { log(`  [w${wid}] ${f.key} — no security for ${f.ticker}, skip`); done++; continue; }
      const html = await fetchStoredHtml(f.key);
      if (!html) { log(`  [w${wid}] ${f.key} — storage fetch failed`); errs++; done++; continue; }
      const { statements, validation } = extractToStatements(parseTadawulXbrl(html), 'TDWL', f.ticker);
      gateRej += validation.rejected.length;
      if (!statements.periods.length) { done++; continue; }
      const { n, added } = await persist(sql, pr[0].id, f.ticker, secId, statements, f.source_ref);
      rowsW += n; ociEq += added; done++;
      if (added || done % 100 === 0) log(`  [w${wid}] ${done}/${files.length} ${f.key.split('/').pop()} → ${statements.periods.length}p, ${n} staged (+${added} oci/eq) | total +${ociEq}`);
    } catch (e) {
      errs++; done++;
      log(`  [w${wid}] ${f.key} err ${String(e).slice(0, 90)}`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
await sql.end();
if (stopped) log(`budget reached — next replay start: ${start + done}`);
log(`DONE ${(Date.now() - t0) / 1000 | 0}s | filings ${done}/${files.length} | objects staged ${rowsW} | NEW oci/equity objects ${ociEq} | gate-rejected ${gateRej} | errors ${errs}`);
