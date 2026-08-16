-- Stop ops.story_blocks.renderer_component claiming components that do not exist.
--
-- The column is populated on all 69 rows — including BlockChart, BlockThesis, BlockLine and
-- BlockWaterfall — because it was seeded from the design registry, which lists the component a
-- block WOULD have. It reads as a capability ("this block can be drawn") and is really just a
-- name, so any consumer trusting it concludes all 61 blocks are renderable. The audit found
-- exactly that: 49 of the names pointed at files that did not exist.
--
-- The real resolution table is src/components/blocks/registry.tsx, and an unregistered code
-- falls to MissingBlock — loud, logged, non-fatal. This makes the DB agree with the filesystem
-- and adds the column that says which is which, so a fitting service or an agent can ask "can
-- this be drawn today" and get a true answer.
--
-- Kept in step by scripts/design/check-block-renderers.mjs, which runs offline in CI.

alter table ops.story_blocks add column if not exists renderer_built boolean not null default false;

comment on column ops.story_blocks.renderer_built is
  'Does a React component actually exist for this block today? renderer_component is only a '
  'NAME (seeded from the design registry, populated even for unbuilt blocks); this is the '
  'capability. Source of truth is src/components/blocks/registry.tsx, kept in step by '
  'scripts/design/check-block-renderers.mjs.';

update ops.story_blocks set renderer_built = (key = any (array[
  -- G · Provenance & trust
  'BLK-PROV','BLK-AGENTS','BLK-FRESH','BLK-ESTIMATE','BLK-CONFLICT','BLK-RULE',
  -- A · Inline
  'BLK-TICKER','BLK-DELTA','BLK-CITE','BLK-TERM','BLK-SPARK','BLK-MARGIN',
  -- C · Tabular
  'BLK-STATSTRIP','BLK-KEYSTATS','BLK-FINTABLE','BLK-SCENARIO','BLK-RANKROW','BLK-BEATMISS',
  'BLK-EXDATE','BLK-COMPARE',
  -- B · Statement
  'BLK-THESIS','BLK-PULLQUOTE','BLK-BIGNUM','BLK-VERDICT','BLK-TAKE','BLK-FALSIFY',
  -- H · Gates
  'BLK-CUT','BLK-PAYWALL'
]));

do $$
declare v_built int; v_active int;
begin
  select count(*) filter (where renderer_built), count(*)
    into v_built, v_active
    from ops.story_blocks where status = 'active';
  raise notice 'renderers: % of % active blocks are actually built', v_built, v_active;

  -- A legacy block must never claim a renderer: it was retired precisely because nothing
  -- should route to it.
  if exists (select 1 from ops.story_blocks where status = 'legacy' and renderer_built) then
    raise exception 'a legacy block is marked renderer_built';
  end if;
end $$;
