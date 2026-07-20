/**
 * pipeline_edit (P3.3, 03 §7.2/§7.3) — the editor stage. Runs as EDITOR-1.
 *
 * Tightens the HEADLINE via chatComplete('editor') (constrained to the existing facts),
 * then runs deterministic template auto-select (§7.3) and sets content_items.template_key
 * + is_premium. The body blocks and citations are LEFT UNTOUCHED — the editor may never
 * alter a number or a [cN] marker (§7.2), and not mutating them satisfies that byte-identically.
 * Then transition edit→rules and enqueue pipeline_rules.
 */
import type { Handler, HandlerContext } from '../index.js';
import { chatComplete } from 'marsad-ingestion';
import { enqueueStage, loadItem, outputHalted, resolvePrincipal, transition } from './shared.js';

interface EditMsg { pipeline_item_id?: number }

const EDITOR_SYSTEM = [
  'You are a Marsad markets editor. Tighten the given headline: <=90 characters, factual, no clickbait,',
  'no new facts or numbers beyond what it already states. Reply with ONLY the rewritten headline text,',
  'no quotes, no prose.',
].join('\n');

export function makeEdit(): Handler {
  const handler: Handler = async (payload, ctx: HandlerContext) => {
    const msg = payload as EditMsg;
    const log = ctx.log.child({ handler: 'pipeline_edit', item: msg.pipeline_item_id });
    if (!msg.pipeline_item_id) { log.warn('edit: no id'); return; }
    const { sql } = ctx;
    if (await outputHalted(sql)) { log.info('edit: output halted — leaving in place'); return; }

    const item = await loadItem(sql, msg.pipeline_item_id);
    if (!item) { log.warn('edit: item gone'); return; }
    if (item.stage !== 'edit') { log.info('edit: not at edit stage — no-op', { stage: item.stage }); return; }

    const editorId = await resolvePrincipal(sql, 'EDITOR-1');
    const ci = (await sql`select headline, word_count from public.content_items where id = ${item.content_id}::uuid`) as unknown as Array<{ headline: string; word_count: number | null }>;
    const cur = ci[0];
    if (!cur) { log.warn('edit: content gone'); return; }

    // Citations present → the auto-select signal set.
    const cites = (await sql`select o.object_type from lake.citations c join lake.objects o on o.id = c.object_id where c.content_id = ${item.content_id}::uuid`) as unknown as Array<{ object_type: string }>;
    const citeTypes = new Set(cites.map((c) => c.object_type));
    const template = autoSelectTemplate(citeTypes, cur.word_count ?? 0, item.template_hint);
    const isPremium = template === 'TPL-08';

    // Tighten the headline (editor pass). Failure is non-fatal — keep the writer's headline.
    let headline = cur.headline;
    try {
      const res = await chatComplete('editor', [{ role: 'user', content: `Headline: ${cur.headline}` }],
        { system: EDITOR_SYSTEM, maxTokens: 60, temperature: 0.2, runContext: { agentId: editorId, pipelineItemId: String(item.id), purpose: `edit:${template}` } });
      const h = res.text.trim().replace(/^["']|["']$/g, '').slice(0, 90);
      if (h.length >= 8) headline = h;
    } catch (err) { log.warn('edit: headline tighten failed — keeping original', { err: String(err).slice(0, 120) }); }

    await sql.begin(async (tx) => {
      await tx`select set_config('app.principal_id', ${editorId}, true)`;
      await tx`select set_config('app.principal_kind', 'agent', true)`;
      await tx`update public.content_items set headline = ${headline}, template_key = ${template}, is_premium = ${isPremium}, updated_at = now() where id = ${item.content_id}::uuid`;
      await tx`update ops.pipeline_items set editor_agent = ${editorId}::uuid, template_hint = ${template} where id = ${item.id}`;
    });

    await transition(sql, item.id, 'rules', editorId, { template });
    await enqueueStage(sql, 'pipeline_rules', item.id);
    log.info('edit: tightened → rules', { template, headline });
  };
  return handler;
}

/** Deterministic template auto-select (03 §7.3), evaluated in order. */
function autoSelectTemplate(citeTypes: Set<string>, wordCount: number, hint: string | null): string {
  if (citeTypes.has('EARNINGS.VERDICT')) return 'TPL-08';
  if (citeTypes.has('IPO.OFFER')) return 'TPL-07';
  if (citeTypes.has('DIVIDEND.EXDATE')) return 'TPL-04';
  if (citeTypes.has('FILING.FINANCIALS') && wordCount > 500) return 'TPL-03';
  if (wordCount < 90) return 'TPL-01';
  return hint ?? 'TPL-03';
}
