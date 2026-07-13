import type { Sql } from './db.js';
import type {
  TaskSpec,
  StoredSnapshot,
  ParseRunRecorder,
  ParseResult,
  Logger,
} from './types.js';

/**
 * Parse harness (§4 / §10) — runs a PURE parse() against a StoredSnapshot and
 * records ingest.parse_runs. Enforces the drift rule:
 *
 *   parse OK but ZERO rows on a CHANGED snapshot ⇒ PARSE_DRIFT
 *   (ingest.parse_runs.status = 'drift_zero_rows', no retry, Desk item).
 *
 * "Changed" here means the snapshot was actually stored (deduped snapshots
 * never reach the harness — the store returns deduped=true and no parse is
 * enqueued). So a stored snapshot with zero parsed rows is by definition drift.
 *
 * Replay (§10): identical entry point — SnapshotStore.load() a historical
 * snapshot, run it here with a bumped parserVersion, re-emit staging.
 */

export interface ParseHarnessResult<T> {
  parseRunId: number;
  status: 'ok' | 'error' | 'drift_zero_rows';
  rows: T[];
  parserVersion: number;
  error?: string;
}

export interface RunParseDeps {
  recorder: ParseRunRecorder;
  logger?: Logger;
}

export async function runParse<T>(
  task: TaskSpec<T>,
  snapshot: StoredSnapshot,
  deps: RunParseDeps,
): Promise<ParseHarnessResult<T>> {
  const { recorder, logger } = deps;

  let result: ParseResult<T>;
  try {
    result = task.parse(snapshot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const parseRunId = await recorder.record({
      snapshotId: snapshot.snapshotId,
      parserVersion: task.parserVersion,
      status: 'error',
      rowsEmitted: null,
      error: message.slice(0, 4000),
    });
    logger?.error('parse threw', { snapshotId: snapshot.snapshotId, err: message });
    return {
      parseRunId,
      status: 'error',
      rows: [],
      parserVersion: task.parserVersion,
      error: message,
    };
  }

  // Guard: parser must stamp the version it claims (§2 ParseResult contract).
  if (result.parserVersion !== task.parserVersion) {
    const message = `parserVersion mismatch: task=${task.parserVersion} result=${result.parserVersion}`;
    const parseRunId = await recorder.record({
      snapshotId: snapshot.snapshotId,
      parserVersion: task.parserVersion,
      status: 'error',
      rowsEmitted: null,
      error: message,
    });
    logger?.error('parse version mismatch', { snapshotId: snapshot.snapshotId, message });
    return {
      parseRunId,
      status: 'error',
      rows: [],
      parserVersion: task.parserVersion,
      error: message,
    };
  }

  // Drift: a stored (changed) snapshot that yields no rows is drift (§10).
  if (result.rows.length === 0) {
    const parseRunId = await recorder.record({
      snapshotId: snapshot.snapshotId,
      parserVersion: task.parserVersion,
      status: 'drift_zero_rows',
      rowsEmitted: 0,
      error: null,
    });
    logger?.warn('parse drift: zero rows on changed snapshot', {
      snapshotId: snapshot.snapshotId,
      dataType: snapshot.dataType,
    });
    return {
      parseRunId,
      status: 'drift_zero_rows',
      rows: [],
      parserVersion: task.parserVersion,
    };
  }

  const parseRunId = await recorder.record({
    snapshotId: snapshot.snapshotId,
    parserVersion: task.parserVersion,
    status: 'ok',
    rowsEmitted: result.rows.length,
    error: null,
  });
  logger?.info('parse ok', {
    snapshotId: snapshot.snapshotId,
    rows: result.rows.length,
  });
  return {
    parseRunId,
    status: 'ok',
    rows: result.rows,
    parserVersion: task.parserVersion,
  };
}

/**
 * lake.parse_runs recorder (0004) — the richer, agent-attributed run ledger,
 * distinct from ingest.parse_runs. Opens a run, links snapshots, then finishes.
 * Used by worker handlers that want lake lineage on top of the ingestion ledger.
 */
export interface LakeParseRun {
  parseRunId: number;
  finish(input: {
    status: 'succeeded' | 'failed' | 'partial';
    objectsCreated?: number;
    objectsUpdated?: number;
    error?: string | null;
  }): Promise<void>;
}

export async function openLakeParseRun(
  sql: Sql,
  input: {
    agentPrincipalId: string;
    parserKey: string;
    parserVersion: string;
    snapshotIds: number[];
  },
): Promise<LakeParseRun> {
  const rows = await sql<{ id: number }[]>`
    insert into lake.parse_runs (agent_id, parser_key, parser_version, status)
    values (${input.agentPrincipalId}, ${input.parserKey}, ${input.parserVersion}, 'running')
    returning id
  `;
  const parseRunId = rows[0]!.id;

  for (const snapshotId of input.snapshotIds) {
    await sql`
      insert into lake.parse_run_snapshots (parse_run_id, snapshot_id)
      values (${parseRunId}, ${snapshotId})
      on conflict (parse_run_id, snapshot_id) do nothing
    `;
  }

  return {
    parseRunId,
    async finish(fin): Promise<void> {
      await sql`
        update lake.parse_runs
           set status = ${fin.status},
               finished_at = now(),
               objects_created = ${fin.objectsCreated ?? 0},
               objects_updated = ${fin.objectsUpdated ?? 0},
               error = ${fin.error ?? null}
         where id = ${parseRunId}
      `;
    },
  };
}
