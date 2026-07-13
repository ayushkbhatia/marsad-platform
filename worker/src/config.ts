import { hostname } from "node:os";

/**
 * All configuration comes from the environment (/etc/marsad/worker.env on the
 * VPS via systemd EnvironmentFile=, .env via `npm run dev` locally). See 06 §12.
 */
export interface WorkerConfig {
  /** marsad_worker role connection string (Supavisor session pooler, IPv4 — 06 Revisions #1). */
  dbUrl: string;
  /**
   * Service-role key: documented least-privilege exception, used ONLY for
   * Supabase Storage bucket uploads (raw-snapshots, filings-pdf). Never for
   * PostgREST data access — all data access goes through dbUrl as marsad_worker.
   */
  supabaseServiceRoleKey: string | undefined;
  supabaseUrl: string | undefined;
  /** Healthchecks.io ping URL for the worker-alive check. Optional. */
  healthcheckUrl: string | undefined;
  /** Identifies this worker instance in logs and claimed_by columns. */
  workerId: string;
  heartbeatIntervalMs: number;
  healthcheckPingIntervalMs: number;
  /** Max time to wait for in-flight handlers on SIGTERM before forcing exit. */
  shutdownGraceMs: number;
  /**
   * ingest.job_queue poller (scheduler→worker bridge, 01 §4.1):
   *  - ingestPollIntervalMs: how long to wait between claim cycles when the last
   *    cycle did NOT fill a full batch (idle). ~15s per 01 §4.1.
   *  - ingestBatchSize: rows claimed per cycle. A full batch loops again with no
   *    wait so a backlog clears promptly.
   *  - ingestConcurrency: max jobs run in parallel per batch. Caps at the
   *    framework's global fetch concurrency ceiling (CONTRACT §5, ≤4); the
   *    per-host ≤1 req/s budget is enforced inside the ingestion fetcher.
   */
  ingestPollIntervalMs: number;
  ingestBatchSize: number;
  ingestConcurrency: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const dbUrl = env.SUPABASE_DB_URL;
  if (!dbUrl) {
    throw new Error(
      "SUPABASE_DB_URL is required (marsad_worker connection string; see worker/env.example)",
    );
  }
  return {
    dbUrl,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || undefined,
    supabaseUrl: env.SUPABASE_URL || undefined,
    healthcheckUrl: env.HEALTHCHECK_URL || undefined,
    workerId: env.WORKER_ID || `${hostname()}-${process.pid}`,
    heartbeatIntervalMs: intFromEnv(env.HEARTBEAT_INTERVAL_MS, 30_000),
    healthcheckPingIntervalMs: intFromEnv(env.HEALTHCHECK_PING_INTERVAL_MS, 300_000),
    shutdownGraceMs: intFromEnv(env.SHUTDOWN_GRACE_MS, 30_000),
    ingestPollIntervalMs: intFromEnv(env.INGEST_POLL_INTERVAL_MS, 15_000),
    ingestBatchSize: intFromEnv(env.INGEST_BATCH_SIZE, 20),
    ingestConcurrency: intFromEnv(env.INGEST_CONCURRENCY, 4),
  };
}

function intFromEnv(raw: string | undefined, fallback: number): number {
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
