-- ─────────────────────────────────────────────────────────────────────────────
-- lake.citations.payload_path — which field of the object a citation is about.
--
-- R-04's drift check asks "has the number this piece cited moved since it was cited?". To ask
-- that it must know WHICH number. It did not, and probed for whatever value in the payload sat
-- numerically nearest the cited one.
--
-- The live failure that closes DEF-RULES-R04-LAKE-DRIFT: item 3's citation c15 reads "trailing
-- twelve-month revenue growth rate · 10.6%", against a COMPUTED.RATIOS object whose payload
-- holds pb, pe, ps, roe, eps_ttm and a dozen more. The probe returned 9.5957 — the P/E — and
-- declared a 10% drift. An earlier recorded failure matched a fiscal year (2026) against a QAR
-- 4.43bn profit the same way. Two unrelated numbers landing inside a tolerance band are not
-- drift, and no band can tell the difference; only the path can.
--
-- Nullable on purpose. Every citation written before this exists has no path, and the checker
-- reports those `unchecked` rather than `passed` — a check that could not run is not a check
-- that passed.
-- ─────────────────────────────────────────────────────────────────────────────
begin;

alter table lake.citations add column if not exists payload_path text;

comment on column lake.citations.payload_path is
  'Dotted path to the field this citation is about within lake.objects.payload '
  '(e.g. line_items.net_income, ratios.pe). Written at draft time. NULL means R-04''s drift '
  'check cannot run for this citation and must report it unchecked, never passed.';

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'lake' and table_name = 'citations' and column_name = 'payload_path'
  ) then
    raise exception 'lake.citations.payload_path did not take';
  end if;
end $$;

commit;
