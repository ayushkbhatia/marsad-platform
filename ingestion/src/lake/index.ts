/**
 * lake — the verification pipeline (CONTRACT §6.5, §7, §9).
 *
 * Public surface the worker handlers import:
 *  - LakeStagingEmitter  — the ingestion→lake staging writer (§6.5).
 *  - LakeCrossCheck      — the 2-source rule → VERIFIED lake.objects (§7).
 *  - KeyRatiosRecompute  — nightly public.key_ratios rebuild (§9).
 *
 * The frozen contract interfaces (StagingRow, StagingEmitter, CrossCheck, …) are
 * re-exported from contract-types.ts; once ingestion/src/core/types.ts lands,
 * the worker imports the canonical ones — they are structurally identical.
 */

export { LakeStagingEmitter } from './staging.js';
export { LakeCrossCheck, type CrossCheckOptions } from './cross-check.js';
export { KeyRatiosRecompute, type KeyRatiosOptions, type RecomputeSummary } from './key-ratios.js';
export { computeKeyRatios, hasAnyRatio, type RatioInputs, type KeyRatios } from './ratios-compute.js';
export { decide, candidatesAgree, pricesAgree, primaryOf, PRICE_TOLERANCE, type Candidate, type Decision } from './agreement.js';
export { canonicalJson, contentHash } from './canonical.js';
export { STAGING_ROWS_DDL } from './staging-schema.js';
export type { LakeSql, LakeTx, LakeLogger } from './db.js';
export type {
  StagingRow,
  StagingEmitter,
  CrossCheck,
  CrossCheckInput,
  CrossCheckResult,
  VenueCode,
} from './contract-types.js';
