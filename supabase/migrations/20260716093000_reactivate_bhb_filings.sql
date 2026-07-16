-- 20260716093000_reactivate_bhb_filings — flip BHB filings_list (id17) back ON (DEF-VENUE-FILINGS).
--
-- THE LAST STEP of the BHB turnkey fix. Prerequisites already landed:
--   * 20260716091000 dropped actionDiscovery + set transport 'http' (the "action discovery found no
--     URL" throw source).
--   * adapters/bhb/filings.ts now fetches the pinned GetAllAnnouncements webapi with the shared
--     dynamic APIKey Bearer (bhb/webapi.ts) — confirmed live 2026-07-16: GET returns 200, status:1,
--     1005 announcements, itemid stable per-filing id.
--   * The filing_detail chain (handler + sources + seen_items columns + extract queue) is deployed.
--
-- Reactivate the source + its schedule. TDWL (id2) and QE (id11) stay OFF — saudiexchange.sa is
-- Akamai-blocked (403 Access Denied even to a VPS headless, verified 2026-07-16) and qe.com.qa
-- q-disclosure is a server-rendered Liferay portlet with no stable per-disclosure JSON feed captured;
-- both are parked with precise triggers in BUILD-STATUS §7.

set search_path = '';

update ingest.sources   set active = true where id = 17 and venue = 'BHB' and data_type = 'filings_list';
update ingest.schedules set active = true where source_id = 17;
