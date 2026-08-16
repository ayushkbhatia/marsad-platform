-- Re-cut ops.templates onto the live 61-code vocabulary, and join the two template axes.
--
-- ── WHY THIS BLOCKS COMPOSITION ───────────────────────────────────────────────
-- 09 §5.5 says pass 1 of composition emits block codes "against an enum containing only the
-- codes legal for this template". The only block-key list in the database is
-- ops.templates.block_keys — and SEVEN OF EIGHT rows name codes the 61-block library retired:
--
--   BLK-TABLE · BLK-CHART · BLK-QUOTE · BLK-YIELD · BLK-COVERAGE · BLK-SCORE · BLK-HOLDERS
--
-- None of those is in ops.story_blocks with status='active'. A compose stage shipped against
-- today's table would offer a model an enum of 2-5 dead codes, and the fit stage would refuse
-- everything it produced. fit-engine.ts:334 already softens template-declared legacy keys to a
-- WARNING for exactly this reason, with the honest note that "a stage that refuses everything
-- gets switched off, which is strictly worse than one that refuses the right things."
--
-- ── AND WHY THE PIECE_TYPE COLUMN ─────────────────────────────────────────────
-- Two template axes exist and nothing joins them. ops.templates (TPL-01..08) is the PIPELINE
-- axis; ops.article_templates (1a/1b/3a/3b) is the LAYOUT axis carrying premium_cut,
-- section_sequence and the real editorial hard_rules. content_items records template_key and
-- no layout id, so the bridge is a hard-coded map at fit-engine.ts:160-172 that covers 4 of 8
-- and resolves TPL-05 to a piece_type ('IPO') no layout row has — which silently degrades the
-- whole premium-cut check to 'unchecked'. The file's own comment predicts this migration:
-- "This map is the stage's ONLY hard-coded policy; it moves into the registry the moment
-- ops.templates gains a piece_type column."
--
-- TPL-01 (WIRE) and TPL-05 (IPO) are left NULL DELIBERATELY. There is no 1w or 1i specimen in
-- the design handoff, and inventing a layout row means inventing design decisions — cut
-- placement, section order — that nobody has made. NULL is the honest state and checkCut
-- already reports 'unchecked' rather than guessing.

-- ─── 1. The re-cut ────────────────────────────────────────────────────────────
update ops.templates set block_keys = v.keys
  from (values
    ('TPL-01', array['BLK-TICKER','BLK-DELTA','BLK-CITE','BLK-FRESH','BLK-PROV','BLK-TAPEROW']),
    ('TPL-02', array['BLK-TICKER','BLK-DELTA','BLK-STATSTRIP','BLK-BREADTH','BLK-CHIPROW','BLK-BARS','BLK-SNAPSHOT','BLK-PROV','BLK-FRESH']),
    ('TPL-03', array['BLK-TICKER','BLK-DELTA','BLK-BIGNUM','BLK-STATSTRIP','BLK-FINTABLE','BLK-BEATMISS','BLK-WATERFALL','BLK-ESTIMATE','BLK-PROV','BLK-CITE','BLK-PULLQUOTE']),
    ('TPL-04', array['BLK-TICKER','BLK-EXDATE','BLK-KEYSTATS','BLK-RANKROW','BLK-AREA','BLK-PROV','BLK-CITE']),
    ('TPL-05', array['BLK-TICKER','BLK-KEYSTATS','BLK-COVER','BLK-TIMELINE','BLK-COUNTDOWN','BLK-PROV','BLK-CITE']),
    ('TPL-06', array['BLK-TIMELINE','BLK-STEPS','BLK-FLOW','BLK-WORKED','BLK-MYTH','BLK-DECISION','BLK-GLOSSARY','BLK-TERM','BLK-ANATOMY']),
    ('TPL-07', array['BLK-TICKER','BLK-THESIS','BLK-TAKE','BLK-CUT','BLK-PAYWALL','BLK-STATSTRIP','BLK-PROV','BLK-CITE','BLK-PULLQUOTE']),
    ('TPL-08', array['BLK-TICKER','BLK-THESIS','BLK-FINTABLE','BLK-COMPARE','BLK-SCENARIO','BLK-LINE','BLK-INDEXED','BLK-STACK','BLK-ESTIMATE','BLK-FALSIFY','BLK-CUT','BLK-PAYWALL','BLK-DOWNLOAD','BLK-AGENTS','BLK-PROV','BLK-RULE'])
  ) as v(key, keys)
 where ops.templates.key = v.key;

-- ─── 2. The join ──────────────────────────────────────────────────────────────
create unique index if not exists article_templates_piece_type_uni
  on ops.article_templates (piece_type);

alter table ops.templates add column if not exists piece_type text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'templates_piece_type_fkey') then
    alter table ops.templates
      add constraint templates_piece_type_fkey
      foreign key (piece_type) references ops.article_templates (piece_type);
  end if;
end $$;

update ops.templates set piece_type = v.pt
  from (values
    ('TPL-02','FEATURE'), ('TPL-03','FEATURE'), ('TPL-07','FEATURE'),
    ('TPL-04','NOTE'), ('TPL-06','EXPLAINER'), ('TPL-08','DEEP DIVE')
  ) as v(key, pt)
 where ops.templates.key = v.key;

comment on column ops.templates.piece_type is
  'The LAYOUT template this pipeline template renders as (ops.article_templates.piece_type). '
  'Replaces the hard-coded PIECE_TYPE_BY_TEMPLATE map in fit-engine.ts. NULL on TPL-01 (wire) '
  'and TPL-05 (IPO) on purpose: no 1w/1i specimen exists in the design handoff, and inventing '
  'a layout row would mean inventing cut placement and section order nobody has decided.';

-- ─── 3. The guard that stops this recurring ───────────────────────────────────
-- A CHECK cannot subquery, so this is a function the test suite calls. Turning the drift into
-- a build failure is the point: the previous divergence survived because nothing compared the
-- template vocabulary against the block registry.
create or replace function ops.fn_assert_template_block_keys()
returns void
language plpgsql stable set search_path to ''
as $$
declare v_bad text;
begin
  select string_agg(t.key || ':' || k, ', ' order by t.key)
    into v_bad
    from ops.templates t
    cross join lateral unnest(t.block_keys) as k
   where not exists (
     select 1 from ops.story_blocks sb where sb.key = k and sb.status = 'active');
  if v_bad is not null then
    raise exception 'ops.templates references non-active block codes: %', v_bad;
  end if;
end $$;

do $$
declare v_null_pt text;
begin
  perform ops.fn_assert_template_block_keys();

  select string_agg(key, ', ' order by key) into v_null_pt
    from ops.templates where piece_type is null;
  -- Only the two documented exceptions may lack a layout template.
  if coalesce(v_null_pt, '') not in ('TPL-01, TPL-05', '') then
    raise exception 'unexpected templates with no piece_type: %', v_null_pt;
  end if;
  raise notice 'templates re-cut; layout join set, NULL only on %', coalesce(v_null_pt, 'none');
end $$;
