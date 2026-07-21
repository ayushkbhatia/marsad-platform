-- 20260722141000 — SECURITY (H-3): revoke anon/authenticated EXECUTE on fn_screener_run.
--
-- public.fn_screener_run(p_criteria jsonb, p_limit integer) is SECURITY DEFINER and its
-- RETURNS TABLE reads key_ratios.pe / pb / roe / dividend_yield directly — so anyone with the
-- browser-embedded anon key could POST /rest/v1/rpc/fn_screener_run and read the PREMIUM
-- valuation ratios, bypassing the v_key_ratios_public free-columns-only gate the reader contract
-- promises. Verified live: prosecdef=true, anon EXECUTE=true.
--
-- Nothing in the reader calls this RPC (the reader screener filters getScreenerUniverse() in-memory
-- via /api/screener/run; only a doc-comment in src/lib/data/entities.ts named it). Pure revoke, safe.

set search_path = '';

revoke execute on function public.fn_screener_run(jsonb, integer) from anon, authenticated, public;
