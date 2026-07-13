/**
 * Staging writer — the ingestion→lake handoff (CONTRACT §6.5, §7; 01 §10).
 *
 * A parser emits normalized rows (§6.1–6.4); the venue DATA handler wraps each
 * as a StagingRow<T> and calls emit(). This writer persists them into
 * `lake.staging_rows` (see staging-schema.ts) idempotently on
 * (source_id, external_id, content_hash) so a retried job cannot double-emit.
 * CrossCheck later reads the unconsumed candidates per natural_key and applies
 * the 2-source rule.
 *
 * Attribution: rows are written as marsad_worker; the fetching DATA agent's
 * identity already lives on the snapshot (lake.snapshots.fetched_by). Staging is
 * pure lineage plumbing — no principal GUC needed here.
 */

import type { LakeSql, LakeLogger } from './db.js';
import { noopLogger } from './db.js';
import { contentHash } from './canonical.js';
import type { StagingEmitter, StagingRow } from './contract-types.js';

export class LakeStagingEmitter implements StagingEmitter {
  constructor(
    private readonly sql: LakeSql,
    private readonly log: LakeLogger = noopLogger,
  ) {}

  async emit<T>(rows: StagingRow<T>[]): Promise<void> {
    if (rows.length === 0) return;

    // Insert one at a time with ON CONFLICT DO NOTHING. Volumes per emit are
    // small (one venue board diff or a handful of filings), and per-row inserts
    // keep the idempotency semantics obvious and the SQL portable across the
    // fake used in unit tests. A future multi-row VALUES optimization is safe
    // to add behind the same conflict target.
    for (const row of rows) {
      const hash = contentHash(row.payload);
      this.assertRow(row);
      await this.sql`
        insert into lake.staging_rows (
          object_type, natural_key, venue_code, source_id, source_rank,
          snapshot_id, external_id, content_hash, payload,
          numeric_value, unit, effective_date, price_sensitive, extracted_at
        ) values (
          ${row.objectType}, ${row.naturalKey}, ${row.venue}, ${row.sourceId}, ${row.sourceRank},
          ${row.snapshotId}, ${row.externalId}, ${hash}, ${this.jsonb(row.payload)},
          ${row.numericValue ?? null}, ${row.unit ?? null}, ${row.effectiveDate ?? null},
          ${row.priceSensitive ?? false}, ${row.extractedAt}
        )
        on conflict (source_id, external_id, content_hash) do nothing
      `;
    }

    this.log.info('staging.emit', { rows: rows.length, naturalKeys: unique(rows.map((r) => r.naturalKey)) });
  }

  /** postgres.js serializes a JS object bound to a jsonb column automatically;
   *  we pass the object through unchanged. Kept as a seam for the test fake. */
  private jsonb(payload: unknown): unknown {
    return payload;
  }

  private assertRow(row: StagingRow<unknown>): void {
    if (!row.naturalKey) throw new Error('staging row missing naturalKey');
    if (!row.objectType) throw new Error('staging row missing objectType');
    if (!Number.isFinite(row.sourceId)) throw new Error('staging row missing sourceId');
    if (!Number.isFinite(row.snapshotId)) throw new Error('staging row missing snapshotId');
    if (!row.extractedAt) throw new Error('staging row missing extractedAt');
  }
}

function unique(values: string[]): number {
  return new Set(values).size;
}
