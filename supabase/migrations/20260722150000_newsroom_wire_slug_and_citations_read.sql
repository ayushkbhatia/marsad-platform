-- 20260722150000 — the reader can't LINK to a published newsroom piece (no
-- slug) and can't RESOLVE its [c1] citation markers (anon has no grant on
-- `lake.citations` at all). Both surfaced building the reader surface for the
-- newsroom's first live WIRE (pipeline item #7, content_id
-- b2459c8e-c28f-4d5b-a37f-df82022904e5, headline "QNB posts QAR 4.43bn net
-- profit in Q2 2026, revenue up 11.2%", status='live', slug=NULL).
--
-- ── Part A: slug generation ─────────────────────────────────────────────────
-- `ops.desk_decide_approval` (approve) and `ops.newsroom_publish_sweep`
-- (scheduled→live) both flip `content_items.status` directly with a plain
-- UPDATE; neither ever stamps `slug` (confirmed via read of both function
-- bodies, 20260720142331_p3_4_sweeps_approval_budget.sql). Rather than touch
-- those two RPCs (cross-cutting, lead-owned), a BEFORE INSERT OR UPDATE
-- trigger on `content_items` fills `slug` the moment a row becomes
-- publicly-visible (`live`/`updated`/`scheduled`/`retracted`) and has none —
-- covers every current and future publish path uniformly, no RPC edits.
--
-- Slug shape: kebab(headline) + '-' + 7 hex chars from the row's own id. The
-- id-derived suffix makes a collision with another row's slug astronomically
-- unlikely (would require another editor to hand-type this exact id
-- fragment); the `while exists(...)` loop is a defensive backstop only, not
-- the primary uniqueness mechanism (the `slug` column already carries a
-- UNIQUE constraint from 20260713000008_content.sql).
--
-- ── Part B: backfill ─────────────────────────────────────────────────────────
-- One-time UPDATE for existing live/updated/scheduled/retracted rows with a
-- NULL slug (today: exactly item #7). Computed directly (not via the
-- trigger's UPDATE path) so it doesn't also bump `updated_at` via the
-- unrelated `content_items_updated_at` trigger beyond what a genuine slug
-- assignment already warrants.
--
-- ── Part C: `public.v_content_citations` ────────────────────────────────────
-- `lake.citations` RLS has only a `worker_all` policy (`marsad_worker`); anon
-- additionally has no USAGE on the `lake` schema at all — so
-- `getArticleBySlug`-style anon reads return zero rows, and the "[c1] →
-- sources note" resolution the reader needs has no data path. Mirrors the
-- established `public.v_scores_public` / `public.v_key_ratios_public` shape
-- exactly: an owner-privileged (`security_invoker=false`) view in `public`
-- that reads the RLS-protected table and is explicitly SELECT-granted to
-- anon/authenticated — the view's WHERE clause IS the security boundary.
--
-- Column list is deliberately narrow: `content_id`, `block_key`, `claim_text`,
-- `quoted_value` only — no `object_id` (internal lake identity) and no
-- `cited_by` (a principal id with no public-safe display path, the same
-- byline-identity gap `src/lib/data/editorial.ts` already flags).
--
-- Row filter is deliberately conservative, NOT just "content is published":
-- a citation has no FK to the specific `content_blocks` row whose text
-- contains its `[cN]` marker, so a naive `status in (...)` filter could leak
-- a citation's `quoted_value` for a claim that only appears inside a GATED
-- block of a premium ARTICLE — working around the block-level premium cut by
-- a side door. Excluding any content_item that has ANY gated block closes
-- that hole categorically (today's WIRE template, TPL-01, is never premium
-- and never gated, so this excludes nothing live; it only matters once a
-- premium ARTICLE with citations ships). `content_blocks` itself stays the
-- sole gating source of truth — this view never overrides it, only avoids
-- exposing citation text for a content item that has any gating at all.

set search_path = '';

-- ── Part A ───────────────────────────────────────────────────────────────────

create or replace function public.fn_content_generate_slug() returns trigger
language plpgsql as $$
declare
  v_base      text;
  v_suffix    text;
  v_candidate text;
begin
  if new.slug is not null then
    return new;
  end if;
  if new.status not in ('live', 'updated', 'scheduled', 'retracted') then
    return new;
  end if;

  v_base := lower(regexp_replace(coalesce(new.headline, ''), '[^a-zA-Z0-9]+', '-', 'g'));
  v_base := trim(both '-' from v_base);
  v_base := left(v_base, 80);
  v_base := trim(both '-' from v_base);
  if v_base = '' then
    v_base := lower(new.content_type);
  end if;

  v_suffix    := substr(replace(new.id::text, '-', ''), 1, 7);
  v_candidate := v_base || '-' || v_suffix;

  while exists (select 1 from public.content_items where slug = v_candidate and id <> new.id) loop
    v_suffix    := substr(md5(v_candidate || clock_timestamp()::text), 1, 6);
    v_candidate := v_base || '-' || v_suffix;
  end loop;

  new.slug := v_candidate;
  return new;
end $$;

create trigger content_items_slug_generate
  before insert or update on public.content_items
  for each row execute function public.fn_content_generate_slug();

comment on function public.fn_content_generate_slug() is
  'Auto-fills content_items.slug (kebab(headline) + 7-hex id suffix) the moment a row '
  'reaches a publicly-visible status (live/updated/scheduled/retracted) with slug still NULL. '
  'Covers desk_decide_approval, newsroom_publish_sweep, and any future publish path uniformly — '
  'no RPC edits required. See 20260722150000_newsroom_wire_slug_and_citations_read.sql.';

-- ── Part B: backfill existing rows ──────────────────────────────────────────

update public.content_items ci
   set slug = sub.base || '-' || substr(replace(sub.id::text, '-', ''), 1, 7)
  from (
    select id,
           coalesce(
             nullif(
               trim(both '-' from left(
                 lower(regexp_replace(coalesce(headline, ''), '[^a-zA-Z0-9]+', '-', 'g')), 80
               )),
               ''
             ),
             lower(content_type)
           ) as base
      from public.content_items
     where slug is null
       and status in ('live', 'updated', 'scheduled', 'retracted')
  ) sub
 where ci.id = sub.id
   and ci.slug is null;

-- ── Part C: anon-safe citation read ─────────────────────────────────────────

create or replace view public.v_content_citations
  with (security_invoker = false) as
  select
    c.content_id,
    c.block_key,
    c.claim_text,
    c.quoted_value
  from lake.citations c
  join public.content_items ci on ci.id = c.content_id
 where ci.status in ('live', 'updated', 'retracted')
   and not exists (
     select 1 from public.content_blocks cb
      where cb.content_id = c.content_id and cb.gated
   );

revoke all on public.v_content_citations from public, anon, authenticated;
grant select on public.v_content_citations to anon, authenticated;
grant select on public.v_content_citations to service_role;

comment on view public.v_content_citations is
  'Anon-safe citation read for the reader "[c1] -> sources" resolution: content_id, block_key, '
  'claim_text, quoted_value only (no object_id, no cited_by principal). Owner-privileged '
  '(security_invoker=false) so it can read lake.citations, which has no anon grant at all. '
  'Excludes any content_item with ANY gated content_blocks row, so a citation used inside a '
  'premium cut can never leak through this side door. Read by createAnonClient() in '
  'src/lib/data/newsroom.ts. See 20260722150000_newsroom_wire_slug_and_citations_read.sql.';
