-- 20260716120000_reconcile_financials_projection_versioning — CONVERGE the statement-persist
-- projection onto ONE contract across repo ⇄ live, and fold the restatement versioning
-- (20260716095100) into the projection the LIVE pipeline actually uses.
--
-- ── WHY (the drift this fixes) ─────────────────────────────────────────────────────────
-- Two projections for `FILING.FINANCIALS → public.financial_statements` existed in parallel:
--   • LIVE (applied out-of-band 2026-07-14, migration `financials_project`, NOT on main):
--     `lake.fn_financials_project()` — a natural-key upsert that CLOBBERS on restatement,
--     reading **snake_case** payload keys (`statement_type`/`line_items`/…) and using
--     `new.security_id`. It is fed by an active Tadawul-XBRL cron — 6,964 rows / 129 securities live.
--   • MAIN (migration `20260716095100`): `lake.fn_financial_statement_project()` with restatement
--     VERSIONING, reading **camelCase** payload keys and resolving security_id from payload
--     venue+ticker. Never applied to live.
-- Applying 095100 to live would have created a SECOND trigger pair (double projection) whose
-- camelCase reads never match the live snake_case objects. This migration removes that split:
-- it makes `lake.fn_financials_project` (the name the LIVE triggers already call) do the VERSIONING,
-- reading the LIVE snake_case contract, and retires the 095100 camelCase function + triggers.
--
-- ── CONVERGENCE (idempotent, applies cleanly to BOTH trees) ────────────────────────────
-- Self-contained + guarded so ONE file brings either tree to the identical end state:
--   • on LIVE  (has khayyam's fn+triggers, lacks 095100's cols/history): adds the versioning
--     columns + history table, replaces the fn body clobber→versioning, keeps the existing triggers.
--   • on MAIN  (has 095100's camel fn+triggers+cols+history, lacks khayyam's fn): drops the camel
--     fn+triggers, creates `fn_financials_project` + its triggers, cols/history already present (no-op).
-- End state everywhere: `lake.fn_financials_project()` (VERSIONING, snake_case, security_id with a
-- venue+ticker fallback) + `objects_financials_project_ins/upd` triggers + the versioning columns +
-- `public.financial_statement_history`. The 6,964 existing rows are preserved (they become version 1).
--
-- The staging mapper (`runtime.mapStatement`) is updated in the same change to emit the snake_case
-- payload this projection reads, so a main-side producer and the live producer target ONE contract.

set search_path = '';

-- ---------------------------------------------------------------------------
-- 1. Versioning columns + history table (idempotent — present already if 095100 ran).
-- ---------------------------------------------------------------------------
alter table public.financial_statements
  add column if not exists version     int         not null default 1,
  add column if not exists is_restated boolean     not null default false,
  add column if not exists restated_at timestamptz;

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
  superseded_by_object_id uuid   references lake.objects(id)
);
create index if not exists fin_stmt_hist_lookup on public.financial_statement_history
  (security_id, statement_type, basis, fiscal_period, version desc);

alter table public.financial_statement_history enable row level security;
drop policy if exists worker_all on public.financial_statement_history;
create policy worker_all on public.financial_statement_history
  for all to marsad_worker using (true) with check (true);

-- ---------------------------------------------------------------------------
-- 2. Retire the 095100 camelCase projection (present on main-from-scratch; absent on live).
-- ---------------------------------------------------------------------------
drop trigger if exists objects_financial_statement_project_ins on lake.objects;
drop trigger if exists objects_financial_statement_project_upd on lake.objects;
drop function if exists lake.fn_financial_statement_project();

-- ---------------------------------------------------------------------------
-- 3. THE converged projection: lake.fn_financials_project() (the name the live triggers call),
--    now with restatement versioning, reading the LIVE snake_case payload contract.
--    security_id: prefer new.security_id (the live producer sets it); fall back to resolving from
--    payload venue+ticker (a main-side producer via runtime.mapStatement carries them). currency
--    normalization mirrors the prior live fn (default SAR, upper, left 3).
-- ---------------------------------------------------------------------------
create or replace function lake.fn_financials_project() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_stmt   text    := new.payload ->> 'statement_type';
  v_kind   text    := new.payload ->> 'period_kind';
  v_fp     text    := new.payload ->> 'fiscal_period';
  v_pe     date    := nullif(new.payload ->> 'period_end', '')::date;
  v_ccy    char(3) := upper(left(coalesce(new.payload ->> 'currency', 'SAR'), 3));
  v_basis  text    := coalesce(nullif(new.payload ->> 'basis', ''), 'consolidated');
  v_items  jsonb   := new.payload -> 'line_items';
  v_seg    jsonb   := new.payload -> 'segments';
  v_sid    bigint;
  v_cur    public.financial_statements%rowtype;
begin
  if new.object_type <> 'FILING.FINANCIALS' then return null; end if;
  if new.state not in ('PENDING', 'VERIFIED') then return null; end if;
  if v_stmt not in ('income', 'balance', 'cashflow') then return null; end if;
  if v_kind not in ('quarter', 'annual', 'ttm')      then return null; end if;
  if v_fp is null or v_pe is null then return null; end if;
  if v_basis not in ('consolidated', 'standalone') then v_basis := 'consolidated'; end if;
  if v_items is null or jsonb_typeof(v_items) <> 'object' then return null; end if;

  -- security_id: the live producer sets it on the object; a main-side producer carries venue+ticker
  -- in the payload. Prefer the object's, else resolve. Unknown ⇒ skip (never mis-attribute).
  v_sid := new.security_id;
  if v_sid is null then
    select id into v_sid from public.securities
     where venue_code = new.payload ->> 'venue' and ticker = new.payload ->> 'ticker';
  end if;
  if v_sid is null then return null; end if;

  select * into v_cur from public.financial_statements
   where security_id = v_sid and statement_type = v_stmt and basis = v_basis
     and fiscal_period = v_fp and is_estimate = false;

  if not found then
    insert into public.financial_statements
      (security_id, statement_type, basis, period_kind, fiscal_period, period_end,
       currency, is_estimate, line_items, segments, source_object_id, version, is_restated)
    values
      (v_sid, v_stmt, v_basis, v_kind, v_fp, v_pe,
       v_ccy, false, v_items, v_seg, new.id, 1, false);
    return null;
  end if;

  -- Idempotent: identical content (replay, or the PENDING→VERIFIED second fire) ⇒ no version bump.
  if v_cur.line_items is not distinct from v_items
     and v_cur.period_end is not distinct from v_pe
     and v_cur.currency  is not distinct from v_ccy then
    update public.financial_statements
       set source_object_id = new.id, updated_at = now()
     where id = v_cur.id;
    return null;
  end if;

  -- RESTATEMENT: archive the outgoing version, then overwrite the current row in place + bump.
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

-- ---------------------------------------------------------------------------
-- 4. The triggers (khayyam's names). Present on live already; created here for main-from-scratch.
--    drop+create makes it idempotent + guarantees they bind the (replaced) function.
-- ---------------------------------------------------------------------------
drop trigger if exists objects_financials_project_ins on lake.objects;
create trigger objects_financials_project_ins after insert on lake.objects
  for each row when (new.object_type = 'FILING.FINANCIALS')
  execute function lake.fn_financials_project();

drop trigger if exists objects_financials_project_upd on lake.objects;
create trigger objects_financials_project_upd after update on lake.objects
  for each row when (new.object_type = 'FILING.FINANCIALS')
  execute function lake.fn_financials_project();
