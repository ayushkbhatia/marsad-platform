-- 0005_prices — quotes (hot row + partitioned history), OHLCV, index levels,
-- freshness/halts state, heatmap/movers MVs (02 §7, §22 step 5), plus the
-- ingestion registry/queue (01 §3.4) and ops health tables the feed-status
-- sweep writes (06 §6). The ingest tables live here (not in 02 §22's list)
-- because this is the earliest point their dependencies exist.

create table public.quotes_latest (
  security_id   bigint primary key references public.securities(id) on delete cascade,
  last          numeric(18,6),
  change        numeric(18,6),
  change_pct    numeric(9,4),
  open          numeric(18,6),
  high          numeric(18,6),
  low           numeric(18,6),
  volume        numeric(20,0),
  vwap          numeric(18,6),
  week52_high   numeric(18,6),
  week52_low    numeric(18,6),
  as_of         timestamptz not null,
  captured_at   timestamptz not null,
  delay_minutes int not null default 15,
  snapshot_id   bigint references lake.snapshots(id),
  tick_dir      smallint check (tick_dir in (-1,0,1))
);

create table public.quotes_intraday (
  security_id bigint not null,
  captured_at timestamptz not null,
  last        numeric(18,6) not null,
  change_pct  numeric(9,4),
  volume      numeric(20,0),
  snapshot_id bigint,
  primary key (security_id, captured_at)
) partition by range (captured_at);

create table public.quotes_intraday_y2026m07 partition of public.quotes_intraday
  for values from ('2026-07-01') to ('2026-08-01');
create table public.quotes_intraday_y2026m08 partition of public.quotes_intraday
  for values from ('2026-08-01') to ('2026-09-01');
create table public.quotes_intraday_y2026m09 partition of public.quotes_intraday
  for values from ('2026-09-01') to ('2026-10-01');

create table public.ohlcv_daily (
  security_id  bigint not null references public.securities(id),
  trade_date   date not null,
  open         numeric(18,6),
  high         numeric(18,6),
  low          numeric(18,6),
  close        numeric(18,6) not null,
  volume       numeric(20,0),
  value_traded numeric(20,2),
  primary key (security_id, trade_date)
);

create table public.index_levels (
  index_code   text not null references public.indices(code),
  as_of        timestamptz not null,
  level        numeric(18,4) not null,
  change       numeric(18,4),
  change_pct   numeric(9,4),
  day_high     numeric(18,4),
  day_low      numeric(18,4),
  value_traded numeric(20,2),
  primary key (index_code, as_of)
);

create table public.index_levels_daily (
  index_code text not null references public.indices(code),
  trade_date date not null,
  open  numeric(18,4),
  high  numeric(18,4),
  low   numeric(18,4),
  close numeric(18,4) not null,
  primary key (index_code, trade_date)
);

-- 6-state machine + 'closed' (01 §8 post-review: closed is part of the machine).
create table public.venue_feed_status (
  venue_code   text primary key references public.venues(code),
  state        text not null default 'delayed'
               check (state in ('live','reconnecting','delayed','offline','halted','auction','closed')),
  detail       text,
  last_sync_at timestamptz,
  retry_count  int not null default 0,
  latency_ms   int,
  updated_at   timestamptz not null default now()
);

create table public.security_status (
  security_id  bigint primary key references public.securities(id),
  state        text not null check (state in ('halted','auction','stale')),
  reason       text,
  resume_at    timestamptz,
  annotated_by uuid references iam.principals(id),
  linked_wire  uuid,   -- FK to content_items added in 0008 (forward reference, 02 §22)
  updated_at   timestamptz not null default now()
);
create trigger security_status_updated_at before update on public.security_status
  for each row execute function public.set_updated_at();

-- Heatmap/movers aggregates, refreshed post-scrape (02 §7).
create materialized view public.mv_sector_heatmap as
select s.venue_code,
       s.sector,
       count(*)                                   as n_securities,
       avg(q.change_pct)                          as avg_change_pct,
       sum(q.volume * q.last)                     as approx_value_traded
from public.securities s
join public.quotes_latest q on q.security_id = s.id
where s.status = 'listed'
group by s.venue_code, s.sector;
create unique index mv_sector_heatmap_uni on public.mv_sector_heatmap (venue_code, sector);

create materialized view public.mv_movers as
select s.id as security_id, s.venue_code, s.ticker, s.name_en, s.sector,
       q.last, q.change_pct, q.volume, q.as_of
from public.securities s
join public.quotes_latest q on q.security_id = s.id
where s.status = 'listed' and q.change_pct is not null;
create unique index mv_movers_uni on public.mv_movers (security_id);

create or replace function public.refresh_market_mvs() returns void
language plpgsql security definer set search_path = ''
as $$
begin
  refresh materialized view concurrently public.mv_sector_heatmap;
  refresh materialized view concurrently public.mv_movers;
end $$;

-- ---------------------------------------------------------------------------
-- Ops health tables (06 §6) — created before the sweep function that writes them.

create table ops.job_heartbeats (
  job_name             text primary key,
  expected_interval_s  int not null,
  last_run_at          timestamptz,
  last_ok_at           timestamptz,
  last_error           text,
  consecutive_failures int not null default 0
);

create table ops.job_runs (
  id          bigint generated always as identity primary key,
  job_name    text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  detail      jsonb not null default '{}'
);
create index job_runs_name_time on ops.job_runs (job_name, started_at desc);

create table ops.incidents (
  id          bigint generated always as identity primary key,
  severity    text not null default 'degraded' check (severity in ('info','degraded','critical')),
  source      text not null,
  message     text not null,
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  auto_expire boolean not null default true
);
create index incidents_open_idx on ops.incidents (created_at) where resolved_at is null;

-- 33a composer (05 §9.3, renamed into ops per 02 Revisions).
create table ops.incident_banners (
  id                      uuid primary key default gen_random_uuid(),
  message                 text not null,
  severity                text not null default 'info' check (severity in ('info','degraded')),
  surfaces                text[] not null,
  venue_code              text references public.venues(code),
  auto_expire_on_recovery boolean not null default true,
  starts_at               timestamptz not null default now(),
  expires_at              timestamptz,
  created_by              uuid not null references iam.principals(id),
  cleared_at              timestamptz,
  cleared_by              uuid references iam.principals(id)
);

-- agent_runs 90-day rollup target (02 §12 retention).
create table ops.agent_daily_stats (
  agent_id        uuid not null references iam.principals(id),
  day             date not null,
  runs            int not null default 0,
  failures        int not null default 0,
  objects_created int not null default 0,
  primary key (agent_id, day)
);

-- ---------------------------------------------------------------------------
-- Ingestion registry, raw index, queue, schedules (01 §3.4). Blob bodies go to
-- Storage bucket lake-raw (02 is naming authority for buckets).

create table ingest.sources (
  id                   bigint generated always as identity primary key,
  venue                text not null references public.venues(code),
  data_type            text not null,
  entry_url            text not null,
  endpoint_config      jsonb not null,
  normalize_rules      jsonb not null default '[]',
  transport            text not null check (transport in ('http','http_bootstrap','headless')),
  robots_status        text not null default 'allowed' check (robots_status in ('allowed','disallowed','override')),
  active               boolean not null default true,
  last_content_hash    text,
  last_changed_at      timestamptz,
  last_success_at      timestamptz,
  consecutive_failures int not null default 0,
  unique (venue, data_type, entry_url)
);

create table ingest.raw_snapshots (
  id           bigint generated always as identity primary key,
  source_id    bigint not null references ingest.sources,
  fetched_at   timestamptz not null default now(),
  url          text not null,
  http_status  int not null,
  content_type text not null,
  content_hash text not null,
  storage_path text not null,
  bytes_stored int not null,
  external_id  text,
  meta         jsonb not null default '{}'
);
create index raw_snapshots_source_time on ingest.raw_snapshots (source_id, fetched_at desc);
-- NULLS NOT DISTINCT so NULL external_id sources (quote boards, bulletins) dedupe too.
create unique index raw_snapshots_dedupe_uni on ingest.raw_snapshots (source_id, content_hash, external_id)
  nulls not distinct;

create table ingest.fetch_log (
  id          bigint generated always as identity primary key,
  source_id   bigint not null references ingest.sources,
  fetched_at  timestamptz not null default now(),
  http_status int,
  changed     boolean not null,
  duration_ms int,
  error       text
);
create index fetch_log_source_time on ingest.fetch_log (source_id, fetched_at desc);

create table ingest.parse_runs (
  id             bigint generated always as identity primary key,
  snapshot_id    bigint not null references ingest.raw_snapshots,
  parser_version int not null,
  started_at     timestamptz not null default now(),
  status         text not null check (status in ('ok','error','drift_zero_rows')),
  rows_emitted   int,
  error          text
);

create table ingest.seen_items (
  source_id    bigint not null references ingest.sources,
  external_id  text not null,
  first_seen   timestamptz not null default now(),
  detail_state text not null default 'pending' check (detail_state in ('pending','fetched','failed')),
  primary key (source_id, external_id)
);

create table ingest.job_queue (
  id          bigint generated always as identity primary key,
  source_id   bigint not null references ingest.sources,
  enqueued_at timestamptz not null default now(),
  run_after   timestamptz not null default now(),
  priority    int not null default 5,
  claimed_by  text,
  claimed_at  timestamptz,
  finished_at timestamptz,
  status      text not null default 'queued' check (status in ('queued','running','ok','failed','skipped_closed'))
);
create index job_queue_claim_idx on ingest.job_queue (priority, run_after) where status = 'queued';

create table ingest.schedules (
  id               bigint generated always as identity primary key,
  source_id        bigint not null references ingest.sources,
  cadence_minutes  int not null,
  session_only     boolean not null default false,
  offset_minutes   int not null default 0,
  last_enqueued_at timestamptz,
  active           boolean not null default true
);

-- ---------------------------------------------------------------------------
-- Calendar helper + scheduler + sweep functions (01 §4.1, §8).

create or replace function ingest.venue_is_open(
  p_venue text, p_at timestamptz,
  p_grace_before interval default '0', p_grace_after interval default '0'
) returns boolean
language plpgsql stable set search_path = ''
as $$
declare
  v_tz    text;
  v_days  int[];
  v_local timestamptz;
  v_dow   int;
begin
  select timezone, trading_days into v_tz, v_days from public.venues where code = p_venue and is_active;
  if not found then return false; end if;

  -- 02 convention: trading_days uses 0=Sun … 6=Sat.
  v_dow := extract(dow from (p_at at time zone v_tz))::int;
  if not (v_dow = any (v_days)) then return false; end if;

  if exists (select 1 from public.market_holidays
             where venue_code = p_venue and holiday_date = (p_at at time zone v_tz)::date) then
    return false;
  end if;

  return exists (
    select 1 from public.market_sessions ms
    where ms.venue_code = p_venue
      and ms.effective_from <= (p_at at time zone v_tz)::date
      and (ms.effective_to is null or ms.effective_to >= (p_at at time zone v_tz)::date)
      and (p_at at time zone v_tz)::time >= ms.open_local  - p_grace_before
      and (p_at at time zone v_tz)::time <  ms.close_local + p_grace_after
  );
end $$;

create or replace function ingest.enqueue_due_jobs() returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int := 0;
  r record;
begin
  for r in
    select sc.id as schedule_id, sc.source_id, sc.session_only, sc.offset_minutes, s.venue
    from ingest.schedules sc
    join ingest.sources s on s.id = sc.source_id and s.active
    where sc.active
      and (sc.last_enqueued_at is null
           or now() - sc.last_enqueued_at >= make_interval(mins => sc.cadence_minutes))
  loop
    if r.session_only
       and not ingest.venue_is_open(r.venue, now(), interval '10 minutes', interval '20 minutes') then
      continue;
    end if;
    insert into ingest.job_queue (source_id, run_after)
    values (r.source_id, now() + make_interval(mins => r.offset_minutes));
    update ingest.schedules set last_enqueued_at = now() where id = r.schedule_id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

create or replace function ingest.requeue_stuck_jobs(p_age interval) returns int
language sql security definer set search_path = ''
as $$
  with r as (
    update ingest.job_queue
       set status = 'queued', claimed_by = null, claimed_at = null
     where status = 'running' and claimed_at < now() - p_age
    returning 1
  )
  select count(*)::int from r;
$$;

-- Loop B (01 §8): pure SQL over ingest.sources + calendar; the single writer of
-- public.venue_feed_status. Thresholds at quotes cadence C = 10 min.
create or replace function ingest.sweep_feed_status() returns void
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
  v_new text;
  v_old text;
  v_last timestamptz;
begin
  for r in select code from public.venues where is_active
  loop
    select max(s.last_success_at) into v_last
    from ingest.sources s
    where s.venue = r.code and s.data_type = 'quotes' and s.active;

    if not ingest.venue_is_open(r.code, now()) then
      v_new := 'closed';
    elsif v_last is null or now() - v_last > interval '45 minutes' then
      v_new := 'offline';
    elsif now() - v_last > interval '30 minutes' then
      v_new := 'delayed';
    elsif now() - v_last > interval '15 minutes' then
      v_new := 'reconnecting';
    else
      v_new := 'live';
    end if;

    select state into v_old from public.venue_feed_status where venue_code = r.code;

    insert into public.venue_feed_status (venue_code, state, last_sync_at, updated_at)
    values (r.code, v_new, v_last, now())
    on conflict (venue_code) do update
      set state        = excluded.state,
          last_sync_at = excluded.last_sync_at,
          retry_count  = case when excluded.state in ('reconnecting','delayed','offline')
                              then public.venue_feed_status.retry_count + 1 else 0 end,
          updated_at   = now()
      -- halted/auction are market states set by the desk/parsers; the pipeline
      -- sweep never overwrites them (01 §8).
      where public.venue_feed_status.state not in ('halted','auction')
         or excluded.state = 'closed';

    if v_new = 'offline' and coalesce(v_old, '') <> 'offline' then
      insert into ops.incidents (severity, source, message)
      values ('degraded', 'feed:' || r.code,
              r.code || ' quotes feed OFFLINE — last sync ' || coalesce(v_last::text, 'never'));
    end if;

    if v_new = 'live' and coalesce(v_old, '') = 'offline' then
      update ops.incidents set resolved_at = now()
      where source = 'feed:' || r.code and resolved_at is null and auto_expire;
      update ops.incident_banners set cleared_at = now()
      where venue_code = r.code and cleared_at is null and auto_expire_on_recovery;
    end if;
  end loop;
end $$;

-- Silence detector for cron/worker jobs (06 §4.1 job 21).
create or replace function ops.heartbeat_sentinel() returns void
language plpgsql security definer set search_path = ''
as $$
begin
  insert into ops.incidents (severity, source, message)
  select 'degraded', 'job:' || h.job_name,
         'job ' || h.job_name || ' silent since ' || coalesce(h.last_run_at::text, 'never')
  from ops.job_heartbeats h
  where coalesce(h.last_run_at, 'epoch'::timestamptz) < now() - make_interval(secs => 2 * h.expected_interval_s)
    and not exists (select 1 from ops.incidents i
                    where i.source = 'job:' || h.job_name and i.resolved_at is null);
end $$;
