#!/usr/bin/env node
/**
 * TIER-0 TRIAGE (PE.1) — the deterministic half of filing comprehension. **No LLM. No OCR. $0.**
 *
 * Drains `ops.filing_extract_queue` state='pending' / content_kind='pdf' / tier0_at is null and, per
 * document: storage GET → sha256 → LiteParse (OCR OFF) → `public.filings.full_text` + `pdf_pages` +
 * `pdf_sha256`, then routes the row:
 *
 *   text recovered  → state='text_ready'  (Tier 2, the `claude -p` semantic pass, picks it up)
 *   no text layer   → state='needs_ocr'   (Tier 1, the model tier, picks it up)
 *   not a PDF/dead  → state='failed'      (3-strike, same as the C1 extractor)
 *
 * WHY THIS EXISTS. 14,409 filings carried a pdf_storage_key and 374 (2.6%) had any text — not
 * because the documents were unreadable but because nothing had ever been pointed at them
 * (DEF-FILING-EXTRACT-ENQUEUE-GAP). The PE.1 probe measured 26 documents / 1,120 pages across all
 * six venues: **86% of pages already carry a native text layer**, TDWL highest at 97%. So the
 * expensive tiers are for a ~14% minority, and this pass alone should take full_text coverage from
 * 2.6% to ~86% at zero marginal cost.
 *
 * WHAT IT DELIBERATELY DOES NOT STORE. LiteParse is deterministic and fast (536 pages/s measured
 * single-threaded), so markdown, per-page bboxes and text-item metadata are all REGENERATABLE from
 * the same bytes on demand. Persisting them for ~454,000 pages would balloon the DB for no
 * information gain. Tier 2 re-parses the handful of documents it actually needs structure for.
 * Store the irreplaceable (full_text, the sha, the corpus measurement); recompute the derivable.
 *
 * ALSO BACKFILLS pdf_sha256 (DEF-FILINGS-NO-CONTENT-HASH). 9,251 TDWL/QE rows have no content hash
 * anywhere — neither column nor storage key — so byte-identity is undetectable for them. The bytes
 * are already in hand here, so hashing is free.
 *
 * Budgeted and self-stopping like every researcher: TIER0_MAX docs/run, CONCURRENCY parallel
 * downloads, RUN_BUDGET_MS below the wrapper's `timeout` so the DONE line always prints.
 *
 *   TIER0_MAX=400 CONCURRENCY=3 node tier0-triage.mjs
 *   VENUE=TDWL TIER0_MAX=50 node tier0-triage.mjs      # single-venue run
 */
import { createHash } from 'node:crypto';
const WORKER_MODULES = process.env.WORKER_MODULES || '/opt/marsad/worker/node_modules';
const postgres = await import(`${WORKER_MODULES}/postgres/src/index.js`).then((m) => m.default ?? m);
const { LiteParse } = await import(`${WORKER_MODULES}/@llamaindex/liteparse/dist/lib.js`);

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL } = process.env;
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL }))
  if (!v) { console.error(`missing env ${k}`); process.exit(1); }

const TIER0_MAX = Number(process.env.TIER0_MAX || 400);
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const RUN_BUDGET_MS = Number(process.env.RUN_BUDGET_MS || 1_000_000);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 60_000); // node fetch has NO default
const MAX_PDF_BYTES = Number(process.env.MAX_PDF_BYTES || 80e6);
const VENUE = process.env.VENUE || null;
const MAX_ATTEMPTS = 3;
const FULLTEXT_CAP = 400_000;      // matches the C1 extractor; search_tsv indexes the first 200k
const DIGITAL_PAGE_MIN_CHARS = 200; // a page below this carries no usable text layer
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// OCR OFF is the whole point: Tier 0 is the free pass. Anything it cannot read is Tier 1's job,
// and saying so honestly (needs_ocr) is more useful than a bad OCR guess.
const lp = new LiteParse({ ocrEnabled: false, quiet: true, outputFormat: 'text' });

async function fetchStoredPdf(key) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/filings/${key}`, {
      headers: { authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
      signal: ctl.signal,
    });
    if (!r.ok) return { err: `storage ${r.status}` };
    const len = Number(r.headers.get('content-length') || 0);
    if (len > MAX_PDF_BYTES) return { err: `too large (${len} bytes)`, permanent: true };
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 5 || buf.subarray(0, 5).toString('latin1') !== '%PDF-')
      return { err: 'not a pdf (magic header)', permanent: true };
    return { buf };
  } catch (e) {
    return { err: `fetch: ${String(e).slice(0, 90)}` };
  } finally { clearTimeout(to); }
}

const t0 = Date.now();
const deadline = t0 + RUN_BUDGET_MS;
const sql = postgres(SUPABASE_DB_URL, { max: CONCURRENCY + 1, prepare: false });

// Claim: never-triaged PDFs, in the value order 20260727113000 stamped onto enqueued_at
// (TDWL+QE RESULTS first). FOR UPDATE SKIP LOCKED so overlapping runs never collide; a crashed
// run's claim expires after 30 minutes, matching the C1 extractor.
const claimed = await sql`
  update ops.filing_extract_queue q
     set picked_at = now(), attempts = attempts + 1
   where q.id in (
     select id from ops.filing_extract_queue
      where state = 'pending'
        and content_kind = 'pdf'
        and tier0_at is null
        and (picked_at is null or picked_at < now() - interval '30 minutes')
        ${VENUE ? sql`and venue_code = ${VENUE}` : sql``}
      order by enqueued_at
      limit ${TIER0_MAX}
      for update skip locked)
  returning q.id, q.filing_id, q.venue_code, q.pdf_storage_key, q.content_sha256, q.attempts`;

log(`tier0-triage — claimed ${claimed.length}${VENUE ? ` (venue ${VENUE})` : ''} (max ${TIER0_MAX}, conc ${CONCURRENCY})`);

let textReady = 0, needsOcr = 0, failed = 0, retried = 0, shaBackfilled = 0;
let totalPages = 0, totalDigital = 0, totalChars = 0, bytes = 0;
let cursor = 0;

async function fail(q, err, permanent) {
  if (permanent || q.attempts >= MAX_ATTEMPTS) {
    await sql`update ops.filing_extract_queue
                 set state='failed', error=${String(err).slice(0, 300)}, done_at=now()
               where id=${q.id}`;
    failed++;
  } else {
    // Stays 'pending' with tier0_at still null ⇒ retried next run.
    await sql`update ops.filing_extract_queue set error=${String(err).slice(0, 300)} where id=${q.id}`;
    retried++;
  }
}

async function worker(wid) {
  while (true) {
    if (Date.now() > deadline) return;
    const i = cursor++;
    if (i >= claimed.length) return;
    const q = claimed[i];
    try {
      const got = await fetchStoredPdf(q.pdf_storage_key);
      if (got.err) { await fail(q, got.err, got.permanent === true); continue; }
      const buf = got.buf;
      bytes += buf.length;

      const sha = createHash('sha256').update(buf).digest('hex');

      const tp = Date.now();
      let parsed;
      try {
        parsed = await lp.parse(buf);
      } catch (e) {
        await fail(q, `liteparse: ${String(e).split('\n')[0].slice(0, 120)}`, false);
        continue;
      }
      const ms = Date.now() - tp;

      const pages = parsed.pages.length;
      const digital = parsed.pages.filter(
        (p) => (p.text ?? '').replace(/\s/g, '').length >= DIGITAL_PAGE_MIN_CHARS,
      ).length;
      const text = (parsed.text ?? '').slice(0, FULLTEXT_CAP);
      const hasText = digital > 0 && text.replace(/\s/g, '').length >= DIGITAL_PAGE_MIN_CHARS;

      totalPages += pages; totalDigital += digital; totalChars += text.length;

      await sql.begin(async (tx) => {
        if (q.filing_id) {
          // full_text only when we actually recovered one — never blank a row that already has text.
          // COALESCE on the sha so a producer-computed hash is never overwritten by ours.
          await tx`update public.filings
                      set full_text     = case when ${hasText} then ${text} else full_text end,
                          pdf_pages     = ${pages},
                          pdf_sha256    = coalesce(pdf_sha256, ${sha})
                    where id = ${q.filing_id}`;
        }
        await tx`update ops.filing_extract_queue
                    set state         = ${hasText ? 'text_ready' : 'needs_ocr'},
                        content_sha256 = coalesce(content_sha256, ${sha}),
                        tier0_at      = now(),
                        tier0_ms      = ${ms},
                        pages         = ${pages},
                        digital_pages = ${digital},
                        text_chars    = ${text.length},
                        error         = null
                  where id = ${q.id}`;
      });

      if (!q.content_sha256) shaBackfilled++;
      if (hasText) textReady++; else needsOcr++;

      if ((textReady + needsOcr) % 50 === 0)
        log(`  [w${wid}] ${textReady + needsOcr}/${claimed.length} · ${totalPages} pages · ${Math.round(100 * totalDigital / Math.max(totalPages, 1))}% with text`);
    } catch (e) {
      await fail(q, String(e).slice(0, 200), false).catch(() => {});
      log(`  [w${wid}] ${q.pdf_storage_key} err ${String(e).slice(0, 90)}`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, claimed.length) }, (_, i) => worker(i)));

const secs = (Date.now() - t0) / 1000;
const pctText = Math.round(100 * totalDigital / Math.max(totalPages, 1));
await sql.end();
log(
  `DONE ${secs | 0}s | text_ready ${textReady} | needs_ocr ${needsOcr} | failed ${failed} | retry ${retried}` +
  ` | pages ${totalPages} (${pctText}% with text) | sha backfilled ${shaBackfilled}` +
  ` | ${(bytes / 1e6).toFixed(0)}MB | ${(totalPages / Math.max(secs, 0.001)).toFixed(1)} pages/s` +
  `${Date.now() > deadline ? ' | deadline-cut' : ''}`,
);
