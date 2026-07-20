/**
 * pipeline_classify (P3.3, 03 §6) — q_pipeline, the conveyor's front door.
 *
 * A VERIFIED lake object arrives (enqueued by lake.fn_verified_enqueue). Triage:
 *   1. Deterministic pre-filter (ops.materiality_prefilter) — ~half of intake at $0.
 *   2. Ambiguous types → chatComplete('classifier') for a materiality verdict.
 * Every verdict (incl. not_material / watch) is logged to ops.classifier_verdicts.
 * MATERIAL ⇒ create a content_items stub + content_tickers + an ops.pipeline_items
 * row at stage 'draft', and enqueue pipeline_draft. Otherwise stop (logged).
 *
 * Runs as DATA-FILINGS (the newsroom's data-side triage owner — no DATA-NEWS in the seed).
 */
import type { Handler, HandlerContext } from '../index.js';
import { chatComplete } from 'marsad-ingestion';
import { resolvePrincipal, enqueueStage, parseJsonReply, switchOn } from './shared.js';

interface ClassifyMsg {
  lake_object_id?: string;
  object_type?: string;
  security_id?: number | null;
  venue?: string | null;
}

interface PrefilterRow { verdict: string; priority: string | null; template_hint: string | null }

const CLASSIFIER_SYSTEM = [
  'You are the materiality classifier for Marsad, a GCC-markets newsroom. You receive ONE',
  'verified market-data object (type + payload) and decide whether it is worth a news piece.',
  'Return ONLY JSON: {"material":bool,"event_type":"string","priority":"wire|story|watch",',
  '"suggested_template":"TPL-01|TPL-03|TPL-04|TPL-07|null","confidence":0..1,"reason":"one line"}.',
  'material=true only for genuinely newsworthy events (results, dividends, M&A, major contracts,',
  'ratings, IPO steps). Routine recomputes / identity backfills / price ticks are never material.',
  'If unsure, set confidence < 0.65 and priority "watch" — do not fabricate significance.',
].join('\n');

export function makeClassify(): Handler {
  const handler: Handler = async (payload, ctx: HandlerContext) => {
    const msg = payload as ClassifyMsg;
    const log = ctx.log.child({ handler: 'pipeline_classify', obj: msg.lake_object_id });
    if (!msg.lake_object_id || !msg.object_type) { log.warn('classify: bad envelope'); return; }
    const lakeObjectId: string = msg.lake_object_id;
    const objectType: string = msg.object_type;
    const securityId = msg.security_id ?? null;
    const { sql } = ctx;

    // Idempotency: skip if a verdict for this object already spawned a piece.
    const seen = (await sql`select 1 from ops.classifier_verdicts where lake_object_id = ${lakeObjectId} and pipeline_item_id is not null limit 1`) as unknown as unknown[];
    if (seen.length > 0) { log.info('classify: already produced a piece — skip'); return; }

    const pre = (await sql`select verdict, priority, template_hint from ops.materiality_prefilter where object_type = ${objectType}`) as unknown as PrefilterRow[];
    const dataAgent = await resolvePrincipal(sql, 'DATA-FILINGS');

    let verdict = pre[0]?.verdict ?? 'ambiguous';
    let priority = pre[0]?.priority ?? null;
    let template = pre[0]?.template_hint ?? null;
    let tier = 'prefilter';
    let confidence: number | null = null;
    let eventType: string | null = null;
    let reason = pre[0] ? 'deterministic prefilter' : 'no prefilter rule';
    let llmRunId: string | null = null;

    if (verdict === 'ambiguous') {
      // LLM tier: fetch the object payload, ask the classifier.
      const objRows = (await sql`select object_type, payload from lake.objects where id = ${lakeObjectId}`) as unknown as Array<{ object_type: string; payload: unknown }>;
      const obj = objRows[0];
      if (!obj) { log.warn('classify: object vanished'); return; }
      try {
        const res = await chatComplete('classifier',
          [{ role: 'user', content: `Object type: ${obj.object_type}\nPayload: ${JSON.stringify(obj.payload).slice(0, 4000)}` }],
          { system: CLASSIFIER_SYSTEM, json: true, maxTokens: 300, temperature: 0, runContext: { agentId: dataAgent, purpose: `classify:${objectType}` } });
        llmRunId = res.llmRunId;
        const v = parseJsonReply(res.text) as { material?: boolean; event_type?: string; priority?: string; suggested_template?: string; confidence?: number; reason?: string };
        confidence = typeof v.confidence === 'number' ? v.confidence : null;
        eventType = v.event_type ?? null;
        reason = (v.reason ?? '').slice(0, 400);
        // Low confidence → watch bucket, never dropped (§6.2, DEFAULTED #5).
        if (v.material && (confidence ?? 0) >= 0.65) { verdict = 'material'; priority = v.priority === 'wire' ? 'wire' : 'story'; template = normalizeTemplate(v.suggested_template); }
        else if (v.material) { verdict = 'material'; priority = 'watch'; }
        else { verdict = 'not_material'; priority = null; }
      } catch (err) {
        log.error('classify: LLM tier failed — parking as watch', { err: String(err).slice(0, 200) });
        verdict = 'ambiguous'; priority = 'watch';
      }
      tier = 'llm';
    }

    const isMaterial = verdict === 'material' && priority !== 'watch';

    // Create the piece (stub + ticker + pipeline item) atomically, then log the verdict with its id.
    let pipelineItemId: number | null = null;
    if (isMaterial) {
      pipelineItemId = await sql.begin(async (tx) => {
        const stub = (await tx`
          insert into public.content_items (content_type, headline, status, author_id, template_key)
          values (${priority === 'wire' ? 'WIRE' : 'ARTICLE'}, ${'(drafting)'}, 'draft', ${dataAgent}::uuid, ${template})
          returning id::text as id`) as unknown as Array<{ id: string }>;
        const contentId = stub[0]!.id;
        if (securityId) {
          await tx`insert into public.content_tickers (content_id, security_id, is_primary) values (${contentId}::uuid, ${securityId}::bigint, true) on conflict do nothing`;
        }
        const item = (await tx`
          insert into ops.pipeline_items (content_id, stage, trigger_object_id, priority, template_hint, writer_agent)
          values (${contentId}::uuid, 'draft', ${lakeObjectId}::uuid, ${priority}, ${template},
                  (select id from iam.principals where handle = ${writerForTemplate(template)}))
          returning id`) as unknown as Array<{ id: number }>;
        return item[0]!.id;
      }) as unknown as number;
    }

    await sql`insert into ops.classifier_verdicts
        (lake_object_id, object_type, security_id, tier, verdict, priority, event_type, suggested_template, confidence, reason, pipeline_item_id, llm_run_id)
      values (${lakeObjectId}::uuid, ${objectType}, ${securityId}, ${tier}, ${verdict}, ${priority}, ${eventType}, ${template}, ${confidence}, ${reason}, ${pipelineItemId}, ${llmRunId}::uuid)`;

    if (isMaterial && pipelineItemId) {
      await enqueueStage(sql, 'pipeline_draft', pipelineItemId);
      log.info('classify: material → piece created', { pipelineItemId, priority, template, tier });
    } else {
      log.info('classify: not drafted', { verdict, priority, tier, confidence });
    }
    void switchOn; // (reserved: a future gate could suppress classify under kill_all_output)
  };
  return handler;
}

function normalizeTemplate(t: string | undefined): string | null {
  if (!t || t === 'null') return null;
  return /^TPL-0[1-8]$/.test(t) ? t : null;
}

/** Template → owning writer agent (03 §2.1). Default WRITER-2 (corporate actions/wires). */
function writerForTemplate(template: string | null): string {
  switch (template) {
    case 'TPL-03': return 'WRITER-1'; // earnings/results
    case 'TPL-06': case 'TPL-08': return 'WRITER-3'; // explainers/deep dives/takes
    case 'TPL-07': return 'WRITER-3';
    default: return 'WRITER-2'; // TPL-01/04/05 corporate actions, dividends, IPOs
  }
}
