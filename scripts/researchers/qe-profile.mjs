#!/usr/bin/env node
/**
 * QE securities-profile one-shot (Phase C3, DEF-SECTOR-DATA-DFM-QE — QE half). The QE MarketWatch
 * board (`mw.php f=MarketWatch`) carries ISIN + SectorEN + SubscribedShares for EVERY listed company
 * in ONE response — no per-ticker scrape, no browser, no proxy. Verified live 2026-07-19 (QNBK →
 * QA0006929895 / Banks & Financial Services / 9,236,428,570 shares).
 *
 * TRANSPORT: `curl` subprocess, NOT node fetch/undici — the QE origin tarpits+RESETS undici from the
 * VPS (the proven qe-financials lesson; node fetch here would hang/reset).
 *
 * Writes one PROFILE.SECURITY lake object per matched security (the fn_security_profile_project
 * camelCase contract, mirroring tadawul-researcher.persistProfile) → projects into
 * public.securities.{sector,isin,shares_outstanding,industry} + stamps profile_scraped_at.
 * Idempotent — re-run quarterly to refresh shares.
 */
import { spawnSync } from 'node:child_process';
import { upsertLakeObject } from './lib/lake-objects.mjs';
const ING = '/opt/marsad/ingestion';
const { mapSectorToTaxonomy } = await import(`${ING}/dist/lake/sector-taxonomy.js`);
const postgres = (await import('/opt/marsad/worker/node_modules/postgres/src/index.js').then(m => m.default ?? m));

const { SUPABASE_DB_URL } = process.env;
if (!SUPABASE_DB_URL) { console.error('missing env SUPABASE_DB_URL'); process.exit(1); }
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const r = spawnSync('curl', [
  '-s', '-m', '40', '-X', 'POST',
  '-H', 'content-type: application/x-www-form-urlencoded; charset=UTF-8',
  '-H', 'referer: https://www.qe.com.qa/',
  '-H', `user-agent: ${UA}`,
  '-H', 'x-requested-with: XMLHttpRequest',
  '-d', 'f=MarketWatch',
  'https://www.qe.com.qa/wp/mw_app/mw.php',
], { maxBuffer: 2e7 });
if (r.status !== 0) { console.error(`board fetch failed: curl ${r.status}`); process.exit(1); }
let board;
try { board = JSON.parse(r.stdout.toString()); } catch { console.error('board: bad json'); process.exit(1); }
const rows = Array.isArray(board?.rows) ? board.rows : [];
log(`qe-profile — board rows ${rows.length}`);
if (!rows.length) process.exit(1);

const sql = postgres(SUPABASE_DB_URL, { max: 2, prepare: false });
const secs = new Map((await sql`select ticker, id from public.securities where venue_code='QE'`).map((x) => [x.ticker, x.id]));
const agent = await sql`select id from iam.principals where handle='SYSTEM' limit 1`;
const pr = await sql`insert into lake.parse_runs (agent_id, parser_key, parser_version, status) values (${agent[0].id}, 'qe_board_profile', '1', 'succeeded') returning id`;

const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
let written = 0, skipped = 0, unmapped = 0;
for (const row of rows) {
  const t = String(row.Symbol || '').trim();
  const secId = secs.get(t);
  if (!secId) { skipped++; continue; } // funds/bonds/rights not in our equity universe
  const isinRaw = String(row.ISIN || '').trim().toUpperCase();
  const isin = ISIN_RE.test(isinRaw) ? isinRaw : null;
  const rawSector = String(row.SectorEN || '').trim() || null;
  const sector = rawSector ? mapSectorToTaxonomy(rawSector).sector : 'unknown';
  if (rawSector && sector === 'unknown') { unmapped++; log(`  ${t}: unmapped sector "${rawSector}" (kept as rawSector)`); }
  const sharesN = Number(String(row.SubscribedShares || '').replace(/,/g, ''));
  const sharesOutstanding = Number.isFinite(sharesN) && sharesN > 0 ? sharesN : null;
  if (isin === null && rawSector === null && sharesOutstanding === null) { skipped++; continue; }

  const nk = `PROFILE.SECURITY:QE:${t}`;
  const payload = { venue: 'QE', ticker: t, sector, rawSector, isin, sharesOutstanding, industry: null };
  await upsertLakeObject(sql, {
    naturalKey: nk, objectType: 'PROFILE.SECURITY', securityId: secId, venueCode: 'QE',
    payload, parseRunId: pr[0].id, sourceRank: 10,
  });
  written++;
}
await sql.end();
log(`DONE | profiles written ${written} | board rows skipped (not our universe / empty) ${skipped} | unmapped sectors ${unmapped}`);
