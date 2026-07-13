-- 0011_engagement — watchlists, alerts, notebook, screens, AI threads, follows;
-- quota-enforcing create functions; fn_screener_run. 02 §14, §22 step 11.

create table public.watchlists (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null,
  column_prefs jsonb,
  created_at   timestamptz not null default now(),
  unique (user_id, name)
);

create table public.watchlist_members (
  watchlist_id uuid not null references public.watchlists(id) on delete cascade,
  security_id  bigint not null references public.securities(id) on delete cascade,
  added_at     timestamptz not null default now(),
  note         text,
  primary key (watchlist_id, security_id)
);

create table public.alerts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  alert_type    text not null check (alert_type in
                ('price_cross','score_change','filing_event','ratio','screen_match','phrase',
                 'ex_date_reminder','index_drawdown','transcript_arrival','ipo_books_open',
                 'holder_disclosure','series_update')),
  quota_bucket  text not null check (quota_bucket in ('stock','screen','phrase')),
  scope         jsonb not null,
  condition     jsonb not null,
  channels      text[] not null default '{push}',   -- whatsapp reserved, sender deferred
  state         text not null default 'armed' check (state in ('armed','triggered','paused')),
  last_fired_at timestamptz,
  created_at    timestamptz not null default now()
);
create index alerts_user_idx on public.alerts (user_id) where state <> 'paused';
create index alerts_type_idx on public.alerts (alert_type) where state = 'armed';

create table public.alert_triggers (
  id                        bigint generated always as identity primary key,
  alert_id                  uuid not null references public.alerts(id) on delete cascade,
  fired_at                  timestamptz not null default now(),
  context                   jsonb not null,
  suppressed_by_quiet_hours boolean not null default false,
  delivered_channels        text[]
);
create index alert_triggers_alert_idx on public.alert_triggers (alert_id, fired_at desc);

create table public.notes (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  security_id         bigint references public.securities(id),
  title               text,
  body                text not null,
  pinned              boolean not null default false,
  clip_source_url     text,
  clip_price_snapshot jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index notes_user_idx on public.notes (user_id, updated_at desc);
create trigger notes_updated_at before update on public.notes
  for each row execute function public.set_updated_at();

create table public.saved_screens (
  id               uuid primary key default gen_random_uuid(),
  owner_user_id    uuid references auth.users(id) on delete cascade,
  owner_analyst_id uuid references public.analysts(principal_id),
  name             text not null,
  criteria         jsonb not null,
  visibility       text not null default 'private' check (visibility in ('private','community','analyst','curated')),
  forked_from      uuid references public.saved_screens(id),
  follower_count   int not null default 0,
  fork_count       int not null default 0,
  match_count      int,
  last_run_at      timestamptz,
  backtest         jsonb,
  created_at       timestamptz not null default now()
);
create index screens_visibility_idx on public.saved_screens (visibility) where visibility <> 'private';

create table public.screen_runs (
  id          bigint generated always as identity primary key,
  screen_id   uuid not null references public.saved_screens(id) on delete cascade,
  run_at      timestamptz not null default now(),
  match_count int not null,
  entered     bigint[] not null default '{}',
  exited      bigint[] not null default '{}'
);

create table public.ai_threads (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  scope      jsonb not null,
  mode       text not null default 'general' check (mode in ('general','deep')),
  title      text,
  created_at timestamptz not null default now()
);

create table public.ai_messages (
  id               uuid primary key default gen_random_uuid(),
  thread_id        uuid not null references public.ai_threads(id) on delete cascade,
  role             text not null check (role in ('user','assistant','refusal')),
  body             jsonb not null,
  citations        jsonb,
  credits_charged  int not null default 0,
  model_used       text,   -- provider-agnostic gateway stamps actual model id
  grounding_cutoff timestamptz,
  feedback         text check (feedback in ('helpful','flagged')),
  created_at       timestamptz not null default now()
);
create index ai_messages_thread_idx on public.ai_messages (thread_id, created_at);

create table public.ai_theses (
  security_id     bigint primary key references public.securities(id),
  headline        text,
  bull            jsonb,
  bear            jsonb,
  fair_value_band jsonb,
  catalysts       jsonb,
  invalidation    jsonb,
  generated_at    timestamptz not null,
  model_used      text,
  regen_trigger   text,
  citations       jsonb not null
);

create table public.follows (
  user_id     uuid not null references auth.users(id) on delete cascade,
  target_kind text not null check (target_kind in ('analyst','screen','venue','holder','security')),
  target_ref  text not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, target_kind, target_ref)
);

-- ---------------------------------------------------------------------------
-- Quota-enforcing create functions (RLS protects reads; these protect quotas).
-- Direct INSERT on alerts/saved_screens/watchlists is revoked in 0014.

create or replace function public.create_alert(
  p_alert_type text, p_scope jsonb, p_condition jsonb, p_channels text[] default '{push}'
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_user   uuid := auth.uid();
  v_bucket text;
  v_limit  int;
  v_used   int;
  v_id     uuid;
begin
  if v_user is null then raise exception 'not authenticated'; end if;

  -- DEFAULTED D3: 3 buckets — phrase / screen / everything-else → stock.
  v_bucket := case when p_alert_type = 'phrase' then 'phrase'
                   when p_alert_type = 'screen_match' then 'screen'
                   else 'stock' end;

  v_limit := coalesce((billing.live_plan(billing.user_tier(v_user)) -> 'limits' ->> ('alerts_' || v_bucket))::int, 0);
  select count(*) into v_used from public.alerts where user_id = v_user and quota_bucket = v_bucket;
  if v_used >= v_limit then
    raise exception 'alert quota exceeded for bucket % (limit %)', v_bucket, v_limit using errcode = 'P0002';
  end if;

  insert into public.alerts (user_id, alert_type, quota_bucket, scope, condition, channels)
  values (v_user, p_alert_type, v_bucket, p_scope, p_condition, p_channels)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.create_saved_screen(
  p_name text, p_criteria jsonb, p_visibility text default 'private'
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_user  uuid := auth.uid();
  v_limit int;
  v_used  int;
  v_id    uuid;
begin
  if v_user is null then raise exception 'not authenticated'; end if;

  v_limit := coalesce((billing.live_plan(billing.user_tier(v_user)) -> 'limits' ->> 'saved_screens')::int, 0);
  select count(*) into v_used from public.saved_screens where owner_user_id = v_user;
  if v_used >= v_limit then
    raise exception 'saved screen quota exceeded (limit %)', v_limit using errcode = 'P0002';
  end if;

  insert into public.saved_screens (owner_user_id, name, criteria, visibility)
  values (v_user, p_name, p_criteria, coalesce(p_visibility, 'private'))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.create_watchlist(p_name text) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_user  uuid := auth.uid();
  v_limit int;
  v_used  int;
  v_id    uuid;
begin
  if v_user is null then raise exception 'not authenticated'; end if;
  v_limit := coalesce((billing.live_plan(billing.user_tier(v_user)) -> 'limits' ->> 'watchlists')::int, 1);
  select count(*) into v_used from public.watchlists where user_id = v_user;
  if v_used >= v_limit then
    raise exception 'watchlist quota exceeded (limit %)', v_limit using errcode = 'P0002';
  end if;
  insert into public.watchlists (user_id, name) values (v_user, p_name) returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Screener (master plan: fn_screener_run, anon rate-limited at the route).
-- v1 stub: AND-chain of allowlisted key_ratios fields; free-tier truncation to
-- 3 rows happens in the route handler, never here.

create or replace function public.fn_screener_run(p_criteria jsonb default '[]'::jsonb, p_limit int default 100)
returns table (
  security_id bigint, ticker text, name_en text, venue_code text, sector text,
  market_cap numeric, pe numeric, pb numeric, dividend_yield numeric, roe numeric,
  score smallint
)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_where  text := 'true';
  v_item   jsonb;
  v_field  text;
  v_op     text;
  v_allowed constant text[] := array['market_cap','pe','pb','eps_ttm','book_value_ps','dividend_yield',
                                     'payout_ratio','roe','roce','nim','net_debt_ebitda','ev_ebitda','ps'];
begin
  for v_item in select * from jsonb_array_elements(coalesce(p_criteria, '[]'::jsonb))
  loop
    v_field := v_item ->> 'field';
    v_op    := v_item ->> 'op';
    if not (v_field = any (v_allowed)) then
      raise exception 'unknown screener field %', v_field;
    end if;
    if v_op not in ('<','<=','>','>=','=') then
      raise exception 'unsupported operator %', v_op;
    end if;
    -- numeric cast of the literal guarantees no injectable text reaches the SQL
    v_where := v_where || format(' and k.%I %s %s', v_field, v_op, (v_item ->> 'value')::numeric);
  end loop;

  -- SECURITY DEFINER bypasses RLS on public.scores, so the premium gate must
  -- be re-applied here: free/anon callers get NULL scores (route handler
  -- serves the metered 3-scores/month peek), never the exact values.
  return query execute format(
    'select s.id, s.ticker, s.name_en, s.venue_code, s.sector,
            k.market_cap, k.pe, k.pb, k.dividend_yield, k.roe,
            case when public.jwt_tier() in (''premium'',''enterprise'') then sc.score end as score
     from public.key_ratios k
     join public.securities s on s.id = k.security_id and s.status = ''listed''
     left join public.scores sc on sc.security_id = k.security_id
     where %s
     order by k.market_cap desc nulls last
     limit %s', v_where, least(greatest(coalesce(p_limit, 100), 1), 500));
end $$;
