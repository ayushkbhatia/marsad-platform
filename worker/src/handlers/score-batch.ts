import type { Handler, HandlerContext } from './index.js';
import type { IngestionRuntime } from './ingestion-runtime.js';
import type { ScoreBatchPayload } from './payloads.js';
import { assertAgentsNotGloballyPaused, AgentPausedError } from './identity.js';

/**
 * score_batch (P1.7c, 07 §3.6) — q_maintenance.
 *
 * The Marsad Score: re-rank the eligible universe off the fresh nightly
 * key_ratios into public.scores / score_history / score_events (+ COMPUTED.SCORE
 * lake objects). Optional securityIds narrows the batch (an earnings-verdict
 * single-name recompute); omitted ⇒ full universe. All computation lives in the
 * ingestion runtime; the handler sets identity and invokes it.
 *
 * The score_batch pg_cron enqueues {"task":"score_batch"}; the consumer aliases
 * `task`→`handler`, so registering a handler named exactly 'score_batch'
 * activates the 04:00 GST cron with no migration.
 */
export function makeScoreBatch(runtime: IngestionRuntime): Handler {
  return async (payloadRaw, ctx: HandlerContext) => {
    const payload = payloadRaw as unknown as ScoreBatchPayload;
    const securityIds = Array.isArray(payload.securityIds) ? payload.securityIds : undefined;

    const log = ctx.log.child({
      handler: 'score_batch',
      scope: securityIds ? `${securityIds.length} securities` : 'full',
    });

    let result: { scored: number };
    try {
      // Global kill-switch check only — no transaction (see key_ratios_recompute /
      // handlers/identity.ts IDENTITY SEAM). runScoreBatch runs on the runtime's own
      // connection and sets its own identity. The freshness-gate abort + empty-universe
      // paths are handled inside the runtime service.
      await assertAgentsNotGloballyPaused(ctx.sql);
      result = await runtime.runScoreBatch(securityIds);
    } catch (err) {
      if (err instanceof AgentPausedError) {
        log.info('score_batch skipped: agents globally paused');
        return;
      }
      // Freshness-gate abort (07 §3.6): stale key_ratios ⇒ a deliberate skip, NOT a
      // fault. Surface loudly (an alert-worthy warn) but return cleanly rather than
      // crash-looping the daily cron message through 5 redeliveries into an incident.
      // Matched by name to avoid a cross-package import of StaleKeyRatiosError.
      if (err instanceof Error && err.name === 'StaleKeyRatiosError') {
        log.error('score_batch aborted: stale key_ratios — not scoring on stale ratios', {
          err: err.message,
        });
        return;
      }
      throw err;
    }

    log.info('score_batch done', { scored: result.scored });
  };
}
