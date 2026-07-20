#!/usr/bin/env node
/**
 * DEF-TDWL-EPS-MAPPING one-off REPROJECT — re-parse the OWNED Tadawul XBRL archive with the FIXED
 * parseTadawulXbrl (Defect A: the genuine "Total diluted EPS" row now wins over the basic fallback) +
 * the shared scaleLineItems guard (Defect B: a per-share key mis-tagged with the net-income magnitude is
 * dropped), then re-project into public.financial_statements via the normal lake path
 * (FILING.FINANCIALS → lake.fn_financials_project), respecting restatement versioning.
 *
 * WHY A DEDICATED SCRIPT: tadawul-researcher.mjs skips already-owned XBRL keys (owned.has), so a normal
 * run never re-parses. This forces a re-parse of the affected securities' owned filings. Source = the
 * `filings` Storage bucket (tdwl/{ticker}/xbrl/*.html) — NO scraping, NO browser, NO proxy.
 *
 * SCOPE: by default, only TDWL securities that currently have an income row VIOLATING the relative guard
 * (eps mis-tagged with net-income magnitude, or a clobbered diluted). Override with an explicit list.
 * Re-parsing ALL of an affected security's filings is safe: the persist() no-ops any period whose payload
 * is byte-identical (mirrors tadawul-xbrl-replay.mjs), so only genuinely-changed periods are written.
 *
 * Run on the VPS (DB RTT — never from a laptop), detached via systemd-run (NOT nohup):
 *   systemd-run --unit=marsad-eps-reproject --property=MemoryHigh=1200M \
 *     --property=EnvironmentFile=/etc/marsad/worker.env \
 *     /usr/bin/node /opt/marsad/scripts/researchers/tadawul-eps-reproject.mjs --dry-run
 * Then, once the dry-run output looks right, drop --dry-run to write.
 *
 * Flags / env:
 *   --dry-run | DRY_RUN=1   report which rows WOULD change (eps before→after) and write NOTHING.
 *   REPROJECT_SYMBOLS=1183,2222   explicit ticker list (skips auto-detection).
 *   CONCURRENCY (default 4).
 */
const ING = process.env.ING || '/opt/marsad/ingestion';
const { parseTadawulXbrl } = await import(`${ING}/dist/adapters/tadawul/xbrl.js`);
const { extractToStatements } = await import(`${ING}/dist/lake/statement-extraction.js`);
const postgres = (await import('/opt/marsad/worker/node_modules/postgres/src/index.js').then((m) => m.default ?? m));

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL } = process.env;
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL }))
  if (!v) { console.error(`missing env ${k}`); process.exit(1); }

const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function fetchStoredHtml(key) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/filings/${key}`, {
    headers: { authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!r.ok) return null;
  return r.text();
}

// The relative per-share guard, mirrored here ONLY to decide which live income rows are "affected" for
// auto-detection + dry-run diffing. The real guard lives in dist/lake/statement-extraction.js.
const MIN_SHARES = 1e6;
function guardViolates(li) {
  const ni = Number(li.net_income);
  if (!Number.isFinite(ni) || ni === 0) return false;
  const bound = Math.abs(ni) / MIN_SHARES;
  for (const k of ['eps_basic', 'eps_diluted', 'dps', 'book_value_ps']) {
    const v = Number(li[k]);
    if (li[k] != null && Number.isFinite(v) && Math.abs(v) > bound) return true;
  }
  return false;
}

// Mirrors tadawul-xbrl-replay.mjs persist() — SAME natural-key shape, one shared parse_run, payload-equality
// no-op, VERIFIED → restatement version, else in-place refresh / insert. Skipped entirely in --dry-run.
async function persist(sql, prId, cs, secId, statements, sourceRef) {
  let n = 0, changed = 0;
  for (const p of statements.periods) {
    const nk = `FINANCIALS:TDWL:${cs}:${p.statementType}:${p.fiscalPeriod}`;
    const payload = {
      statement_type: p.statementType, period_kind: p.periodKind, fiscal_period: p.fiscalPeriod,
      period_end: p.periodEnd, currency: p.currency, basis: 'consolidated', line_items: p.lineItems,
      ...(p.presentation && p.presentation.length ? { presentation: p.presentation } : {}),
      ...(sourceRef ? { filing_source_ref: sourceRef } : {}),
    };
    const live = await sql`select id, revision, state, payload from lake.objects where natural_key=${nk} and superseded_by is null limit 1`;
    if (live[0] && JSON.stringify(live[0].payload) === JSON.stringify(payload)) continue; // no-op
    if (live[0] && live[0].state === 'VERIFIED') {
      const nid = (await sql`select gen_random_uuid() as id`)[0].id;
      await sql`update lake.objects set superseded_by=${nid}, state='RETIRED' where id=${live[0].id}`;
      await sql`insert into lake.objects (id,object_type,natural_key,security_id,venue_code,payload,state,revision,parse_run_id,source_rank) values (${nid},'FILING.FINANCIALS',${nk},${secId},'TDWL',${sql.json(payload)},'PENDING',${live[0].revision + 1},${prId},10)`;
    } else if (live[0]) {
      await sql`update lake.objects set payload=${sql.json(payload)}, revision=${live[0].revision + 1}, parse_run_id=${prId}, source_rank=10 where id=${live[0].id}`;
    } else {
      await sql`insert into lake.objects (object_type,natural_key,security_id,venue_code,payload,state,revision,parse_run_id,source_rank) values ('FILING.FINANCIALS',${nk},${secId},'TDWL',${sql.json(payload)},'PENDING',1,${prId},10)`;
    }
    if (p.statementType === 'income') changed++;
    n++;
  }
  return { n, changed };
}

// Dry-run diff: compare the FRESHLY-PARSED income eps fields against the CURRENT live lake.objects payload,
// so the operator sees exactly which rows would change and how, before any write.
async function diff(sql, cs, statements) {
  let changed = 0;
  for (const p of statements.periods) {
    if (p.statementType !== 'income') continue;
    const nk = `FINANCIALS:TDWL:${cs}:${p.statementType}:${p.fiscalPeriod}`;
    const live = await sql`select payload from lake.objects where natural_key=${nk} and superseded_by is null limit 1`;
    const old = (live[0]?.payload?.line_items) || {};
    const nw = p.lineItems;
    const oB = old.eps_basic, oD = old.eps_diluted, nB = nw.eps_basic, nD = nw.eps_diluted;
    if (oB !== nB || oD !== nD) {
      changed++;
      log(`    ~ ${cs} ${p.fiscalPeriod}: eps_basic ${oB ?? '∅'}→${nB ?? '∅'} | eps_diluted ${oD ?? '∅'}→${nD ?? '∅'} (ni ${nw.net_income})`);
    }
  }
  return changed;
}

const t0 = Date.now();
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
const sql = postgres(SUPABASE_DB_URL, { max: CONCURRENCY + 1, prepare: false });

// 1) Affected tickers.
let tickers;
if (process.env.REPROJECT_SYMBOLS) {
  tickers = process.env.REPROJECT_SYMBOLS.split(',').map((s) => s.trim()).filter(Boolean);
} else {
  const rows = await sql`
    select distinct s.ticker
    from public.financial_statements fs
    join public.securities s on s.id = fs.security_id
    where s.venue_code='TDWL' and fs.statement_type='income'
      and (fs.line_items->>'net_income') is not null and (fs.line_items->>'net_income')::numeric <> 0
      and (
        (fs.line_items ? 'eps_diluted' and abs((fs.line_items->>'eps_diluted')::numeric) > abs((fs.line_items->>'net_income')::numeric)/1e6)
        or (fs.line_items ? 'eps_basic' and abs((fs.line_items->>'eps_basic')::numeric) > abs((fs.line_items->>'net_income')::numeric)/1e6)
      )
    order by s.ticker`;
  tickers = rows.map((r) => r.ticker);
}

// 2) Their owned XBRL filings.
const files = await sql`
  select f.pdf_storage_key as key, f.source_ref, f.security_id, split_part(f.pdf_storage_key, '/', 2) as ticker
  from public.filings f
  join public.securities s on s.id = f.security_id
  where f.venue_code='TDWL' and f.pdf_storage_key like 'tdwl/%/xbrl/%'
    and s.ticker = any(${tickers})
  order by f.pdf_storage_key`;

const agent = await sql`select id from iam.principals where handle='SYSTEM' limit 1`;
const pr = DRY_RUN ? [{ id: null }]
  : await sql`insert into lake.parse_runs (agent_id, parser_key, parser_version, status) values (${agent[0].id}, 'tadawul_eps_reproject', '1', 'succeeded') returning id`;
log(`${DRY_RUN ? 'DRY-RUN ' : ''}eps-reproject — ${tickers.length} affected TDWL securities, ${files.length} owned XBRL filings${DRY_RUN ? '' : `, parse_run ${pr[0].id}`}`);

let done = 0, rowsW = 0, incChanged = 0, gateRej = 0, errs = 0, cursor = 0;

async function worker(wid) {
  while (true) {
    const i = cursor++;
    if (i >= files.length) return;
    const f = files[i];
    try {
      const html = await fetchStoredHtml(f.key);
      if (!html) { log(`  [w${wid}] ${f.key} — storage fetch failed`); errs++; done++; continue; }
      const { statements, validation } = extractToStatements(parseTadawulXbrl(html), 'TDWL', f.ticker);
      gateRej += validation.rejected.length;
      if (!statements.periods.length) { done++; continue; }
      if (DRY_RUN) {
        incChanged += await diff(sql, f.ticker, statements);
      } else {
        const { n, changed } = await persist(sql, pr[0].id, f.ticker, f.security_id, statements, f.source_ref);
        rowsW += n; incChanged += changed;
      }
      done++;
      if (done % 100 === 0) log(`  [w${wid}] ${done}/${files.length}`);
    } catch (e) { errs++; done++; log(`  [w${wid}] ${f.key} err ${String(e).slice(0, 90)}`); }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
await sql.end();
log(`DONE ${(Date.now() - t0) / 1000 | 0}s | ${DRY_RUN ? 'DRY-RUN (no writes) | ' : ''}filings ${done}/${files.length} | income rows ${DRY_RUN ? 'that WOULD change' : 'changed'} ${incChanged} | objects staged ${rowsW} | gate-rejected ${gateRej} | errors ${errs}`);
if (DRY_RUN) log('re-run without --dry-run to apply.');
