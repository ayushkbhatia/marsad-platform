#!/usr/bin/env node
/**
 * Index-levels producer (DEF-INDEX-LEVELS) — fills the reader's index tape for the 6 GCC headline
 * indices. The index LEVEL is NOT in any venue quote board (verified) and the exchanges' own index
 * endpoints are WAF/auth-gated, so we source the single public number from two aggregators the owner
 * approved: Yahoo (DFMGI) + tradingeconomics (the other 5) — deliberately NOT TradingView.
 *
 * Lands one INDEX.LEVEL lake.object per venue per session-date (payload = NormalizedIndexLevel, camelCase);
 * the dormant projection (lake.fn_index_level_project, migration 20260720163000) + LIVE_LATEST_TYPES
 * refresh then fill public.index_levels (tape) + index_levels_daily (OHLC). Run every ~10 min in-session.
 *
 * Run on the VPS:
 *   systemd-run --unit=marsad-index-levels --property=EnvironmentFile=/etc/marsad/worker.env \
 *     /usr/bin/node /opt/marsad/scripts/researchers/index-levels.mjs
 */
import { spawnSync } from 'node:child_process';
const postgres = (await import('/opt/marsad/worker/node_modules/postgres/src/index.js').then((m) => m.default ?? m));
const { SUPABASE_DB_URL } = process.env;
if (!SUPABASE_DB_URL) { console.error('missing env SUPABASE_DB_URL'); process.exit(1); }
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const num = (s) => { const n = Number(String(s ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };

function curl(url, extraArgs = []) {
  const r = spawnSync('curl', ['-s', '-m', '25', '--compressed', '-H', `user-agent: ${UA}`, ...extraArgs, url], { maxBuffer: 6e7 });
  return r.status === 0 ? r.stdout.toString() : null;
}

// venue → { indexCode, source }. Yahoo returns level+change+pct directly; tradingeconomics gives the
// level (+ best-effort change) off the page headline.
const SOURCES = [
  { venue: 'DFM',  indexCode: 'DFMGI', kind: 'yahoo', sym: 'DFMGI.AE' },
  { venue: 'TDWL', indexCode: 'TASI',  kind: 'te', country: 'saudi-arabia' },
  { venue: 'ADX',  indexCode: 'FADGI', kind: 'te', country: 'united-arab-emirates' },
  { venue: 'QE',   indexCode: 'QSI',   kind: 'te', country: 'qatar' },
  { venue: 'MSX',  indexCode: 'MSX30', kind: 'te', country: 'oman' },
  { venue: 'BHB',  indexCode: 'BAX',   kind: 'te', country: 'bahrain' },
];

function fetchYahoo(sym) {
  const body = curl(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`);
  if (!body) return { err: 'fetch-fail' };
  let m; try { m = JSON.parse(body).chart.result[0].meta; } catch { return { err: 'bad-json' }; }
  const level = num(m.regularMarketPrice);
  const prev = num(m.chartPreviousClose ?? m.previousClose);
  if (level === null) return { err: 'no-level' };
  const change = prev !== null ? +(level - prev).toFixed(4) : null;
  const changePct = prev ? +(((level - prev) / prev) * 100).toFixed(4) : null;
  return { level, change, changePct };
}

function fetchTE(country) {
  const body = curl(`https://tradingeconomics.com/${country}/stock-market`);
  if (!body) return { err: 'fetch-fail' };
  // headline: "...stock market index, the XXX, rose/fell to NNNN ..."
  const m = body.match(/stock market index, the [A-Za-z0-9 &]+?, (?:rose|fell|increased|decreased|gained|dropped|was)(?: to| by|) ([0-9][0-9,.]+)/i);
  const level = m ? num(m[1]) : null;
  if (level === null) return { err: 'no-level' };
  // best-effort change/% — TE renders the daily delta in the OHLC widget; grab a "+N (+N%)"/"N points" if present.
  let change = null, changePct = null;
  const cm = body.match(/([\-+]?[0-9][0-9,.]*)\s*points?\b/i);
  if (cm) change = num(cm[1]);
  const pm = body.match(/([\-+]?[0-9][0-9.]*)\s*%/);
  if (pm && Math.abs(Number(pm[1])) < 25) changePct = Number(pm[1]); // sane daily % guard
  return { level, change, changePct };
}

const sql = postgres(SUPABASE_DB_URL, { max: 2, prepare: false });
const agent = await sql`select id from iam.principals where handle='SYSTEM' limit 1`;
const pr = await sql`insert into lake.parse_runs (agent_id, parser_key, parser_version, status) values (${agent[0].id}, 'index_levels', '1', 'running') returning id`;
const asOf = new Date().toISOString();
const sessionDate = asOf.slice(0, 10);   // UTC date; projection derives venue-local trade_date from asOf
log(`index-levels — ${SOURCES.length} indices, asOf ${asOf}`);

let ok = 0, fail = 0;
for (const s of SOURCES) {
  const res = s.kind === 'yahoo' ? fetchYahoo(s.sym) : fetchTE(s.country);
  if (res.err) { fail++; log(`  ${s.venue}/${s.indexCode}: ${res.err}`); continue; }
  const nk = `INDEX.LEVEL:${s.venue}:${s.indexCode}:${sessionDate}`;
  const payload = { indexCode: s.indexCode, level: res.level, change: res.change, changePct: res.changePct,
                    dayHigh: null, dayLow: null, valueTraded: null, asOf };
  const live = await sql`select id, revision from lake.objects where natural_key=${nk} and superseded_by is null limit 1`;
  if (live[0]) {
    // LIVE_LATEST in-place refresh for today's tape (fires the UPDATE projection trigger).
    await sql`update lake.objects set payload=${sql.json(payload)}, numeric_value=${res.level}, revision=${live[0].revision + 1}, parse_run_id=${pr[0].id}, updated_at=now() where id=${live[0].id}`;
  } else {
    await sql`insert into lake.objects (object_type,natural_key,security_id,venue_code,payload,numeric_value,unit,effective_date,state,revision,parse_run_id,source_rank,price_sensitive)
              values ('INDEX.LEVEL',${nk},null,${s.venue},${sql.json(payload)},${res.level},null,${sessionDate},'PENDING',1,${pr[0].id},20,false)`;
  }
  ok++;
  log(`  ${s.venue}/${s.indexCode} = ${res.level}${res.changePct != null ? ` (${res.changePct}%)` : ''}`);
}
await sql`update lake.parse_runs set status='succeeded', finished_at=now() where id=${pr[0].id}`;
await sql.end();
log(`DONE | ok ${ok} | fail ${fail}`);
