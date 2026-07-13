-- Restore-drill sentinel checks (.github/workflows/restore-drill.yml).
-- Fails (RAISE EXCEPTION -> psql ON_ERROR_STOP -> non-zero exit) if any core
-- table is missing or empty after a restore. Table names per
-- docs/architecture/02-data-lake.md (the single source of truth):
--   public.venues          (0003_market_reference — seeded with the 6 venues)
--   public.securities      (0003 — the ~812-name universe)
--   billing.plan_versions  (0010_billing — "plans"; seeded with the 33c config V1)
do $$
declare
  sentinel  text;
  n         bigint;
begin
  foreach sentinel in array array[
    'public.venues',
    'public.securities',
    'billing.plan_versions'
  ]
  loop
    execute format('select count(*) from %s', sentinel) into n;
    if n = 0 then
      raise exception 'sanity check FAILED: % has 0 rows', sentinel;
    end if;
    raise notice 'sanity ok: % has % rows', sentinel, n;
  end loop;
end
$$;
