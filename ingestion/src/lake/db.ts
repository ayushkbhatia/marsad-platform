/**
 * Narrow DB surface the lake pipeline runs against.
 *
 * The live worker passes the shared `postgres` (postgres.js) `Sql` instance
 * created in `worker/src/db.ts` — it connects as the dedicated `marsad_worker`
 * role (grants on ingest.*, lake.*, ops.*; no billing.*). We type only the two
 * shapes this module uses — tagged-template queries and `sql.begin(tx)` — so the
 * lake services can be unit-tested against an in-memory fake without pulling in
 * a live pooler. postgres.js's real `Sql`/`TransactionSql` are structurally
 * assignable to `LakeSql`/`LakeTx`.
 *
 * Every query in this module runs as marsad_worker. Per-object attribution is
 * the GUC `app.principal_id` (the venue DATA agent for extraction; the
 * cross-check verifier principal for verification) — set by the worker handler
 * around each unit of work (CONTRACT §9), NOT here. This module reads/sets no
 * GUC of its own; it takes verifier/actor principal ids as explicit args so it
 * stays a pure function of its inputs and the DB state.
 */

/** A tagged-template query returning rows of R. Mirrors postgres.js `Sql`. */
export interface LakeSql {
  <R = Row>(strings: TemplateStringsArray, ...params: unknown[]): Promise<R[]>;
  /**
   * Run `fn` inside one transaction. postgres.js resolves the outer promise
   * with fn's return value and COMMITs; a throw ROLLBACKs. The supersede flow
   * relies on this single-transaction guarantee so the DEFERRABLE self-FK on
   * lake.objects.superseded_by resolves at COMMIT (0004).
   */
  begin<T>(fn: (tx: LakeTx) => Promise<T>): Promise<T>;
}

/** Transaction handle — same call shape as the pool, minus nested begin(). */
export interface LakeTx {
  <R = Row>(strings: TemplateStringsArray, ...params: unknown[]): Promise<R[]>;
}

export type Row = Record<string, unknown>;

/** Structured logger (subset of the worker Logger; CONTRACT §3). */
export interface LakeLogger {
  info(msg: string, extra?: object): void;
  warn(msg: string, extra?: object): void;
  error(msg: string, extra?: object): void;
}

export const noopLogger: LakeLogger = {
  info() {},
  warn() {},
  error() {},
};
