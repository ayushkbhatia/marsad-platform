-- 20260720140000_adx_eod_deactivate_unpinned_route — stop the ADX eod_bulletin (id9) failure loop.
--
-- ROOT CAUSE (DEF-EOD-BULLETIN): id9 was seeded with a PLACEHOLDER actionDiscovery and never pinned
-- (endpoint_config: extract:'network_capture', navigateUrl tradingreport.aspx, no urlTemplate). The ADX
-- daily trading report page is a SharePoint ASPX whose XLSX download is a postback/button, NOT an
-- auto-fired XHR, so passive network_capture never sees a URL matching the responseUrlPattern and
-- browser.bootstrap() throws "action discovery (network_capture) found no URL" (core/browser.ts) —
-- same disease as BHB filings (20260716091000), except ADX has no pinned urlTemplate to fall back to.
--
-- WHY SURFACING NOW: the eodCloseGate fix (20260715…) finally lets the gate OPEN post-close, so the
-- handler runs and hits the broken discovery ~hourly in the +180min window; the failure sentinel
-- (20260717101959) then correctly raises it as a TRUE failure (3 fails 2026-07-20). It was always
-- broken — the pin (TODO(vps)) was never done — it just never executed until the gate opened.
--
-- FIX: deactivate the source + its schedule until the route is pinned. eod_bulletin is wanted ONLY as
-- the OHLCV 2nd cross-check (P1.7a) and feeds nothing today — live ADX bars accrue from the quotes
-- board + EOD accrual (0028) — so deactivating costs nothing downstream and stops a genuine-but-useless
-- incident. Real fix (backlogged in BUILD-STATUS §7 DEF-EOD-BULLETIN): rebuild ADX eodBulletin off the
-- apigateway JSON board (/adx/marketwatch/1.1/securityBoards/mainMarket already returns full OHLCV) —
-- a TaskSpec, not a config flip, and needs a live VPS capture to verify. Mirrors the DFM/QE/MSX/TDWL
-- eod sources already deactivated (20260715150100).

set search_path = '';

update ingest.sources
   set active = false
 where id = 9
   and venue = 'ADX'
   and data_type = 'eod_bulletin';

update ingest.schedules
   set active = false
 where source_id = 9;
