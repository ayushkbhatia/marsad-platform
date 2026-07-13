import postgres from "postgres";
import type { WorkerConfig } from "./config.js";

export type Sql = postgres.Sql;

/**
 * One shared pool as the marsad_worker role. Grants: ingest.*, lake.*, ops.*,
 * pgmq queue functions — no billing.* or IAM key tables (06 Revisions #1).
 */
export function createDb(config: WorkerConfig): Sql {
  return postgres(config.dbUrl, {
    max: 5,
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
