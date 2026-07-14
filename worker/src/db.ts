import postgres from "postgres";
import type { WorkerConfig } from "./config.js";

export type Sql = postgres.Sql;

/**
 * One shared pool as the marsad_worker role. Grants: ingest.*, lake.*, ops.*,
 * pgmq queue functions — no billing.* or IAM key tables (06 Revisions #1).
 */
export function createDb(config: WorkerConfig): Sql {
  return postgres(config.dbUrl, {
    // Pool size (P1.7a fix). max:5 was catastrophically small: the worker runs 5
    // always-on pgmq queue consumers, each holding one connection continuously in
    // read_with_poll — that alone consumes the whole pool, leaving ZERO headroom for
    // the ingest poller, a handler's own queries (cross_check runs several per message),
    // or the OHLCV backfill's concurrent snapshot+stage lanes. The result was severe
    // starvation: cross_check crawled at ~1 msg/20s and the backfill's sink lanes
    // blocked waiting for a connection (the "fetch stalls after 8 symbols" hang).
    //
    // HARD CEILING: the Supabase SESSION pooler caps this project at pool_size 15 —
    // opening more throws (EMAXCONNSESSION) "max clients reached in session mode". So
    // max must stay UNDER 15 (postgres.js queues excess requests client-side rather
    // than erroring). Default 12 leaves ~3 for external clients (dashboard, MCP). This
    // is a genuine ceiling on worker concurrency: the 5 always-on queue consumers alone
    // hold ~5, so the poller + q_pipeline batch + backfill sink share the remaining ~7.
    // Raising it requires bumping the Supabase pooler pool_size (owner, dashboard), then
    // DB_POOL_MAX. Env-overridable.
    max: config.dbPoolMax,
    // Supavisor session pooler tolerates prepared statements, but disabling
    // them keeps the worker safe if the owner ever points dbUrl at the
    // transaction pooler port instead.
    prepare: false,
    connection: {
      application_name: `marsad-worker/${config.workerId}`,
    },
    idle_timeout: 30,
    connect_timeout: 15,
    onnotice: () => {
      /* silence NOTICEs; structured logs only */
    },
  });
}
