-- 0033_key_ratios_score_cols — the [NEW COL] additive set on public.key_ratios
-- that the Marsad Score (P1.7c) consumes (07-lake-enrichment.md §3.2). Forward-only,
-- no destructive change: every column is nullable and defaults NULL so the nightly
-- fn_recompute path (ingestion KeyRatiosRecompute) backfills them without a rewrite.
--
--   net_margin/gross_margin  — profitability margins (gross null for banks/insurers, §3.3)
--   rev_growth_yoy/eps_growth_yoy — TTM-vs-prior-year-TTM growth
--   rev_cagr_3y/eps_cagr_3y  — 3-year CAGR ((ttm / 3y_ago)^(1/3) − 1)
--   ret_3m/ret_6m/ret_12_1   — dividend/split-adjusted price momentum from ohlcv_daily
--   ebitda_ttm               — cached, feeds ev_ebitda + net_debt_ebitda + the Score
--   currency_computed        — ratios are in local ccy; USD-normalize at read via fx_rates

alter table public.key_ratios
  add column net_margin        numeric(7,4),
  add column gross_margin      numeric(7,4),
  add column rev_growth_yoy    numeric(9,4),
  add column eps_growth_yoy    numeric(9,4),
  add column rev_cagr_3y       numeric(9,4),
  add column eps_cagr_3y       numeric(9,4),
  add column ret_3m            numeric(9,4),
  add column ret_6m            numeric(9,4),
  add column ret_12_1          numeric(9,4),
  add column ebitda_ttm        numeric(20,2),
  add column currency_computed char(3);
