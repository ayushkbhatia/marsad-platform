-- 0010_billing — plans (seed 33c config as V1), subscriptions, ZATCA invoice
-- archive, dunning trail, promos, meters, credit ledger, metering functions.
-- 02 §13, §22 step 10. Stripe is payment truth; Postgres is entitlement truth.

create table billing.plan_versions (
  id             bigint generated always as identity primary key,
  version_no     int not null unique,
  effective_from date not null,
  plans          jsonb not null,
  changed_by     uuid not null references iam.principals(id),
  created_at     timestamptz not null default now()
);

create table billing.promo_codes (
  id               bigint generated always as identity primary key,
  code             text not null unique,
  discount         jsonb not null,
  activation_event text,
  max_redemptions  int,
  redeemed_count   int not null default 0,
  valid_from       timestamptz,
  valid_to         timestamptz,
  created_by       uuid not null references iam.principals(id)
);

create table billing.subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid references auth.users(id) on delete set null,  -- survives PDPL purge as anonymous revenue record
  plan_key               text not null check (plan_key in ('free','premium_monthly','premium_annual','enterprise')),
  status                 text not null check (status in ('trialing','active','past_due','paused','canceled')),
  stripe_customer_id     text,
  stripe_subscription_id text unique,
  trial_ends_at          timestamptz,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  dunning_state          text check (dunning_state in ('retry_1','retry_2','final','paused')),
  next_retry_at          timestamptz,
  promo_code_id          bigint references billing.promo_codes(id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create unique index one_active_sub_per_user on billing.subscriptions (user_id)
  where status in ('trialing','active','past_due','paused');
create trigger subscriptions_updated_at before update on billing.subscriptions
  for each row execute function public.set_updated_at();

create table billing.invoices (
  id                uuid primary key default gen_random_uuid(),
  order_no          text not null unique,
  user_id           uuid not null,        -- deliberately NOT an FK: ZATCA 10-year archive survives account purge
  subscription_id   uuid references billing.subscriptions(id),
  stripe_invoice_id text unique,
  issued_at         timestamptz not null,
  line_items        jsonb not null,
  subtotal_sar      numeric(14,2) not null,
  vat_rate          numeric(5,4) not null default 0.15,
  vat_amount_sar    numeric(14,2) not null,
  total_sar         numeric(14,2) not null,
  currency          char(3) not null default 'SAR',
  seller_trn        text not null,
  buyer_vat_id      text,
  buyer_name        text,
  buyer_country     char(2),
  payment_method    text,
  status            text not null check (status in ('scheduled','paid','failed','refunded','credit_note')),
  pdf_path          text,
  zatca_payload     jsonb,
  created_at        timestamptz not null default now()
);
create index invoices_user_idx on billing.invoices (user_id, issued_at desc);
create trigger invoices_no_delete before delete on billing.invoices
  for each row execute function public.prevent_mutation();

create table billing.payment_attempts (
  id           bigint generated always as identity primary key,
  invoice_id   uuid not null references billing.invoices(id),
  attempted_at timestamptz not null default now(),
  outcome      text not null check (outcome in ('succeeded','declined','error')),
  decline_code text,
  attempt_no   int not null
);

create table billing.usage_meters (
  user_id      uuid not null references auth.users(id) on delete cascade,
  meter_key    text not null,           -- 'premium_reads','scores','ai_answers'
  period_month date not null,           -- Gulf-calendar first-of-month
  used         int not null default 0,
  primary key (user_id, meter_key, period_month)
);

create table billing.credit_ledger (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  delta      int not null,
  reason     text not null check (reason in
             ('monthly_grant','rollover','answer','deep_answer','thesis','topup','refund','expiry')),
  ref_id     uuid,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index credit_ledger_user_idx on billing.credit_ledger (user_id, created_at desc);

-- Metered premium reads are idempotent per article per period (02 Revisions).
create table billing.article_unlocks (
  user_id      uuid not null references auth.users(id) on delete cascade,
  content_id   uuid not null references public.content_items(id) on delete cascade,
  period_month date not null,
  unlocked_at  timestamptz not null default now(),
  primary key (user_id, content_id, period_month)
);

-- ---------------------------------------------------------------------------
-- Negative-scope enforcement, billing half (05 §2.4): agents never touch billing.
create or replace function billing.fn_no_agent_writes() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('app.principal_kind', true), '') = 'agent' then
    raise exception 'agents may not write %.% (negative scope)', tg_table_schema, tg_table_name;
  end if;
  return coalesce(new, old);
end $$;

create trigger no_agent_writes before insert or update or delete on billing.plan_versions
  for each row execute function billing.fn_no_agent_writes();
create trigger no_agent_writes before insert or update or delete on billing.subscriptions
  for each row execute function billing.fn_no_agent_writes();
create trigger no_agent_writes before insert or update or delete on billing.invoices
  for each row execute function billing.fn_no_agent_writes();
create trigger no_agent_writes before insert or update or delete on billing.promo_codes
  for each row execute function billing.fn_no_agent_writes();

-- Config-doc half of the same backstop (05 §2.4): rules/nav/front-page version
-- docs are hard-line agent-never surfaces. The tables land in 0008/0009 but the
-- shared trigger function is defined here, so the triggers attach here.
create trigger no_agent_writes before insert or update or delete on ops.rulesets
  for each row execute function billing.fn_no_agent_writes();
create trigger no_agent_writes before insert or update or delete on ops.rules
  for each row execute function billing.fn_no_agent_writes();
create trigger no_agent_writes before insert or update or delete on ops.nav_versions
  for each row execute function billing.fn_no_agent_writes();
create trigger no_agent_writes before insert or update or delete on ops.front_page_versions
  for each row execute function billing.fn_no_agent_writes();

-- ---------------------------------------------------------------------------
-- Metering functions (02 §13) — SECURITY DEFINER, route-handler-only surface.

create or replace function billing.live_plan(p_tier text) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select plans -> p_tier
  from billing.plan_versions
  where effective_from <= (now() at time zone 'Asia/Dubai')::date
  order by version_no desc
  limit 1;
$$;

create or replace function billing.user_tier(p_user uuid) returns text
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select case when s.plan_key = 'enterprise' then 'enterprise'
                when s.plan_key in ('premium_monthly','premium_annual') then 'premium'
                else 'free' end
    from billing.subscriptions s
    where s.user_id = p_user and s.status in ('trialing','active')
    order by s.created_at desc limit 1
  ), 'free');
$$;

-- Atomic upsert-and-check against the live plan limits. Returns true when the
-- unit was consumed (premium/enterprise are unmetered on these three meters).
create or replace function billing.consume_meter(p_user uuid, p_meter text) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_tier   text := billing.user_tier(p_user);
  v_limit  int;
  v_period date := date_trunc('month', (now() at time zone 'Asia/Dubai'))::date;
  v_row    record;
begin
  if p_meter not in ('premium_reads','scores','ai_answers') then
    raise exception 'unknown meter %', p_meter;
  end if;
  if v_tier in ('premium','enterprise') then
    return true;
  end if;

  v_limit := coalesce((billing.live_plan(v_tier) -> 'meters' ->> (p_meter || '_mo'))::int, 0);

  -- A zero/absent limit must deny WITHOUT writing a row: a used=1 row for a
  -- denied first call becomes phantom prior usage if the plan limit is raised.
  if v_limit <= 0 then
    return false;
  end if;

  insert into billing.usage_meters as m (user_id, meter_key, period_month, used)
  values (p_user, p_meter, v_period, 1)
  on conflict (user_id, meter_key, period_month) do update
    set used = m.used + 1
    where m.used < v_limit
  returning m.used into v_row;

  return found and v_limit > 0;
end $$;

-- Locks the user's ledger tail, rejects if balance < cost. Refusals call with
-- cost 0 so the "0 CREDITS CHARGED" event still logs. Returns new balance.
create or replace function billing.spend_credits(p_user uuid, p_cost int, p_reason text, p_ref uuid default null)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_balance int;
begin
  perform pg_advisory_xact_lock(hashtext('credits:' || p_user::text));
  select coalesce(sum(delta), 0) into v_balance from billing.credit_ledger where user_id = p_user;
  if p_cost > 0 and v_balance < p_cost then
    raise exception 'insufficient_credits' using errcode = 'P0001';
  end if;
  insert into billing.credit_ledger (user_id, delta, reason, ref_id)
  values (p_user, -p_cost, p_reason, p_ref);
  return v_balance - p_cost;
end $$;

-- Job 5 guard (02 §21): runs daily 00:05 GST; acts only on the Gulf 1st.
-- Meters reset implicitly (keyed by period_month); this grants premium credits
-- and expires rollovers older than their window.
create or replace function billing.monthly_reset() returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_grant int;
begin
  if extract(day from (now() at time zone 'Asia/Dubai')) <> 1 then
    return;
  end if;

  v_grant := coalesce((billing.live_plan('premium') -> 'meters' ->> 'ai_credits_mo')::int, 500);

  -- Expiry rows for grants past their expiry window, capped at the user's
  -- current positive balance: expired grants may already be (partly) spent,
  -- and expiring the full grant amount would drive the ledger negative and
  -- lock spend_credits (which assumes balance >= 0).
  insert into billing.credit_ledger (user_id, delta, reason)
  select g.user_id, -least(g.expired, b.balance), 'expiry'
  from (
    select l.user_id, sum(l.delta) as expired
    from billing.credit_ledger l
    where l.reason in ('monthly_grant','rollover') and l.delta > 0
      and l.expires_at is not null and l.expires_at < now()
      and not exists (select 1 from billing.credit_ledger e
                      where e.user_id = l.user_id and e.reason = 'expiry'
                        and e.created_at > l.expires_at)
    group by l.user_id
    having sum(l.delta) > 0
  ) g
  join lateral (
    select coalesce(sum(c.delta), 0) as balance
    from billing.credit_ledger c
    where c.user_id = g.user_id
  ) b on true
  where b.balance > 0;

  -- monthly grant to active premium/enterprise subscribers; rolls 1 month
  insert into billing.credit_ledger (user_id, delta, reason, expires_at)
  select s.user_id, v_grant, 'monthly_grant', now() + interval '2 months'
  from billing.subscriptions s
  where s.user_id is not null
    and s.status in ('trialing','active')
    and s.plan_key in ('premium_monthly','premium_annual','enterprise');
end $$;

-- ---------------------------------------------------------------------------
-- Seed: 33c monetization config as V1 (DEFAULTED D1: meters 2/3/5 + 20 credits).

insert into billing.plan_versions (version_no, effective_from, plans, changed_by)
values (1, '2026-07-01', '{
  "free": {
    "price_sar": 0,
    "meters": {"premium_reads_mo": 2, "scores_mo": 3, "ai_answers_mo": 5, "ai_credits_mo": 20},
    "limits": {"watchlists": 1, "watchlist_names": 10, "alerts_stock": 10, "alerts_screen": 2,
               "alerts_phrase": 2, "saved_screens": 5}
  },
  "premium_monthly": {
    "price_sar": 119,
    "meters": {"ai_credits_mo": 500},
    "limits": {"watchlists": 10, "watchlist_names": 100, "alerts_stock": 800, "alerts_screen": 75,
               "alerts_phrase": 50, "saved_screens": 100}
  },
  "premium_annual": {
    "price_sar": 1228.20, "vat_incl": true,
    "meters": {"ai_credits_mo": 500},
    "limits": {"watchlists": 10, "watchlist_names": 100, "alerts_stock": 800, "alerts_screen": 75,
               "alerts_phrase": 50, "saved_screens": 100}
  },
  "premium": {
    "meters": {"ai_credits_mo": 500},
    "limits": {"watchlists": 10, "watchlist_names": 100, "alerts_stock": 800, "alerts_screen": 75,
               "alerts_phrase": 50, "saved_screens": 100}
  },
  "enterprise": {"from_sar": 24000,
    "meters": {"ai_credits_mo": 2000},
    "limits": {"watchlists": 50, "watchlist_names": 500, "alerts_stock": 5000, "alerts_screen": 500,
               "alerts_phrase": 200, "saved_screens": 1000}
  }
}', (select id from iam.principals where handle = 'SYSTEM'));

select ops.ensure_bucket('invoices', false);
