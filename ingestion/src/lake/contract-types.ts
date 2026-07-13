/**
 * Frozen contract types this lake module consumes (CONTRACT.md §2, §6, §7).
 *
 * These MIRROR the canonical declarations in `ingestion/src/core/types.ts`
 * (owned by the core/framework builder). They are re-declared here — and ONLY
 * here, inside this module's assigned path (`ingestion/src/lake/**`) — so the
 * lake pipeline type-checks and unit-tests in isolation without reaching into
 * another builder's not-yet-written file.
 *
 * TypeScript is structural: once `core/types.ts` lands, the worker-side handlers
 * import the canonical `StagingRow`/`CrossCheck`/… and pass them straight into
 * this module — the shapes are identical by construction, so they interoperate.
 * If the frozen contract ever changes, change CONTRACT.md first, then both here
 * and in core/types.ts (§0 rule). Keep them byte-for-byte aligned.
 */

// §2 — venue vocabulary.
export type VenueCode = 'TDWL' | 'DFM' | 'ADX' | 'QE' | 'MSX' | 'BHB';

// §6 normalized row shapes — only the fields the lake pipeline handles are
// re-declared; the payload is carried opaquely as StagingRow<T>.payload.

// §6.5 — the ingestion→lake handoff row.
export interface StagingRow<T> {
  /** 'QUOTE.LAST','DISCLOSURE.DPS','DIVIDEND.EXDATE','FILING.FINANCIALS',… */
  objectType: string;
  /** deterministic, e.g. 'DIVIDEND.EXDATE:TDWL:7010:2026-INT1' */
  naturalKey: string;
  venue: VenueCode;
  sourceId: number; // ingest.sources.id
  snapshotId: number; // ingest.raw_snapshots.id (lineage)
  externalId: string | null;
  /** primary-wins ordering: registrar=10, exchange=20, press=90 */
  sourceRank: number;
  payload: T; // the normalized shape from §6.1–6.4
  /** fast-path scalar → lake.objects.numeric_value + datapoint fan-out */
  numericValue?: number | null;
  unit?: string | null;
  /** business date → lake.objects.effective_date */
  effectiveDate?: string | null;
  /** → lake.objects.price_sensitive (dividends/IPO/results) */
  priceSensitive?: boolean;
  extractedAt: string; // ISO UTC
}

export interface StagingEmitter {
  emit<T>(rows: StagingRow<T>[]): Promise<void>;
}

// §7 — CrossCheck service.
export interface CrossCheckInput {
  naturalKey: string;
  objectType: string;
}

export interface CrossCheckResult {
  objectId: string; // lake.objects.id (uuid)
  state: 'PENDING' | 'VERIFIED' | 'CONFLICT';
  revision: number;
}

export interface CrossCheck {
  resolve(input: CrossCheckInput): Promise<CrossCheckResult>;
}
