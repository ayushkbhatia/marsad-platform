-- 20260722140000 — SECURITY: revoke anon/authenticated from privileged mutation RPCs
-- and the desk-approvals view (H-1, H-2 from the reader anon-exposure audit 2026-07-22).
--
-- Verified live before applying:
--   accrue_ohlcv_from_quotes(date)      security_definer, anon+authenticated EXECUTE  → can forge OHLCV
--   bootstrap_securities_from_board(jsonb) security_definer, anon+authenticated EXECUTE → can inject securities
--   v_desk_approvals                    anon+authenticated SELECT, runs as owner       → leaks unpublished drafts
-- The public anon key ships in every browser, so these are reachable by anyone via PostgREST.
--
-- Pure REVOKE — reversible, and nothing legitimate uses these grants:
--   the reader never calls these RPCs; the Desk reads v_desk_approvals via the service-role
--   client (server-admin.ts), which bypasses grant checks. The worker connects out-of-band.

set search_path = '';

-- H-1 — privileged mutation RPCs must never be anon/authenticated-executable.
revoke execute on function public.accrue_ohlcv_from_quotes(date)       from anon, authenticated, public;
revoke execute on function public.bootstrap_securities_from_board(jsonb) from anon, authenticated, public;

-- H-2 — the pre-publication editorial queue must not be readable by anon/authenticated.
revoke all on public.v_desk_approvals from anon, authenticated;
