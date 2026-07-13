/**
 * ingestion config loader. Same environment contract as worker/src/config.ts
 * (06 §12): all config comes from the environment. DB access is as the
 * marsad_worker role via SUPABASE_DB_URL; Storage uploads use the service-role
 * key (documented least-privilege exception, bucket-write only — 01 §3.1).
 */

import { parseProxyFromEnv, type ProxyConfig } from './proxy.js';

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
  /**
   * Outbound proxy resolved from env (IPROYAL_PROXY_URL / PROXY_URL, or split
   * PROXY_SERVER+PROXY_USERNAME+PROXY_PASSWORD). undefined ⇒ no proxy configured.
   * Applied ONLY to sources whose endpoint_config.use_proxy is true — the worker
   * calls core/proxy.resolveProxyForSource(source, env) per source, so this is the
   * pre-parsed convenience handle, not an unconditional egress override. Creds are
   * NEVER hardcoded; the owner sets them in the VPS worker.env.
   *
   * Optional so pre-existing synthesized-config paths (runtime.ts worker path)
   * that omit it stay valid — an absent field means the same as "no proxy".
   */
  proxy?: ProxyConfig | undefined;
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
    proxy: parseProxyFromEnv(env),
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
