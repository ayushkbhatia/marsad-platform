/**
 * pipeline_rules (P3.3, 03 §8) — the guardrail stage. Assembles the RuleContext from
 * the drafted content + citations (+ the cited objects' live state/payload + lineage),
 * runs the P3.2 engine (runRules), persists ops.rule_violations, stamps
 * content_items.rules_passed_version, and routes:
 *   - passed + auto-publish eligible + auto_publish_wires ON → published (the human-free path)
 *   - passed otherwise → approval (a human decides)
 *   - blocked → back to draft with the failures (rules-fail loop, cap 2 → reassigned_human, §8.2)
 */
import type { Handler, HandlerContext } from '../index.js';
import { runRules, type RuleContext, type CitationRow, type BlockRow } from 'marsad-ingestion';
import { FIT_SWITCH, enqueueFit } from './fit.js';
import { enqueueStage, loadItem, resolvePrincipal, switchOn, transition } from './shared.js';

interface RulesMsg { pipeline_item_id?: number }
const MAX_RULES_LOOPS = 2;

export function makeRulesStage(): Handler {
  const handler: Handler = async (payload, ctx: HandlerContext) => {
    const msg = payload as RulesMsg;
    const log = ctx.log.child({ handler: 'pipeline_rules', item: msg.pipeline_item_id });
    if (!msg.pipeline_item_id) { log.warn('rules: no id'); return; }
    const { sql } = ctx;

    const item = await loadItem(sql, msg.pipeline_item_id);
    if (!item) { log.warn('rules: item gone'); return; }
    if (item.stage !== 'rules') { log.info('rules: not at rules stage — no-op', { stage: item.stage }); return; }

    const editorId = await resolvePrincipal(sql, 'EDITOR-1');
    const rulesetVersion = ((await sql`select version_no from ops.rulesets where is_live limit 1`) as unknown as Array<{ version_no: number }>)[0]?.version_no ?? 9;
    const banned = ((await sql`select phrase from ops.banned_phrases where lang = 'en'`) as unknown as Array<{ phrase: string }>).map((r) => r.phrase);

    // R-03's provenance floor, as DATA. The same table lake.fn_intake_eligible_state reads for
    // intake, so the rule that judges a citation and the gate that admits an object cannot drift
    // apart again — which is exactly what happened when 20260727150000 widened intake to PENDING
    // and rules.ts kept demanding VERIFIED.
    const citableStatesByType = Object.fromEntries(
      ((await sql`select object_type, citable_states from ops.materiality_prefilter`) as unknown as Array<{ object_type: string; citable_states: string[] | null }>)
        .filter((r) => Array.isArray(r.citable_states) && r.citable_states.length > 0)
        .map((r) => [r.object_type, r.citable_states as string[]]),
    );

    const rc = await assembleContext(sql, item.content_id);

    const engine = await runRules(rc, {
      rulesetVersion, bannedPhrases: banned, headlineMaxChars: 90, autoWordCap: 40,
      citableStatesByType,
    });

    // Persist rule outcomes (skip pure passes to keep the table signal-dense).
    await sql.begin(async (tx) => {
      for (const r of engine.results) {
        if (r.outcome === 'passed') continue;
        const outcome = r.outcome === 'auto_fixed' ? 'auto_fixed' : r.outcome === 'passed_after_fix' ? 'passed_after_fix' : r.outcome === 'warned' ? 'warned' : 'blocked';
        await tx`insert into ops.rule_violations (content_id, ruleset_version, rule_key, outcome, detail, actor_id)
          values (${item.content_id}::uuid, ${rulesetVersion}, ${r.rule_key}, ${outcome}, ${sql.json(r.detail as never)}::jsonb, ${editorId}::uuid)`;
      }
      await tx`update ops.pipeline_items set rules_passed_version = ${engine.passed ? rulesetVersion : null} where id = ${item.id}`;
      if (engine.finalHeadline !== rc.headline) {
        await tx`update public.content_items set headline = ${engine.finalHeadline} where id = ${item.content_id}::uuid`;
      }
    });

    if (!engine.passed) {
      const loops = item.rules_fail_loops + 1;
      const blocked = engine.results.filter((r) => r.outcome === 'blocked').map((r) => r.rule_key);
      if (loops > MAX_RULES_LOOPS) {
        await transition(sql, item.id, 'reassigned_human', editorId, { reason: 'rules loop exhausted', blocked });
        log.warn('rules: loop exhausted → human', { blocked });
        return;
      }
      await sql`update ops.pipeline_items set rules_fail_loops = ${loops} where id = ${item.id}`;
      await transition(sql, item.id, 'draft', editorId, { rules_failed: blocked, loop: loops });
      await enqueueStage(sql, 'pipeline_draft', item.id);
      log.info('rules: blocked → back to draft', { blocked, loop: loops });
      return;
    }

    // PD.8: when the fit stage is on, rules hands off to it and fit owns the routing
    // (approval vs auto-publish) — the composition has to be judged before anything is
    // published, including on the human-free wire path. `switchOn` is false for a key
    // that does not exist, so this is inert until `fit-stage.sql` is applied.
    if (await switchOn(sql, FIT_SWITCH)) {
      await transition(sql, item.id, 'fit', editorId, { auto_eligible: engine.autoPublishEligible });
      await enqueueFit(sql, item.id, engine.autoPublishEligible);
      log.info('rules: passed → fit', { autoEligible: engine.autoPublishEligible });
      return;
    }

    const autoOn = await switchOn(sql, 'auto_publish_wires');
    if (engine.autoPublishEligible && autoOn) {
      // The DB publish gate (fn_enforce_agent_publish_gate) is the final authority; set status live
      // as EDITOR (PUBLISHING class) inside an identity tx so the gate passes.
      await sql.begin(async (tx) => {
        await tx`select set_config('app.principal_id', ${editorId}, true)`;
        await tx`select set_config('app.principal_kind', 'agent', true)`;
        await tx`update public.content_items set status = 'live' where id = ${item.content_id}::uuid`;
      });
      await transition(sql, item.id, 'published', editorId, { auto: true });
      log.info('rules: passed → AUTO-PUBLISHED (wire)', {});
    } else {
      await transition(sql, item.id, 'approval', editorId, { auto_eligible: engine.autoPublishEligible, auto_switch: autoOn });
      log.info('rules: passed → approval queue', { autoEligible: engine.autoPublishEligible, autoSwitch: autoOn });
    }
  };
  return handler;
}

/**
 * Every field of a block payload that carries PROSE a rule must judge.
 *
 * WHY THIS IS NOT `body.text`: today the writer emits only `{kind:'text', body:{text}}`, so
 * `body?.text ?? ''` is correct and looks harmless. The moment a compose stage writes a
 * structured BLK-* payload — `{headline, caption, note, …}` with no `text` key — every block
 * reads as the empty string, R-03 finds no numbers to demand citations for, R-04 finds no
 * magnitudes to compare, and the whole piece PASSES SILENTLY. A rules engine that returns
 * "clean" because it was handed nothing is the worst failure this pipeline can have, so the
 * extraction is widened before the producer exists rather than after.
 *
 * Mirrors PROSE_FIELDS in fit-engine.ts; keep the two in step.
 */
const PROSE_FIELDS = ['text', 'body', 'prose', 'caption', 'note', 'standfirst'] as const;

function proseOf(body: Record<string, unknown> | null): string {
  if (!body) return '';
  const parts: string[] = [];
  for (const f of PROSE_FIELDS) {
    const v = body[f];
    if (typeof v === 'string' && v.trim()) parts.push(v);
  }
  return parts.join(' ');
}

/** Read the drafted piece into the pure-engine RuleContext. */
async function assembleContext(sql: HandlerContext['sql'], contentId: string): Promise<RuleContext> {
  const ci = ((await sql`select content_type, template_key, headline, dek, word_count, is_premium from public.content_items where id = ${contentId}::uuid`) as unknown as Array<{ content_type: string; template_key: string | null; headline: string; dek: string | null; word_count: number | null; is_premium: boolean }>)[0]!;

  const blocks = ((await sql`select seq, block_kind, body, bound_object_id::text as bound_object_id, gated from public.content_blocks where content_id = ${contentId}::uuid order by seq`) as unknown as Array<{ seq: number; block_kind: string; body: Record<string, unknown> | null; bound_object_id: string | null; gated: boolean }>)
    .map<BlockRow>((b) => ({ seq: b.seq, block_kind: b.block_kind, body: proseOf(b.body), bound_object_id: b.bound_object_id, gated: b.gated }));

  // Citations joined to the cited object's live state/payload + a lineage-root proxy
  // (distinct parse_runs across the piece — the snapshot-root machinery is not fully wired,
  // so this is the documented pragmatic proxy; it only gates auto-publish, which is OFF).
  // R-03's provenance floor needs more than the state: the object's TYPE (to look up its
  // citable-state allowlist), whether it has been superseded, and whether its parse-run
  // lineage actually succeeded. The lineage join is the load-bearing one — it is what makes
  // "traceable to a primary document" a checked fact rather than an assertion, and it is
  // re-checked here rather than trusted from intake because a run can be marked failed (or
  // reaped, see ops.reap_stuck_parse_runs) after the object was admitted.
  const cites = (await sql`
    select c.claim_key, c.object_id::text as object_id, c.quoted_value, c.cited_by,
           o.state as object_state, o.object_type, o.payload as object_payload, o.parse_run_id,
           (o.superseded_by is not null) as superseded,
           (pr.status = 'succeeded')     as parse_run_ok
    from lake.citations c
    join lake.objects o on o.id = c.object_id
    left join lake.parse_runs pr on pr.id = o.parse_run_id
    where c.content_id = ${contentId}::uuid`) as unknown as Array<{ claim_key: string | null; object_id: string; quoted_value: string | null; object_state: string | null; object_type: string | null; object_payload: Record<string, unknown> | null; parse_run_id: number | null; superseded: boolean; parse_run_ok: boolean | null }>;
  const distinctRoots = new Set(cites.map((c) => c.parse_run_id).filter((x) => x != null)).size;
  const citations: CitationRow[] = cites.map((c) => ({
    claim_key: c.claim_key ?? '', lake_object_id: c.object_id, cited_value: c.quoted_value,
    cited_hash: null, object_state: c.object_state, object_type: c.object_type,
    object_payload: c.object_payload,
    superseded: c.superseded,
    // A null parse_run_id (no lineage row at all) reads as unproven, not as absent-so-fine.
    parse_run_ok: c.parse_run_ok === true,
  }));

  const tickers = ((await sql`select ct.security_id, s.ticker, (s.status = 'listed') as resolved from public.content_tickers ct join public.securities s on s.id = ct.security_id where ct.content_id = ${contentId}::uuid`) as unknown as Array<{ security_id: number; ticker: string; resolved: boolean }>)
    .map((t) => ({ security_id: t.security_id, ticker: t.ticker, resolved_listed: t.resolved }));

  const disclaimer = ((await sql`select 1 from public.content_blocks where content_id = ${contentId}::uuid and block_kind = 'disclaimer' limit 1`) as unknown as unknown[]).length > 0;
  const openCorrection = ((await sql`select 1 from ops.correction_flags cf where cf.content_id = ${contentId}::uuid and cf.resolved_at is null limit 1`) as unknown as unknown[]).length > 0;

  return {
    content_id: contentId, content_type: ci.content_type, template_key: ci.template_key,
    headline: ci.headline, dek: ci.dek, word_count: ci.word_count ?? 0, is_premium: ci.is_premium,
    blocks, citations, tickers, has_disclaimer_block: disclaimer, open_correction: openCorrection,
    distinct_lineage_roots: distinctRoots,
  };
}
