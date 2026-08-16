-- ─────────────────────────────────────────────────────────────────────────────
-- D-family: mark the three chart shapes that now draw.
--
-- `renderer_built` is the filter that keeps the composer inside what the reader can actually
-- draw — a block composed with no renderer puts a loud MissingBlock on a published page. Loud is
-- right for a bug; it is not something to schedule on purpose.
--
-- BLK-LINE, BLK-AREA and BLK-BARS now have renderers over the real series contract
-- (lake.fn_resolve_series, 20260816290000). The other twelve D shapes stay false: a scatter, a
-- waterfall and a candle are not worth hand-rolling ahead of the Vega-Lite compiler, and a stub
-- that renders nothing is indistinguishable from a bug.
-- ─────────────────────────────────────────────────────────────────────────────
begin;

update ops.story_blocks
   set renderer_built = true
 where key in ('BLK-LINE', 'BLK-AREA', 'BLK-BARS');

-- The invariant, not the count: the manifest on disk and this column must agree, and these three
-- are the only D-family rows that may claim a renderer at this migration.
do $$
declare n_d int; n_missing int;
begin
  select count(*) into n_d
    from ops.story_blocks
   where family = 'D' and renderer_built;
  if n_d <> 3 then
    raise exception 'expected exactly 3 drawable D blocks, found %', n_d;
  end if;

  select count(*) into n_missing
    from (values ('BLK-LINE'), ('BLK-AREA'), ('BLK-BARS')) v(key)
   where not exists (
     select 1 from ops.story_blocks b where b.key = v.key and b.renderer_built
   );
  if n_missing <> 0 then
    raise exception '% of the three chart blocks did not take the update', n_missing;
  end if;
end $$;

commit;
