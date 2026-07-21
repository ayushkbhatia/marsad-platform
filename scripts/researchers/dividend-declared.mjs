#!/usr/bin/env node
/**
 * DIVIDEND.DECLARED producer (DEF-DIVIDEND-DECLARED, BUILD-STATUS §7) — the dated dividend
 * declaration feed that arms TPL-04 wires + populates real reader dividend ex-date cards.
 *
 * A FOLLOW-ON off the filing-facts extractor (scripts/researchers/filing-extractor.mjs): that job
 * already runs `claude -p` over every DIVIDEND-typed filing PDF and writes
 * `public.filings.extracted_facts.ai.dividend = {dps, currency, ex_date, record_date, pay_date}`.
 * This job reads those already-extracted facts (NO new LLM call — the bounded cost was paid once by
 * the extractor), and per declaration:
 *   1. resolve the security (prefer filings.security_id; else a UNIQUE source_ref symbol-token match);
 *   2. extractDividend() → NormalizedDividend (pure, tested: marsad-ingestion dividend-declared.ts);
 *   3. find a corroborating SECOND lineage root (the equity-projected reader dividend for the same
 *      security+year, an INDEPENDENT statement/XBRL lineage) → ≥2 roots when present, 1 gracefully;
 *   4. supersede-then-insert a `DIVIDEND.EXDATE` lake.objects row (PENDING, price_sensitive) — the
 *      object_type edit.ts autoSelectTemplate maps to TPL-04 and the ops.materiality_prefilter row
 *      routes material→wire→TPL-04 (03 §6/§7);
 *   5. upsert public.dividends (state pending_confirm) referencing that object (source_object_id).
 *
 * WHY DIRECT lake.objects insert (not staging_rows/cross_check): the fact is DERIVED from an
 * already-persisted filing, not fetched from a live feed — the same situation as the live
 * second-source researcher stockanalysis-financials.mjs (FINANCIALS.XCHECK), whose direct
 * parse_run + supersede-then-insert pattern this mirrors. staging_rows would need a fabricated
 * ingest.raw_snapshots + ingest.sources FK per source; direct insert with the researcher's own
 * lake.parse_runs is the established path for derived/second-source objects.
 *
 * THE 33b GATE (deliberate): a dividend is price-sensitive. lake.fn_object_state_guard refuses
 * VERIFIED for a price_sensitive object without a HUMAN verifier, and fn_dividend_confirm_guard
 * refuses go-live without a human confirmer. So the object lands PENDING and the reader row lands
 * pending_confirm; a Desk human confirm promotes BOTH → fires lake.fn_verified_enqueue →
 * pipeline_classify → TPL-04. This job never sets VERIFIED / live.
 *
 * IDEMPOTENT + coverage-guarded + self-stopping (fleet guardrails): the DIVIDEND.EXDATE natural_key
 * collapses re-runs onto one object (changed value ⇒ a superseded revision); public.dividends upserts
 * on dividends_uni and NEVER clobbers a human-confirmed live/cancelled row; already-produced filings
 * are skipped (a DIVIDEND.EXDATE object already carries their source_filing_id) unless REFRESH=1;
 * DIVIDEND_MAX caps the chunk and RUN_BUDGET_MS self-stops before the wrapper timeout.
 *
 *   DIVIDEND_MAX=50 node dividend-declared.mjs           # produce a chunk
 *   ASSESS_ONLY=1 node dividend-declared.mjs             # dry report, writes NOTHING
 *   REFRESH=1 ONLY_VENUE=MSX node dividend-declared.mjs  # re-produce one venue
 */
const postgres = await import('/opt/marsad/worker/node_modules/postgres/src/index.js').then((m) => m.default ?? m);

// The PURE, unit-tested normalization core (marsad-ingestion, built to /opt/marsad/ingestion/dist).
// Mirrors the msx-stmt-extract.mjs dynamic-import-of-built-ingestion pattern; a hard failure here is
// correct (the researcher must not hand-roll a divergent copy of the tested logic).
const DIST = process.env.INGESTION_DIST || '/opt/marsad/ingestion/dist/lake/dividend-declared.js';
let D;
try {
  D = await import(DIST);
} catch (e) {
  console.error(`cannot import built dividend-declared module at ${DIST} — build marsad-ingestion first (npm --prefix ingestion run build). ${e.message}`);
  process.exit(1);
}
const {
  extractDividend, dividendNaturalKey, disclosureRoot, buildLineageRoots,
  dividendObjectPayload, dividendUpsertRow, AGGREGATOR_RANK,
} = D;

const { SUPABASE_DB_URL } = process.env;
if (!SUPABASE_DB_URL) { console.error('missing env SUPABASE_DB_URL'); process.exit(1); }

const DIVIDEND_MAX = Number(process.env.DIVIDEND_MAX || 50);
const REFRESH = process.env.REFRESH === '1';
const ASSESS_ONLY = process.env.ASSESS_ONLY === '1';
const ONLY_VENUE = (process.env.ONLY_VENUE || '').toUpperCase();
const RUN_BUDGET_MS = Number(process.env.RUN_BUDGET_MS || 1_000_000);
const AGENT_HANDLE = process.env.DIVIDEND_AGENT || 'DATA-FILINGS';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const t0 = Date.now();
const deadline = t0 + RUN_BUDGET_MS;
const sql = postgres(SUPABASE_DB_URL, { max: 2, prepare: false });

// ── candidate DIVIDEND filings carrying a structured DPS, not yet produced (coverage guard). ──
// The coverage guard needs NO schema change: a filing is "produced" once a DIVIDEND.EXDATE object
// carries its id under payload.source_filing_id. REFRESH=1 re-produces everything.
const rows = await sql`
  select f.id, f.venue_code, f.security_id, f.title, f.filed_at, f.source_ref,
         f.extracted_facts -> 'ai' -> 'dividend' as ai_dividend
    from public.filings f
   where f.filing_type = 'DIVIDEND'
     and (f.extracted_facts -> 'ai' -> 'dividend' ->> 'dps') is not null
     and (${ONLY_VENUE === ''} or f.venue_code = ${ONLY_VENUE || null})
     and (${REFRESH} or not exists (
        select 1 from lake.objects o
        where o.object_type = 'DIVIDEND.EXDATE'
          and o.superseded_by is null
          and (o.payload ->> 'source_filing_id')::bigint = f.id))
   order by f.filed_at desc nulls last
   limit ${DIVIDEND_MAX}`;

log(`dividend-declared — ${rows.length} candidate DIVIDEND filing(s) (max ${DIVIDEND_MAX}, refresh ${REFRESH}, assess ${ASSESS_ONLY})`);

/** Resolve a listed security id + ticker for a filing. Prefer the filing's own security_id; else a
 *  UNIQUE symbol-token match on source_ref against a listed ticker for the venue (conservative — a
 *  non-unique or missing match yields null and the filing is skipped, never mis-attributed). */
async function resolveSecurity(f) {
  if (f.security_id) {
    const s = await sql`select id, ticker from public.securities where id = ${f.security_id} limit 1`;
    if (s[0]) return s[0];
  }
  const ref = String(f.source_ref || '');
  const tokens = [...new Set(ref.split(/[^A-Za-z0-9]+/).filter((t) => /[A-Za-z]/.test(t) && t.length >= 2 && t !== f.venue_code))];
  if (tokens.length === 0) return null;
  const matches = await sql`
    select id, ticker from public.securities
     where venue_code = ${f.venue_code} and status = 'listed' and ticker = any(${tokens})`;
  return matches.length === 1 ? matches[0] : null; // unique match only
}

/** A corroborating SECOND lineage root: an equity-projected reader dividend for the SAME security and
 *  fiscal YEAR, referencing an INDEPENDENT lake object (the statement/XBRL lineage, not this feed).
 *  Returns the corroborating LineageRoot or null (→ single root, PENDING, graceful). */
async function corroboratingRoot(securityId, fiscalRef) {
  const m = /(\d{4})/.exec(fiscalRef || '');
  if (!m) return null;
  const year = m[1];
  const found = await sql`
    select d.source_object_id, o.object_type
      from public.dividends d
      join lake.objects o on o.id = d.source_object_id
     where d.security_id = ${securityId}
       and coalesce(d.fiscal_ref, '') like ${'%' + year + '%'}
       and o.object_type <> 'DIVIDEND.EXDATE'   -- an INDEPENDENT root, not another copy of this feed
     limit 1`;
  if (!found[0]) return null;
  return { root: 'equity_projection', rank: AGGREGATOR_RANK, objectId: found[0].source_object_id, note: 'reader dividend history (equity_change lineage)' };
}

let produced = 0, skipped = 0, doubled = 0, revised = 0;

if (ASSESS_ONLY) {
  for (const f of rows) {
    const sec = await resolveSecurity(f);
    const d = sec ? extractDividend({ id: f.id, venue: f.venue_code, ticker: sec.ticker, title: f.title, filedAt: f.filed_at, aiDividend: f.ai_dividend }) : null;
    if (!sec) { skipped++; log(`  SKIP filing ${f.id} ${f.venue_code} ${f.source_ref}: unresolved security`); continue; }
    if (!d) { skipped++; log(`  SKIP filing ${f.id} ${f.venue_code} ${sec.ticker}: no usable DPS`); continue; }
    const corr = await corroboratingRoot(sec.id, d.fiscalRef);
    log(`  WOULD produce ${dividendNaturalKey(d)} dps=${d.dps}${d.currency} ex=${d.exDate ?? '—'} roots=${corr ? 2 : 1}`);
    produced++;
  }
  await sql.end();
  log(`ASSESS DONE ${((Date.now() - t0) / 1000) | 0}s | would-produce ${produced} | skipped ${skipped}`);
  process.exit(0);
}

// ── write pass: one parse_run for the batch (lineage), then per-declaration supersede-then-insert. ──
const agent = await sql`select id from iam.principals where handle = ${AGENT_HANDLE} limit 1`;
if (!agent[0]) { console.error(`agent principal ${AGENT_HANDLE} not found`); await sql.end(); process.exit(1); }
const pr = await sql`insert into lake.parse_runs (agent_id, parser_key, parser_version, status) values (${agent[0].id}, 'dividend_declared', '1', 'running') returning id`;
const runId = pr[0].id;

for (const f of rows) {
  if (Date.now() > deadline) { log('run budget reached — stopping (next fire resumes)'); break; }
  try {
    const sec = await resolveSecurity(f);
    if (!sec) { skipped++; continue; }
    const d = extractDividend({ id: f.id, venue: f.venue_code, ticker: sec.ticker, title: f.title, filedAt: f.filed_at, aiDividend: f.ai_dividend });
    if (!d) { skipped++; continue; }

    const nk = dividendNaturalKey(d);
    const corr = await corroboratingRoot(sec.id, d.fiscalRef);
    const lineage = buildLineageRoots(disclosureRoot(f.id, f.source_ref), corr);
    const payload = dividendObjectPayload(d, f.id, lineage);
    const r0 = dividendUpsertRow(d, sec.id, /* filled per-object below */ '');

    // ONE transaction per declaration: the supersede-then-insert relies on the DEFERRABLE
    // lake.objects.superseded_by FK resolving at COMMIT (points at the not-yet-inserted new id), and
    // the object + reader row must land atomically (no orphan object if the reader upsert fails).
    const wrote = await sql.begin(async (tx) => {
      // A VERIFIED live row (a human already confirmed this declaration) is superseded to a new
      // PENDING revision; a PENDING live row is updated in place; no live row ⇒ a fresh PENDING object.
      const live = await tx`select id, revision, state from lake.objects where natural_key = ${nk} and superseded_by is null limit 1`;
      let objectId, wasRevision = false;
      if (live[0] && live[0].state === 'VERIFIED') {
        const nid = (await tx`select gen_random_uuid() as id`)[0].id;
        await tx`update lake.objects set superseded_by = ${nid}, state = 'RETIRED' where id = ${live[0].id}`;
        await tx`insert into lake.objects (id, object_type, natural_key, security_id, venue_code, payload, numeric_value, unit, effective_date, state, revision, parse_run_id, source_rank, price_sensitive)
                  values (${nid}, 'DIVIDEND.EXDATE', ${nk}, ${sec.id}, ${f.venue_code}, ${tx.json(payload)}, ${d.dps}, ${d.currency}, ${d.exDate ?? null}, 'PENDING', ${live[0].revision + 1}, ${runId}, ${lineage.sourceRank}, true)`;
        objectId = nid; wasRevision = true;
      } else if (live[0]) {
        await tx`update lake.objects set payload = ${tx.json(payload)}, numeric_value = ${d.dps}, unit = ${d.currency}, effective_date = ${d.exDate ?? null}, revision = ${live[0].revision + 1}, parse_run_id = ${runId}, source_rank = ${lineage.sourceRank}, updated_at = now() where id = ${live[0].id}`;
        objectId = live[0].id; wasRevision = true;
      } else {
        const ins = await tx`insert into lake.objects (object_type, natural_key, security_id, venue_code, payload, numeric_value, unit, effective_date, state, revision, parse_run_id, source_rank, price_sensitive)
                  values ('DIVIDEND.EXDATE', ${nk}, ${sec.id}, ${f.venue_code}, ${tx.json(payload)}, ${d.dps}, ${d.currency}, ${d.exDate ?? null}, 'PENDING', 1, ${runId}, ${lineage.sourceRank}, true) returning id`;
        objectId = ins[0].id;
      }

      // Reader row: upsert on dividends_uni, NEVER clobbering a human-confirmed live/cancelled row.
      const r = { ...r0, source_object_id: objectId };
      await tx`
        insert into public.dividends (security_id, div_type, fiscal_ref, dps, currency, ex_date, record_date, pay_date, verification, state, source_object_id)
        values (${r.security_id}, ${r.div_type}, ${r.fiscal_ref}, ${r.dps}, ${r.currency}, ${r.ex_date}, ${r.record_date}, ${r.pay_date}, ${r.verification}, ${r.state}, ${r.source_object_id})
        on conflict (security_id, div_type, coalesce(fiscal_ref, ''), coalesce(ex_date, '9999-12-31'::date))
        do update set dps = excluded.dps, currency = excluded.currency, record_date = excluded.record_date,
                      pay_date = excluded.pay_date, source_object_id = excluded.source_object_id, updated_at = now()
        where public.dividends.state = 'pending_confirm'`;
      return { objectId, wasRevision };
    });

    if (lineage.count >= 2) doubled++;
    if (wrote.wasRevision) revised++;

    // Best-effort Desk-visibility stamp (only if the migration's column is present — never required).
    await sql`update public.filings set dividend_declared_at = now() where id = ${f.id}`.catch(() => {});

    produced++;
    const objectId = wrote.objectId;
    log(`  ✓ ${nk} dps=${d.dps}${d.currency} ex=${d.exDate ?? '—'} roots=${lineage.count} rank=${lineage.sourceRank} → obj ${objectId}`);
  } catch (e) {
    log(`  ✗ filing ${f.id} ${f.venue_code} ${f.source_ref}: ${String(e).slice(0, 160)}`);
  }
}

await sql`update lake.parse_runs set status = 'succeeded', finished_at = now(), objects_created = ${produced}, objects_updated = ${revised} where id = ${runId}`;
await sql.end();
log(`DONE ${((Date.now() - t0) / 1000) | 0}s | produced ${produced} | double-sourced ${doubled} | revised ${revised} | skipped ${skipped} | candidates ${rows.length}`);
