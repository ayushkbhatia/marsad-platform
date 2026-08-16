-- TPL-03 must not promise a block the design forbids on its layout.
--
-- The compose stage's vocabulary filter caught this on its first live evaluation: TPL-03
-- (Earnings Recap) listed BLK-FINTABLE, but the block's own piece_types is {DEEP DIVE, NOTE}
-- and TPL-03 maps to FEATURE. The design's position is that a full financial table belongs in
-- a note or a deep dive; a feature carries the figure and the argument, not the statement.
--
-- I put FINTABLE in that list during the re-cut (20260816230000) without checking the block's
-- own piece_types against the template's layout. Removing it from the template rather than
-- widening the block, because the block registry is generated from the design cards and is the
-- authority; a template is an editorial selection FROM that vocabulary, not a licence to
-- override it.
--
-- ⚠️ OPEN QUESTION FOR THE OWNER, deliberately not decided here: an Earnings Recap may simply
-- be the wrong shape for the FEATURE layout. Layout 1b (NOTE) is where FINTABLE and the rating
-- card live, and a recap is arguably a note. But 1b carries premium_cut.present = false — the
-- WHOLE note is premium — so moving TPL-03 there would paywall every earnings recap, which is
-- a pricing decision rather than a design one.

-- Generalised, because the guard below found FIVE more templates with the same defect once it
-- was written — every one of them mine, from the re-cut. Removing the offending pairs rather
-- than hand-listing them means the fix covers what I missed as well as what I noticed:
--   TPL-02 BLK-CHIPROW, BLK-SNAPSHOT · TPL-04 BLK-KEYSTATS · TPL-06 BLK-FLOW
--   TPL-08 BLK-THESIS, BLK-SCENARIO · TPL-03 BLK-FINTABLE
update ops.templates t
   set block_keys = (
     select coalesce(array_agg(k order by ord), '{}')
       from unnest(t.block_keys) with ordinality as u(k, ord)
       join ops.story_blocks sb on sb.key = u.k
      where sb.piece_types is null
         or sb.piece_types && array['ALL','AI']
         or t.piece_type is null
         or sb.piece_types @> array[t.piece_type]
   )
 where t.piece_type is not null;

do $$
declare v_bad text; v_empty text;
begin
  -- No template may list a block whose piece_types excludes that template's layout. This is the
  -- generalisation of the specific fix above, so the next re-cut cannot reintroduce the class.
  select string_agg(t.key || ':' || k, ', ')
    into v_bad
    from ops.templates t
    cross join lateral unnest(t.block_keys) as k
    join ops.story_blocks sb on sb.key = k
   where t.piece_type is not null
     and sb.piece_types is not null
     and not (sb.piece_types && array['ALL','AI'])
     and not (sb.piece_types @> array[t.piece_type]);
  if v_bad is not null then
    raise exception 'templates list blocks their layout forbids: %', v_bad;
  end if;

  -- Removing forbidden blocks must not leave a template with nothing to compose from.
  select string_agg(key, ', ') into v_empty
    from ops.templates where coalesce(array_length(block_keys, 1), 0) = 0;
  if v_empty is not null then
    raise exception 'templates left with an empty vocabulary: %', v_empty;
  end if;
end $$;
