-- 20260719175458_ops_llm_runs_accounting — Phase D: ops.llm_runs (03 §1.7) was specced since P0
-- ("every call writes one row, no anonymous LLM spend") but NEVER migrated — the gateway's
-- accounting had nowhere to write. Discovered by the FIRST real chatComplete call (the Phase D
-- smoke agent). Table + the REST-path RPC (accounting.ts fallback when `postgres` is absent).

set search_path = '';

create table ops.llm_runs (
  id               uuid primary key,
  agent_id         uuid not null,
  pipeline_item_id bigint,
  role             text not null,
  provider         text not null,
  model            text not null,
  purpose          text not null,
  input_tokens     int  not null default 0,
  output_tokens    int  not null default 0,
  cost_usd         numeric(10, 6) not null default 0,
  latency_ms       int  not null default 0,
  degraded         boolean not null default false,
  error            text,
  created_at       timestamptz not null default now()
);
create index llm_runs_created on ops.llm_runs (created_at desc);
create index llm_runs_agent on ops.llm_runs (agent_id, created_at desc);

alter table ops.llm_runs enable row level security;
grant insert on ops.llm_runs to marsad_worker;
grant select on ops.llm_runs to marsad_worker, service_role;

create or replace function public.record_llm_run(p_run jsonb) returns void
language sql security definer set search_path = ''
as $$
  insert into ops.llm_runs
    (id, agent_id, pipeline_item_id, role, provider, model, purpose,
     input_tokens, output_tokens, cost_usd, latency_ms, degraded, error)
  values (
    (p_run ->> 'id')::uuid,
    (p_run ->> 'agent_id')::uuid,
    nullif(p_run ->> 'pipeline_item_id', '')::bigint,
    p_run ->> 'role',
    p_run ->> 'provider',
    p_run ->> 'model',
    p_run ->> 'purpose',
    coalesce((p_run ->> 'input_tokens')::int, 0),
    coalesce((p_run ->> 'output_tokens')::int, 0),
    coalesce((p_run ->> 'cost_usd')::numeric, 0),
    coalesce((p_run ->> 'latency_ms')::int, 0),
    coalesce((p_run ->> 'degraded')::boolean, false),
    p_run ->> 'error');
$$;
revoke all on function public.record_llm_run(jsonb) from public, anon, authenticated;
grant execute on function public.record_llm_run(jsonb) to service_role;
