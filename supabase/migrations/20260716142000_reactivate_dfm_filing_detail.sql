-- 20260716142000_reactivate_dfm_filing_detail — flip DFM filing_detail back ON (DEF-VENUE-FILINGS-DFM-PDF).
-- (Stamp bumped 140000→142000 to avoid collision with 20260716140000_activate_bhb_ohlcv_backfill from #40.)
--
-- Reverses 20260716095000, which set DFM filing_detail active=false SOLELY because the per-announcement
-- PDF host was unpinned: adapters/dfm/filings.ts joined eFsah resources[].r_path to the api2.dfm.ae
-- origin, which 404s on a resource GET (api2 is the LIST-feed host, not the document host).
--
-- Blocker fixed: the real document host is feeds.dfm.ae/documents. Verified live 2026-07-16 from an
-- ordinary IP (no browser, no WAF): `GET https://feeds.dfm.ae/documents<r_path>` → 200 application/pdf
-- across many issuers (EMAAR/DIB/SALIK/ETIHADENERGY/PARKIN/TALABAT, 0.6–5 MB each), while the same path
-- under api2.dfm.ae → 404. adapters/dfm/filings.ts v3 now resolves pdfUrl against feeds.dfm.ae/documents
-- (spaces percent-encoded) — so the detail drain downloads a real PDF instead of burning 404s.
--
-- The 404-burn that justified the deactivation is therefore gone: worst case the browser-bootstrap
-- filings_list poll under-captures and the drain is a harmless no-op; best case DFM disclosure PDFs land
-- in the 'filings' bucket + public.filings + ops.filing_extract_queue like MSX. (Financial STATEMENTS are
-- produced independently by the browser-free scripts/researchers/dfm-backfill.mjs Class-A worker.)
--
-- Prerequisite that MUST land together: adapters/dfm/filings.ts v3 (feeds.dfm.ae host). Key by
-- (venue, data_type) to mirror the deactivation exactly (reversible).

set search_path = '';

update ingest.sources s
   set active = true
 where s.venue = 'DFM' and s.data_type = 'filing_detail';

update ingest.schedules sc
   set active = true
  from ingest.sources s
 where s.id = sc.source_id and s.venue = 'DFM' and s.data_type = 'filing_detail';
