#!/usr/bin/env node
/**
 * TDWL shares_outstanding one-shot backfill (DEF-SECTOR-DATA / DEF-EXIT-MUBASHER — the shares half).
 *
 * Owner-approved bounded Mubasher use: shares_outstanding is the single binding input for real
 * PE/PB/market-cap/Score on TDWL, and it is NOT in the Tadawul XBRL (only par-value share-capital).
 * The Mubasher company page SSRs "Current Total Shares" straight into the HTML — no API, no browser,
 * no proxy. Verified 2026-07-20: SAB(1060)=2,054,794,522, ARAMCO(2222)=242,000,000,000,
 * ALRAJHI(1120)=4,000,000,000, STC(7010)=5,000,000,000 — all correct.
 *
 * SHARES-ONLY payload: sector/isin/industry are left null so fn_security_profile_project's COALESCE
 * PRESERVES TDWL's XBRL-sourced sector/isin (only shares_outstanding fills + profile_scraped_at stamps).
 *
 * COVERAGE GUARD: only securities with shares_outstanding IS NULL (idempotent; one-shot — this goes
 * dormant once TDWL is covered, honouring the exit-Mubasher steer). Set REFRESH=1 to re-scrape all.
 * Polite: sequential fetch + a small delay per page (~295 KB each).
 *
 * Run on the VPS (DB RTT) detached:
 *   systemd-run --unit=marsad-tdwl-shares --property=EnvironmentFile=/etc/marsad/worker.env \
 *     /usr/bin/node /opt/marsad/scripts/researchers/tadawul-shares.mjs
 */
import { spawnSync } from 'node:child_process';
const postgres = (await import('/opt/marsad/worker/node_modules/postgres/src/index.js').then((m) => m.default ?? m));

const { SUPABASE_DB_URL } = process.env;
if (!SUPABASE_DB_URL) { console.error('missing env SUPABASE_DB_URL'); process.exit(1); }
// venue_code → Mubasher market-path code (they differ: BHB→BB, MSX→MSM). Same "Current Total Shares"
// SSR block on every venue's company page; tickers are the venue symbols (EMAAR/ADCB/BKMB/…).
const VENUE = process.env.VENUE || 'TDWL';
const MARKET = { TDWL: 'TDWL', ADX: 'ADX', DFM: 'DFM', BHB: 'BB', MSX: 'MSM' }[VENUE];
if (!MARKET) { console.error(`unknown VENUE ${VENUE} (expect TDWL|ADX|DFM|BHB|MSX)`); process.exit(1); }
const REFRESH = process.env.REFRESH === '1';
const DELAY_MS = Number(process.env.DELAY_MS || 350);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "Current Total Shares" label → the next stock-overview__value span (digits + commas).
const SHARES_RE = /Current Total Shares<\/span>\s*<span[^>]*>([0-9,]+)<\/span>/;
function scrapeShares(ticker) {
  const r = spawnSync('curl', [
    '-s', '-m', '30', '--compressed',
    '-H', `user-agent: ${UA}`,
    '-H', 'accept: text/html',
    `https://english.mubasher.info/markets/${MARKET}/stocks/${ticker}`,
  ], { maxBuffer: 5e7 });
  if (r.status !== 0) return { err: `curl ${r.status}` };
  const html = r.stdout.toString();
  const m = SHARES_RE.exec(html);
  if (!m) return { err: 'no-shares-span' };
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? { shares: n } : { err: `bad-number ${m[1]}` };
}

const sql = postgres(SUPABASE_DB_URL, { max: 2, prepare: false });
const only = (process.env.TICKERS || '').split(',').map((s) => s.trim()).filter(Boolean);
const universe = only.length
  ? await sql`select ticker, id from public.securities where venue_code=${VENUE} and ticker = any(${only}) order by ticker`
  : REFRESH
    ? await sql`select ticker, id from public.securities where venue_code=${VENUE} and status='listed' order by ticker`
    : await sql`select ticker, id from public.securities where venue_code=${VENUE} and status='listed' and shares_outstanding is null order by ticker`;
const agent = await sql`select id from iam.principals where handle='SYSTEM' limit 1`;
const pr = await sql`insert into lake.parse_runs (agent_id, parser_key, parser_version, status) values (${agent[0].id}, ${'mubasher_shares_' + VENUE.toLowerCase()}, '1', 'succeeded') returning id`;
log(`mubasher-shares ${VENUE} (market ${MARKET}) — ${universe.length} tickers to scrape (REFRESH=${REFRESH})`);

let written = 0, notfound = 0, failed = 0, i = 0;
for (const { ticker: t, id: secId } of universe) {
  i++;
  const res = scrapeShares(t);
  if (res.err) {
    if (res.err === 'no-shares-span') notfound++; else failed++;
    if (i % 25 === 0 || res.err !== 'no-shares-span') log(`  [${i}/${universe.length}] ${t}: ${res.err}`);
    await sleep(DELAY_MS);
    continue;
  }
  const nk = `PROFILE.SECURITY:${VENUE}:${t}`;
  const payload = { venue: VENUE, ticker: t, sector: null, rawSector: null, isin: null, sharesOutstanding: res.shares, industry: null };
  const live = await sql`select id, revision, state from lake.objects where natural_key=${nk} and superseded_by is null limit 1`;
  if (live[0] && live[0].state === 'VERIFIED') {
    const nid = (await sql`select gen_random_uuid() as id`)[0].id;
    await sql`update lake.objects set superseded_by=${nid}, state='RETIRED' where id=${live[0].id}`;
    await sql`insert into lake.objects (id,object_type,natural_key,security_id,venue_code,payload,state,revision,parse_run_id,source_rank) values (${nid},'PROFILE.SECURITY',${nk},${secId},${VENUE},${sql.json(payload)},'PENDING',${live[0].revision + 1},${pr[0].id},10)`;
  } else if (live[0]) {
    await sql`update lake.objects set payload=${sql.json(payload)}, revision=${live[0].revision + 1}, parse_run_id=${pr[0].id}, source_rank=10 where id=${live[0].id}`;
  } else {
    await sql`insert into lake.objects (object_type,natural_key,security_id,venue_code,payload,state,revision,parse_run_id,source_rank) values ('PROFILE.SECURITY',${nk},${secId},${VENUE},${sql.json(payload)},'PENDING',1,${pr[0].id},10)`;
  }
  written++;
  if (i % 25 === 0) log(`  [${i}/${universe.length}] ${written} written · ${notfound} no-shares · ${failed} fetch-fail`);
  await sleep(DELAY_MS);
}
await sql.end();
log(`DONE | shares written ${written} | no-shares-span ${notfound} | fetch-fail ${failed} | of ${universe.length}`);
