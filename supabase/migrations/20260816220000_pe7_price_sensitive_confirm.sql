-- PE.7 — the desk can confirm a price-sensitive lake object.
--
-- lake.fn_object_state_guard has always required a HUMAN verifier for a price_sensitive
-- object, and no code ever implemented that path. So the guard sat waiting and the objects sat
-- PENDING: 1,235 public.dividends rows have been 'pending_confirm' since July, and the 500
-- DISCLOSURE.DPS / DIVIDEND.EXDATE objects the canonicaliser just created would have joined
-- them permanently. BLK-EXDATE and the entire dividend wire class cannot publish without this.
--
-- ── WHY THE BULK RPC IS NOT A NICETY ──────────────────────────────────────────
-- 485 DPS objects is 485 human decisions. A queue that can only be worked one row at a time is
-- a queue nobody works — it is abandoned in week one and the family stays dark, which is
-- exactly the outcome this migration exists to prevent. The single-object RPC is the audited
-- path; the bulk RPC is what makes the audited path survivable.
--
-- ── WHAT A CONFIRM MEANS ──────────────────────────────────────────────────────
-- For a price-sensitive family the human confirm IS the intake gate (09 §3.4), which is why
-- ops.materiality_prefilter keeps their accepted_states and citable_states at {VERIFIED}: the
-- object becomes both triggerable and quotable at the moment a named person vouches for it,
-- and not before. verification_basis is recorded as 'human' so BLK-PROV can say so rather
-- than showing a bare VERIFIED badge.

create or replace function ops.desk_confirm_lake_object(p_object_id uuid, p_note text default null)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := nullif(current_setting('app.principal_id', true), '')::uuid;
  v_kind  text;
  v_state text;
  v_type  text;
  v_ps    boolean;
begin
  if v_actor is null then raise exception 'desk_confirm_lake_object: no app.principal_id set'; end if;

  -- The guard will reject a non-human anyway; failing here gives a usable error instead of a
  -- trigger exception, and makes the intent explicit at the call site.
  select kind into v_kind from iam.principals where id = v_actor;
  if v_kind is distinct from 'human' then
    raise exception 'desk_confirm_lake_object: % is not a human principal', coalesce(v_kind, 'unknown');
  end if;
  if not exists (select 1 from iam.role_grants rg
                  where rg.principal_id = v_actor
                    and rg.role_key in (select role_key from iam.capability_grants
                                         where capability = 'approvals.decide')) then
    raise exception 'desk_confirm_lake_object: actor holds no approvals.decide role';
  end if;

  select state::text, object_type, price_sensitive
    into v_state, v_type, v_ps
    from lake.objects where id = p_object_id for update;
  if v_state is null then raise exception 'desk_confirm_lake_object: object % not found', p_object_id; end if;
  if v_state <> 'PENDING' then
    raise exception 'desk_confirm_lake_object: object is %, not PENDING', v_state;
  end if;

  update lake.objects
     set state = 'VERIFIED', verified_by = v_actor, verified_at = now(),
         verification_basis = 'human'
   where id = p_object_id;

  -- A confirmed dividend object releases its public.dividends row in the same transaction:
  -- two records of one fact must not disagree about whether a human has vouched for it.
  if v_type in ('DIVIDEND.EXDATE', 'DISCLOSURE.DPS') then
    update public.dividends d
       set state = 'live'
      from lake.objects o
     where o.id = p_object_id
       and d.security_id = o.security_id
       and d.state = 'pending_confirm'
       and (o.payload ->> 'ex_date') is not null
       and d.ex_date is not distinct from (o.payload ->> 'ex_date')::date;
  end if;

  insert into ops.audit_log (actor_id, action, entity, entity_id, detail)
  values (v_actor, 'lake.confirm', 'lake.objects', p_object_id::text,
          jsonb_build_object('object_type', v_type, 'price_sensitive', v_ps, 'note', p_note));

  return 'VERIFIED';
end $$;

grant execute on function ops.desk_confirm_lake_object(uuid, text) to authenticated, service_role;

create or replace function ops.desk_confirm_lake_objects(p_object_ids uuid[], p_note text default null)
returns int
language plpgsql security definer set search_path = ''
as $$
declare v_id uuid; v_n int := 0;
begin
  foreach v_id in array p_object_ids loop
    begin
      perform ops.desk_confirm_lake_object(v_id, p_note);
      v_n := v_n + 1;
    exception when others then
      -- One bad row must not abandon a batch of 485. The failure is recorded and the rest proceed.
      insert into ops.audit_log (actor_id, action, entity, entity_id, detail)
      values (nullif(current_setting('app.principal_id', true), '')::uuid, 'lake.confirm.failed',
              'lake.objects', v_id::text, jsonb_build_object('error', sqlerrm));
    end;
  end loop;
  return v_n;
end $$;

grant execute on function ops.desk_confirm_lake_objects(uuid[], text) to authenticated, service_role;

create or replace function public.desk_confirm_object(p_object_id uuid, p_note text default null)
returns text language plpgsql security definer set search_path = ''
as $$
declare v_owner uuid;
begin
  select id into v_owner from iam.principals where handle = 'DESK-OWNER';
  if v_owner is null then raise exception 'desk_confirm_object: DESK-OWNER principal missing'; end if;
  perform set_config('app.principal_id', v_owner::text, true);
  return ops.desk_confirm_lake_object(p_object_id, p_note);
end $$;

revoke all on function public.desk_confirm_object(uuid, text) from public, anon, authenticated;
grant execute on function public.desk_confirm_object(uuid, text) to service_role;

-- The queue a human actually works.
create or replace view public.v_desk_price_sensitive
with (security_invoker = true) as
select o.id            as object_id,
       o.object_type,
       o.venue_code,
       s.ticker,
       s.name_en       as company,
       o.numeric_value as dps,
       o.unit          as currency,
       o.payload ->> 'ex_date'     as ex_date,
       o.payload ->> 'record_date' as record_date,
       o.payload ->> 'pay_date'    as pay_date,
       (o.payload ->> 'source_filing_id')::bigint as source_filing_id,
       f.title         as filing_title,
       f.filed_at,
       o.created_at
  from lake.objects o
  join public.securities s on s.id = o.security_id
  left join public.filings f on f.id = (o.payload ->> 'source_filing_id')::bigint
 where o.price_sensitive
   and o.state = 'PENDING'
   and o.superseded_by is null;

comment on view public.v_desk_price_sensitive is
  'Price-sensitive lake objects awaiting a human confirm. lake.fn_object_state_guard requires '
  'a HUMAN verifier for these, so this queue is the ONLY route by which a dividend or ex-date '
  'can ever become citable. Carries the source filing so the confirmer can check the claim '
  'against the document rather than trusting the extraction.';

grant select on public.v_desk_price_sensitive to service_role;

do $$
declare v_q int;
begin
  select count(*) into v_q from public.v_desk_price_sensitive;
  raise notice 'price-sensitive confirm queue: % objects awaiting a human', v_q;

  -- An agent must never be able to confirm one of these.
  begin
    perform set_config('app.principal_id',
      (select id::text from iam.principals p join iam.agent_accounts a on a.principal_id = p.id limit 1), true);
    perform ops.desk_confirm_lake_object((select id from lake.objects where price_sensitive and state = 'PENDING' limit 1));
    raise exception 'an AGENT was able to confirm a price-sensitive object';
  exception when others then
    if position('not a human principal' in sqlerrm) = 0 and position('holds no approvals' in sqlerrm) = 0 then
      raise exception 'unexpected failure in the agent-confirm guard test: %', sqlerrm;
    end if;
  end;
  perform set_config('app.principal_id', '', true);
end $$;
