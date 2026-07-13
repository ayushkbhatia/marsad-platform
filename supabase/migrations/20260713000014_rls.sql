-- 0014_rls — RLS on every table (public policies per 02 §19; private schemas
-- enabled with worker-only policies as belt-and-braces), role grants for
-- marsad_worker (billing revoked), custom access token hook. 02 §19, §22 step 14.

-- ---------------------------------------------------------------------------
-- 1. Enable RLS everywhere (tables + partitions; matviews cannot take RLS and
--    are aggregate-only). Private schemas get NO anon/authenticated policies —
--    even a misconfigured exposure returns zero rows.
do $$
declare r record;
begin
  for r in
    select n.nspname, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p')
      and n.nspname in ('public','iam','lake','ops','billing','comms','analytics','ingest','vectors')
  loop
    execute format('alter table %I.%I enable row level security', r.nspname, r.relname);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. marsad_worker: policies + grants on ingest/lake/ops/comms/analytics/
--    vectors/public; read-only iam; ZERO grants on billing (01 §3.1 —
--    "agents never touch billing" is a database fact at the role level).
do $$
declare r record;
begin
  for r in
    select n.nspname, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p')
      and n.nspname in ('public','lake','ops','comms','analytics','ingest','vectors')
  loop
    execute format('create policy worker_all on %I.%I for all to marsad_worker using (true) with check (true)',
                   r.nspname, r.relname);
  end loop;

  for r in
    select n.nspname, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and n.nspname = 'iam'
  loop
    execute format('create policy worker_read on %I.%I for select to marsad_worker using (true)',
                   r.nspname, r.relname);
  end loop;
end $$;

-- Worker heartbeats its own operational state on iam.agent_accounts only.
create policy worker_touch_agent_state on iam.agent_accounts
  for update to marsad_worker using (true) with check (true);

grant usage on schema public, lake, ops, comms, analytics, ingest, vectors, iam, pgmq, extensions to marsad_worker;
grant select, insert, update, delete on all tables in schema lake, ops, comms, analytics, ingest, vectors to marsad_worker;
grant select, insert, update, delete on all tables in schema public to marsad_worker;
grant select on all tables in schema iam to marsad_worker;
grant update (status, next_run_at, key_hash, key_rotated_at) on iam.agent_accounts to marsad_worker;
grant usage, select on all sequences in schema public, lake, ops, comms, analytics, ingest to marsad_worker;
grant execute on all functions in schema pgmq to marsad_worker;
grant select, insert, update, delete on all tables in schema pgmq to marsad_worker;
grant execute on all functions in schema ingest, ops, analytics to marsad_worker;
grant execute on function public.refresh_market_mvs() to marsad_worker;

revoke all on schema billing from marsad_worker;
revoke all on all tables in schema billing from marsad_worker;
revoke all on all functions in schema billing from marsad_worker;

-- service_role: full reach into private schemas for Next.js server code.
grant usage on schema lake, ops, comms, analytics, ingest, vectors, iam, billing to service_role;
grant all on all tables in schema lake, ops, comms, analytics, ingest, vectors, iam, billing to service_role;
grant usage, select on all sequences in schema lake, ops, comms, analytics, ingest, iam, billing to service_role;
grant execute on all functions in schema billing, analytics, ops, ingest, iam, lake to service_role;

-- ---------------------------------------------------------------------------
-- 3. Reader-facing policies (02 §19 policy families).

-- Family 1: world-readable reference & delayed market data (writes: none).
do $$
declare t text;
begin
  foreach t in array array[
    'venues','sectors','securities','indices','index_sector_weights','fx_rates',
    'market_sessions','market_holidays','quotes_latest','quotes_intraday','ohlcv_daily',
    'index_levels','index_levels_daily','venue_feed_status','security_status',
    'filings','transcripts','transcript_segments','earnings_events','estimates',
    'ipo_offers','ipo_timeline_events','listing_debuts','holders','holder_positions',
    'ownership_snapshots','analysts','analyst_calls']
  loop
    execute format('create policy world_read on public.%I for select to anon, authenticated using (true)', t);
  end loop;
end $$;

create policy world_read on public.dividends
  for select to anon, authenticated using (state = 'live');

create policy world_read on public.datapoint_series
  for select to anon, authenticated using (is_public);

create policy world_read on public.datapoints
  for select to anon, authenticated
  using (exists (select 1 from public.datapoint_series s where s.id = series_id and s.is_public));

-- Family 2: published content only; gated blocks never reach free JWTs.
create policy published_read on public.content_items
  for select to anon, authenticated
  using (status in ('live','updated','retracted'));

create policy published_read on public.content_blocks
  for select to anon, authenticated
  using (
    exists (select 1 from public.content_items ci
            where ci.id = content_id and ci.status in ('live','updated','retracted'))
    and (not gated or public.jwt_tier() <> 'free')
  );

create policy published_read on public.content_tickers
  for select to anon, authenticated
  using (exists (select 1 from public.content_items ci
                 where ci.id = content_id and ci.status in ('live','updated','retracted')));

create policy published_read on public.content_corrections
  for select to anon, authenticated
  using (exists (select 1 from public.content_items ci
                 where ci.id = content_id and ci.status in ('live','updated','retracted')));

-- Family 3: premium-only surfaces (free "peek" rides the metered server path).
do $$
declare t text;
begin
  foreach t in array array['scores','score_history','score_events','marsad_select','ai_theses']
  loop
    execute format(
      'create policy premium_read on public.%I for select to authenticated using (public.jwt_tier() in (''premium'',''enterprise''))', t);
  end loop;
end $$;

-- Family 4: user-owned engagement.
create policy own_select on public.user_profiles
  for select to authenticated using (user_id = (select auth.uid()));
create policy own_update on public.user_profiles
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy own_all on public.watchlists
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy own_all on public.watchlist_members
  for all to authenticated
  using (exists (select 1 from public.watchlists w where w.id = watchlist_id and w.user_id = (select auth.uid())))
  with check (exists (select 1 from public.watchlists w where w.id = watchlist_id and w.user_id = (select auth.uid())));

create policy own_select on public.alerts
  for select to authenticated using (user_id = (select auth.uid()));
create policy own_update on public.alerts
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_delete on public.alerts
  for delete to authenticated using (user_id = (select auth.uid()));

create policy own_select on public.alert_triggers
  for select to authenticated
  using (exists (select 1 from public.alerts a where a.id = alert_id and a.user_id = (select auth.uid())));

create policy own_all on public.notes
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy own_or_shared_select on public.saved_screens
  for select to authenticated
  using (owner_user_id = (select auth.uid()) or visibility <> 'private');
create policy shared_select_anon on public.saved_screens
  for select to anon using (visibility in ('community','analyst','curated'));
create policy own_update on public.saved_screens
  for update to authenticated using (owner_user_id = (select auth.uid())) with check (owner_user_id = (select auth.uid()));
create policy own_delete on public.saved_screens
  for delete to authenticated using (owner_user_id = (select auth.uid()));

create policy own_or_shared_select on public.screen_runs
  for select to authenticated
  using (exists (select 1 from public.saved_screens s
                 where s.id = screen_id
                   and (s.owner_user_id = (select auth.uid()) or s.visibility <> 'private')));

create policy own_all on public.ai_threads
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy own_select on public.ai_messages
  for select to authenticated
  using (exists (select 1 from public.ai_threads t where t.id = thread_id and t.user_id = (select auth.uid())));

create policy own_all on public.follows
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- External analyst applications (20d): public intake, desk-only reads.
create policy applications_insert on public.analyst_applications
  for insert to authenticated
  with check (status = 'submitted' and reviewed_by is null);

-- ---------------------------------------------------------------------------
-- 4. Table/sequence/function grants for the PostgREST roles. RLS is the gate;
--    grants define the outer ceiling.
grant select on all tables in schema public to anon, authenticated;
grant insert, update, delete on public.watchlists, public.watchlist_members, public.notes,
      public.ai_threads, public.follows to authenticated;
grant update, delete on public.alerts, public.saved_screens to authenticated;
grant update on public.user_profiles to authenticated;
grant insert on public.analyst_applications to authenticated;

-- Quota-consuming inserts go through SECURITY DEFINER functions only (02 §19).
revoke insert on public.alerts from authenticated;
revoke insert on public.saved_screens from authenticated;
revoke insert on public.watchlists from authenticated;
grant execute on function public.create_alert(text, jsonb, jsonb, text[]) to authenticated;
grant execute on function public.create_saved_screen(text, jsonb, text) to authenticated;
grant execute on function public.create_watchlist(text) to authenticated;
grant execute on function public.fn_screener_run(jsonb, int) to anon, authenticated;

-- Functions default to EXECUTE granted to PUBLIC; revoking only from anon/
-- authenticated is a no-op (the PUBLIC grant still applies). Every public-
-- schema RPC surface below is stripped of the PUBLIC default, then only the
-- explicit grants above define reach. refresh_market_mvs stays worker/cron-
-- only — a PostgREST caller triggering REFRESH ... CONCURRENTLY is a DoS lever.
revoke execute on function public.refresh_market_mvs() from public, anon, authenticated;
revoke execute on function public.fn_screener_run(jsonb, int) from public;
revoke execute on function public.create_alert(text, jsonb, jsonb, text[]) from public, anon;
revoke execute on function public.create_saved_screen(text, jsonb, text) from public, anon;
revoke execute on function public.create_watchlist(text) from public, anon;

-- Watchlist INSERT rides create_watchlist(); members table keeps direct grants
-- (no quota on membership rows, RLS scopes them to the owner's lists).

-- ---------------------------------------------------------------------------
-- 5. Custom access token hook (02 §19 D9, 05 §2.2): stamps plan_tier +
--    desk_role + principal_id at token mint. Registered in supabase/config.toml
--    locally; on hosted, enable under Auth → Hooks (dashboard).
create or replace function public.custom_access_token_hook(event jsonb) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  claims jsonb := coalesce(event -> 'claims', '{}'::jsonb);
  v_user uuid := (event ->> 'user_id')::uuid;
  v_tier text;
  v_role text;
  v_pid  uuid;
begin
  select case when s.plan_key = 'enterprise' then 'enterprise'
              when s.plan_key in ('premium_monthly','premium_annual') then 'premium'
              else 'free' end
    into v_tier
  from billing.subscriptions s
  where s.user_id = v_user and s.status in ('trialing','active')
  order by s.created_at desc
  limit 1;

  claims := jsonb_set(claims, '{app_metadata}',
    coalesce(claims -> 'app_metadata', '{}'::jsonb) || jsonb_build_object('plan_tier', coalesce(v_tier, 'free')));

  select p.id, rg.role_key
    into v_pid, v_role
  from iam.principals p
  left join iam.role_grants rg
    on rg.principal_id = p.id
   and rg.role_key in ('owner','eic','reporter','analyst','support')
  where p.auth_user_id = v_user and p.kind = 'human' and p.is_active
  order by array_position(array['owner','eic','reporter','analyst','support'], rg.role_key) nulls last
  limit 1;

  if v_pid is not null then
    claims := claims || jsonb_build_object('principal_id', v_pid);
    if v_role is not null then
      claims := claims || jsonb_build_object('desk_role', v_role);
    end if;
  end if;

  return jsonb_set(event, '{claims}', claims);
end $$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from anon, authenticated, public;

-- Views: world-readable mirrors run with owner privileges (postgres), so no
-- policies needed; grants define reach.
grant select on public.nav_config_live, public.score_events_feed to anon, authenticated;
grant select on public.my_notifications to authenticated;
grant select on public.mv_sector_heatmap, public.mv_movers to anon, authenticated;

-- Realtime: deliberately NO publication on quotes_latest (02 §19 post-review) —
-- readers poll at the scrape cadence; Desk run-log rides a broadcast channel.
