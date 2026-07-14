import type { Handler, HandlerContext } from './index.js';
import type { IngestionRuntime, RunTaskResult } from './ingestion-runtime.js';
import type { FilingsPollPayload } from './payloads.js';
import { resolveActiveAgent, runAsPrincipalId, AgentPausedError } from './identity.js';
import { logFetchFailure, logFetchSkipped } from './fetch-log.js';
import { enqueueFilingDetails } from './enqueue.js';
import { heartbeatRun, heartbeatOk, heartbeatError } from './job-heartbeat.js';

/**
 * filings_poll (CONTRACT §9) — q_ingest.
 *
 * Poll a venue's filings_list source. Filings attribute to DATA-FILINGS (not the
 * venue DATA agent — CONTRACT §2 agentAccount note). The runtime diffs the
 * parsed list against ingest.seen_items; every genuinely new external_id becomes
 * a priority-1 filing_detail job on ingest.job_queue (event-driven, CONTRACT §8).
 *
 * Only new ids enqueue detail fetches — a re-listed announcement is a no-op
 * (list-diff, 01 §"filings").
 *
 * Crash-safety is by IDEMPOTENCY, not a single cross-boundary transaction. The
 * frozen runTask interface (ingestion-runtime.ts) does NOT accept the handler's
 * tx — its snapshot/parse/staging writes run on the runtime's own connection and
 * commit independently of the handler tx below. So the seen_items + wake-up
 * enqueue in this handler's tx are NOT atomic with staging, and must be safe to
 * replay:
 *   - runTask staging is idempotent on (source_id, external_id, content_hash)
 *     (CONTRACT §6.5), so a redelivery after staging committed re-emits nothing.
 *   - seen_items insert is ON CONFLICT DO NOTHING (PK source_id, external_id),
 *     and only rows it actually inserts (RETURNING) count as new — a redelivery
 *     re-diffs the same list and stages no already-seen id.
 *   - the single filing_detail wake-up row is harmless if re-enqueued: it just
 *     re-triggers a drain of the (now possibly empty) pending seen_items.
 * The one residual window — runTask staged but the handler tx rolled back before
 * seen_items committed — is absorbed on redelivery: runTask re-runs (staging
 * idempotent), the ids are still "new" (seen_items empty), and they are staged
 * as pending + the wake-up re-enqueued. No double-emit, no lost diff.
 */
export function makeFilingsPoll(runtime: IngestionRuntime): Handler {
  return async (payloadRaw, ctx: HandlerContext) => {
    const payload = payloadRaw as unknown as FilingsPollPayload;
    const sourceId = payload.sourceId;
    if (typeof sourceId !== 'number') {
      throw new Error(`filings_poll: missing/invalid sourceId: ${JSON.stringify(payloadRaw)}`);
    }

    const log = ctx.log.child({ handler: 'filings_poll', sourceId });
    const startedAt = Date.now();

    let source;
    try {
      source = await runtime.loadSource(sourceId);
    } catch (err) {
      await logFetchFailure(ctx.sql, sourceId, err, Date.now() - startedAt);
      throw err;
    }

    // Per-venue heartbeat so a single venue's filings feed going silent is
    // detected even while the shared queue heartbeat stays green (CONTRACT §9).
    await heartbeatRun(ctx.sql, 'filings_poll', source.venue);

    if (!source.active) {
      log.warn('source inactive; skipping filings_poll', { venue: source.venue });
      await logFetchSkipped(ctx.sql, sourceId, 'source_inactive');
      await heartbeatOk(ctx.sql, 'filings_poll', source.venue);
      return;
    }

    // Filings always run as DATA-FILINGS regardless of venue.
    const agentAccount = runtime.agentAccountForSource(source);
    const tasks = runtime.tasksForSource(source);
    if (tasks.length === 0) {
      log.warn('no filings task for source', { dataType: source.dataType });
      await logFetchSkipped(ctx.sql, sourceId, 'no_task_for_data_type');
      await heartbeatOk(ctx.sql, 'filings_poll', source.venue);
      return;
    }

    const detailSourceId = await runtime.filingDetailSourceId(source.venue);

    let result: { results: RunTaskResult[]; detailsEnqueued: number };
    try {
      // Kill-switch check (no tx). runTask runs on the runtime's OWN connection, so it must not be
      // wrapped in a held handler tx — that idle-tx-across-runTask is the pool-deadlock pattern.
      const identity = await resolveActiveAgent(ctx.sql, agentAccount);
      const results: RunTaskResult[] = [];
      for (const task of tasks) {
        results.push(
          await runtime.runTask({ source, task, agentPrincipalId: identity.principalId }),
        );
      }

      // Collect newly-seen external ids and record them as pending seen_items + one filing_detail
      // wake-up in a NARROW tx (milliseconds; principal GUC set for the lake triggers). The tx wraps
      // ONLY the enqueue — NOT the multi-second runTask above — and is skipped when there are no new
      // ids. Not atomic with runTask's staging (separate connection); crash-safety is by idempotency
      // (seen_items ON CONFLICT; idempotent staging; harmless wake-up re-enqueue), not this tx.
      const newIds = dedupeStrings(results.flatMap((r) => r.newExternalIds));
      let detailsEnqueued = 0;
      if (newIds.length > 0) {
        detailsEnqueued = await runAsPrincipalId(ctx.sql, identity.principalId, async (tx) =>
          enqueueFilingDetails(tx, source.id, detailSourceId, newIds),
        );
      }
      result = { results, detailsEnqueued };
    } catch (err) {
      if (err instanceof AgentPausedError) {
        log.info('filings_poll skipped: agent paused', { agentAccount });
        await logFetchSkipped(ctx.sql, sourceId, 'agent_paused');
        await heartbeatOk(ctx.sql, 'filings_poll', source.venue);
        return;
      }
      await logFetchFailure(ctx.sql, sourceId, err, Date.now() - startedAt);
      await heartbeatError(ctx.sql, 'filings_poll', source.venue, err);
      throw err;
    }

    await heartbeatOk(ctx.sql, 'filings_poll', source.venue);

    const changed = result.results.some((r) => r.changed);
    const rowsEmitted = result.results.reduce((n, r) => n + r.rowsEmitted, 0);
    log.info('filings_poll done', {
      venue: source.venue,
      changed,
      rowsEmitted,
      filingDetailsEnqueued: result.detailsEnqueued,
      hasDetailSource: detailSourceId !== null,
    });
  };
}

function dedupeStrings(xs: string[]): string[] {
  return [...new Set(xs)];
}
