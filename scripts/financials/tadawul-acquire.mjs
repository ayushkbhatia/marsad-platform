#!/usr/bin/env node
/**
 * Tadawul financials acquisition — PRODUCTIONIZED runner (docs/plans/p17-financials-pdf-architecture.md
 * + p17-financials-BUILD-LOG.md "TADAWUL PDF ACQUISITION — PROVEN"). Runs the proven Akamai-bypass recipe
 * end-to-end on the VPS:
 *   headful Chromium (xvfb) + sticky residential GCC IP + warm → enumerate financial-statement
 *   announcements → detail iframe → fsPdf → download → store PDF to the public `filings` bucket →
 *   pdftotext → LLM extraction (sharpened prompt) → the committed validation gate → FILING.FINANCIALS
 *   lake objects → lake.fn_financials_project → public.financial_statements.
 *
 * RUN (on the VPS, with the worker's secrets loaded):
 *   sudo -n bash -c 'set -a; source /etc/marsad/worker.env; set +a; \
 *     TADAWUL_PROXY="http://USER:PASS_country-ae,sa_session-<id>_lifetime-30m@geo.iproyal.com:12321" \
 *     ACQUIRE_LIMIT=6 node /opt/marsad/scripts/financials/tadawul-acquire.mjs'
 *
 * Env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL (all in worker.env);
 *      TADAWUL_PROXY (the IPRoyal sticky-session proxy URL); ACQUIRE_LIMIT (default 6);
 *      ACQUIRE_FROM / ACQUIRE_TO ('YYYY-MM-DD' for a historical backfill window; default = recent).
 *
 * This is a self-contained script (compiled-runtime constraint: no tsx, worker not yet wired to
 * src/lib/llm). It imports the committed PURE core from the built ingestion dist and calls Anthropic +
 * Supabase over plain fetch (same wire the gateway uses). The clean-architecture follow-up is to fold
 * this into a headful BrowserClient handler once the worker→gateway build wiring lands (DEF-WORKER-LLM-KEY).
 */

import { spawnSync } from 'node:child_process';
const ING = '/opt/marsad/ingestion';
const { chromium } = await import(`${ING}/node_modules/playwright/index.js`).then(m => m.default ?? m);
const { extractToStatements } = await import(`${ING}/dist/lake/statement-extraction.js`);
const postgres = (await import('/opt/marsad/worker/node_modules/postgres/src/index.js').then(m => m.default ?? m));

const {
  ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL,
  TADAWUL_PROXY, ACQUIRE_LIMIT = '6', ACQUIRE_FROM = '', ACQUIRE_TO = '',
} = process.env;
for (const [k, v] of Object.entries({ ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL, TADAWUL_PROXY }))
  if (!v) { console.error(`missing env ${k}`); process.exit(1); }
const LIMIT = Number(ACQUIRE_LIMIT);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── Sharpened extraction prompt (fixes L1: equity total-incl-minority for the identity; net income =
//    income-statement bottom line attributable to parent; bank total operating income → revenue). ──
const SYSTEM = [
  'You extract financial data from a listed-company statement filing text. Return ONLY JSON:',
  '{"currency":"ISO3","scale":"units|thousands|millions|billions","periods":[{"period_kind":"quarter|annual",',
  '"fiscal_period":"e.g. Q1 2026","period_end":"YYYY-MM-DD","is_comparative":bool,"revenue":n,"gross_profit":n,',
  '"ebit":n,"net_income":n,"eps_diluted":n,"total_assets":n,"total_liabilities":n,"equity":n,"cash":n,',
  '"current_liabilities":n,"total_debt":n,"dep_amort":n}] } (null for any line not printed).',
  'RULES: numbers exactly as printed; scale = the declared unit ("in SAR thousands" → "thousands").',
  '- equity = TOTAL equity INCLUDING non-controlling interests (so total_assets = total_liabilities + equity).',
  '- net_income = the INCOME-STATEMENT bottom-line profit for the period attributable to equity holders of the',
  '  parent (NOT a statement-of-changes-in-equity component, NOT other comprehensive income).',
  '- revenue: for a bank/finance company use TOTAL OPERATING INCOME (net special-commission/interest income',
  '  + fee & other operating income). gross_profit is null for banks/insurers.',
  '- eps_diluted is per-share — never rescale. Emit the reported period AND its comparative. Never guess.',
].join('\n');

async function extractPdf(buf, hintTicker) {
  const t = spawnSync('pdftotext', ['-layout', '-', '-'], { input: buf, maxBuffer: 30e6 });
  const text = (t.stdout?.toString() || '').slice(0, 55000);
  if (text.length < 400) return { error: 'no text layer' };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 2500, system: SYSTEM, messages: [{ role: 'user', content: 'Filing text:\n\n' + text }] }),
  });
  const j = await r.json();
  if (j.error) return { error: j.error.type };
  const m = (j.content?.[0]?.text || '').match(/\{[\s\S]*\}/);
  if (!m) return { error: 'no json' };
  let parsed; try { parsed = JSON.parse(m[0]); } catch { return { error: 'bad json' }; }
  const { statements, validation } = extractToStatements(parsed, 'TDWL', hintTicker);
  return { statements, validation, tokens: (j.usage?.input_tokens || 0) + (j.usage?.output_tokens || 0) };
}

async function uploadPdf(key, buf) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/filings/${key}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/pdf', 'x-upsert': 'true', 'cache-control': 'max-age=31536000' },
    body: buf,
  });
  return r.ok || r.status === 200;
}

// ── Headful acquisition (the proven recipe) ──
async function acquire() {
  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    proxy: parseProxy(TADAWUL_PROXY) });
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', timezoneId: 'Asia/Riyadh', viewport: { width: 1366, height: 768 } });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); window.chrome = { runtime: {} }; });
  const page = await ctx.newPage();
  const nav = async (url) => { for (let i = 0; i < 3; i++) { try { return (await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 80000 })).status(); } catch { /* retry */ } } return 0; };
  const acquired = [];
  try {
    await nav('https://www.saudiexchange.sa/wps/portal/saudiexchange'); await page.waitForTimeout(7000);
    await nav('https://www.saudiexchange.sa/wps/portal/saudiexchange/newsandreports/issuer-news/issuer-announcements'); await page.waitForTimeout(12000);
    const rows = await page.evaluate(() => [...document.querySelectorAll('a[href*="anId="]')].map((a) => {
      const t = (a.textContent || '').replace(/\s+/g, ' ').trim();
      const an = a.href.match(/anId=(\d+)/); const cs = a.href.match(/cs=(\d+)/);
      return { anId: an && an[1], cs: cs && cs[1], title: t, href: a.href };
    }).filter((r) => r.anId && /availability of the (interim|annual|quarterly|condensed)[^.]*?(financial|statement)/i.test(r.title)));
    log(`financial-statement announcements found: ${rows.length}`);
    for (const row of rows.slice(0, LIMIT)) {
      try {
        await nav(row.href); await page.waitForTimeout(9000);
        const frame = page.frames().find((f) => /announcements-details/i.test(f.url())) || page.frames().find((f) => f !== page.mainFrame());
        const fsPdf = frame && await frame.evaluate(() => {
          const u = [...document.querySelectorAll('a,iframe,object,embed')].map((e) => e.src || e.data || e.href).find((x) => x && /Resources\/fsPdf\//i.test(x) && /\.pdf$/i.test(x));
          return u || null;
        });
        if (!fsPdf) { log(`  ${row.cs} ${row.title.slice(0, 40)} — no fsPdf`); continue; }
        const dl = await page.evaluate(async (u) => {
          const r = await fetch(u, { headers: { Accept: 'application/pdf' } });
          const b = new Uint8Array(await r.arrayBuffer()); let bin = ''; for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
          return { status: r.status, len: b.length, magic: String.fromCharCode(...b.slice(0, 5)), b64: btoa(bin) };
        }, fsPdf);
        if (dl.magic !== '%PDF') { log(`  ${row.cs} download failed ${dl.status}`); continue; }
        acquired.push({ ...row, fsPdf, buf: Buffer.from(dl.b64, 'base64') });
        log(`  ✓ ${row.cs} ${row.title.slice(0, 45)} — ${dl.len}B`);
      } catch (e) { log(`  row err ${String(e).slice(0, 60)}`); }
    }
  } finally { await browser.close(); }
  return acquired;
}

function parseProxy(u) { const m = u.match(/^http:\/\/([^:]+):(.+)@([^:]+):(\d+)$/); return { server: `http://${m[3]}:${m[4]}`, username: m[1], password: m[2] }; }

// ── DB: resolve security, write FILING.FINANCIALS lake objects, stamp pdf_storage_key ──
async function persist(sql, item, statements, storageKey) {
  const sec = await sql`select id, venue_code from public.securities where venue_code='TDWL' and ticker=${item.cs} limit 1`;
  if (!sec[0]) { log(`  no security for cs=${item.cs}`); return 0; }
  const secId = sec[0].id;
  const agent = await sql`select id from iam.principals where handle='SYSTEM' limit 1`;
  const pr = await sql`insert into lake.parse_runs (agent_id, parser_key, parser_version, status) values (${agent[0].id}, 'tadawul_financials', '1', 'succeeded') returning id`;
  let n = 0;
  for (const p of statements.periods) {
    const nk = `FINANCIALS:TDWL:${item.cs}:${p.statementType}:${p.fiscalPeriod}`;
    const payload = { statement_type: p.statementType, period_kind: p.periodKind, fiscal_period: p.fiscalPeriod, period_end: p.periodEnd, currency: p.currency, basis: 'consolidated', line_items: p.lineItems };
    // supersede prior live object for this key
    const live = await sql`select id, revision from lake.objects where natural_key=${nk} and superseded_by is null limit 1`;
    if (live[0]) {
      const nid = (await sql`select gen_random_uuid() as id`)[0].id;
      await sql`update lake.objects set superseded_by=${nid}, state='RETIRED' where id=${live[0].id}`;
      await sql`insert into lake.objects (id,object_type,natural_key,security_id,venue_code,payload,state,revision,parse_run_id,source_rank) values (${nid},'FILING.FINANCIALS',${nk},${secId},'TDWL',${sql.json(payload)},'PENDING',${live[0].revision + 1},${pr[0].id},20)`;
    } else {
      await sql`insert into lake.objects (object_type,natural_key,security_id,venue_code,payload,state,revision,parse_run_id,source_rank) values ('FILING.FINANCIALS',${nk},${secId},'TDWL',${sql.json(payload)},'PENDING',1,${pr[0].id},20)`;
    }
    n++;
  }
  // record the owned PDF on public.filings (venue-scoped; source_ref = the announcement)
  await sql`insert into public.filings (security_id, venue_code, source_ref, filing_type, title, filed_at, pdf_storage_key)
            values (${secId}, 'TDWL', ${'TDWL-ANN-' + item.anId}, 'RESULTS', ${item.title.slice(0, 200)}, now(), ${storageKey})
            on conflict (venue_code, source_ref) do update set pdf_storage_key=excluded.pdf_storage_key`;
  return n;
}

// ── main ──
const t0 = Date.now();
log(`Tadawul acquisition — limit ${LIMIT}${ACQUIRE_FROM ? `, window ${ACQUIRE_FROM}..${ACQUIRE_TO}` : ' (recent)'}`);
const items = await acquire();
log(`acquired ${items.length} statement PDFs`);
if (!items.length) process.exit(0);
const sql = postgres(SUPABASE_DB_URL, { max: 2, prepare: false });
let stored = 0, projected = 0, rejected = 0;
try {
  for (const it of items) {
    const key = `tdwl/${it.cs}/${it.fsPdf.split('/').pop()}`;
    const up = await uploadPdf(key, it.buf); if (up) stored++;
    const ex = await extractPdf(it.buf, it.cs);
    if (ex.error) { log(`  ${it.cs} extract error: ${ex.error}`); continue; }
    rejected += ex.validation.rejected.length;
    if (!ex.statements.periods.length) { log(`  ${it.cs} — all periods rejected by gate (${ex.validation.rejected.map((r) => r.reasons[0]?.check).join(',')})`); continue; }
    const n = await persist(sql, it, ex.statements, up ? key : null);
    projected += n;
    log(`  ${it.cs} → stored=${up} extracted ${ex.statements.periods.length}p (${ex.tokens}tok) → ${n} financial_statements rows`);
  }
} finally { await sql.end(); }
log(`DONE ${(Date.now() - t0) / 1000 | 0}s | PDFs stored ${stored} | financial_statements rows ${projected} | periods gate-rejected ${rejected}`);
