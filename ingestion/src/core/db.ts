import postgres from 'postgres';
import type { IngestionConfig } from './config.js';

export type Sql = postgres.Sql;

/**
 * One shared pool as the marsad_worker role — same pattern as worker/src/db.ts.
 * Grants: ingest.*, lake.*, ops.*, pgmq — no billing.* / IAM key tables.
 * prepare:false keeps us safe if dbUrl ever points at the transaction pooler.
 */
export function createDb(config: IngestionConfig): Sql {
  return postgres(config.dbUrl, {
    max: 5,
    prepare: false,
    connection: {
      application_name: `marsad-ingestion/${config.workerId}`,
    },
    idle_timeout: 30,
    connect_timeout: 15,
    onnotice: () => {
      /* silence NOTICEs; structured logs only */
    },
  });
}
