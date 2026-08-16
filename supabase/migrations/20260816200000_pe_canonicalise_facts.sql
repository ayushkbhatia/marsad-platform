-- PE — turn comprehension output into first-class lake objects.
--
-- ── THE PROBLEM ───────────────────────────────────────────────────────────────
-- ops.v_intake_readiness says only ONE of six material signal families has any supply:
-- FILING.FINANCIALS. DIVIDEND.EXDATE, DISCLOSURE.DPS, EARNINGS.VERDICT and IPO.OFFER are all
-- zero, and the standing conclusion was that the newsroom is starved.
--
-- It is not. The facts already exist — in the wrong table.
--   · public.filings.extracted_facts->'ai' carries {doc_type, event_date, key_points[],
--     dividend, earnings} on 10,317 filings, written by the filing-extractor lane.
--   · public.earnings_events carries eps_actual AND eps_prior on 5,781 rows.
-- Both are invisible to the newsroom, which reads lake.objects. Nothing bridges them.
--
--   EARNINGS.VERDICT  5,781 candidates
--   FILING.EVENT      8,307 candidates
--   DISCLOSURE.DPS /
--   DIVIDEND.EXDATE   2,884 candidates
--
-- ── WHY SQL AND NOT A RESEARCHER SCRIPT ───────────────────────────────────────
-- The plan called for ingestion/src/lake/*.ts plus a scripts/researchers/*.mjs runner, on the
-- reasoning that Worker Deploy was broken so only scp'd researchers could ship. Two things
-- changed that: Worker Deploy is green again, and more decisively, a new systemd timer still
-- needs someone with a shell on the VPS to enable it — so a researcher would sit in git,
-- unscheduled, which is precisely how scripts/researchers/dividend-declared.mjs came to have
-- zero parse runs in its entire life.
--
-- This work is a pure DB→DB projection: source and target are both Postgres, security
-- resolution is a join, and the batch bound is a LIMIT. It runs on pg_cron with no deploy and
-- no shell. It also sidesteps the parse-run race by construction (20260816190000): the run is
-- opened and marked succeeded in the same statement, before any object references it.
--
-- ── ON NOT WRITING earnings_events.verdict ────────────────────────────────────
-- Deliberately untouched. Its CHECK is ('BEAT','IN_LINE','MISS','HELD') — a CONSENSUS
-- vocabulary — and public.estimates has 0 rows, so we have no consensus to beat. Our benchmark
-- is the prior year. Writing 'BEAT' into that column would publish a fabricated claim through
-- the reader surface, and R-03 could not catch it because the NUMBER is real; only the word is
-- wrong. The lake object states its benchmark explicitly instead.

-- ─── Shared: open a parse run that is already succeeded ───────────────────────
create or replace function lake.fn_open_canonicaliser_run(p_key text)
returns bigint
language sql security definer set search_path to ''
as $$
  insert into lake.parse_runs (agent_id, parser_key, parser_version, status, started_at, finished_at)
  select (select id from iam.principals where handle = 'DATA-FILINGS'),
         p_key, '1', 'succeeded', now(), now()
  returning id;
$$;

comment on function lake.fn_open_canonicaliser_run(text) is
  'Opens a parse run ALREADY marked succeeded. Deliberate: lake.fn_intake_admissible reads '
  'parse_runs.status, and a run left ''running'' while its objects are written is the exact '
  'race that made every Lane-B object permanently non-enqueueable (20260816190000). The run '
  'records lineage; it is not a progress indicator.';

-- ─── EARNINGS.VERDICT — the result vs the year before ─────────────────────────
create or replace function lake.fn_canonicalise_earnings_verdicts(p_limit int default 500)
returns int
language plpgsql security definer set search_path to ''
as $$
declare v_run bigint; v_n int;
begin
  v_run := lake.fn_open_canonicaliser_run('canon_earnings_verdict');

  with cand as (
    select ee.id, ee.security_id, ee.fiscal_period, ee.report_date,
           ee.eps_actual, ee.eps_prior, ee.results_filing_id, ee.source_object_id,
           s.ticker, s.venue_code
      from public.earnings_events ee
      join public.securities s on s.id = ee.security_id
     where ee.eps_actual is not null and ee.eps_prior is not null
       and not exists (
         select 1 from lake.objects o
          where o.natural_key = 'EARNINGS.VERDICT:' || s.venue_code || ':' || s.ticker || ':' || ee.fiscal_period
            and o.superseded_by is null)
     order by ee.report_date desc nulls last
     limit p_limit
  )
  insert into lake.objects
    (object_type, natural_key, security_id, venue_code, payload, numeric_value, unit,
     effective_date, state, revision, parse_run_id, source_rank, price_sensitive)
  select 'EARNINGS.VERDICT',
         'EARNINGS.VERDICT:' || c.venue_code || ':' || c.ticker || ':' || c.fiscal_period,
         c.security_id, c.venue_code,
         jsonb_build_object(
           -- NAME THE BENCHMARK. With public.estimates empty this is a year-on-year move, not
           -- a beat or a miss. BLK-VERDICT / BLK-BEATMISS must render "vs a year earlier".
           'benchmark',      'prior_year',
           'eps_actual',     c.eps_actual,
           'eps_prior',      c.eps_prior,
           'change_pct',     case when c.eps_prior <> 0
                                  then round(((c.eps_actual - c.eps_prior) / abs(c.eps_prior)) * 100, 2)
                                  else null end,
           'direction',      case when c.eps_actual > c.eps_prior then 'up'
                                  when c.eps_actual < c.eps_prior then 'down' else 'flat' end,
           'fiscal_period',  c.fiscal_period,
           'report_date',    c.report_date,
           'earnings_event_id', c.id,
           'source_filing_id',  c.results_filing_id),
         c.eps_actual, 'eps',
         c.report_date, 'PENDING', 1, v_run, 100, false
    from cand c
  on conflict (natural_key, revision) do nothing;

  get diagnostics v_n = row_count;
  update lake.parse_runs set objects_created = v_n where id = v_run;
  return v_n;
end $$;

-- ─── FILING.EVENT — the retrieval substrate ───────────────────────────────────
create or replace function lake.fn_canonicalise_filing_events(p_limit int default 500)
returns int
language plpgsql security definer set search_path to ''
as $$
declare v_run bigint; v_n int;
begin
  v_run := lake.fn_open_canonicaliser_run('canon_filing_event');

  with cand as (
    select f.id, f.security_id, f.venue_code, f.source_ref, f.filed_at, f.filing_type,
           f.title, f.ai_summary, f.is_market_moving,
           f.extracted_facts -> 'ai' as ai
      from public.filings f
     where f.extracted_facts ? 'ai'
       and f.security_id is not null
       and nullif(f.extracted_facts -> 'ai' ->> 'event_date', '') is not null
       and not exists (
         select 1 from lake.objects o
          where o.natural_key = 'FILING.EVENT:' || f.venue_code || ':' || f.source_ref
            and o.superseded_by is null)
     order by f.filed_at desc
     limit p_limit
  )
  insert into lake.objects
    (object_type, natural_key, security_id, venue_code, payload,
     effective_date, state, revision, parse_run_id, source_rank, price_sensitive)
  select 'FILING.EVENT',
         'FILING.EVENT:' || c.venue_code || ':' || c.source_ref,
         c.security_id, c.venue_code,
         jsonb_build_object(
           'doc_type',         c.ai ->> 'doc_type',
           'event_date',       c.ai ->> 'event_date',
           'key_points',       coalesce(c.ai -> 'key_points', '[]'::jsonb),
           'ai_summary',       c.ai_summary,
           'title',            c.title,
           'filing_type',      c.filing_type,
           'is_market_moving', c.is_market_moving,
           'filed_at',         c.filed_at,
           'source_filing_id', c.id,
           'filing_source_ref', c.source_ref),
         -- A malformed event_date must not abort a batch of 500.
         case when (c.ai ->> 'event_date') ~ '^\d{4}-\d{2}-\d{2}$'
              then (c.ai ->> 'event_date')::date else c.filed_at::date end,
         'PENDING', 1, v_run, 100, false
    from cand c
  on conflict (natural_key, revision) do nothing;

  get diagnostics v_n = row_count;
  update lake.parse_runs set objects_created = v_n where id = v_run;
  return v_n;
end $$;

-- ─── DISCLOSURE.DPS / DIVIDEND.EXDATE — price-sensitive ───────────────────────
create or replace function lake.fn_canonicalise_dividends(p_limit int default 500)
returns int
language plpgsql security definer set search_path to ''
as $$
declare v_run bigint; v_n int;
begin
  v_run := lake.fn_open_canonicaliser_run('canon_dividend');

  with cand as (
    select f.id, f.security_id, f.venue_code, f.source_ref, f.filed_at,
           s.ticker,
           f.extracted_facts -> 'ai' -> 'dividend' as d
      from public.filings f
      join public.securities s on s.id = f.security_id
     where f.extracted_facts -> 'ai' -> 'dividend' <> 'null'::jsonb
       and (f.extracted_facts -> 'ai' -> 'dividend' ->> 'dps') is not null
     order by f.filed_at desc
     limit p_limit
  ),
  typed as (
    select c.*,
           case when (c.d ->> 'ex_date') ~ '^\d{4}-\d{2}-\d{2}$' then (c.d ->> 'ex_date')::date end as ex_date
      from cand c
  )
  insert into lake.objects
    (object_type, natural_key, security_id, venue_code, payload, numeric_value, unit,
     effective_date, state, revision, parse_run_id, source_rank, price_sensitive)
  select
    case when t.ex_date is not null then 'DIVIDEND.EXDATE' else 'DISCLOSURE.DPS' end,
    case when t.ex_date is not null
         then 'DIVIDEND.EXDATE:' || t.venue_code || ':' || t.ticker || ':' || t.ex_date::text
         else 'DISCLOSURE.DPS:'  || t.venue_code || ':' || t.source_ref end,
    t.security_id, t.venue_code,
    jsonb_build_object(
      'dps',              (t.d ->> 'dps')::numeric,
      'currency',         t.d ->> 'currency',
      'ex_date',          t.d ->> 'ex_date',
      'record_date',      t.d ->> 'record_date',
      'pay_date',         t.d ->> 'pay_date',
      'source_filing_id', t.id,
      'filing_source_ref', t.source_ref),
    (t.d ->> 'dps')::numeric, coalesce(t.d ->> 'currency', 'unknown'),
    coalesce(t.ex_date, t.filed_at::date),
    -- PENDING and price_sensitive: lake.fn_object_state_guard requires a HUMAN verifier for
    -- these, and ops.materiality_prefilter keeps citable_states = {VERIFIED}. The desk confirm
    -- IS the intake gate for a dividend; that is 09 §3.4's position and the DB already enforces it.
    'PENDING', 1, v_run, 100, true
    from typed t
  on conflict (natural_key, revision) do nothing;

  get diagnostics v_n = row_count;
  update lake.parse_runs set objects_created = v_n where id = v_run;
  return v_n;
end $$;

-- ─── Orchestrator + schedule ──────────────────────────────────────────────────
create or replace function ops.canonicalise_facts(p_limit int default 500)
returns jsonb
language plpgsql security definer set search_path to ''
as $$
declare v_v int; v_e int; v_d int;
begin
  v_v := lake.fn_canonicalise_earnings_verdicts(p_limit);
  v_e := lake.fn_canonicalise_filing_events(p_limit);
  v_d := lake.fn_canonicalise_dividends(p_limit);
  return jsonb_build_object('earnings_verdict', v_v, 'filing_event', v_e, 'dividend', v_d);
end $$;

select cron.unschedule('canonicalise_facts') where exists
  (select 1 from cron.job where jobname = 'canonicalise_facts');
select cron.schedule('canonicalise_facts', '7 * * * *', $$select ops.canonicalise_facts(500)$$);

-- ─── Seed the backlog in bounded passes, then assert ──────────────────────────
do $$
declare v jsonb; i int;
begin
  for i in 1..30 loop
    v := ops.canonicalise_facts(500);
    exit when (v ->> 'earnings_verdict')::int = 0
          and (v ->> 'filing_event')::int = 0
          and (v ->> 'dividend')::int = 0;
  end loop;
  raise notice 'canonicalisation seeded: %', v;
end $$;

do $$
declare v_types text;
begin
  select string_agg(object_type || '=' || n, ' ' order by object_type)
    into v_types
    from (select object_type, count(*) n from lake.objects
           where object_type in ('EARNINGS.VERDICT','FILING.EVENT','DISCLOSURE.DPS','DIVIDEND.EXDATE')
           group by object_type) t;
  raise notice 'new families: %', coalesce(v_types, 'NONE');

  -- Assert the INVARIANT, not a production headcount: after the seeding loop no eligible
  -- candidate may remain un-canonicalised. True of an empty database (0 = 0) and of
  -- production, and strictly stronger than "expect 2 families" — it catches a candidate the
  -- loop skipped, which a count never could. (An absolute threshold here is what failed CI
  -- from-scratch: a fresh database has no filings, so zero objects is the right answer.)
  if exists (
    select 1
      from public.earnings_events ee
      join public.securities s on s.id = ee.security_id
     where ee.eps_actual is not null and ee.eps_prior is not null
       and not exists (select 1 from lake.objects o
                        where o.natural_key = 'EARNINGS.VERDICT:' || s.venue_code || ':' || s.ticker || ':' || ee.fiscal_period
                          and o.superseded_by is null)
     limit 1
  ) then
    raise exception 'earnings verdict candidates remain un-canonicalised after seeding';
  end if;

  if exists (
    select 1 from public.filings f
     where f.extracted_facts ? 'ai' and f.security_id is not null
       and nullif(f.extracted_facts -> 'ai' ->> 'event_date', '') is not null
       and not exists (select 1 from lake.objects o
                        where o.natural_key = 'FILING.EVENT:' || f.venue_code || ':' || f.source_ref
                          and o.superseded_by is null)
     limit 1
  ) then
    raise exception 'filing event candidates remain un-canonicalised after seeding';
  end if;

  -- Every EARNINGS.VERDICT must name its benchmark, or a reader will call it a beat.
  if exists (select 1 from lake.objects
              where object_type = 'EARNINGS.VERDICT' and payload ->> 'benchmark' is distinct from 'prior_year') then
    raise exception 'an EARNINGS.VERDICT is missing benchmark=prior_year';
  end if;

  -- Dividends must be price-sensitive, or a machine could verify them.
  if exists (select 1 from lake.objects
              where object_type in ('DISCLOSURE.DPS','DIVIDEND.EXDATE') and not price_sensitive) then
    raise exception 'a dividend object is not price_sensitive';
  end if;
end $$;
