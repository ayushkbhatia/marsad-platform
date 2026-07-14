-- 0038_key_ratios_score_cols — Score-input columns on public.key_ratios.
--
-- PROVENANCE: applied to prod live 2026-07-14 (ledger `key_ratios_score_cols`) but its .sql was never
-- committed; recovered verbatim from supabase_migrations.schema_migrations.statements and committed here
-- so `supabase db reset` (CI from-scratch) reproduces prod. Ordered after 0037 (append, not renumber)
-- since it only ALTERs public.key_ratios (0006) and is independent of 0030–0037.

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
