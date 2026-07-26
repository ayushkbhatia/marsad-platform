/**
 * Shared, race-safe upsert into lake.objects for the researcher fleet.
 *
 * WHY THIS EXISTS: every researcher hand-rolled the same read-modify-write into lake.objects as
 * separate autocommitted round-trips (`select … where superseded_by is null` then `insert … revision 1`).
 * That has two bugs, both of which crashed marsad-saf-TDWL (stockanalysis-financials.mjs) on 2026-07-21:
 *
 *   1. Check-then-act race. Two overlapping runs both see "no live row" for the same natural_key and
 *      both insert at revision 1 → duplicate (natural_key, revision) → `one_live_per_key`
 *      (supabase/migrations/20260713000004_lake.sql:92).
 *   2. Deferred-FK violation. The VERIFIED-supersede branch points superseded_by at a not-yet-inserted
 *      uuid. That self-FK is `deferrable initially deferred` (0004_lake.sql:85-87), so in autocommit it
 *      is checked at the UPDATE's own commit and always fails — that branch could never have worked.
 *
 * The fix (proven earlier in dividend-declared.mjs:172-190): run the whole three-branch body inside ONE
 * `sql.begin()` transaction per natural_key (deferred FK resolves at COMMIT), and guard both inserts with
 * `on conflict (natural_key, revision) do nothing` + a single re-read-and-retry — mirroring the guard
 * ops.objectify_ohlcv_backfill already uses (20260713000040_ohlcv_bulk_objectify.sql:101).
 *
 * TRANSPORT-AGNOSTIC: takes an existing `sql` (postgres.js) handle — never opens its own connection.
 * The researchers import postgres from an absolute VPS path and construct `sql` themselves.
 *
 * @param sql   a postgres.js handle (top-level, NOT already inside a transaction)
 * @param p     {
 *                naturalKey, objectType, securityId, venueCode, payload,  // required
 *                parseRunId, sourceRank,                                   // required
 *                numericValue?, unit?, effectiveDate?, priceSensitive?,    // optional (index/dividend cols)
 *              }
 * @returns { objectId: string|null, action: 'created'|'updated'|'superseded'|'noop' }
 */
export async function upsertLakeObject(sql, p) {
  let r = await upsertOnce(sql, p);
  if (r.conflict) {
    // A racing run inserted the same (natural_key, revision) between our read and insert.
    // Re-enter: the live row now exists, so this pass takes the update-in-place branch.
    r = await upsertOnce(sql, p);
    if (r.conflict) return { objectId: null, action: 'noop' };
  }
  return r;
}

async function upsertOnce(sql, p) {
  const numericValue = p.numericValue ?? null;
  const unit = p.unit ?? null;
  const effectiveDate = p.effectiveDate ?? null;
  const priceSensitive = p.priceSensitive ?? null;

  return await sql.begin(async (tx) => {
    const live = await tx`
      select id, revision, state from lake.objects
      where natural_key = ${p.naturalKey} and superseded_by is null limit 1`;

    if (live[0] && live[0].state === 'VERIFIED') {
      // A human confirmed this key: supersede the live row with a new PENDING revision.
      const nid = (await tx`select gen_random_uuid() as id`)[0].id;
      await tx`update lake.objects set superseded_by = ${nid}, state = 'RETIRED' where id = ${live[0].id}`;
      const ins = await tx`
        insert into lake.objects
          (id, object_type, natural_key, security_id, venue_code, payload,
           numeric_value, unit, effective_date, state, revision, parse_run_id, source_rank, price_sensitive)
        values
          (${nid}, ${p.objectType}, ${p.naturalKey}, ${p.securityId}, ${p.venueCode}, ${tx.json(p.payload)},
           ${numericValue}, ${unit}, ${effectiveDate}, 'PENDING', ${live[0].revision + 1}, ${p.parseRunId}, ${p.sourceRank}, ${priceSensitive})
        on conflict (natural_key, revision) do nothing
        returning id`;
      if (!ins[0]) return { conflict: true };
      return { objectId: nid, action: 'superseded' };
    }

    if (live[0]) {
      // A PENDING/CONFLICT live row is updated in place (never mutate a VERIFIED payload).
      await tx`
        update lake.objects set
          payload = ${tx.json(p.payload)}, numeric_value = ${numericValue}, unit = ${unit},
          effective_date = ${effectiveDate}, revision = ${live[0].revision + 1},
          parse_run_id = ${p.parseRunId}, source_rank = ${p.sourceRank},
          price_sensitive = ${priceSensitive}, updated_at = now()
        where id = ${live[0].id}`;
      return { objectId: live[0].id, action: 'updated' };
    }

    // No live row: fresh PENDING object at revision 1.
    const ins = await tx`
      insert into lake.objects
        (object_type, natural_key, security_id, venue_code, payload,
         numeric_value, unit, effective_date, state, revision, parse_run_id, source_rank, price_sensitive)
      values
        (${p.objectType}, ${p.naturalKey}, ${p.securityId}, ${p.venueCode}, ${tx.json(p.payload)},
         ${numericValue}, ${unit}, ${effectiveDate}, 'PENDING', 1, ${p.parseRunId}, ${p.sourceRank}, ${priceSensitive})
      on conflict (natural_key, revision) do nothing
      returning id`;
    if (!ins[0]) return { conflict: true };
    return { objectId: ins[0].id, action: 'created' };
  });
}
