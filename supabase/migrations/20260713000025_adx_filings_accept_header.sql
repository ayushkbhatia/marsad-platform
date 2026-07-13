-- 0025_adx_filings_accept_header — the ADX apigateway news feed does content
-- negotiation: without Accept: application/json it returns an 86KB HTML page
-- (looks like an Akamai block but is just the wrong representation); WITH it,
-- the 51KB JSON feed (verified live: side-by-side probe, only the header differs).
-- The direct-mode bootstrap + real-UA context were correct; this header was the
-- actual cause of the drift/parse-error. Adds Accept to the ADX filings headers.
update ingest.sources
set endpoint_config = jsonb_set(
      endpoint_config,
      '{headers,Accept}',
      '"application/json"'::jsonb,
      true),
    last_content_hash = null
where venue = 'ADX' and data_type = 'filings_list';
