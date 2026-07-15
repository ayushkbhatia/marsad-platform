-- MSX OHLCV backfill → the summary-report.aspx/List endpoint (full OHLCV, ~23y).
--
-- Repoints the MSX ohlcv_backfill source (id=26) from the retired close-only company-chart-data.aspx
-- (provider msx-company-chart, which 400'd + burned the msx.om budget) to the Summary-Report "List"
-- endpoint: POST summary-report.aspx/List body {"Symbol":"{sym}","Type":"D","From":"1990-01-01",
-- "To":"{today}"} → {"d":[ {DateEn,Open,High,Low,Close,Volume,Turnover,…} ]}, one POST = full daily
-- history (BKMB 5750 bars 2003→today). This is the endpoint behind the site's Summary-Report →
-- Export-to-Excel flow (the Excel button re-formats the same JSON). Plain HTTP, no browser/captcha.
-- Adapter: adapters/msx/history.ts (provider 'msx-summary', full OHLC, "Mmm DD, YYYY"→ISO). Lowercase
-- header keys (override fetcher defaults). Left active; the runtime coverage guard (ohlcv_backfilled_at)
-- + BACKFILL_CHUNK_SIZE chunk it, and it stops once every MSX security is seeded.

update ingest.sources
set transport = 'http',
    active = true,
    endpoint_config = jsonb_build_object(
      'method', 'POST',
      'provider', 'msx-summary',
      'urlTemplate', 'https://www.msx.om/summary-report.aspx/List',
      'responseKind', 'json',
      'timeoutMs', 30000,
      'fromDate', '1990-01-01',
      'fetch_concurrency', 4,
      'headers', jsonb_build_object(
        'content-type', 'application/json; charset=UTF-8',
        'x-requested-with', 'XMLHttpRequest',
        'accept', 'application/json, text/javascript, */*; q=0.01',
        'referer', 'https://www.msx.om/summary-report.aspx',
        'user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
      )
    )
where id = 26 and venue = 'MSX' and data_type = 'ohlcv_backfill';
