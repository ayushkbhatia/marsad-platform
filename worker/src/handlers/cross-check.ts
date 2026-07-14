import type { Handler, HandlerContext } from './index.js';
import type { IngestionRuntime } from './ingestion-runtime.js';
import type { CrossCheckPayload } from './payloads.js';
import { assertAgentsNotGloballyPaused, AgentPausedError } from './identity.js';

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

    let result;
    try {
      // Global kill-switch check only — NO transaction. crossCheck.resolve() opens its OWN tx on
      // the runtime's pooled connection (lake/cross-check.ts) and resolves its own verifier, so the
      // handler's tx GUC never reached it — the wrapper just held a connection idle-in-transaction
      // while resolve() ran, and N concurrent copies (pipelineConcurrency) exhausted the pool and
      // deadlocked. assertAgentsNotGloballyPaused does the same global-pause check, no tx held.
      await assertAgentsNotGloballyPaused(ctx.sql);
      result = await runtime.crossCheck.resolve({ naturalKey, objectType });
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
