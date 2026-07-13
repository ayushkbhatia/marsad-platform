/**
 * Token & cost accounting → ops.llm_runs (03 §1.7, moved to ops per Revision 4).
 *
 * Every gateway call writes one row — the accounting call lives inside the
 * gateway, not the caller. Inserts never throw; a lost accounting row is a
 * logged warning, not an outage. The pg_cron rollup (fn_rollup_llm_costs,
 * 00:00 GST) and the $60/mo budget ladder consume whatever rows landed.
 *
 * `ops` is NEVER exposed to PostgREST — 02-data-lake.md locks the exposure
 * surface to `public, graphql_public`. The row therefore lands via one of two
 * sanctioned paths, picked automatically from the environment:
 *
 *   1. Worker (SUPABASE_DB_URL present): direct INSERT as the marsad_worker
 *      pg role over the Supavisor session pooler (06 Revisions #1 — the
 *      worker's service-role key is Storage-only, DB goes through this role).
 *      Uses `postgres` (postgres.js — the worker's standard driver, see
 *      worker/src/db.ts) and needs `GRANT INSERT ON ops.llm_runs TO
 *      marsad_worker` in the ops migration.
 *   2. Next.js server runtime: SECURITY DEFINER RPC public.record_llm_run(jsonb)
 *      called with the service-role key — the same sanctioned pattern as 02's
 *      public.track() analytics insert. EXECUTE is granted to service_role only.
 */

import { createClient } from "@supabase/supabase-js";
import type { LlmRunRow } from "./types";

// ── Path 1: direct pg (worker) ──────────────────────────────────────────────

/** Minimal structural type so `postgres` stays a worker-only dependency. */
interface PostgresSqlLike {
  unsafe(query: string, parameters?: unknown[]): Promise<unknown>;
}

// undefined = not initialized yet; null = unavailable on this runtime.
let pgSql: PostgresSqlLike | null | undefined;

async function getPgSql(): Promise<PostgresSqlLike | null> {
  if (pgSql !== undefined) return pgSql;

  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    pgSql = null;
    return null;
  }

  try {
    // Resolve `postgres` outside the bundler graph: it is a worker-only
    // dependency and must not break the Next build (or Edge runtime) when
    // absent.
    const { createRequire } = await import("node:module");
    const requireModule = createRequire(import.meta.url);
    const postgres = requireModule("postgres") as (
      url: string,
      options: Record<string, unknown>,
    ) => PostgresSqlLike;
    pgSql = postgres(dbUrl, {
      max: 2,
      // Safe if the owner points dbUrl at the transaction pooler port
      // (matches worker/src/db.ts).
      prepare: false,
      idle_timeout: 30,
      connect_timeout: 15,
      connection: { application_name: "marsad-llm-accounting" },
    });
  } catch {
    // `postgres` not installed here (e.g. Next dev with SUPABASE_DB_URL in
    // .env.local) — fall through to the RPC path.
    pgSql = null;
  }
  return pgSql;
}

const INSERT_SQL = `
  insert into ops.llm_runs
    (id, agent_id, pipeline_item_id, role, provider, model, purpose,
     input_tokens, output_tokens, cost_usd, latency_ms, degraded, error)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`;

// ── Path 2: public.record_llm_run RPC (Next.js server runtime) ─────────────

function createRpcClient(url: string, serviceKey: string) {
  // Default (public) schema — ops is deliberately NOT in PostgREST's exposed
  // schema list; only the SECURITY DEFINER RPC crosses that boundary.
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

type RpcClient = ReturnType<typeof createRpcClient>;

let rpcClient: RpcClient | null | undefined;
let warnedDisabled = false;

function getRpcClient(): RpcClient | null {
  if (rpcClient !== undefined) return rpcClient;

  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    rpcClient = null;
    if (!warnedDisabled) {
      warnedDisabled = true;
      console.warn(
        "[llm/accounting] no SUPABASE_DB_URL (worker path) and SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing (RPC path) — llm_runs accounting disabled",
      );
    }
    return null;
  }

  rpcClient = createRpcClient(url, serviceKey);
  return rpcClient;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Insert one ops.llm_runs row. Never throws: every failure is logged and
 * swallowed — nothing in accounting may take down an LLM call. Returns the
 * insert promise so callers can bound-await it (serverless) or tests can
 * await it; the gateway races it against a short timeout.
 */
export function recordLlmRun(row: LlmRunRow): Promise<void> {
  return insertRow(row).catch((err: unknown) => {
    console.warn(
      `[llm/accounting] insert failed for run ${row.id}:`,
      err instanceof Error ? err.message : err,
    );
  });
}

async function insertRow(row: LlmRunRow): Promise<void> {
  const sql = await getPgSql();
  if (sql) {
    await sql.unsafe(INSERT_SQL, [
      row.id,
      row.agent_id,
      row.pipeline_item_id,
      row.role,
      row.provider,
      row.model,
      row.purpose,
      row.input_tokens,
      row.output_tokens,
      row.cost_usd,
      row.latency_ms,
      row.degraded,
      row.error,
    ]);
    return;
  }

  const rpc = getRpcClient();
  if (!rpc) return; // disabled — warned once above

  const { error } = await rpc.rpc("record_llm_run", { p_run: row });
  if (error) throw new Error(`record_llm_run RPC: ${error.message}`);
}

/** Test seam: reset memoized clients (e.g. after mutating process.env). */
export function _resetAccountingClientForTests(): void {
  pgSql = undefined;
  rpcClient = undefined;
  warnedDisabled = false;
}
