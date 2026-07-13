-- 0013_analytics_audit — partitioned event stream + rollup tables, ingest RPC
-- (service-role only, per 02 Revisions); append-only audit log with hash chain
-- + anchors; partition/retention maintenance. 02 §17, §18, §20, 05 §6.

create table analytics.events (
  id          bigint generated always as identity,
  occurred_at timestamptz not null default now(),
  event_type  text not null,
  user_id     uuid,
  anon_id     text,
  session_id  text,
  content_id  uuid,
  security_id bigint,
  props       jsonb not null default '{}',
  primary key (occurred_at, id)
) partition by range (occurred_at);

create table analytics.events_y2026m07 partition of analytics.events
  for values from ('2026-07-01') to ('2026-08-01');
create table analytics.events_y2026m08 partition of analytics.events
  for values from ('2026-08-01') to ('2026-09-01');
create table analytics.events_y2026m09 partition of analytics.events
  for values from ('2026-09-01') to ('2026-10-01');

create index events_type_time on analytics.events (event_type, occurred_at desc);
create index events_content   on analytics.events (content_id, occurred_at desc) where content_id is not null;

create table analytics.daily_content_stats (
  day        date not null,
  content_id uuid not null,
  views      int not null default 0,
  uniques    int not null default 0,
  saves      int not null default 0,
  shares     int not null default 0,
  paywall_hits int not null default 0,
  trials     int not null default 0,
  primary key (day, content_id)
);

create table analytics.daily_kpis (
  day  date primary key,
  kpis jsonb not null default '{}'
);

-- Ingest RPC. Post-review hardening: NOT exposed to anon/authenticated — the
-- /api/e route handler (validates, caps, strips IPs) inserts via service role.
create or replace function analytics.track(p_events jsonb) returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_allowed constant text[] := array[
    'page_view','click','share','save','watchlist_add','alert_create','ai_answer',
    'screener_run','paywall_hit','trial_start','ad_impression','hb'];
  v_count int := 0;
  e jsonb;
begin
  if jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) > 50 then
    raise exception 'track() expects an array of at most 50 events';
  end if;
  for e in select * from jsonb_array_elements(p_events)
  loop
    if not ((e ->> 'event_type') = any (v_allowed)) then
      continue;  -- unknown types are dropped, not fatal (lossy beacon contract)
    end if;
    insert into analytics.events (event_type, user_id, anon_id, session_id, content_id, security_id, props)
    values (e ->> 'event_type',
            nullif(e ->> 'user_id', '')::uuid,
            e ->> 'anon_id',
            e ->> 'session_id',
            nullif(e ->> 'content_id', '')::uuid,
            nullif(e ->> 'security_id', '')::bigint,
            coalesce(e -> 'props', '{}'::jsonb));
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- Audit log: partitioned yearly, append-only, hash-chained (02 §18, 05 §6.4).

create table ops.audit_log (
  id           bigint generated always as identity,
  occurred_at  timestamptz not null default now(),
  actor_id     uuid not null references iam.principals(id),
  category     text not null check (category in
               ('QUEUE','CONTENT','PUBLISH','LAKE','NAV','BILLING','IAM','RULES','ADS','DATA_OPS','SUPPORT')),
  action       text not null,
  object_ref   text,
  before_value jsonb,      -- REQUIRED on overrides (31b rule; enforced in ops.audit callers)
  detail       jsonb not null default '{}',
  prev_hash    bytea,
  row_hash     bytea,      -- set by trigger; never by callers
  primary key (occurred_at, id)
) partition by range (occurred_at);

create table ops.audit_log_y2026 partition of ops.audit_log
  for values from ('2026-01-01') to ('2027-01-01');
create table ops.audit_log_y2027 partition of ops.audit_log
  for values from ('2027-01-01') to ('2028-01-01');
create table ops.audit_log_y2028 partition of ops.audit_log
  for values from ('2028-01-01') to ('2029-01-01');

create index audit_actor_idx    on ops.audit_log (actor_id, occurred_at desc);
create index audit_category_idx on ops.audit_log (category, occurred_at desc);

-- Tamper-EVIDENCE, not tamper-proofing (05 §6.4): advisory lock serializes the
-- chain; head is anchored daily outside the database.
create or replace function ops.fn_audit_hash_chain() returns trigger
language plpgsql as $$
declare
  v_prev bytea;
begin
  perform pg_advisory_xact_lock(hashtext('audit_chain'));
  select row_hash into v_prev
  from ops.audit_log
  order by occurred_at desc, id desc
  limit 1;

  new.prev_hash := v_prev;
  -- occurred_at enters the hash as epoch seconds: timestamptz::text follows the
  -- session TimeZone/DateStyle, which would make hashes verifier-dependent.
  new.row_hash := sha256(
    coalesce(v_prev, '\x'::bytea) ||
    convert_to(concat_ws('|',
      extract(epoch from new.occurred_at)::text, new.actor_id, new.category, new.action,
      coalesce(new.object_ref, ''), coalesce(new.before_value::text, ''), new.detail::text
    ), 'UTF8'));
  return new;
end $$;

create trigger audit_hash_chain before insert on ops.audit_log
  for each row execute function ops.fn_audit_hash_chain();

create trigger audit_no_mutate before update or delete on ops.audit_log
  for each row execute function public.prevent_mutation();

-- Single write path so the trail cannot be forgotten by an application bug.
create or replace function ops.audit(
  p_actor uuid, p_category text, p_action text,
  p_object text default null, p_before jsonb default null, p_detail jsonb default '{}'
) returns void
language sql security definer set search_path = ''
as $$
  insert into ops.audit_log (actor_id, category, action, object_ref, before_value, detail)
  values (p_actor, p_category, p_action, p_object, p_before, coalesce(p_detail, '{}'::jsonb));
$$;

create table ops.audit_anchors (
  anchor_date date primary key,
  head_hash   bytea not null,
  row_count   bigint not null,
  created_at  timestamptz not null default now()
);

-- 00:05 GST daily: record the chain head and mail it to the owner (external
-- anchor at $0 — the owner's inbox is outside our infrastructure).
create or replace function ops.audit_anchor_daily() returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_head bytea;
  v_count bigint;
begin
  select row_hash into v_head from ops.audit_log order by occurred_at desc, id desc limit 1;
  select count(*) into v_count from ops.audit_log;
  if v_head is null then return; end if;

  insert into ops.audit_anchors (anchor_date, head_hash, row_count)
  values ((now() at time zone 'Asia/Dubai')::date, v_head, v_count)
  on conflict (anchor_date) do nothing;

  perform pgmq.send('q_email', jsonb_build_object(
    'task', 'audit_anchor_email',
    'anchor_date', (now() at time zone 'Asia/Dubai')::date,
    'head_hash', encode(v_head, 'hex'),
    'row_count', v_count));
end $$;

-- On-demand verification for 31b.
create or replace function ops.verify_audit_chain(p_from timestamptz, p_to timestamptz)
returns table (audit_id bigint, occurred_at timestamptz, expected bytea, actual bytea)
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
  v_expected bytea;
begin
  for r in select * from ops.audit_log a
           where a.occurred_at between p_from and p_to
           order by a.occurred_at, a.id
  loop
    -- Must mirror fn_audit_hash_chain exactly: epoch seconds, not ::text.
    v_expected := sha256(
      coalesce(r.prev_hash, '\x'::bytea) ||
      convert_to(concat_ws('|',
        extract(epoch from r.occurred_at)::text, r.actor_id, r.category, r.action,
        coalesce(r.object_ref, ''), coalesce(r.before_value::text, ''), r.detail::text
      ), 'UTF8'));
    if v_expected is distinct from r.row_hash then
      audit_id := r.id; occurred_at := r.occurred_at; expected := v_expected; actual := r.row_hash;
      return next;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Partition + retention maintenance (02 §20, §21 jobs 12/13).

create or replace function ops.ensure_partitions() returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_month date;
  v_year  int;
  v_name  text;
begin
  -- monthly partitions, current + next 3
  for i in 0..3 loop
    v_month := date_trunc('month', now())::date + make_interval(months => i);

    v_name := 'quotes_intraday_y' || to_char(v_month, 'YYYY') || 'm' || to_char(v_month, 'MM');
    if to_regclass('public.' || v_name) is null then
      execute format('create table public.%I partition of public.quotes_intraday for values from (%L) to (%L)',
                     v_name, v_month, v_month + interval '1 month');
      execute format('alter table public.%I enable row level security', v_name);
    end if;

    v_name := 'events_y' || to_char(v_month, 'YYYY') || 'm' || to_char(v_month, 'MM');
    if to_regclass('analytics.' || v_name) is null then
      execute format('create table analytics.%I partition of analytics.events for values from (%L) to (%L)',
                     v_name, v_month, v_month + interval '1 month');
      execute format('alter table analytics.%I enable row level security', v_name);
    end if;
  end loop;

  -- yearly audit partition, next year
  v_year := extract(year from now())::int + 1;
  v_name := 'audit_log_y' || v_year;
  if to_regclass('ops.' || v_name) is null then
    execute format('create table ops.%I partition of ops.audit_log for values from (%L) to (%L)',
                   v_name, make_date(v_year, 1, 1), make_date(v_year + 1, 1, 1));
    execute format('alter table ops.%I enable row level security', v_name);
  end if;

  -- pg_partman parity when installed (02 §1); harmless no-op otherwise
  begin
    perform partman.run_maintenance();
  exception when others then
    null;
  end;
end $$;

create or replace function ops.apply_retention() returns void
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
  v_month date;
begin
  -- quotes_intraday: 3 months, whole-partition drops only
  for r in select c.relname from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname ~ '^quotes_intraday_y\d{4}m\d{2}$'
  loop
    v_month := to_date(regexp_replace(r.relname, '^quotes_intraday_y(\d{4})m(\d{2})$', '\1\2'), 'YYYYMM');
    if v_month < date_trunc('month', now())::date - interval '3 months' then
      execute format('drop table public.%I', r.relname);
    end if;
  end loop;

  -- analytics.events: 13 months
  for r in select c.relname from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'analytics' and c.relname ~ '^events_y\d{4}m\d{2}$'
  loop
    v_month := to_date(regexp_replace(r.relname, '^events_y(\d{4})m(\d{2})$', '\1\2'), 'YYYYMM');
    if v_month < date_trunc('month', now())::date - interval '13 months' then
      execute format('drop table analytics.%I', r.relname);
    end if;
  end loop;

  -- audit_log: 7 years; DETACH only (archive-to-Storage is a worker task)
  for r in select c.relname from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           join pg_inherits i on i.inhrelid = c.oid
           where n.nspname = 'ops' and c.relname ~ '^audit_log_y\d{4}$'
  loop
    if (regexp_replace(r.relname, '^audit_log_y', ''))::int < extract(year from now())::int - 7 then
      execute format('alter table ops.audit_log detach partition ops.%I', r.relname);
    end if;
  end loop;

  -- small-table indexed deletes (02 §20)
  delete from public.index_levels where as_of < now() - interval '90 days';
  delete from public.screen_runs  where run_at < now() - interval '90 days';
  delete from comms.notifications where created_at < now() - interval '12 months';
  delete from ingest.fetch_log    where fetched_at < now() - interval '30 days';

  -- agent_runs: roll up into daily stats, then trim past 90 days
  insert into ops.agent_daily_stats (agent_id, day, runs, failures, objects_created)
  select ar.agent_id, ar.started_at::date, count(*),
         count(*) filter (where ar.status = 'failed'),
         coalesce(sum((ar.stats ->> 'objects_created')::int), 0)
  from ops.agent_runs ar
  where ar.started_at < now() - interval '90 days'
  group by ar.agent_id, ar.started_at::date
  on conflict (agent_id, day) do update
    set runs = ops.agent_daily_stats.runs + excluded.runs,
        failures = ops.agent_daily_stats.failures + excluded.failures,
        objects_created = ops.agent_daily_stats.objects_created + excluded.objects_created;
  delete from ops.agent_runs where started_at < now() - interval '90 days';

  -- snapshot blob purge: quote scrapes 90 days, generic HTML 1 year; metadata
  -- rows kept forever so lineage never dangles (02 §3). GUC unlocks the
  -- immutability trigger for exactly this transaction.
  perform set_config('marsad.allow_snapshot_purge', 'on', true);
  update lake.snapshots
     set storage_path = null, body_inline = null, purged_at = now()
   where purged_at is null
     and ((source_key like '%.quotes%'  and fetched_at < now() - interval '90 days')
       or (content_type like 'text/html%' and source_key not like '%filing%'
           and source_key not like '%prospectus%' and source_key not like '%transcript%'
           and fetched_at < now() - interval '1 year'));
end $$;
