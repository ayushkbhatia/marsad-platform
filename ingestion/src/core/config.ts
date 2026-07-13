/**
 * ingestion config loader. Same environment contract as worker/src/config.ts
 * (06 §12): all config comes from the environment. DB access is as the
 * marsad_worker role via SUPABASE_DB_URL; Storage uploads use the service-role
 * key (documented least-privilege exception, bucket-write only — 01 §3.1).
 */

export interface IngestionConfig {
  /** marsad_worker role connection string (Supavisor session pooler, IPv4). */
  dbUrl: string;
  /** Service-role key: ONLY for Supabase Storage 'lake-raw'/'filings' uploads. */
  supabaseServiceRoleKey: string | undefined;
  supabaseUrl: string | undefined;
  /** Identifies this worker/process in claimed_by columns and logs. */
  workerId: string;
  /** Per-host request budget hard ceiling per the recon exit criterion (§5). */
  requestBudgetPerHostPerDay: number;
  /** Per-host token-bucket rate (requests per second). */
  perHostRateLimitPerSec: number;
  /** Global fetch concurrency ceiling (§5). */
  globalConcurrency: number;
  /** Default per-fetch timeout (ms). */
  defaultTimeoutMs: number;
  /**
   * gzipped-size threshold (bytes): bodies above this go to Storage 'lake-raw',
   * at or below stay inline in lake.snapshots.body_inline. Matches the 32768
   * rule in 0004 (lake.snapshots body_inline comment).
   */
  inlineMaxBytes: number;
  /** Storage bucket for raw scraped bytes. */
  rawBucket: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IngestionConfig {
  const dbUrl = env.SUPABASE_DB_URL;
  if (!dbUrl) {
    throw new Error(
      'SUPABASE_DB_URL is required (marsad_worker connection string; see worker/env.example)',
    );
  }
  return {
    dbUrl,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || undefined,
    supabaseUrl: env.SUPABASE_URL || undefined,
    workerId: env.WORKER_ID || `${hostFallback()}-${process.pid}`,
    requestBudgetPerHostPerDay: intFromEnv(env.INGEST_REQ_BUDGET_PER_HOST_DAY, 300),
    perHostRateLimitPerSec: floatFromEnv(env.INGEST_PER_HOST_RPS, 1),
    globalConcurrency: intFromEnv(env.INGEST_GLOBAL_CONCURRENCY, 4),
    defaultTimeoutMs: intFromEnv(env.INGEST_DEFAULT_TIMEOUT_MS, 20_000),
    inlineMaxBytes: intFromEnv(env.INGEST_INLINE_MAX_BYTES, 32_768),
    rawBucket: env.INGEST_RAW_BUCKET || 'lake-raw',
  };
}

function hostFallback(): string {
  try {
    // Lazy require to keep this module import-safe in non-node test contexts.
    return process.env.HOSTNAME || 'ingestion';
  } catch {
    return 'ingestion';
  }
}

function intFromEnv(raw: string | undefined, fallback: number): number {
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function floatFromEnv(raw: string | undefined, fallback: number): number {
  const n = raw ? Number.parseFloat(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
