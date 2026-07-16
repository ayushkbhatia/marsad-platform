-- 20260716091000_bhb_filings_drop_action_discovery — unblock BHB filings_list (id17), DEF-VENUE-FILINGS.
--
-- ROOT CAUSE (BUILD-STATUS §7): id17 has a PINNED urlTemplate (the GetAllAnnouncements webapi feed)
-- but ALSO carried endpoint_config.actionDiscovery with extract:'network_capture'. The BHB filings
-- adapter's fetchFilings() runs browser.bootstrap(actionDiscovery) whenever actionDiscovery is present
-- under an http_bootstrap transport; network_capture waits for the page to fire the feed XHR, the
-- SharePoint page never does, so bootstrap() throws WAF_CHALLENGE "action discovery found no URL"
-- (core/browser.ts:166-170) — 0/138 fetches ok, the parser never runs.
--
-- FIX (ledger: "drop actionDiscovery so fetchFilings uses it directly"): remove actionDiscovery and
-- move to plain http. The BHB webapi WAF gate is gone (quotes went direct 20260715150100, egressing the
-- bare VPS IP), so a plain http GET of the pinned urlTemplate returns the JSON directly — no browser, no
-- discovery. The golden fixture fixtures/bhb/filings-live.json already pins the parser.
--
-- active stays FALSE here — reactivation is the LAST step (20260716xxxx_reactivate_venue_filings),
-- gated on a live fetch_log 'ok' + a filings row landing. This migration only fixes the config.

set search_path = '';

update ingest.sources
   set transport = 'http',
       endpoint_config = (endpoint_config - 'actionDiscovery')
 where id = 17
   and venue = 'BHB'
   and data_type = 'filings_list';
