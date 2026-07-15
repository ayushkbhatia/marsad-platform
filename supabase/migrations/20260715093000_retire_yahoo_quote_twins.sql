-- Retire the Yahoo per-symbol QUOTE twins for TDWL/DFM/QE — redundant with the
-- native boards, and a needless drain on the rotating IPRoyal proxy.
--
-- Completes 081318 (dfm_qe_native_quote_boards), which retired the DFM/QE Yahoo
-- quote twins (id 20/21) but MISSED the TDWL twin (id 19): it kept polling
-- query1.finance.yahoo.com per-symbol through the proxy (~282 fetches/24h) for
-- tickers the Mubasher native board (id 1) already carries in full.
--
-- Background: 0021 seeded provider='yahoo' per-symbol quote sources as a 2nd
-- cross-check source; 0027 routed all Yahoo sources through the rotating proxy.
-- 081318 then moved each venue to its native single-source board, and the
-- QUOTE.LAST live-latest in-place refresh (cross-check.ts) advances single-source
-- quotes each poll — so the Yahoo quote 2nd-source is no longer needed. Verified
-- 2026-07-15: the Yahoo twins carry ZERO tickers the native boards lack
-- (TDWL 268⊂414, DFM 52⊂473, QE 49⊂146) → pure redundant proxy fetches.
--
-- Scoped by natural key (data_type='quotes' AND provider='yahoo') so it targets
-- exactly the three quote twins and can never silently miss one again. Does NOT
-- touch the Yahoo ohlcv_backfill sources (data_type='ohlcv_backfill', still paused
-- pending Mubasher-direct routing — see BUILD-STATUS §7) or any WAF venue (BHB,
-- provider≠yahoo). enqueue_due_jobs() already gates on ingest.sources.active (0005),
-- so clearing the source is sufficient; the schedule is cleared too for an
-- unambiguous off-state. IDEMPOTENT + id-independent. Targets LIVE prod
-- (yjsncnpbjuueaoeejrqj).

update ingest.sources
set active = false
where data_type = 'quotes'
  and coalesce(endpoint_config ->> 'provider', '') = 'yahoo';

update ingest.schedules sc
set active = false
from ingest.sources s
where sc.source_id = s.id
  and s.data_type = 'quotes'
  and coalesce(s.endpoint_config ->> 'provider', '') = 'yahoo';
