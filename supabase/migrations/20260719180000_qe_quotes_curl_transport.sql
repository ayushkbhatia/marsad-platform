-- QE live quotes: route the board fetch through the curl transport instead of undici.
--
-- QE's Akamai edge on www.qe.com.qa RESETS undici's TLS handshake from the VPS datacenter IP but
-- ACCEPTS curl's OpenSSL handshake (the same finding that put the QE *financials* researcher on curl,
-- PR #54). The live *quotes* board (mw.php) still ran through undici in the worker, so it froze
-- intermittently on the reset. The worker now reads endpoint_config.use_curl and builds a curl-backed
-- HttpClient (ingestion runtime httpClientForSource -> core/fetcher makeCurlTransport).
--
-- DIRECT egress only — QE quotes is not proxied. Reversible with no code change: set use_curl=false.
-- Guarded on the live-board URL so it only touches the mw.php source (id 10), never the Yahoo
-- fallback (id 21).
update ingest.sources
set endpoint_config = coalesce(endpoint_config, '{}'::jsonb) || jsonb_build_object('use_curl', true)
where venue = 'QE'
  and data_type = 'quotes'
  and endpoint_config->>'urlTemplate' = 'https://www.qe.com.qa/wp/mw_app/mw.php';
