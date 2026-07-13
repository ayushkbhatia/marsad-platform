-- 0002_iam — principals, roles, grants, agent accounts, switches, keys,
-- reader profiles, signup + PDPL-purge triggers, operational seed
-- (SYSTEM + 12 agents + role matrix). 02 §2, 05 §2.

create type iam.principal_kind as enum ('human', 'agent', 'system');

create table iam.principals (
  id           uuid primary key default gen_random_uuid(),
  kind         iam.principal_kind not null,
  auth_user_id uuid unique references auth.users(id) on delete set null, -- humans only; SET NULL so the PDPL purge succeeds
  handle       text not null unique,
  display_name text not null,
  is_active    boolean not null default true,
  purged_at    timestamptz,
  created_at   timestamptz not null default now(),
  constraint human_has_auth check (kind <> 'human' or auth_user_id is not null or purged_at is not null),
  constraint agent_no_auth  check (kind <> 'agent' or auth_user_id is null)
);

create table iam.roles (
  key         text primary key,
  description text not null
);

create table iam.role_grants (
  principal_id uuid not null references iam.principals(id) on delete cascade,
  role_key     text not null references iam.roles(key),
  granted_by   uuid not null references iam.principals(id),
  granted_at   timestamptz not null default now(),
  primary key (principal_id, role_key)
);

-- 31b permissions matrix as data (02 §2 DEFAULTED D10); conditions evaluated in code.
create table iam.capability_grants (
  role_key   text not null references iam.roles(key),
  capability text not null,           -- 'content.draft' … 'config.monetization'
  grant_kind text not null default 'full' check (grant_kind in ('full', 'conditional')),
  condition  text,                    -- 'wire<=40w', 'flag_only', 'owner_ok', …
  primary key (role_key, capability)
);

create table iam.agent_accounts (
  principal_id    uuid primary key references iam.principals(id) on delete cascade,
  agent_class     text not null check (agent_class in ('DATA','WRITER','PUBLISHING')),
  scope_string    text not null,
  scopes          jsonb not null,
  owner_principal uuid not null references iam.principals(id),
  key_hash        text,
  key_rotated_at  timestamptz,
  run_enabled     boolean not null default true,
  status          text not null default 'idle' check (status in ('active','idle','erroring','killed')),
  next_run_at     timestamptz,
  created_at      timestamptz not null default now()
);

create table iam.global_switches (
  key        text primary key,
  value      boolean not null,
  changed_by uuid not null references iam.principals(id),
  changed_at timestamptz not null default now()
);

-- Bearer keys for the agent gateway (05 §2.5); plaintext never stored.
create table iam.agent_api_keys (
  id           uuid primary key default gen_random_uuid(),
  principal_id uuid not null references iam.principals(id),
  key_prefix   text not null,
  key_hash     bytea not null,
  created_by   uuid not null references iam.principals(id),
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at   timestamptz not null,
  revoked_at   timestamptz
);
create unique index agent_api_keys_hash_uni on iam.agent_api_keys (key_hash);

-- ---------------------------------------------------------------------------
-- Reader profiles (02 §2).

create sequence public.member_no_seq start 48214; -- fixture continues from M-48213

create table public.user_profiles (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  member_no         text unique,
  display_name      text,
  currency_pref     char(3) not null default 'SAR' check (currency_pref in ('SAR','AED','QAR','OMR','BHD','KWD','USD')),
  market_prefs      text[] not null default '{}',
  sector_prefs      text[] not null default '{}',
  wire_brief_opt_in boolean not null default false,
  onboarded_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create trigger user_profiles_updated_at before update on public.user_profiles
  for each row execute function public.set_updated_at();

-- Signup: every reader gets a profile + an auditable human principal (02 §2).
create or replace function iam.fn_handle_new_user() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_member text := 'M-' || nextval('public.member_no_seq');
  -- Phone/anonymous/OAuth signups can arrive with NULL email; principals.
  -- display_name is NOT NULL, so fall back to the member number.
  v_name   text := coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''),
                            nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
                            v_member);
begin
  insert into public.user_profiles (user_id, member_no, display_name)
  values (new.id, v_member, v_name);

  insert into iam.principals (kind, auth_user_id, handle, display_name)
  values ('human', new.id, lower(v_member), v_name);

  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function iam.fn_handle_new_user();

-- PDPL purge: deleting auth.users pseudonymizes the orphaned principal (02 §2, §18).
create or replace function iam.fn_purge_principal() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  update iam.principals
     set purged_at = now(), display_name = 'deleted-user', is_active = false
   where auth_user_id = old.id;
  return old;
end $$;

create trigger on_auth_user_deleted before delete on auth.users
  for each row execute function iam.fn_purge_principal();

-- ---------------------------------------------------------------------------
-- Operational seed: roles, SYSTEM, 12 agents, capability matrix, switches.

insert into iam.roles (key, description) values
  ('owner',            'Platform owner — full control'),
  ('eic',              'Editor-in-chief'),
  ('reporter',         'Reporter'),
  ('analyst',          'Analyst'),
  ('support',          'Support'),
  ('reviewer',         'Workbench reviewer (flag role, D10)'),
  ('agent_data',       'DATA agent class'),
  ('agent_writer',     'WRITER agent class'),
  ('agent_publishing', 'PUBLISHING agent class'),
  ('reader',           'Reader (default for signups)');

insert into iam.principals (kind, handle, display_name)
values ('system', 'SYSTEM', 'SYSTEM');

-- 12 agent service accounts (05 §2.1 roster: 6 venue DATA + DATA-FILINGS,
-- WRITER-1..3, EDITOR-1..2 as PUBLISHING class).
insert into iam.principals (kind, handle, display_name)
values
  ('agent', 'DATA-TDWL',     'DATA-TDWL'),
  ('agent', 'DATA-DFM',      'DATA-DFM'),
  ('agent', 'DATA-ADX',      'DATA-ADX'),
  ('agent', 'DATA-QE',       'DATA-QE'),
  ('agent', 'DATA-MSX',      'DATA-MSX'),
  ('agent', 'DATA-BHB',      'DATA-BHB'),
  ('agent', 'DATA-FILINGS',  'DATA-FILINGS'),
  ('agent', 'WRITER-1',      'WRITER-1'),
  ('agent', 'WRITER-2',      'WRITER-2'),
  ('agent', 'WRITER-3',      'WRITER-3'),
  ('agent', 'EDITOR-1',      'EDITOR-1'),
  ('agent', 'EDITOR-2',      'EDITOR-2');

-- Agent accounts. owner_principal is SYSTEM until the owner's human principal
-- exists (created on first Desk sign-in); reassignment is a Desk action.
insert into iam.agent_accounts (principal_id, agent_class, scope_string, scopes, owner_principal)
select p.id,
       case when p.handle like 'DATA-%'   then 'DATA'
            when p.handle like 'WRITER-%' then 'WRITER'
            else 'PUBLISHING' end,
       case when p.handle like 'DATA-%'   then 'lake:write · scrape:run · never publish'
            when p.handle like 'WRITER-%' then 'drafts:create · lake:read (verified only) · never publish'
            else 'pipeline:advance · publish: wire ≤40w only · never billing' end,
       case when p.handle like 'DATA-%'   then '{"allow":["lake:write","ingest:*"],"deny":["content:*","publish:*","billing:*","rules:*"]}'::jsonb
            when p.handle like 'WRITER-%' then '{"allow":["drafts:create","lake:read:verified"],"deny":["publish:*","billing:*","rules:*"]}'::jsonb
            else '{"allow":["pipeline:advance","publish:wire_le_40w"],"deny":["billing:*","rules:*","team:*","config:*"]}'::jsonb end,
       (select id from iam.principals where handle = 'SYSTEM')
from iam.principals p
where p.kind = 'agent';

insert into iam.role_grants (principal_id, role_key, granted_by)
select p.id,
       case when p.handle like 'DATA-%'   then 'agent_data'
            when p.handle like 'WRITER-%' then 'agent_writer'
            else 'agent_publishing' end,
       (select id from iam.principals where handle = 'SYSTEM')
from iam.principals p
where p.kind = 'agent';

-- Capability matrix C01–C11 (05 §2.3), conditions as config.
insert into iam.capability_grants (role_key, capability, grant_kind, condition) values
  ('owner','content.draft','full',null), ('eic','content.draft','full',null),
  ('reporter','content.draft','full',null), ('analyst','content.draft','full',null),
  ('agent_writer','content.draft','full',null), ('agent_publishing','content.draft','conditional','edit_only'),
  ('owner','content.publish','full',null), ('eic','content.publish','full',null),
  ('agent_publishing','content.publish','conditional','wire<=40w'),
  ('owner','approvals.decide','full',null), ('eic','approvals.decide','conditional','send_back_reassign_only'),
  ('owner','surfaces.config','full',null), ('eic','surfaces.config','full',null),
  ('owner','rules.edit','full',null),
  ('owner','lake.write','full',null), ('analyst','lake.write','conditional','datapoints_with_source'),
  ('agent_data','lake.write','full',null),
  ('owner','market.ops','full',null), ('eic','market.ops','full',null),
  ('analyst','market.ops','conditional','flag_only'), ('agent_data','market.ops','conditional','flag_only'),
  ('owner','subscribers.billing','full',null), ('support','subscribers.billing','conditional','export_owner_ok'),
  ('owner','ads.manage','full',null), ('eic','ads.manage','full',null),
  ('owner','team.manage','full',null),
  ('owner','config.monetization','full',null);

insert into iam.global_switches (key, value, changed_by)
select k, v, (select id from iam.principals where handle = 'SYSTEM')
from (values ('pause_all_agents', false), ('kill_all_output', false), ('auto_publish_wires', true)) as s(k, v);
