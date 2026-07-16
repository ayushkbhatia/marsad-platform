-- 20260716095100_financial_statements_persist_versioning — the SOURCE-AGNOSTIC persist
-- half of DEF-STMT-INGEST (07 §P1.7b): project FILING.FINANCIALS lake.objects into
-- public.financial_statements, with RESTATEMENT VERSIONING so a re-filed quarter appends
-- history instead of silently clobbering the prior filing.
--
-- ── THE GAP THIS CLOSES ────────────────────────────────────────────────────────────
-- The statement-normalizer (ingestion/src/lake/statement-normalizer.ts: source rows →
-- the §3.1 primitive line_items) + the ratio + Score engines are built and golden-tested,
-- but the persist path is ORPHANED: nothing projects a statement lake.object into the
-- serving table, so public.financial_statements is EMPTY all-time and key-ratios.ts /
-- score_batch starve. This mirrors the FILING.REF → public.filings projection
-- (lake.fn_filing_project, 0037) and the OHLCV/quote projections — a trigger on
-- lake.objects that lands the VERIFIED/PENDING object into the reader's flat table.
--
-- SOURCE-AGNOSTIC BY DESIGN: whatever produces the FILING.FINANCIALS staging rows — the
-- free deterministic Tadawul XBRL feed (owner's preferred source), a future aggregator,
-- or the LLM/PDF path (normalizeViaLlm seam) — flows the SAME object payload contract:
--   { venue, ticker, statementType, basis, periodKind, fiscalPeriod, periodEnd,
--     currency, lineItems }   (camelCase; the §3.1 primitive keys inside lineItems)
-- This migration owns NONE of those producers; it owns the persist contract they target.
-- On main today there is NO active `financials` source, so the trigger simply never fires
-- until a producer lands — this migration is INERT against the live pipeline (no behaviour
-- change), exactly the clean seam a producer plugs into. The runtime staging mapper
-- (runtime.mapStatement → FILING.FINANCIALS) ships in the same change so the
-- staging→cross_check→objects→projection chain is complete end to end.
--
-- ── RESTATEMENT VERSIONING (the "cheap now, painful later" fix) ─────────────────────
-- public.financial_statements.unique (security_id, statement_type, basis, fiscal_period,
-- is_estimate) has NO version column, so the natural-key upsert would let a restated
-- quarter OVERWRITE the original in place — the audit trail (what the numbers were before
-- the restatement) is destroyed, and any point-in-time ratio/Score recompute is corrupted.
--
-- FIX = current-row + append-only history-table split (NOT a key change):
--   • public.financial_statements keeps EXACTLY its existing natural key → still ONE current
--     row per (security, statement_type, basis, fiscal_period, is_estimate). Every reader
--     (key-ratios.ts's trailing-quarter TTM roll-up) is UNTOUCHED and can never double-count
--     a restated period — the whole reason for this shape over a version-in-the-key design.
--   • public.financial_statement_history is APPEND-ONLY: on a restatement the projection
--     archives the OUTGOING current row here (with its version + the object that superseded
--     it) BEFORE overwriting the current row in place with the new numbers + a bumped
--     version + is_restated = true. Nothing is destroyed; the full filing history is queryable.
-- version = 1 / is_restated = false is the steady state; only a genuine content change bumps.

set search_path = '';

-- ---------------------------------------------------------------------------
-- 1. Versioning columns on the current serving row (additive, forward-only).
-- ---------------------------------------------------------------------------
alter table public.financial_statements
  add column if not exists version     int         not null default 1,
  add column if not exists is_restated boolean     not null default false,
  add column if not exists restated_at timestamptz;

comment on column public.financial_statements.version is
  'Filing version for this (security, statement_type, basis, fiscal_period). 1 = original; bumped by lake.fn_financial_statement_project on each restatement (prior version archived to financial_statement_history).';
comment on column public.financial_statements.is_restated is
  'True once this period has been restated (version > 1). The prior filed numbers live in public.financial_statement_history.';

-- ---------------------------------------------------------------------------
-- 2. Append-only prior-version archive. A restatement copies the OUTGOING current
--    row here before the current row is overwritten. Internal provenance/audit —
--    NOT world-readable (marsad_worker only). RLS is enabled EXPLICITLY because the
--    0014 blanket enable-RLS loop only covered tables existing at that migration.
-- ---------------------------------------------------------------------------
create table if not exists public.financial_statement_history (
  id                      bigint generated always as identity primary key,
  security_id             bigint not null references public.securities(id),
  statement_type          text not null,
  basis                   text not null,
  period_kind             text not null,
  fiscal_period           text not null,
  period_end              date not null,
  currency                char(3) not null,
  is_estimate             boolean not null,
  version                 int not null,
  line_items              jsonb not null,
  segments                jsonb,
  source_filing_id        bigint references public.filings(id),
  source_object_id        uuid   references lake.objects(id),
  archived_at             timestamptz not null default now(),
  -- the FILING.FINANCIALS object whose restatement superseded this version (lineage).
  superseded_by_object_id uuid   references lake.objects(id)
);
create index fin_stmt_hist_lookup on public.financial_statement_history
  (security_id, statement_type, basis, fiscal_period, version desc);

alter table public.financial_statement_history enable row level security;
create policy worker_all on public.financial_statement_history
  for all to marsad_worker using (true) with check (true);

-- ---------------------------------------------------------------------------
-- 3. The projection: FILING.FINANCIALS lake.object → public.financial_statements,
--    with restatement versioning. Mirrors lake.fn_filing_project (0037), adding the
--    archive-then-overwrite version bump. SECURITY DEFINER (bypasses RLS to write the
--    serving/history tables) with an empty search_path (schema-qualify everything).
-- ---------------------------------------------------------------------------
create or replace function lake.fn_financial_statement_project() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_venue  text    := coalesce(new.venue_code, new.payload ->> 'venue');
  v_ticker text    := new.payload ->> 'ticker';
  v_stmt   text    := new.payload ->> 'statementType';
  v_basis  text    := coalesce(nullif(new.payload ->> 'basis', ''), 'consolidated');
  v_kind   text    := new.payload ->> 'periodKind';
  v_fp     text    := new.payload ->> 'fiscalPeriod';
  v_pe     date    := nullif(new.payload ->> 'periodEnd', '')::date;
  v_ccy    char(3) := nullif(new.payload ->> 'currency', '');
  v_items  jsonb   := new.payload -> 'lineItems';
  v_seg    jsonb   := new.payload -> 'segments';
  v_sid    bigint;
  v_cur    public.financial_statements%rowtype;
begin
  if new.object_type <> 'FILING.FINANCIALS' then return null; end if;
  -- Only a live object projects; a superseded/retired revision must not re-write the row.
  if new.state not in ('PENDING', 'VERIFIED') then return null; end if;

  -- NOT-NULL / CHECK-constrained projections; skip a malformed object rather than fail
  -- the whole cross_check tx (mirrors fn_filing_project's defensive skips).
  if v_venue is null or v_ticker is null or v_stmt is null or v_kind is null
     or v_fp is null or v_pe is null or v_ccy is null or v_items is null then
    return null;
  end if;
  if v_stmt  not in ('income', 'balance', 'cashflow')      then return null; end if;
  if v_kind  not in ('quarter', 'annual', 'ttm')           then return null; end if;
  if v_basis not in ('consolidated', 'standalone')         then return null; end if;

  -- Resolve security_id from venue+ticker in the payload (the object may not carry a
  -- security_id for a freshly-seeded object type; the payload always carries identity).
  -- Unknown security ⇒ skip (never mis-attribute onto the wrong company).
  select id into v_sid
    from public.securities
   where venue_code = v_venue and ticker = v_ticker;
  if v_sid is null then return null; end if;

  select * into v_cur
    from public.financial_statements
   where security_id = v_sid and statement_type = v_stmt and basis = v_basis
     and fiscal_period = v_fp and is_estimate = false;

  if not found then
    -- First filing for this period → version 1.
    insert into public.financial_statements
      (security_id, statement_type, basis, period_kind, fiscal_period, period_end,
       currency, is_estimate, line_items, segments, source_object_id, version, is_restated)
    values
      (v_sid, v_stmt, v_basis, v_kind, v_fp, v_pe,
       v_ccy, false, v_items, v_seg, new.id, 1, false);
    return null;
  end if;

  -- Idempotent: a re-projection with identical content (a replay, or the PENDING→VERIFIED
  -- second trigger fire for the SAME object) is a NO-OP — it must NOT bump the version.
  -- Refresh only the source-lineage pointer to the newest object that carried the value.
  if v_cur.line_items is not distinct from v_items
     and v_cur.period_end is not distinct from v_pe
     and v_cur.currency  is not distinct from v_ccy then
    update public.financial_statements
       set source_object_id = new.id, updated_at = now()
     where id = v_cur.id;
    return null;
  end if;

  -- RESTATEMENT: content changed. Archive the outgoing version, then overwrite the current
  -- row IN PLACE (readers keep seeing exactly one current row) with a bumped version.
  insert into public.financial_statement_history
    (security_id, statement_type, basis, period_kind, fiscal_period, period_end,
     currency, is_estimate, version, line_items, segments, source_filing_id,
     source_object_id, superseded_by_object_id)
  values
    (v_cur.security_id, v_cur.statement_type, v_cur.basis, v_cur.period_kind,
     v_cur.fiscal_period, v_cur.period_end, v_cur.currency, v_cur.is_estimate,
     v_cur.version, v_cur.line_items, v_cur.segments, v_cur.source_filing_id,
     v_cur.source_object_id, new.id);

  update public.financial_statements
     set period_kind      = v_kind,
         period_end       = v_pe,
         currency         = v_ccy,
         line_items       = v_items,
         segments         = coalesce(v_seg, segments),
         source_object_id = new.id,
         version          = v_cur.version + 1,
         is_restated      = true,
         restated_at      = now(),
         updated_at       = now()
   where id = v_cur.id;

  return null;
end $$;

-- Fire on BOTH insert (single-source PENDING land) and update (PENDING→VERIFIED promotion
-- when a 2nd source agrees, or a superseding restatement revision) — identical to the
-- FILING.REF projection triggers (0037). The idempotency guard above makes the double-fire
-- (INSERT then UPDATE for the same object) a safe no-op.
drop trigger if exists objects_financial_statement_project_ins on lake.objects;
create trigger objects_financial_statement_project_ins after insert on lake.objects
  for each row when (new.object_type = 'FILING.FINANCIALS')
  execute function lake.fn_financial_statement_project();

drop trigger if exists objects_financial_statement_project_upd on lake.objects;
create trigger objects_financial_statement_project_upd after update on lake.objects
  for each row when (new.object_type = 'FILING.FINANCIALS')
  execute function lake.fn_financial_statement_project();

-- NB: no one-time backfill loop (cf. fn_filing_project's) — there are ZERO FILING.FINANCIALS
-- objects on main today, and the versioning logic lives in the trigger, so every future
-- object (the first one included) is projected correctly by the trigger itself.
