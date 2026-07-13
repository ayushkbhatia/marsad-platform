import type { Handler, HandlerContext } from './index.js';
import type { IngestionRuntime } from './ingestion-runtime.js';
import type { CrossCheckPayload } from './payloads.js';
import { runAsPrincipalId, AgentPausedError } from './identity.js';

/**
 * cross_check (CONTRACT §7, §9) — q_pipeline.
 *
 * For one (naturalKey, objectType), run the lake CrossCheck service: gather
 * candidate staging rows, apply the 2-source rule, and transition/insert the
 * lake.objects row (VERIFIED / CONFLICT / PENDING) via the supersede-then-insert
 * pattern. The heavy DDL-aware logic lives in ingestion/src/lake/cross-check.ts;
 * the handler only sets the pipeline principal identity and invokes resolve().
 *
 * VERIFIED numeric objects fan out to public.datapoints automatically via the
 * lake trigger — the handler must NOT write datapoints itself (CONTRACT §7).
 */
export function makeCrossCheck(runtime: IngestionRuntime): Handler {
  return async (payloadRaw, ctx: HandlerContext) => {
    const payload = payloadRaw as unknown as CrossCheckPayload;
    const { naturalKey, objectType } = payload;
    if (!naturalKey || !objectType) {
      throw new Error(`cross_check: missing naturalKey/objectType: ${JSON.stringify(payloadRaw)}`);
    }

    const log = ctx.log.child({ handler: 'cross_check', naturalKey, objectType });
    const principalId = await runtime.pipelinePrincipalId();

    let result;
    try {
      result = await runAsPrincipalId(ctx.sql, principalId, async () => {
        return runtime.crossCheck.resolve({ naturalKey, objectType });
      });
    } catch (err) {
      if (err instanceof AgentPausedError) {
        log.info('cross_check skipped: agents globally paused');
        return;
      }
      throw err;
    }

    log.info('cross_check resolved', {
      objectId: result.objectId,
      state: result.state,
      revision: result.revision,
    });
  };
}
