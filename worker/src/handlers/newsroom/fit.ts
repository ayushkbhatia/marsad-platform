/**
 * pipeline_fit (PD.8, 09 §6) — THE REFUSAL SURFACE. Sits between `rules` and
 * `approval`: rules judges the PROSE (R-01..R-10), fit judges the COMPOSITION against
 * the stored design vocabulary, and refuses.
 *
 * This is the first code in the repo that READS `ops.story_blocks` / `ops.templates`
 * (DEF-REGISTRY-ZERO-READERS: both tables have existed since 2026-07-13 with zero
 * readers, while every value they hold was re-hard-coded three or four times in TS).
 * `max_words`, `always_premium` and the block vocabulary are read here, not declared.
 *
 * ── Three decisions worth stating up front ─────────────────────────────────────
 *
 * 1. LEGACY BLOCK KEYS ARE TWO DIFFERENT EVENTS.
 *    A piece that EMITS a legacy code (`BLK-TABLE`, `BLK-CHART`, …) is REFUSED: the
 *    agent reached outside the closed 61-block vocabulary, which is precisely what this
 *    stage exists to stop. But a TEMPLATE that merely NAMES a legacy key in
 *    `ops.templates.block_keys` is a WARNING, because:
 *      · seven of the eight TPL-0x rows name at least one legacy key — they are 2026-07-13
 *        seed data that PD.2 deliberately grandfathered rather than rewrote — so refusing
 *        would refuse every non-wire piece, and a stage that refuses everything gets
 *        switched off, which is strictly worse than one that refuses the right things;
 *      · the writer did not choose it and cannot fix it. The remedy is a data migration
 *        re-pointing `ops.templates.block_keys` at the active 61. A refusal that no one
 *        at the Desk can act on fails the "actionable" test; a warning naming the keys
 *        and the remedy passes it.
 *
 * 2. A REFUSAL GOES TO A HUMAN, NOT ROUND THE LOOP. The rules stage already gave the
 *    writer two attempts at the prose. A fit refusal means the piece is not composable
 *    as drafted — a vocabulary, binding or arithmetic failure — so it transitions to
 *    `reassigned_human` carrying the full report. It never degrades a block and never
 *    substitutes a fallback.
 *
 * 3. THE STAGE IS OFF UNTIL ITS MIGRATION IS APPLIED. `fit` is not yet a legal
 *    `ops.pipeline_items.stage` value (see `fit-stage.sql`, written but NOT applied).
 *    `switchOn()` returns false for a key that does not exist, so the switch
 *    `newsroom_fit_stage` is off by construction today and the rules stage keeps its
 *    current routing. Applying the migration seeds the switch and turns the stage on.
 */
import type { Handler, HandlerContext } from '../index.js';
import type { Sql } from '../../db.js';
import {
  runFit, resolvePieceType,
  type FitBlock, type FitCitation, type FitInput, type FitReport,
  type LayoutTemplate, type PipelineTemplate, type RegistryBlock,
} from './fit-engine.js';
import { pgmqSend } from '../enqueue.js';
import { Q_PIPELINE, loadItem, outputHalted, resolvePrincipal, switchOn, transition } from './shared.js';

interface FitMsg {
  pipeline_item_id?: number;
  /** The rules stage's auto-publish verdict, carried forward (fit owns the routing now). */
  auto_eligible?: boolean;
}

/** The switch the rules stage consults before routing into this stage. */
export const FIT_SWITCH = 'newsroom_fit_stage';

export function makeFitStage(): Handler {
  const handler: Handler = async (payload, ctx: HandlerContext) => {
    const msg = payload as FitMsg;
    const log = ctx.log.child({ handler: 'pipeline_fit', item: msg.pipeline_item_id });
    if (!msg.pipeline_item_id) { log.warn('fit: no id'); return; }
    const { sql } = ctx;

    const item = await loadItem(sql, msg.pipeline_item_id);
    if (!item) { log.warn('fit: item gone'); return; }
    if (item.stage !== 'fit') { log.info('fit: not at fit stage — no-op', { stage: item.stage }); return; }

    const editorId = await resolvePrincipal(sql, 'EDITOR-1');
    const input = await assembleFitInput(sql, item.content_id);
    const report = runFit(input);

    await persistReport(sql, item.id, input, report, log);

    if (!report.passed) {
      await transition(sql, item.id, 'reassigned_human', editorId, {
        reason: 'fit refused',
        refusals: report.refusals.map((r) => ({ code: r.code, block: r.block_code, seq: r.seq, rule: r.rule, evidence: r.evidence })).slice(0, 20),
      });
      log.warn('fit: REFUSED → human', { codes: report.refusals.map((r) => r.code) });
      return;
    }

    // Passed. Place the cut when the layout template requires one and none exists.
    // A content mutation, so it respects the output kill switches like every other one.
    if (report.cut.placement_after_seq !== null) {
      if (await outputHalted(sql)) {
        log.info('fit: output halted — cut placement skipped', { after_seq: report.cut.placement_after_seq });
      } else {
        await sql`update public.content_items set premium_cut_after_block = ${report.cut.placement_after_seq} where id = ${item.content_id}::uuid`;
        log.info('fit: premium cut placed', { after_seq: report.cut.placement_after_seq });
      }
    }

    const autoOn = await switchOn(sql, 'auto_publish_wires');
    if (msg.auto_eligible === true && autoOn) {
      await sql.begin(async (tx) => {
        await tx`select set_config('app.principal_id', ${editorId}, true)`;
        await tx`select set_config('app.principal_kind', 'agent', true)`;
        await tx`update public.content_items set status = 'live' where id = ${item.content_id}::uuid`;
      });
      await transition(sql, item.id, 'published', editorId, { auto: true, fit: 'passed', warnings: report.warnings.map((w) => w.code) });
      log.info('fit: passed → AUTO-PUBLISHED (wire)', { warnings: report.warnings.length });
      return;
    }

    await transition(sql, item.id, 'approval', editorId, {
      fit: 'passed',
      warnings: report.warnings.map((w) => ({ code: w.code, evidence: w.evidence })),
      unchecked: report.unchecked.length,
      auto_eligible: msg.auto_eligible === true, auto_switch: autoOn,
    });
    log.info('fit: passed → approval queue', { warnings: report.warnings.length, unchecked: report.unchecked.length, numerals: report.stats.numerals_checked });
  };
  return handler;
}

// ---------------------------------------------------------------------------
// Assembly — the registry + the drafted piece, read into the pure engine's shape
// ---------------------------------------------------------------------------

export async function assembleFitInput(sql: Sql, contentId: string): Promise<FitInput> {
  const ci = ((await sql`
    select ci.content_type, ci.template_key, ci.is_premium, ci.word_count, ci.premium_cut_after_block,
           (p.kind::text = 'agent') as agent_authored
      from public.content_items ci
      left join iam.principals p on p.id = ci.author_id
     where ci.id = ${contentId}::uuid
  `) as unknown as Array<{
    content_type: string; template_key: string | null; is_premium: boolean;
    word_count: number | null; premium_cut_after_block: number | null; agent_authored: boolean | null;
  }>)[0];
  if (!ci) throw new Error(`fit: content_item ${contentId} not found`);

  const blocks = ((await sql`
    select seq, block_kind, body, bound_object_id::text as bound_object_id, gated
      from public.content_blocks where content_id = ${contentId}::uuid order by seq
  `) as unknown as Array<{ seq: number; block_kind: string; body: unknown; bound_object_id: string | null; gated: boolean }>)
    .map<FitBlock>((b) => ({
      seq: b.seq,
      code: b.block_kind,
      payload: (b.body && typeof b.body === 'object' && !Array.isArray(b.body)) ? b.body as Record<string, unknown> : {},
      bound_object_id: b.bound_object_id,
      gated: b.gated,
    }));

  const citations = ((await sql`
    select c.claim_key, c.object_id::text as object_id, c.quoted_value,
           o.state as object_state, o.object_type, o.payload as object_payload
      from lake.citations c left join lake.objects o on o.id = c.object_id
     where c.content_id = ${contentId}::uuid
  `) as unknown as Array<{ claim_key: string | null; object_id: string; quoted_value: string | null; object_state: string | null; object_type: string | null; object_payload: Record<string, unknown> | null }>)
    .map<FitCitation>((c) => ({
      claim_key: c.claim_key ?? '',
      object_id: c.object_id,
      quoted_value: c.quoted_value,
      object_state: c.object_state,
      object_type: c.object_type,
      object_payload: c.object_payload,
    }));

  // The SAME allowlist R-03 reads. Loading it here rather than hard-coding VERIFIED is what
  // stops the fit stage being stricter than the surface the writer was given to cite from.
  const citableStatesByType = Object.fromEntries(
    ((await sql`select object_type, citable_states from ops.materiality_prefilter`) as unknown as Array<{ object_type: string; citable_states: string[] | null }>)
      .filter((r) => Array.isArray(r.citable_states) && r.citable_states.length > 0)
      .map((r) => [r.object_type, r.citable_states as string[]]),
  );

  // ---- the registry ----------------------------------------------------------
  // Legacy rows are loaded ALONGSIDE the active 61: resolving a legacy code is what
  // lets the refusal say "retired" instead of "unknown", which is a different fix.
  const registryRows = (await sql`
    select key, status, family, piece_types, requires_binding, binds_to, constraints, payload_schema
      from ops.story_blocks
  `) as unknown as Array<{
    key: string; status: string; family: string | null; piece_types: string[] | null;
    requires_binding: boolean; binds_to: string | null; constraints: unknown; payload_schema: Record<string, unknown> | null;
  }>;
  const registry: Record<string, RegistryBlock> = {};
  for (const r of registryRows) {
    registry[r.key.toUpperCase()] = {
      key: r.key,
      status: r.status,
      family: r.family,
      piece_types: r.piece_types,
      requires_binding: r.requires_binding,
      binds_to: r.binds_to,
      constraints: Array.isArray(r.constraints) ? r.constraints.map(String) : null,
      payload_schema: r.payload_schema,
    };
  }

  const pipelineTemplate = ci.template_key
    ? ((await sql`select key, block_keys, auto_publish_eligible, always_premium, max_words from ops.templates where key = ${ci.template_key}`) as unknown as PipelineTemplate[])[0] ?? null
    : null;

  const pieceType = resolvePieceType(ci.content_type, ci.template_key);
  const layoutTemplate = pieceType
    ? ((await sql`select id, piece_type, premium_cut, hard_rules from ops.article_templates where piece_type = ${pieceType} limit 1`) as unknown as LayoutTemplate[])[0] ?? null
    : null;

  return {
    content_id: contentId,
    content_type: ci.content_type,
    template_key: ci.template_key,
    is_premium: ci.is_premium,
    word_count: ci.word_count ?? 0,
    agent_authored: ci.agent_authored === true,
    premium_cut_after_block: ci.premium_cut_after_block,
    blocks, citations, registry, pipelineTemplate, layoutTemplate, citableStatesByType,
  };
}

/**
 * Persist the report. `ops.fit_reports` arrives with this stage's migration, so the
 * write is probed rather than assumed — the stage must be deployable before the
 * migration is applied. `ops.rule_violations` is deliberately NOT used: its `rule_key`
 * is FK'd to `ops.rules(ruleset_version, rule_key)`, so a FIT-* code cannot be written
 * there without seeding a parallel ruleset, which would confuse "the prose broke R-04"
 * with "the composition broke". The transition detail (→ `ops.agent_runs.stats`) carries
 * the evidence either way, so nothing is lost when the table is absent.
 */
async function persistReport(
  sql: Sql, itemId: number, input: FitInput, report: FitReport, log: HandlerContext['log'],
): Promise<void> {
  const has = (await sql`select to_regclass('ops.fit_reports') is not null as ok`) as unknown as Array<{ ok: boolean }>;
  if (has[0]?.ok !== true) {
    log.info('fit: ops.fit_reports absent (migration not applied) — report carried in the transition detail only', {});
    return;
  }
  await sql`
    insert into ops.fit_reports (pipeline_item_id, content_id, passed, refusals, warnings, unchecked, cut, stats)
    values (${itemId}, ${input.content_id}::uuid, ${report.passed},
            ${sql.json(report.refusals as never)}::jsonb, ${sql.json(report.warnings as never)}::jsonb,
            ${sql.json(report.unchecked as never)}::jsonb, ${sql.json(report.cut as never)}::jsonb,
            ${sql.json(report.stats as never)}::jsonb)`;
}

/** Enqueue the fit stage, carrying the rules stage's auto-publish verdict forward
 *  (fit owns the publish/approval routing once it is on, so the verdict must travel
 *  with the message — `ops.pipeline_items` has no column for it). */
export async function enqueueFit(sql: Sql, pipelineItemId: number, autoEligible: boolean): Promise<void> {
  await pgmqSend(sql, Q_PIPELINE, { handler: 'pipeline_fit', pipeline_item_id: pipelineItemId, auto_eligible: autoEligible });
}
