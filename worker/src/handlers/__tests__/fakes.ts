import type { Sql } from '../../db.js';
import type { HandlerContext } from '../index.js';
import type { WorkerConfig } from '../../config.js';
import type {
  IngestionRuntime,
  SourceRecord,
  RunTaskResult,
  TaskSpec,
  VenueCode,
  AgentAccount,
  CrossCheckResult,
} from '../ingestion-runtime.js';

/**
 * Test doubles for the handler unit tests. No DB, no network — the handlers are
 * pure orchestration over the IngestionRuntime interface and a `sql` seam.
 */

export interface RecordedQuery {
  strings: string[];
  values: unknown[];
  text: string;
}

/**
 * A fake postgres.js `sql`. Records every tagged-template query, resolves it
 * from a queue of scripted responses (default []), and supports .begin (runs the
 * callback with the same fake), .json and .array (identity-ish markers).
 */
export function makeFakeSql(): {
  sql: Sql;
  queries: RecordedQuery[];
  /** Push a canned result for the Nth matching query (matched by substring). */
  on(substr: string, rows: unknown[]): void;
} {
  const queries: RecordedQuery[] = [];
  const canned: Array<{ substr: string; rows: unknown[] }> = [];

  function resolveFor(text: string): unknown[] {
    const idx = canned.findIndex((c) => text.includes(c.substr));
    if (idx >= 0) {
      const [hit] = canned.splice(idx, 1);
      return hit!.rows;
    }
    return [];
  }

  const tag = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join('?');
    queries.push({ strings: [...strings], values, text });
    return Promise.resolve(resolveFor(text));
  };

  // Attach postgres.js-style helpers.
  const sqlAny = tag as unknown as Record<string, unknown>;
  sqlAny.json = (v: unknown) => ({ __json: v });
  sqlAny.array = (v: unknown) => ({ __array: v });
  sqlAny.begin = async (fn: (tx: unknown) => Promise<unknown>) => fn(tag);

  return {
    sql: tag as unknown as Sql,
    queries,
    on(substr: string, rows: unknown[]) {
      canned.push({ substr, rows });
    },
  };
}

export function makeSilentLogger(): HandlerContext['log'] {
  const self: HandlerContext['log'] = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => self,
  };
  return self;
}

export function makeCtx(sql: Sql): HandlerContext {
  return {
    sql,
    log: makeSilentLogger(),
    config: { workerId: 'test-worker' } as unknown as WorkerConfig,
    queue: 'q_ingest',
    msgId: '1',
    readCt: 0,
  };
}

export function makeSource(over: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: 101,
    venue: 'QE',
    dataType: 'quotes',
    entryUrl: 'https://example.test/board',
    transport: 'http',
    active: true,
    lastContentHash: null,
    ...over,
  };
}

export function makeRunResult(over: Partial<RunTaskResult> = {}): RunTaskResult {
  return {
    changed: true,
    snapshotId: 5001,
    rowsEmitted: 3,
    stagedKeys: [],
    newExternalIds: [],
    parserVersion: 1,
    ...over,
  };
}

const NOOP_TASK: TaskSpec = {
  dataType: 'quotes',
  parserVersion: 1,
  fetch: async () => [],
  parse: () => ({ rows: [], parserVersion: 1 }),
};

/**
 * A configurable fake IngestionRuntime. Every method has a sensible default and
 * a spy record; tests override the bits they exercise.
 */
export interface FakeRuntime extends IngestionRuntime {
  readonly calls: {
    runTask: Array<{ sourceId: number; tradeDate: string | undefined; agentPrincipalId: string }>;
    countStagingSources: Array<{ naturalKey: string; objectType: string }>;
    crossCheckResolve: Array<{ naturalKey: string; objectType: string }>;
    recomputeKeyRatios: Array<number[] | undefined>;
    runScoreBatch: Array<number[] | undefined>;
  };
}

export function makeFakeRuntime(over: Partial<IngestionRuntime> = {}): FakeRuntime {
  const calls: FakeRuntime['calls'] = {
    runTask: [],
    countStagingSources: [],
    crossCheckResolve: [],
    recomputeKeyRatios: [],
    runScoreBatch: [],
  };

  const base: IngestionRuntime = {
    loadSource: async (id) => makeSource({ id }),
    agentAccountForSource: (s) => (`DATA-${s.venue}` as AgentAccount),
    runTask: async (input) => {
      calls.runTask.push({ sourceId: input.source.id, tradeDate: input.tradeDate, agentPrincipalId: input.agentPrincipalId });
      return makeRunResult();
    },
    tasksForSource: () => [NOOP_TASK],
    eodSourcesForVenue: async (venue: VenueCode) => [makeSource({ venue, dataType: 'eod_bulletin' })],
    filingDetailSourceId: async () => 999,
    crossCheck: {
      resolve: async (input) => {
        calls.crossCheckResolve.push(input);
        return { objectId: 'obj-1', state: 'VERIFIED', revision: 1 } as CrossCheckResult;
      },
    },
    pipelinePrincipalId: async () => '00000000-0000-0000-0000-000000000001',
    recomputeKeyRatios: async (ids) => {
      calls.recomputeKeyRatios.push(ids);
      return { rowsWritten: ids ? ids.length : 42 };
    },
    runScoreBatch: async (ids) => {
      calls.runScoreBatch.push(ids);
      return { scored: ids ? ids.length : 42 };
    },
    countStagingSources: async (naturalKey, objectType) => {
      calls.countStagingSources.push({ naturalKey, objectType });
      return 1;
    },
  };

  return Object.assign(base, over, { calls }) as FakeRuntime;
}

/** Canned iam identity row for a runnable (not paused) agent. */
export function activeAgentRows(principalId = 'pid-agent-1') {
  return [{ principal_id: principalId, run_enabled: true, globally_paused: false }];
}
