-- 0007_datapoints_scores — datapoint series/values with lake lineage, Marsad
-- Score tables, lake→datapoint fan-out trigger. 02 §6, §9, §22 step 7.

create table public.datapoint_series (
  id                 bigint generated always as identity primary key,
  security_id        bigint references public.securities(id),
  entity_kind        text not null default 'security' check (entity_kind in ('security','index','venue','macro')),
  entity_ref         text,
  metric_key         text not null,
  display_name       text not null,
  unit               text not null,
  cadence            text not null check (cadence in ('quarterly','annual','monthly','event','daily')),
  maintainer_id      uuid references iam.principals(id),
  revision_sla_hours int not null default 24,
  is_public          boolean not null default true,
  created_at         timestamptz not null default now()
);
create unique index datapoint_series_uni on public.datapoint_series
  (entity_kind, coalesce(entity_ref,''), coalesce(security_id,0), metric_key);

create table public.datapoints (
  id               bigint generated always as identity primary key,
  series_id        bigint not null references public.datapoint_series(id) on delete cascade,
  period           text not null,
  period_end       date not null,
  value            numeric not null,
  prev_value       numeric,
  source_object_id uuid not null references lake.objects(id),
  as_of            timestamptz not null default now(),
  -- DEFERRABLE: fn_datapoint_fanout points the old row at a pre-allocated new
  -- id BEFORE inserting it (the partial unique index below forbids two live
  -- rows, so insert-first is impossible); the FK is checked at COMMIT.
  superseded_by    bigint references public.datapoints(id) deferrable initially deferred
);
-- One live value per period (02 §6, partial unique).
create unique index datapoints_live_uni on public.datapoints (series_id, period_end) where superseded_by is null;
create index datapoints_series_idx on public.datapoints (series_id, period_end desc) where superseded_by is null;

-- Fan-out: on lake verification, project the scalar into public.datapoints.
-- Series binding contract: payload carries metric_key + period/period_end.
-- No matching series ⇒ silently skipped (not every object is a chart series).
create or replace function lake.fn_datapoint_fanout() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_series bigint;
  v_period_end date;
  v_prev numeric;
  v_prev_id bigint;
  v_new_id bigint;
begin
  if new.state <> 'VERIFIED' or old.state = 'VERIFIED' then return null; end if;
  if new.numeric_value is null or new.payload ->> 'metric_key' is null then return null; end if;

  select s.id into v_series
  from public.datapoint_series s
  where s.metric_key = new.payload ->> 'metric_key'
    and (s.security_id = new.security_id
         or (s.security_id is null and s.entity_ref = new.payload ->> 'entity_ref'))
  limit 1;
  if v_series is null then return null; end if;

  v_period_end := coalesce((new.payload ->> 'period_end')::date, new.effective_date);
  if v_period_end is null then return null; end if;

  select d.id, d.value into v_prev_id, v_prev
  from public.datapoints d
  where d.series_id = v_series and d.period_end = v_period_end and d.superseded_by is null;

  if v_prev_id is not null then
    -- Supersede BEFORE inserting: datapoints_live_uni allows one live row per
    -- (series, period_end), so the previous row must stop being live first.
    -- The new id is pre-allocated; the deferred self-FK resolves at COMMIT.
    v_new_id := nextval(pg_get_serial_sequence('public.datapoints', 'id'));
    update public.datapoints set superseded_by = v_new_id where id = v_prev_id;
    insert into public.datapoints (id, series_id, period, period_end, value, prev_value, source_object_id)
    overriding system value
    values (v_new_id, v_series,
            coalesce(new.payload ->> 'period', to_char(v_period_end, 'YYYY-MM-DD')),
            v_period_end, new.numeric_value, v_prev, new.id);
  else
    insert into public.datapoints (series_id, period, period_end, value, prev_value, source_object_id)
    values (v_series,
            coalesce(new.payload ->> 'period', to_char(v_period_end, 'YYYY-MM-DD')),
            v_period_end, new.numeric_value, v_prev, new.id);
  end if;
  return null;
end $$;

create trigger objects_datapoint_fanout after update on lake.objects
  for each row execute function lake.fn_datapoint_fanout();

-- ---------------------------------------------------------------------------
-- Marsad Score (02 §9). Absence of a scores row = the 22c PENDING state.

create table public.scores (
  security_id         bigint primary key references public.securities(id) on delete cascade,
  score               smallint not null check (score between 0 and 100),
  rating              text not null check (rating in ('BUY','OVERWEIGHT','HOLD','UNDERWEIGHT','SELL')),
  weekly_delta        smallint,
  grade_value         text check (grade_value ~ '^[A-D][+-]?$'),
  grade_growth        text check (grade_growth ~ '^[A-D][+-]?$'),
  grade_profitability text check (grade_profitability ~ '^[A-D][+-]?$'),
  grade_momentum      text check (grade_momentum ~ '^[A-D][+-]?$'),
  grade_revisions     text check (grade_revisions ~ '^[A-D][+-]?$'),
  sector_percentile   smallint,
  sector_peer_count   int,
  computed_at         timestamptz not null,
  next_compute_at     timestamptz,
  source_object_id    uuid references lake.objects(id)
);

create table public.score_history (
  security_id       bigint not null references public.securities(id),
  computed_on       date not null,
  score             smallint not null,
  rating            text not null,
  grades            jsonb not null,
  sector_percentile smallint,
  primary key (security_id, computed_on)
);

create table public.score_events (
  id          bigint generated always as identity primary key,
  security_id bigint not null references public.securities(id),
  event_kind  text not null check (event_kind in ('score_change','rating_change','grade_change')),
  old_value   text,
  new_value   text,
  detail      jsonb,
  occurred_at timestamptz not null default now()
);
create index score_events_time_idx on public.score_events (occurred_at desc);

create table public.marsad_select (
  rebalance_month date not null,
  rank            smallint not null check (rank between 1 and 5),
  security_id     bigint not null references public.securities(id),
  note            text,
  primary key (rebalance_month, rank)
);

-- Free-surface score teaser (02 Revisions): direction + magnitude bucket only
-- for free/anon; exact values pass through for premium/enterprise JWTs.
create view public.score_events_feed as
select e.id,
       e.security_id,
       e.event_kind,
       e.occurred_at,
       case when e.old_value ~ '^\d+$' and e.new_value ~ '^\d+$'
            then sign(e.new_value::int - e.old_value::int)::int end as direction,
       case when e.old_value ~ '^\d+$' and e.new_value ~ '^\d+$' then
         case when abs(e.new_value::int - e.old_value::int) >= 10 then 'large'
              when abs(e.new_value::int - e.old_value::int) >= 4  then 'medium'
              else 'small' end
       end as magnitude,
       case when public.jwt_tier() in ('premium','enterprise') then e.old_value end as old_value,
       case when public.jwt_tier() in ('premium','enterprise') then e.new_value end as new_value
from public.score_events e;
