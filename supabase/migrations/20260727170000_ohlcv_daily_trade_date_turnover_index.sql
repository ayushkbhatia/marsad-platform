-- The index the reader's prerender head has always needed, and never had.
--
-- `listPrerenderStocks()` (src/lib/data/stock-params.ts) asks one question at build time:
--   select security_id, value_traded from public.ohlcv_daily
--    where trade_date = <latest> order by value_traded desc nulls last limit 60
--
-- Both existing indexes lead with security_id:
--   ohlcv_daily_pkey           btree (security_id, trade_date)
--   ohlcv_daily_sec_date_desc  btree (security_id, trade_date DESC)
-- A btree can only be used from its leading column, so an equality on trade_date alone matches
-- neither. Measured 2026-07-27: Seq Scan over 609,723 rows / 97 MB, then a top-60 sort —
-- **1,855 ms** as marsad_worker on a warm cache. Over PostgREST as `anon`, from a cold build
-- machine, that exceeds the role's statement_timeout and the query returns an error.
--
-- The consequence was not a slow build. It was a RED build for 10 commits (c181a86..a5b8d6c):
-- the caller discarded `error`, so a timeout became an empty result, and Next 16's Cache
-- Components rejects an empty generateStaticParams as EmptyGenerateStaticParamsError — an error
-- naming the wrong cause, on a route that was never touched. The caller's error handling is
-- fixed in the same commit; this is the half that makes the query cheap enough not to need it.
--
-- Column order is the query's shape: equality first, then the sort key with matching direction,
-- so the plan becomes an index scan that stops after 60 rows with no sort at all.

create index if not exists ohlcv_daily_date_turnover
  on public.ohlcv_daily (trade_date, value_traded desc nulls last);

comment on index public.ohlcv_daily_date_turnover is
  'Serves the reader prerender head: latest-session turnover leaders '
  '(where trade_date = ? order by value_traded desc nulls last limit N). '
  'Both other indexes lead with security_id and cannot answer a trade_date-only equality.';
