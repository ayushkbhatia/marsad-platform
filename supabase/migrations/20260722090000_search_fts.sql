-- 20260722090000_search_fts — federated Search (16a), Postgres FTS + pg_trgm,
-- no external engine. Source of truth: docs/architecture/04-reader-app.md §6.
--
-- One denormalized table, `public.search_documents`, maintained by AFTER
-- triggers on the two POPULATED public source tables — `public.securities` and
-- `public.filings`. 04 §6 also names `articles`/`analyst_profiles`/`holders` as
-- future doc_types once those slices exist; wiring them is a follow-up migration
-- (extend the `doc_type` check constraint + add a trigger mirroring the two
-- below — do not widen the constraint speculatively).
--
-- Deliberately NOT built here (04 §6 mentions them, but they are outside this
-- migration's scope and are logged in docs/BUILD-STATUS.md §7 as
-- DEF-SEARCH-HISTORY): per-user `search_history` recents and `search_misses`
-- zero-result logging. Both need a personalized/dynamic write path (auth +
-- mutation) that doesn't belong in this anon-cacheable slice; the 16a "Recent
-- searches" chips are backed by client-side localStorage instead for now.
--
-- Security model: `search_documents` itself is NOT the public read surface —
-- RLS is enabled with a worker-only policy and NO anon/authenticated SELECT
-- grant. `fn_search()` (SECURITY DEFINER) is the ONLY sanctioned reader and
-- returns metadata columns only (never `body`), so a future premium doc_type
-- (articles) can carry gated text in this table without ever being reachable
-- by a direct client SELECT — defense in depth for the "premium bodies never
-- reach anon" requirement, even before an article trigger exists.
--
-- Fully schema-qualified throughout (every function runs with search_path='').

set search_path = '';

-- ---------------------------------------------------------------------------
-- 0. Extension (idempotent — already installed live, but the migration must be
--    self-contained for a fresh-DB replay). Supabase convention: relocatable
--    extensions go in `extensions` (mirrors 0001_extensions.sql).
create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. search_documents
create table public.search_documents (
  id            bigint generated always as identity primary key,
  doc_type      text not null check (doc_type in ('security', 'filing')),
  doc_id        bigint not null,
  ticker        text,
  title         text not null,
  -- Free-text corpus (NOT the gated article body per the security note above —
  -- for security/filing rows this is always public metadata: identity fields,
  -- filing type/form code, and the already-public ai_summary).
  body          text not null default '',
  body_tsv      tsvector generated always as (
                  setweight(to_tsvector('english', coalesce(title, '')), 'A')
                  || setweight(to_tsvector('english', coalesce(body, '')), 'B')
                ) stored,
  -- Denormalized ticker+name(+title) string for fuzzy/prefix matching via
  -- pg_trgm ("aramco", "2222", "QNBK") independent of FTS word-boundary rules.
  trigram_label text not null default '',
  -- Ranking multiplier: identity hits (securities) outrank a document that
  -- merely mentions the same company, so a ticker/name query's "Top match"
  -- is the security card, matching the 16a design.
  weight        real not null default 1.0,
  url           text not null,
  premium       boolean not null default false,
  updated_at    timestamptz not null default now(),
  unique (doc_type, doc_id)
);

create index search_documents_tsv_idx  on public.search_documents using gin (body_tsv);
create index search_documents_trgm_idx on public.search_documents using gin (trigram_label extensions.gin_trgm_ops);

comment on table public.search_documents is
  'Denormalized federated-search index (04-reader-app.md §6). Maintained by AFTER triggers on '
  'public.securities and public.filings (fn_search_index_security / fn_search_index_filing, below). '
  'NOT the public read surface — see the security note at the top of this migration; read only '
  'through public.fn_search().';
comment on column public.search_documents.body is
  'Public search corpus for this doc — never the gated body of a future premium doc_type.';
comment on column public.search_documents.weight is
  'Ranking multiplier (securities=3.0, market-moving filings=1.5, filings=1.0) — a heuristic blend, '
  'not calibrated against click data; revisit once real query logs exist.';

alter table public.search_documents enable row level security;
create policy worker_all on public.search_documents
  for all to marsad_worker using (true) with check (true);
-- Deliberately no anon/authenticated policy — see the security note above.

-- ---------------------------------------------------------------------------
-- 2. Trigger: public.securities → search_documents (doc_type='security')
--
-- SECURITY DEFINER so the upsert succeeds regardless of which role fired the
-- INSERT/UPDATE/DELETE on securities (marsad_worker day-to-day, postgres/
-- service_role for migrations/admin ops) — mirrors lake.fn_financials_xcheck_reconcile
-- (20260721090000). Scoped to the columns that actually feed the index so a
-- routine scrape touch (ohlcv_backfilled_at, profile_scraped_at, sa_*) doesn't
-- fire a no-op reindex.
create or replace function public.fn_search_index_security() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.search_documents where doc_type = 'security' and doc_id = old.id;
    return old;
  end if;

  insert into public.search_documents
    (doc_type, doc_id, ticker, title, body, trigram_label, weight, url, premium, updated_at)
  values (
    'security',
    new.id,
    new.ticker,
    new.name_en,
    concat_ws(' ', new.ticker, new.name_en, new.isin, new.sector, new.industry, new.board_segment, new.venue_code),
    concat_ws(' ', new.ticker, new.name_en),
    3.0,
    '/stocks/' || new.venue_code || '/' || new.ticker,
    false,
    now()
  )
  on conflict (doc_type, doc_id) do update set
    ticker        = excluded.ticker,
    title         = excluded.title,
    body          = excluded.body,
    trigram_label = excluded.trigram_label,
    url           = excluded.url,
    updated_at    = now();

  return new;
end
$$;

create trigger search_documents_from_securities
  after insert or delete or update of ticker, name_en, isin, sector, industry, board_segment, venue_code
  on public.securities
  for each row execute function public.fn_search_index_security();

-- ---------------------------------------------------------------------------
-- 3. Trigger: public.filings → search_documents (doc_type='filing')
--
-- Denormalizes the parent security's ticker+name into the filing's body/
-- trigram_label so a company-name query ("aramco") surfaces its filings even
-- when the filing title itself never spells out the company (typical — filing
-- titles read like "Board resolution — Q2 interim dividend of SAR 0.34").
-- KNOWN STALENESS TRADE-OFF: if a security's ticker/name is later renamed,
-- already-indexed filings keep the old denormalized text until that filing
-- row is itself touched again — acceptable (renames are rare; both tables see
-- far more inserts than the corrective re-touch would need).
create or replace function public.fn_search_index_filing() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_ticker text;
  v_name   text;
begin
  if tg_op = 'DELETE' then
    delete from public.search_documents where doc_type = 'filing' and doc_id = old.id;
    return old;
  end if;

  if new.security_id is not null then
    select s.ticker, s.name_en into v_ticker, v_name
    from public.securities s
    where s.id = new.security_id;
  end if;

  insert into public.search_documents
    (doc_type, doc_id, ticker, title, body, trigram_label, weight, url, premium, updated_at)
  values (
    'filing',
    new.id,
    v_ticker,
    coalesce(new.title, 'Untitled filing'),
    concat_ws(' ', new.filing_type, new.form_code, v_ticker, v_name, new.ai_summary),
    concat_ws(' ', v_ticker, v_name, new.title),
    case when new.is_market_moving then 1.5 else 1.0 end,
    '/filings/' || new.id,
    false,
    now()
  )
  on conflict (doc_type, doc_id) do update set
    ticker        = excluded.ticker,
    title         = excluded.title,
    body          = excluded.body,
    trigram_label = excluded.trigram_label,
    weight        = excluded.weight,
    url           = excluded.url,
    updated_at    = now();

  return new;
end
$$;

create trigger search_documents_from_filings
  after insert or delete or update of security_id, title, filing_type, form_code, ai_summary, is_market_moving
  on public.filings
  for each row execute function public.fn_search_index_filing();

-- ---------------------------------------------------------------------------
-- 4. fn_search(p_q) — the sanctioned public read path.
--
-- websearch_to_tsquery('english', …) (never raises on free-typed input, unlike
-- to_tsquery — the right primitive for a search box) union-ranked with a
-- trigram pass (pg_trgm's `%` operator, GIN-indexed via trigram_label), so a
-- typo'd or non-word-boundary query ("aramc", "2222") still surfaces hits that
-- pure FTS would miss. Counts (per doc_type + overall) are computed BEFORE the
-- final LIMIT so the 16a facet chips ("Filings · 38") reflect the true match
-- count, not just the returned page. Returns metadata columns only — `body`
-- (the search corpus, which for a future premium doc_type would carry gated
-- text) is never selected into the result, independent of the `premium` flag;
-- the reader renders a `premium: true` chip and links out, nothing more.
create or replace function public.fn_search(p_q text)
returns table (
  doc_type    text,
  doc_id      bigint,
  ticker      text,
  title       text,
  url         text,
  premium     boolean,
  rank        real,
  type_count  bigint,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_q   text := trim(coalesce(p_q, ''));
  v_tsq tsquery;
begin
  if v_q = '' then
    return;
  end if;

  -- Loosen pg_trgm's similarity floor (default 0.3) for this call only — short
  -- strings (4-letter tickers, "2222") need a lower bar to register as a fuzzy
  -- hit. set_config(..., true) is transaction-scoped (SET LOCAL semantics) and
  -- self-resets; it never leaks to the caller's session.
  perform set_config('pg_trgm.similarity_threshold', '0.15', true);
  v_tsq := websearch_to_tsquery('english', v_q);

  return query
  with fts as (
    select sd.doc_type, sd.doc_id, sd.ticker, sd.title, sd.url, sd.premium,
           (ts_rank(sd.body_tsv, v_tsq) * sd.weight)::real as hit_rank
    from public.search_documents sd
    where sd.body_tsv @@ v_tsq
  ),
  trgm as (
    select sd.doc_type, sd.doc_id, sd.ticker, sd.title, sd.url, sd.premium,
           (extensions.similarity(sd.trigram_label, v_q) * sd.weight)::real as hit_rank
    from public.search_documents sd
    where sd.trigram_label operator(extensions.%) v_q
  ),
  combined as (
    select * from fts
    union all
    select * from trgm
  ),
  ranked as (
    select c.doc_type, c.doc_id, c.ticker, c.title, c.url, c.premium,
           max(c.hit_rank) as hit_rank
    from combined c
    group by c.doc_type, c.doc_id, c.ticker, c.title, c.url, c.premium
  ),
  counted as (
    select r.*,
           count(*) over (partition by r.doc_type) as type_count,
           count(*) over ()                          as total_count
    from ranked r
  )
  select c.doc_type, c.doc_id, c.ticker, c.title, c.url, c.premium,
         c.hit_rank as rank, c.type_count, c.total_count
  from counted c
  order by c.hit_rank desc, c.doc_type asc, c.doc_id asc
  limit 200;
end
$$;

comment on function public.fn_search(text) is
  'Federated search over public.search_documents: websearch_to_tsquery FTS ∪ pg_trgm fuzzy pass, '
  'union-ranked, counts computed pre-LIMIT so facet counts are exact. Returns metadata only — never '
  'the indexed body text. anon-EXECUTE (see grant below); it is the sole sanctioned reader of '
  'search_documents. Called from src/lib/data/search.ts via createAnonClient().rpc(''fn_search'',…).';

-- anon EXECUTE grant — fn_search returns only public metadata (doc identity,
-- title, url, premium flag, rank, counts), never a document body, so it is
-- safe for unauthenticated callers exactly like fn_screener_run.
revoke all on function public.fn_search(text) from public;
grant execute on function public.fn_search(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Backfill — populate search_documents from the existing securities +
--    filings rows (idempotent — safe to re-run; on conflict upserts in place).
--    Shaping logic intentionally mirrors the two trigger functions above; if
--    you change one, change both.
insert into public.search_documents
  (doc_type, doc_id, ticker, title, body, trigram_label, weight, url, premium, updated_at)
select
  'security',
  s.id,
  s.ticker,
  s.name_en,
  concat_ws(' ', s.ticker, s.name_en, s.isin, s.sector, s.industry, s.board_segment, s.venue_code),
  concat_ws(' ', s.ticker, s.name_en),
  3.0,
  '/stocks/' || s.venue_code || '/' || s.ticker,
  false,
  now()
from public.securities s
on conflict (doc_type, doc_id) do update set
  ticker        = excluded.ticker,
  title         = excluded.title,
  body          = excluded.body,
  trigram_label = excluded.trigram_label,
  url           = excluded.url,
  updated_at    = now();

insert into public.search_documents
  (doc_type, doc_id, ticker, title, body, trigram_label, weight, url, premium, updated_at)
select
  'filing',
  f.id,
  s.ticker,
  coalesce(f.title, 'Untitled filing'),
  concat_ws(' ', f.filing_type, f.form_code, s.ticker, s.name_en, f.ai_summary),
  concat_ws(' ', s.ticker, s.name_en, f.title),
  case when f.is_market_moving then 1.5 else 1.0 end,
  '/filings/' || f.id,
  false,
  now()
from public.filings f
left join public.securities s on s.id = f.security_id
on conflict (doc_type, doc_id) do update set
  ticker        = excluded.ticker,
  title         = excluded.title,
  body          = excluded.body,
  trigram_label = excluded.trigram_label,
  weight        = excluded.weight,
  url           = excluded.url,
  updated_at    = now();
