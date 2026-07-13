import type { Handler, HandlerContext } from './index.js';
import type { IngestionRuntime } from './ingestion-runtime.js';
import type { KeyRatiosPayload } from './payloads.js';
import { runAsPrincipalId, AgentPausedError } from './identity.js';

/**
 * key_ratios_recompute (CONTRACT §9) — q_pipeline.
 *
 * Nightly rebuild of public.key_ratios off VERIFIED lake objects. Optional
 * securityIds narrows the rebuild to specific securities (e.g. after a late
 * filing verification); omitted ⇒ full rebuild. All computation lives in the
 * ingestion runtime; the handler sets identity and invokes it.
 */
export function makeKeyRatiosRecompute(runtime: IngestionRuntime): Handler {
  return async (payloadRaw, ctx: HandlerContext) => {
    const payload = payloadRaw as unknown as KeyRatiosPayload;
    const securityIds = Array.isArray(payload.securityIds) ? payload.securityIds : undefined;

    const log = ctx.log.child({
      handler: 'key_ratios_recompute',
      scope: securityIds ? `${securityIds.length} securities` : 'full',
    });

    const principalId = await runtime.pipelinePrincipalId();

    let result: { rowsWritten: number };
    try {
      result = await runAsPrincipalId(ctx.sql, principalId, async () => {
        return runtime.recomputeKeyRatios(securityIds);
      });
    } catch (err) {
      if (err instanceof AgentPausedError) {
        log.info('key_ratios_recompute skipped: agents globally paused');
        return;
      }
      throw err;
    }

    log.info('key_ratios_recompute done', { rowsWritten: result.rowsWritten });
  };
}
