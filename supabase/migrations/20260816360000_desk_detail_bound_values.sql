-- ─────────────────────────────────────────────────────────────────────────────
-- The desk could not see what it was approving.
--
-- /admin/approvals/[id] rendered the piece as:
--
--     detail.blocks.map((b) => b.body?.text ?? "").join("\n\n")
--
-- A design block's `body` IS the payload — a BLK-STATSTRIP holds `cells`, a BLK-BIGNUM holds
-- `value`/`caption`/`context_line`. None of them has a `text` field, so every composed exhibit
-- rendered as an empty string. On item 3 that is six of eleven blocks: the approver saw the
-- prose paragraphs with silent gaps where the evidence was, and was asked to approve it.
--
-- This is the third instance of the same `?.text ?? ''` assumption (after the rules-stage
-- assembler), and the most consequential, because the other two blocked a piece while this one
-- silently showed a human the wrong thing.
--
-- Two additions, both needed before a block can be drawn:
--   `bound_object_id` — which lake object each block binds; and
--   `bound_values`    — the resolved value per bound object, so the desk sees the FIGURE and
--                       not a uuid. Resolved here rather than in the app because the reader's
--                       v_content_bound_objects is scoped to live content by design, and a
--                       piece at approval is not live.
--
-- Still security definer + service_role only, exactly as before: this is a desk surface, and
-- the grant is unchanged.
-- ─────────────────────────────────────────────────────────────────────────────
begin;

create or replace function public.desk_approval_detail(p_item bigint)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'item', (select to_jsonb(v) from public.v_desk_approvals v where v.item_id = p_item),
    'blocks', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'seq', cb.seq, 'kind', cb.block_kind, 'body', cb.body, 'gated', cb.gated,
        'bound_object_id', cb.bound_object_id
      ) order by cb.seq), '[]'::jsonb)
      from public.content_blocks cb
      join ops.pipeline_items pi on pi.content_id = cb.content_id
      where pi.id = p_item),
    -- Every object any block on this piece binds, keyed by id, so the renderer resolves
    -- without a second round trip and without reaching into lake from the app.
    'bound_values', (
      select coalesce(jsonb_object_agg(o.id::text, jsonb_build_object(
        'object_id', o.id, 'object_type', o.object_type, 'state', o.state::text,
        'verification_basis', o.verification_basis, 'numeric_value', o.numeric_value,
        'unit', o.unit, 'effective_date', o.effective_date, 'verified_at', o.verified_at,
        'payload', o.payload
      )), '{}'::jsonb)
      from lake.objects o
      where o.id in (
        select cb.bound_object_id
          from public.content_blocks cb
          join ops.pipeline_items pi on pi.content_id = cb.content_id
         where pi.id = p_item and cb.bound_object_id is not null
      )),
    'citations', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'claim_key', c.claim_key, 'object_id', c.object_id, 'object_type', o.object_type,
        'object_state', o.state, 'quoted_value', c.quoted_value, 'claim', c.claim_text,
        'payload_path', c.payload_path
      ) order by c.claim_key), '[]'::jsonb)
      from lake.citations c
      join ops.pipeline_items pi on pi.content_id = c.content_id
      left join lake.objects o on o.id = c.object_id
      where pi.id = p_item),
    'violations', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'rule_key', rv.rule_key, 'outcome', rv.outcome, 'detail', rv.detail
      ) order by rv.rule_key), '[]'::jsonb)
      from ops.rule_violations rv
      join ops.pipeline_items pi on pi.content_id = rv.content_id
      where pi.id = p_item)
  );
$$;

revoke all on function public.desk_approval_detail(bigint) from public, anon, authenticated;
grant execute on function public.desk_approval_detail(bigint) to service_role;

comment on function public.desk_approval_detail(bigint) is
  'One piece, fully assembled for desk review — including each block''s bound_object_id and the '
  'resolved lake value behind it. The desk renders design blocks, so it needs the figures: '
  'v_content_bound_objects is scoped to live content by design and a piece at approval is not '
  'live. service_role only, unchanged.';

do $$
declare v jsonb;
begin
  -- The invariant: whatever a block binds, the caller can resolve. Not a count — a piece with
  -- no bound blocks is legal and must still pass.
  select public.desk_approval_detail(pi.id) into v
    from ops.pipeline_items pi
   where exists (select 1 from public.content_blocks cb
                  where cb.content_id = pi.content_id and cb.bound_object_id is not null)
   limit 1;
  if v is not null and exists (
    select 1
      from jsonb_array_elements(v -> 'blocks') b
     where b ->> 'bound_object_id' is not null
       and not (v -> 'bound_values') ? (b ->> 'bound_object_id')
  ) then
    raise exception 'desk_approval_detail returned a bound block whose object it did not resolve';
  end if;
end $$;

commit;
