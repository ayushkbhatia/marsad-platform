-- 0024_adx_filings_direct — switch ADX filings to the new bootstrap 'direct' mode.
--
-- P1.5 live-gap fix. 0023 set ADX filings actionDiscovery.extract='network_capture', but the ADX
-- disclosures feed is NOT auto-fired by the navigate page — it is a FIXED apigateway URL behind a
-- static SPA apikey header that the SPA fetches only on interaction/route change. So passive
-- network_capture times out ("action discovery found no URL"). The correct pattern (verified live:
-- navigate to seat Akamai cookies, then in-context fetch the apigateway URL with the apikey header
-- → HTTP 200, 25 disclosure rows) is the new extract='direct' mode added to core/browser.ts:
-- bootstrap navigates to seat cookies, returns no discovered URL, and the adapter fetches its own
-- endpoint_config.urlTemplate (the pinned apigateway news URL) with the apikey header.
--
-- Only the actionDiscovery.extract discriminant changes; urlTemplate + headers (set by 0023) stay.
-- Idempotent: jsonb_set on the single ADX filings_list row; clears last_content_hash so it re-parses.

update ingest.sources
set endpoint_config = jsonb_set(endpoint_config, '{actionDiscovery,extract}', '"direct"'::jsonb, true),
    last_content_hash = null
where venue = 'ADX' and data_type = 'filings_list';
