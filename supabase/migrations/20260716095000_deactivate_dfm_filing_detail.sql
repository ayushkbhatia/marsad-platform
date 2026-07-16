-- 20260716095000_deactivate_dfm_filing_detail — DFM filings list-only until the eFsah PDF host is pinned.
--
-- The filing_detail chain works (proven live on MSX: 3 distinct per-announcement PDFs landed in the
-- 'filings' bucket + linked + queued). But DFM's per-announcement PDF URL is BROKEN: the eFsah feed's
-- resources[].r_path (e.g. '/2026/Jul/15/<uuid>/BOD Meeting.Pdf.pdf'), which adapters/dfm/filings.ts
-- joins to the api2.dfm.ae origin, returns HTTP 404 {"statusCode":404,"message":"Resource not found"}
-- for a plain GET (verified 2026-07-16 from the VPS across several host/prefix variants). So api2.dfm.ae
-- is the LIST-feed host, not the resource-download host — the real PDF CDN needs to be captured.
--
-- Rather than burn ~20 futile 404 fetches per DFM filing-burst (per-host budget discipline), DFM filings
-- are LIST-ONLY (they still publish to public.filings) until the resource host is pinned. Deactivate the
-- DFM filing_detail source + schedule, keyed by (venue, data_type). Follow-up: DEF-VENUE-FILINGS-DFM-PDF.

set search_path = '';

update ingest.sources s
   set active = false
 where s.venue = 'DFM' and s.data_type = 'filing_detail';

update ingest.schedules sc
   set active = false
  from ingest.sources s
 where s.id = sc.source_id and s.venue = 'DFM' and s.data_type = 'filing_detail';
