-- 20260716094500_bhb_filing_detail_list_only — BHB filings are list-only (detail PDF deferred).
--
-- 20260716090500 seeded a BHB filing_detail source (active) like every other venue. But BHB's
-- AnnouncementDetail page (the list ref's linkUrl) does NOT serve the real per-announcement attachment
-- in static HTML — the document loads client-side via SharePoint's _vti_bin/spsdisco.aspx, and the only
-- .pdf hrefs in the served HTML are site chrome (Code-of-Ethics / Corporate-Governance footer links).
-- So the detail drain grabbed the SAME wrong chrome PDF for every announcement. BHB per-announcement
-- PDF download needs BHB's webapi attachment endpoint (DEF-VENUE-FILINGS-BHB-PDF, §7); until then BHB
-- filings are LIST-ONLY (announcements still publish to public.filings via fn_filing_project, 0037).
--
-- Deactivate the BHB filing_detail source + schedule, keyed by (venue, data_type) so a from-scratch
-- migration replay lands the same live state (the id is seed-generated, never hardcoded).

set search_path = '';

update ingest.sources s
   set active = false
 where s.venue = 'BHB' and s.data_type = 'filing_detail';

update ingest.schedules sc
   set active = false
  from ingest.sources s
 where s.id = sc.source_id and s.venue = 'BHB' and s.data_type = 'filing_detail';
