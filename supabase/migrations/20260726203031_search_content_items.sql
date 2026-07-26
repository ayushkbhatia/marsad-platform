-- 20260727120000_search_content_items — index PUBLISHED editorial in federated
-- search (BRIDGE-BUILD-PLAN step P3.8).
--
-- WHY: `20260722090000_search_fts.sql` built `public.search_documents` over the
-- two populated public tables and left a note that `articles` would follow "once
-- that slice exists". It exists — `public.content_items` is the newsroom's
-- output — but nothing the desk publishes has ever been findable: `fn_search`
-- only ever saw doc_type in ('security','filing'). This migration adds the third
-- doc_type. `fn_search` itself is NOT redefined — its signature is the FE
-- contract (`src/lib/data/search.ts`), and it already reads whatever is in the
-- table.
--
-- ── VISIBILITY RULE (the only rule that matters here) ───────────────────────
-- A row is indexed IFF `status in ('live','updated','retracted')` — the exact
-- predicate `public.content_items`' anon RLS policy uses. A draft, a scheduled
-- piece, a killed piece: never indexed. And because status can move BACKWARDS
-- (a live piece pulled back to draft), the trigger DELETEs the index row on any
-- update that leaves the visible set — a stale index entry is a leak, not a
-- staleness bug. `search_documents` has no anon SELECT grant and `fn_search` is
-- SECURITY DEFINER, so an over-indexed row would be readable by everyone.
--
-- ── NEVER THE BODY ─────────────────────────────────────────────────────────
-- Only public metadata is indexed: kicker, headline, dek, section. The article
-- body lives in `public.content_blocks`, where the premium cut is enforced by
-- RLS (`not gated or jwt_tier() <> 'free'`). Copying block text into
-- `search_documents.body` would move gated prose into a table that a
-- SECURITY DEFINER function reads with no tier check — exactly the leak the
-- base migration's security note promised not to create. The `premium` flag is
-- carried instead, so the reader can chip a hit as premium and link out.
--
-- ── doc_id FOR A UUID KEY ──────────────────────────────────────────────────
-- `search_documents.doc_id` is a bigint (securities/filings have bigint pks) and
-- `fn_search` returns it as a bigint to the front end. `content_items.id` is a
-- uuid, so widening the column would be an FE-visible signature change for no
-- reader benefit: nothing dereferences a content doc_id — `url` is carried on
-- the row. We therefore store a deterministic bigint digest of the uuid in
-- `doc_id` (purely a dedup/upsert key) and the real uuid in a new `doc_uuid`
-- column, which is what any future join must use.
set search_path = '';

-- ---------------------------------------------------------------------------
-- 1. Widen the doc_type domain + carry the real uuid key.
alter table public.search_documents drop constraint search_documents_doc_type_check;
alter table public.search_documents add constraint search_documents_doc_type_check
  check (doc_type in ('security', 'filing', 'content'));

alter table public.search_documents add column if not exists doc_uuid uuid;

comment on column public.search_documents.doc_uuid is
  'Real primary key for uuid-keyed doc_types (content). doc_id is a deterministic digest of this '
  'value, kept only so the (doc_type, doc_id) upsert key and the bigint fn_search signature hold.';

create unique index if not exists search_documents_doc_uuid_idx
  on public.search_documents (doc_type, doc_uuid) where doc_uuid is not null;

-- ---------------------------------------------------------------------------
-- 2. uuid → bigint digest. Immutable (hashtextextended is), so it is safe in an
--    index expression later if one is ever wanted. Masked to the non-negative
--    range purely for readability in logs.
create or replace function public.fn_search_doc_id(p_uuid uuid) returns bigint
language sql immutable strict parallel safe set search_path = ''
as $$
  select pg_catalog.hashtextextended(p_uuid::text, 0) & 9223372036854775807;
$$;

comment on function public.fn_search_doc_id(uuid) is
  'Deterministic bigint digest of a uuid primary key, for public.search_documents.doc_id. '
  'A dedup key only — never a foreign key; join on doc_uuid.';

-- ---------------------------------------------------------------------------
-- 3. Trigger: public.content_items → search_documents (doc_type='content').
--
-- URL rule mirrors the reader exactly (one canonical per piece, never a second):
--   WIRE  → /wire/{slug ?? id}   (src/lib/data/newsroom.ts listPublishedWireSlugs)
--   other → /articles/{slug}     (src/lib/data/editorial.ts)
-- An ARTICLE with no slug has no URL, so it is not indexable — treated exactly
-- like an invisible status.
create or replace function public.fn_search_index_content() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_url     text;
  v_visible boolean;
begin
  if tg_op = 'DELETE' then
    delete from public.search_documents where doc_type = 'content' and doc_uuid = old.id;
    return old;
  end if;

  v_visible := new.status in ('live', 'updated', 'retracted');

  if new.content_type = 'WIRE' then
    v_url := '/wire/' || coalesce(new.slug, new.id::text);
  elsif new.slug is not null then
    v_url := '/articles/' || new.slug;
  else
    v_url := null;
  end if;

  -- Un-publishing (or losing the slug) must REMOVE the row, not leave it stale.
  if not v_visible or v_url is null then
    delete from public.search_documents where doc_type = 'content' and doc_uuid = new.id;
    return new;
  end if;

  insert into public.search_documents
    (doc_type, doc_id, doc_uuid, ticker, title, body, trigram_label, weight, url, premium, updated_at)
  values (
    'content',
    public.fn_search_doc_id(new.id),
    new.id,
    null,                                   -- a story is not a security; its tickers live in content_tickers
    new.headline,
    -- PUBLIC METADATA ONLY — never content_blocks text (see header).
    concat_ws(' ', new.kicker, new.headline, new.dek, new.section, new.content_type),
    concat_ws(' ', new.headline, new.kicker),
    1.2,                                    -- above a routine filing, well below a security identity hit (3.0)
    v_url,
    new.is_premium,
    now()
  )
  on conflict (doc_type, doc_id) do update set
    doc_uuid      = excluded.doc_uuid,
    title         = excluded.title,
    body          = excluded.body,
    trigram_label = excluded.trigram_label,
    weight        = excluded.weight,
    url           = excluded.url,
    premium       = excluded.premium,
    updated_at    = now();

  return new;
end
$$;

drop trigger if exists search_documents_from_content on public.content_items;
create trigger search_documents_from_content
  after insert or delete or update of status, slug, content_type, headline, dek, kicker, section, is_premium
  on public.content_items
  for each row execute function public.fn_search_index_content();

-- ---------------------------------------------------------------------------
-- 4. Backfill — idempotent, and shaped identically to the trigger above (if you
--    change one, change both). The status/URL predicate is repeated here rather
--    than inferred, so a replay on a fresh DB cannot index a draft.
insert into public.search_documents
  (doc_type, doc_id, doc_uuid, ticker, title, body, trigram_label, weight, url, premium, updated_at)
select
  'content',
  public.fn_search_doc_id(ci.id),
  ci.id,
  null,
  ci.headline,
  concat_ws(' ', ci.kicker, ci.headline, ci.dek, ci.section, ci.content_type),
  concat_ws(' ', ci.headline, ci.kicker),
  1.2,
  case when ci.content_type = 'WIRE'
       then '/wire/' || coalesce(ci.slug, ci.id::text)
       else '/articles/' || ci.slug end,
  ci.is_premium,
  now()
from public.content_items ci
where ci.status in ('live', 'updated', 'retracted')
  and (ci.content_type = 'WIRE' or ci.slug is not null)
on conflict (doc_type, doc_id) do update set
  doc_uuid      = excluded.doc_uuid,
  title         = excluded.title,
  body          = excluded.body,
  trigram_label = excluded.trigram_label,
  weight        = excluded.weight,
  url           = excluded.url,
  premium       = excluded.premium,
  updated_at    = now();

-- Sweep any row that should no longer be indexed (replay safety / status moves
-- that happened while the trigger did not exist).
delete from public.search_documents sd
where sd.doc_type = 'content'
  and not exists (
    select 1 from public.content_items ci
    where ci.id = sd.doc_uuid
      and ci.status in ('live', 'updated', 'retracted')
      and (ci.content_type = 'WIRE' or ci.slug is not null)
  );
