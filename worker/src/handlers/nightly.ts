import type { Handler, HandlerContext } from './index.js';
import type { IngestionRuntime } from './ingestion-runtime.js';
import { assertAgentsNotGloballyPaused, AgentPausedError } from './identity.js';

/**
 * nightly (P1.7, 07 §3.6, 02:00 GST) — q_maintenance.
 *
 * The nightly omnibus: run the full key_ratios recompute — the complete-table job
 * that must finish before the 04:00 score_batch, since a percentile is meaningless
 * until every name is ratio-complete. All computation lives in the ingestion
 * runtime; the handler sets identity and invokes it.
 *
 * The nightly_omnibus pg_cron enqueues {"task":"nightly"}; the consumer aliases
 * `task`→`handler`, so registering a handler named exactly 'nightly' activates the
 * 02:00 GST cron with no migration.
 */
export function makeNightly(runtime: IngestionRuntime): Handler {
  return async (_payloadRaw, ctx: HandlerContext) => {
    const log = ctx.log.child({ handler: 'nightly' });

    let result: { rowsWritten: number };
    try {
      // Global kill-switch check only — no transaction (IDENTITY SEAM). The full
      // key_ratios rebuild runs on the runtime's own connection.
      await assertAgentsNotGloballyPaused(ctx.sql);
      result = await runtime.recomputeKeyRatios();
    } catch (err) {
      if (err instanceof AgentPausedError) {
        log.info('nightly skipped: agents globally paused');
        return;
      }
      throw err;
    }

    log.info('nightly done', { keyRatiosRowsWritten: result.rowsWritten });
  };
}
