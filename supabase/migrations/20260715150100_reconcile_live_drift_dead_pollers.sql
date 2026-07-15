-- 20260715150100_reconcile_live_drift_dead_pollers — repo⇄live reconciliation (audit 2026-07-15).
--
-- The live DB was patched over MCP during the 2026-07-15 audit without matching repo SQL, and
-- several earlier migrations leave a fresh replay in a state the live DB deliberately moved off.
-- Every statement below is IDEMPOTENT and a NO-OP against today's live DB (this file was applied
-- live the same day via the worker DB role); its purpose is to make a fresh replay converge on
-- the live, working state instead of silently resurrecting dead or dangerous config.

set search_path = '';

-- ---------------------------------------------------------------------------
-- (1) BHB quotes (id16): drop the replay-fatal provider key; pin the live working config.
--
-- 20260715100000 wrote endpoint_config.provider='bhb_webapi'. runtime.tasksForProvider routes
-- provider-bearing rows ONLY to backfill TaskSpecs: for data_type='quotes' it returns [] WITHOUT
-- falling through to the ADAPTERS map (ingestion/src/runtime.ts:183-185), so on a replayed DB the
-- BHB quotes source dispatches ZERO tasks — silently killed. Live has NO provider key (quotes
-- route via ADAPTERS.BHB.quotes) and is proven working (14/21 ok fetches in the 24h before this
-- commit). Also pinned from live (diverges from BOTH 20260715100000 and 20260715141155):
--   use_proxy=false — the webapi host no longer WAF-gates; direct VPS egress works (the 141155
--                     header already noted the Radware WAF is gone; live went the rest of the way
--                     off the paid proxy). proxy_mode dropped with it.
--   rotated Bearer  — the previous PUBLIC client APIKey (49d257cf…) expired server-side (401s);
--                     this is the current token from the CompanyProfile page JS. NOT a server
--                     secret (same class as the one 20260715100000 committed).
--   'user-agent' key stays LOWERCASE exactly as live — the proven-working header shape.

update ingest.sources
set endpoint_config = jsonb_build_object(
      'method', 'GET',
      'urlTemplate', 'https://webapi.bahrainbourse.com/api/data/GetTabularData?storedProcdure=Quotes',
      'responseKind', 'json',
      'timeoutMs', 45000,
      'use_proxy', false,
      'headers', jsonb_build_object(
        'Authorization', 'Bearer 228d70201a384f7da667c75cd0f49146d238b950e9c44759b8fe3165af2061bc',
        'Accept', 'application/json',
        'Referer', 'https://bahrainbourse.com/',
        'user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
      )
    )
where id = 16 and venue = 'BHB' and data_type = 'quotes';

-- ---------------------------------------------------------------------------
-- (2) Deep-backfill pause (DEF-DEEP-BACKFILL-ROLLOUT) — the live pause, committed as SQL.
--
-- The Mubasher deep OHLCV re-drain (0042: TDWL→1993 / DFM→2000 / QE→2006, ~3-4M bars) was PAUSED
-- live (schedules off + coverage-guard stamps) pending the staging-throughput fix, but the pause
-- was never committed: a replay leaves 0035/0042's schedule activations standing and resurrects a
-- multi-million-bar drain into market hours. Pause EVERY ohlcv_backfill schedule — matches live
-- exactly (yahoo 22-24 retired by 0042, mubasher 25/27-29 + msx-summary 26 paused). Resuming is a
-- deliberate later flip owned by DEF-DEEP-BACKFILL-ROLLOUT (§7).

update ingest.schedules sc
   set active = false
  from ingest.sources s
 where s.id = sc.source_id
   and s.data_type = 'ohlcv_backfill'
   and sc.active;

-- Coverage-guard stamps: TDWL/DFM/QE securities were force-stamped live so listedTickersForVenue
-- (unbackfilledOnly) yields [] and any stray backfill job no-ops (runtime.ts coverage guard).
-- Reproduce that on replay (live no-op: all three venues are already fully stamped). ADX is NOT
-- blanket-stamped — live deliberately keeps 14 ADX names unstamped awaiting the re-drain (the
-- stale-mapping re-clears), and this migration must not hide them.

update public.securities
   set ohlcv_backfilled_at = now()
 where venue_code in ('TDWL', 'DFM', 'QE')
   and status = 'listed'
   and ohlcv_backfilled_at is null;

-- ---------------------------------------------------------------------------
-- (3) Dead pollers OFF until their fixes land — so fetch_log and freshness stop lying.
--
-- Filings: TDWL id2 + QE id11 have no pinned endpoint_config.urlTemplate → browser.bootstrap()
-- throws 'action discovery found no URL' on every poll (24h before this commit: 176 fetches each,
-- 0 ok, QE ~27s per attempt); BHB id17 is the same disease at ~17s/fetch (its source was already
-- flipped inactive live this morning — this commits that flip and parks its schedule with it).
-- All three re-activate as the LAST step of the DEF-VENUE-FILINGS turnkey fix (capture + pin the
-- real feed urlTemplate + golden fixture).
--
-- EOD bulletins: DFM/QE/MSX adapters expose NO eodBulletin TaskSpec (adapters/{dfm,qe,msx}/
-- index.ts) — the hourly eod_sweep job reports 'ok' while dispatching zero fetches, a fake-fresh
-- signal; TDWL eod_bulletin targets Akamai-blocked saudiexchange.sa, so when its close gate opens
-- it can only fail. ADX + BHB eod_bulletin STAY active: their adapters carry real eodBulletin
-- TaskSpecs (close-gated by eodCloseGate).

update ingest.sources
   set active = false
 where (venue, data_type) in (
         ('TDWL', 'filings_list'), ('QE', 'filings_list'), ('BHB', 'filings_list'),
         ('TDWL', 'eod_bulletin'), ('DFM', 'eod_bulletin'),
         ('QE', 'eod_bulletin'), ('MSX', 'eod_bulletin'))
   and active;

update ingest.schedules sc
   set active = false
  from ingest.sources s
 where s.id = sc.source_id
   and (s.venue, s.data_type) in (
         ('TDWL', 'filings_list'), ('QE', 'filings_list'), ('BHB', 'filings_list'),
         ('TDWL', 'eod_bulletin'), ('DFM', 'eod_bulletin'),
         ('QE', 'eod_bulletin'), ('MSX', 'eod_bulletin'))
   and sc.active;
