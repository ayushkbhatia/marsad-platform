-- QE quotes → the LIVE market-watch board (POST mw_app/mw.php).
--
-- The source was pointed at /pps/qse_files/MarketWatch.txt, which turned out to be a
-- STALE STATIC file: Last-Modified Oct 2025, byte-identical intraday (QNBK frozen at a
-- day-old 18.61), so every poll deduped as changed=false and QE quotes never advanced.
-- The QE website's real live board is a POST to www.qe.com.qa/wp/mw_app/mw.php with a
-- form body f=MarketWatch (same {total,rows:[…]} schema, LIVE prices — QNBK 17.22).
-- A plain-HTTP POST works from the VPS (200, 461KB, ~15s — fits the 25s timeout + the
-- fetcher's 30s connect ceiling). Lowercase header keys so they override fetcher defaults.

update ingest.sources
set endpoint_config = jsonb_build_object(
      'method', 'POST',
      'urlTemplate', 'https://www.qe.com.qa/wp/mw_app/mw.php',
      'responseKind', 'txt_json',
      'timeoutMs', 25000,
      'headers', jsonb_build_object(
        'content-type', 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-requested-with', 'XMLHttpRequest',
        'accept', '*/*',
        'referer', 'https://www.qe.com.qa/',
        'user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
      ),
      'body', 'f=MarketWatch'
    )
where id = 10 and venue = 'QE' and data_type = 'quotes';
