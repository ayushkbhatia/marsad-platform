/**
 * Token & cost accounting → ops.llm_runs (03 §1.7). WORKER-SIDE port of
 * src/lib/llm/accounting.ts — the newsroom pipeline runs inside marsad-worker,
 * which always has SUPABASE_DB_URL + the `postgres` driver, so this copy keeps
 * ONLY the direct-INSERT path and drops the Next/serverless `@supabase/supabase-js`
 * RPC fallback (that dep is not in the ingestion/worker package). Row lands as the
 * marsad_worker pg role (GRANT INSERT ON ops.llm_runs TO marsad_worker).
 *
 * Inserts never throw; a lost accounting row is a logged warning, not an outage.
 */

import type { LlmRunRow } from "./types.js";

/** Minimal structural type so `postgres` stays the only driver dependency. */
interface PostgresSqlLike {
  unsafe(query: string, parameters?: unknown[]): Promise<unknown>;
}

// undefined = not initialized yet; null = unavailable on this runtime.
let pgSql: PostgresSqlLike | null | undefined;
let warnedDisabled = false;

async function getPgSql(): Promise<PostgresSqlLike | null> {
  if (pgSql !== undefined) return pgSql;

  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    pgSql = null;
    if (!warnedDisabled) {
      warnedDisabled = true;
      console.warn(
        "[llm/accounting] SUPABASE_DB_URL missing — ops.llm_runs accounting disabled (no anonymous-spend row will be written)",
      );
    }
    return null;
  }

  try {
    const { createRequire } = await import("node:module");
    const requireModule = createRequire(import.meta.url);
    const postgres = requireModule("postgres") as (
      url: string,
      options: Record<string, unknown>,
    ) => PostgresSqlLike;
    pgSql = postgres(dbUrl, {
      max: 2,
      prepare: false,
      idle_timeout: 30,
      connect_timeout: 15,
      connection: { application_name: "marsad-llm-accounting" },
    });
  } catch (err) {
    pgSql = null;
    if (!warnedDisabled) {
      warnedDisabled = true;
      console.warn(
        `[llm/accounting] postgres driver unavailable — accounting disabled: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return pgSql;
}

const INSERT_SQL = `
  insert into ops.llm_runs
    (id, agent_id, pipeline_item_id, role, provider, model, purpose,
     input_tokens, output_tokens, cost_usd, latency_ms, degraded, error)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`;

/**
 * Insert one ops.llm_runs row. Never throws: every failure is logged and
 * swallowed — nothing in accounting may take down an LLM call.
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
  if (!sql) return; // disabled — warned once above
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
}

/** Test seam: reset the memoized client (e.g. after mutating process.env). */
export function _resetAccountingClientForTests(): void {
  pgSql = undefined;
  warnedDisabled = false;
}
