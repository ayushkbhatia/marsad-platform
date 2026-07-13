import type { Sql } from '../db.js';
import type { WorkerConfig } from '../config.js';
import type { IngestionRuntime } from './ingestion-runtime.js';

/**
 * Builds the concrete IngestionRuntime from the `marsad-ingestion` package.
 *
 * This is the ONE place in the worker that imports the ingestion package. It is
 * dynamically imported so that:
 *   - the handler modules (and their unit tests) never pull the ingestion build
 *     graph in — they depend only on the IngestionRuntime *interface*;
 *   - the worker fails loudly at boot (not at first message) if the package or
 *     its Storage/transport env is missing.
 *
 * The ingestion package exposes a single factory that assembles its registry,
 * transport clients (HttpClient/BrowserClient), SnapshotStore, ParseRunRecorder,
 * StagingEmitter, ADAPTERS map and CrossCheck against the worker's DB pool and
 * config, and returns an object satisfying IngestionRuntime (CONTRACT §1–§9).
 *
 * NOTE for the ingestion-package builder: export a named factory
 *   `createIngestionRuntime(deps: { sql, config }): IngestionRuntime`
 * from the package root (`marsad-ingestion`). If the export name differs, this
 * is the only worker file that changes.
 */
export async function createIngestionRuntime(deps: {
  sql: Sql;
  config: WorkerConfig;
}): Promise<IngestionRuntime> {
  // Dynamic import keeps the dependency out of the handlers' type graph and lets
  // the worker boot-check it explicitly. The cast routes through `unknown`: the
  // ingestion package's own IngestionRuntime/SourceRecord types are structurally
  // near-identical to the worker's narrow mirror (ingestion-runtime.ts), but the
  // mirror deliberately widens SourceRecord with an index signature and treats
  // http/browser/logger as opaque, so a direct structural cast is (correctly)
  // rejected. This boundary is the ONE sanctioned place to bridge the two views.
  const mod = (await import('marsad-ingestion')) as unknown as {
    createIngestionRuntime?: (d: {
      sql: Sql;
      supabaseUrl: string | undefined;
      supabaseServiceRoleKey: string | undefined;
      workerId: string;
    }) => IngestionRuntime;
  };

  if (typeof mod.createIngestionRuntime !== 'function') {
    throw new Error(
      "marsad-ingestion does not export createIngestionRuntime(); the worker's handler " +
        'wiring (worker/src/handlers/runtime-wiring.ts) expects that factory (CONTRACT §1).',
    );
  }

  return mod.createIngestionRuntime({
    sql: deps.sql,
    supabaseUrl: deps.config.supabaseUrl,
    supabaseServiceRoleKey: deps.config.supabaseServiceRoleKey,
    workerId: deps.config.workerId,
  });
}
