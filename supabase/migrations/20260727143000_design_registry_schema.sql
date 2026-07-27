-- PD.1 — the design system becomes a runtime registry.
--
-- `ops.story_blocks` (14 rows) and `ops.templates` (8 rows) have existed since 2026-07-13 as design
-- intent and have **zero readers in the entire repo** (DEF-REGISTRY-ZERO-READERS, verified by
-- exhaustive grep over both table names and every column). Every policy value they hold is
-- re-hard-coded 3–4× in TypeScript instead. Meanwhile the actual design system — 61 blocks in 8
-- families, 4 longform templates — landed 2026-07-27 and is stored at `docs/design/`.
--
-- This migration gives the registry the columns needed to be load-bearing: what a block IS, what it
-- may bind to, where it is allowed, and what payload it requires. PD.2 seeds it from the JSON; PD.3
-- fills `payload_schema` from Zod; PD.8's fit stage is the first code that reads it and refuses.
--
-- ── TWO VOCABULARIES, AND WHY BOTH SURVIVE ────────────────────────────────────────────────────
-- The seeded 14 and the design 61 overlap on only SIX keys
-- (BLK-TICKER, BLK-DELTA, BLK-EXDATE, BLK-VERDICT, BLK-TIMELINE, BLK-ESTIMATE). The other EIGHT —
-- BLK-QUOTE, BLK-TABLE, BLK-CHART, BLK-SCORE, BLK-YIELD, BLK-COVERAGE, BLK-HOLDERS, BLK-FILING —
-- exist only in the seed, and they carry the `lake_object_type` bindings (TRANSCRIPT.QUOTE,
-- COMPUTED.SCORE, COMPUTED.YIELD, IPO.COVERAGE, OWNERSHIP.SNAPSHOT, ESTIMATE.OBS,
-- FILING.FINANCIALS) that `ops.templates.block_keys` currently references.
--
-- They are NOT mechanically renameable to design keys, and pretending otherwise would destroy
-- information. The design deliberately SPLITS the coarse ones:
--     BLK-CHART   → the entire D family, 15 shapes, one per question ("WHAT MOVED IT?" → waterfall)
--     BLK-TABLE   → BLK-FINTABLE / BLK-KEYSTATS / BLK-STATSTRIP / BLK-COMPARE
-- Collapsing 15 chart shapes back onto one key would discard the single most useful thing the
-- design gives an agent. Re-pointing `ops.templates.block_keys` at the finer vocabulary is a
-- deliberate editorial decision, not a rename — so it is deferred, tracked, and done with eyes open.
--
-- Therefore: `status` distinguishes them. The 61 design blocks are 'active' (the closed vocabulary a
-- writer may emit and the fit stage validates against); the 8 seed-only keys are 'legacy' (kept so
-- the TPL rows that reference them still resolve). End state is 69 rows, not 61 — the earlier
-- "count = 61" acceptance criterion was written before this overlap was measured.

-- ---------------------------------------------------------------------------
-- (a) ops.story_blocks — what a block is, and what it demands.

alter table ops.story_blocks
  add column if not exists family                  text,
  add column if not exists family_name             text,
  add column if not exists display_name            text,
  add column if not exists allowed_piece_types     text,
  add column if not exists piece_types             text[],
  add column if not exists chart_question          text,
  add column if not exists binding_rule            text,
  add column if not exists binds_to                text,
  add column if not exists required_payload_fields jsonb,
  add column if not exists constraints             jsonb,
  add column if not exists payload_schema          jsonb,
  add column if not exists requires_binding        boolean not null default false,
  add column if not exists rule_id                 text,
  add column if not exists gating_related          boolean not null default false,
  add column if not exists schema_version          int not null default 1,
  add column if not exists status                  text not null default 'active';

alter table ops.story_blocks
  drop constraint if exists story_blocks_status_check;
alter table ops.story_blocks
  add constraint story_blocks_status_check check (status in ('active','legacy','retired'));

alter table ops.story_blocks
  drop constraint if exists story_blocks_family_check;
alter table ops.story_blocks
  add constraint story_blocks_family_check
  check (family is null or family in ('A','B','C','D','E','F','G','H'));

comment on column ops.story_blocks.family is
  'Design family A–H: A Inline · B Statement · C Tabular · D Charts · E Mechanism · F Wire & live '
  'state · G Provenance & trust · H Gates & CTAs. NULL on legacy seed-only keys.';
comment on column ops.story_blocks.allowed_piece_types is
  'Verbatim from the design card, unparsed — e.g. "NOTE · DEEP DIVE", "ALL", "WIRE · STOCK". Kept '
  'raw so the card text is never lost; `piece_types` is the queryable normalisation.';
comment on column ops.story_blocks.piece_types is
  'Normalised from allowed_piece_types. {ALL} means the block is permitted in every piece type. '
  'THIS is the fit stage''s permission check — the design states permission per BLOCK, not per '
  'template, so there is deliberately no allowed-families list on ops.article_templates: the four '
  'exported longform pages are specimens (only 2/2/1/4 blocks are actually stated on them), not '
  'exhaustive declarations of what each type permits. Deriving permission from them would refuse a '
  'chart in a Feature.';
comment on column ops.story_blocks.chart_question is
  'Family D only: the QUESTION the shape answers ("WHAT MOVED IT?" → BLK-WATERFALL). This is the '
  'chart-selection contract — the agent picks a question, the compiler picks the shape. For D blocks '
  'the design card''s piece-type slot carries this question rather than a piece type, which is why '
  'it is lifted into its own column.';
comment on column ops.story_blocks.required_payload_fields is
  'What a writer agent must supply for this block to render, from the design card. The source of '
  'truth for payload_schema (PD.3).';
comment on column ops.story_blocks.constraints is
  'Machine-checkable hard rules from the card footer — e.g. BLK-COVER "the 1.0x line is always red", '
  'BLK-CORRECTION "amber, never red", BLK-FINTABLE "max 8 rows inline". Enforced by the fit stage.';
comment on column ops.story_blocks.requires_binding is
  'True ⇒ the block may not publish without a resolvable bound_object_id AND a lake.citations row. '
  'This is design hard-rule #2 (every number carries a freshness state and a provenance stamp) made '
  'machine-checkable.';
comment on column ops.story_blocks.status is
  'active = the closed design vocabulary a writer may emit (61). legacy = seed-only keys kept so '
  'ops.templates.block_keys still resolves (8) — see DEF-REGISTRY-LEGACY-BLOCK-KEYS. retired = '
  'withdrawn.';

-- renderer_component is NOT NULL on the existing table; the 61 seeded rows supply one each (PD.2).
-- The components themselves do not exist yet — PD.5 builds them, family G first.

-- ---------------------------------------------------------------------------
-- (b) ops.article_templates — the LAYOUT axis (1a/1b/3a/3b).
--
-- Deliberately a SECOND table, not a widening of ops.templates. They are different axes and
-- conflating them is why template selection is currently a 5-arm switch in edit.ts:
--   ops.templates       TPL-01…TPL-08 — the PIPELINE axis: what kind of piece the newsroom is
--                       making, what it may auto-publish, its word cap. FK'd from 4 places.
--   ops.article_templates 1a/1b/3a/3b — the LAYOUT axis: the longform chassis a piece is rendered
--                       into, its section sequence, its rail/gutter, where its premium cut falls.
-- A TPL-08 Premium Deep Dive is rendered in the 3a chassis; a TPL-03 Earnings Recap in 1a. One does
-- not imply the other.

-- Deliberately AGENT-FACING FIELDS ONLY. The pixel geometry — page_grid, body_typography, rail,
-- gutter, block_instances, unique_to_this_type, inherited_from_1a — stays in
-- docs/design/article-templates.json, because its consumer is the React renderer at build time, not
-- an agent at run time. Putting it here would be ~80 KB of prose the runtime never reads, and a
-- second copy to drift. Same principle as Tier 0 not persisting markdown: the DB holds what the
-- runtime needs, the repo holds the design reference.
create table if not exists ops.article_templates (
  id                     text primary key,          -- '1a' | '1b' | '3a' | '3b'
  name                   text not null,
  role                   text,                      -- e.g. 'the chassis every other type inherits'
  stated_read_length     text,
  access_tier            jsonb,                     -- {readme, badge_in_markup, effective}
  piece_type             text,                      -- the token block permissions match against
  section_sequence       jsonb not null default '[]',   -- ordered regions: {order, region, required, contains}
  premium_cut            jsonb,
  writer_metadata_fields jsonb not null default '{}',   -- THE research stage's output contract
  hard_rules             jsonb not null default '[]',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

comment on table ops.article_templates is
  'PD.1 — the LAYOUT axis of the design system (docs/design/article-templates.json). Distinct from '
  'ops.templates, which is the pipeline axis (TPL-01…08). A piece has one of each.';
comment on column ops.article_templates.writer_metadata_fields is
  'Every field the research stage must produce for this template to be fillable. 1b (research note) '
  'needs nine groups — identity, call, thesis, analyst, whats_changed, exhibits, narrative, '
  'valuation, risk, compliance. This list is what makes a research note buildable at all.';
comment on column ops.article_templates.piece_type is
  'The piece-type token this template renders — FEATURE | NOTE | DEEP DIVE | EXPLAINER. The fit '
  'stage joins it against ops.story_blocks.piece_types to decide whether a block is permitted here. '
  'Permission lives on the BLOCK (the design states it per card); this column is just the key.';

-- ---------------------------------------------------------------------------
-- (c) ops.design_system — the parts that are one blob, not a row set:
--     the shared chassis, the design tokens, and the family definitions.

create table if not exists ops.design_system (
  key        text primary key,        -- 'chassis' | 'tokens' | 'families'
  value      jsonb not null,
  source     text not null,           -- the docs/design/ file it was generated from
  updated_at timestamptz not null default now()
);

comment on table ops.design_system is
  'PD.1 — chassis geometry, design tokens and family definitions from docs/design/. Seeded by the '
  'generator so drift between repo and DB is a diff, never a mystery.';

-- ---------------------------------------------------------------------------
-- (d) RLS + grants. ops is a private schema (no anon/authenticated USAGE), but 02 §19's
--     belt-and-braces rule requires RLS on every table regardless — and scripts/assert-rls.sql is a
--     CI gate that has been red since 2026-07-20 for exactly this omission
--     (DEF-RLS-GATE-RED-SINCE-0720). Do not add to it.

alter table ops.article_templates enable row level security;
alter table ops.design_system     enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                  where schemaname='ops' and tablename='article_templates' and policyname='worker_read') then
    create policy worker_read on ops.article_templates for select to marsad_worker using (true);
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname='ops' and tablename='design_system' and policyname='worker_read') then
    create policy worker_read on ops.design_system for select to marsad_worker using (true);
  end if;
end $$;

grant select on ops.article_templates to marsad_worker;
grant select on ops.design_system     to marsad_worker;
grant all    on ops.article_templates to service_role;
grant all    on ops.design_system     to service_role;
