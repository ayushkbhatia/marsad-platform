/**
 * pipeline_compose (PD · 09 §5.5) — turn a drafted piece into designed blocks.
 *
 * Sits between EDIT and RULES:
 *   · after edit, because edit sets template_key, and the template fixes the legal vocabulary;
 *   · before rules, so R-01..R-10 judge the prose that actually ships rather than the draft's.
 *
 * NOT folded into edit.ts. That handler's whole auditability claim is that it never touches the
 * body or the citations — "the editor may never alter a number or a [cN] marker, and not
 * mutating them satisfies that byte-identically". Composition rewrites the body, so putting it
 * there would destroy the one property that makes the editor checkable.
 *
 * OFF by default: `newsroom_compose_stage` is false, and `edit → rules` survives alongside
 * `edit → compose`, so this can be switched on and off without a migration.
 */
import type { Handler, HandlerContext } from '../index.js';
import type { Logger } from '../../log.js';
import { BLOCK_PAYLOAD_SCHEMAS, chatComplete } from 'marsad-ingestion';
import {
  budgetState, enqueueStage, loadItem, outputHalted, parseJsonReply, resolvePrincipal, switchOn, transition,
} from './shared.js';
import {
  CHASSIS_KINDS, legalVocabulary, outlineSchema, spliceComposition, validateOutline,
  type FilledBlock, type OutlineEntry, type StoryBlockRow,
} from './compose-engine.js';

interface ComposeMsg { pipeline_item_id?: number }

const COMPOSE_SWITCH = 'newsroom_compose_stage';

const OUTLINE_SYSTEM = [
  'You are Marsad\'s composition agent. You receive a finished draft and the blocks you are',
  'allowed to use. Choose the sequence of blocks that presents this piece, in reading order.',
  'RULES: use ONLY the block codes offered — the list is the whole vocabulary for this piece.',
  'Where a block binds a figure, give the lake object id from CITABLE FACTS; NEVER invent one.',
  'Prefer fewer, better-chosen blocks: every block must earn its place by answering a question',
  'the prose raises. Do not restate the same figure in two blocks, and never use a block twice',
  'when its constraints say ONE PER PIECE.',
].join('\n');

const FILL_SYSTEM = [
  'You are Marsad\'s composition agent, filling ONE block. Return ONLY the JSON payload for it.',
  'Write the prose fields in British English, factual, no advice, no hype.',
  'NEVER write a number into a field that takes a binding — the binding resolves at render time,',
  'and a typed number is exactly the fabrication the binding contract exists to prevent.',
].join('\n');

export function makeComposeHandler(): Handler {
  const handler: Handler = async (payload, ctx) => {
    const msg = payload as ComposeMsg;
    const log = ctx.log.child({ handler: 'pipeline_compose', item: msg.pipeline_item_id });
    if (!msg.pipeline_item_id) { log.warn('compose: no id'); return; }
    const { sql } = ctx;

    if (await outputHalted(sql)) { log.info('compose: output halted — parking'); return; }
    if (!(await switchOn(sql, COMPOSE_SWITCH))) {
      log.info('compose: stage switch off — no-op');
      return;
    }

    const item = await loadItem(sql, msg.pipeline_item_id);
    if (!item) { log.warn('compose: item gone'); return; }
    if (item.stage !== 'compose') { log.info('compose: not at compose stage', { stage: item.stage }); return; }

    const composerId = await resolvePrincipal(sql, 'WRITER-1');
    const budget = await budgetState(sql);

    // ── The legal vocabulary for THIS piece ───────────────────────────────────
    const tpl = ((await sql`
      select t.block_keys, t.piece_type
        from ops.templates t
        join public.content_items ci on ci.template_key = t.key
       where ci.id = ${item.content_id}::uuid`) as unknown as Array<{ block_keys: string[]; piece_type: string | null }>)[0];
    if (!tpl) { log.warn('compose: no template for piece — leaving prose as drafted'); await handOff(sql, item, composerId, log); return; }

    const registry = (await sql`
      select key, status, family, piece_types, requires_binding, renderer_built, payload_schema, constraints
        from ops.story_blocks`) as unknown as StoryBlockRow[];

    const vocab = legalVocabulary(tpl.block_keys ?? [], registry, tpl.piece_type, true);
    if (vocab.codes.length === 0) {
      // Nothing drawable for this template. Not a failure of the piece — pass it through as
      // prose rather than refusing it, and say why.
      log.warn('compose: no legal drawable blocks for this template', { excluded: vocab.excluded });
      await handOff(sql, item, composerId, log, { skipped: 'no_legal_blocks', excluded: vocab.excluded });
      return;
    }

    // The citable set is the same one the writer was given: its own citations.
    const cites = (await sql`
      select claim_key, object_id::text as object_id, quoted_value
        from lake.citations where content_id = ${item.content_id}::uuid`) as unknown as Array<{ claim_key: string | null; object_id: string; quoted_value: string | null }>;
    const allowedIds = new Set(cites.map((c) => c.object_id));

    const blocks = (await sql`
      select seq, block_kind, body from public.content_blocks
       where content_id = ${item.content_id}::uuid order by seq`) as unknown as Array<{ seq: number; block_kind: string; body: { text?: string } | null }>;
    const ci = ((await sql`select headline, dek from public.content_items where id = ${item.content_id}::uuid`) as unknown as Array<{ headline: string; dek: string | null }>)[0]!;

    // Only the chassis blocks are prose. A re-compose (a send-back) may find design blocks from
    // the previous pass still on the draft; those are this stage's own output and are replaced,
    // never fed back in as if the writer had written them.
    const prose = blocks.filter((b) => CHASSIS_KINDS.has(b.block_kind));
    const anchors = prose.filter((b) => b.block_kind !== 'disclaimer');

    const draftText = [
      `HEADLINE: ${ci.headline}`,
      ci.dek ? `DEK: ${ci.dek}` : '',
      '',
      'THE PROSE (kept verbatim; `after_paragraph` refers to these numbers):',
      ...anchors.map((b, i) => `[P${i + 1}] (${b.block_kind}) ${b.body?.text ?? ''}`),
      '',
      'CITABLE FACTS (use these ids for bindings):',
      ...cites.map((c) => `${c.object_id}  ${c.claim_key ?? ''}  ${c.quoted_value ?? ''}`),
      '',
      `BLOCKS YOU MAY USE: ${vocab.codes.join(', ')}`,
    ].filter(Boolean).join('\n');

    // ── Pass 1 · outline ──────────────────────────────────────────────────────
    let outline: OutlineEntry[];
    try {
      const res = await chatComplete('writer', [{ role: 'user', content: draftText }], {
        system: OUTLINE_SYSTEM,
        json: outlineSchema(vocab.codes, anchors.length),
        maxTokens: 1200, temperature: 0.1, budgetDegraded: budget !== 'ok',
        runContext: { agentId: composerId, pipelineItemId: String(item.id), purpose: `compose:outline:${item.template_hint ?? 'TPL'}` },
      });
      const parsed = (res.parsed ?? parseJsonReply(res.text)) as { blocks?: OutlineEntry[] };
      outline = Array.isArray(parsed.blocks) ? parsed.blocks : [];
    } catch (err) {
      log.error('compose: outline call failed — passing the piece through as prose', { err: String(err).slice(0, 200) });
      await handOff(sql, item, composerId, log, { skipped: 'outline_failed' });
      return;
    }

    const rejections = validateOutline(outline, vocab.codes, allowedIds, registry, anchors.length);
    if (rejections.length > 0) {
      // Caught BEFORE any fill call: pass 2 costs one model call per block, so a bad outline
      // should be free to reject.
      log.warn('compose: outline rejected — passing through as prose', { rejections });
      await handOff(sql, item, composerId, log, { skipped: 'outline_rejected', rejections });
      return;
    }

    // ── Pass 2 · fill, one constrained call per block ─────────────────────────
    const filled: FilledBlock[] = [];
    for (const entry of outline) {
      const row = registry.find((r) => r.key === entry.block_code);
      if (!row?.payload_schema) continue;
      try {
        const res = await chatComplete('writer', [{
          role: 'user',
          content: [
            `BLOCK: ${entry.block_code}`,
            `INTENT: ${entry.one_line_intent}`,
            entry.binding_object_id ? `BINDING OBJECT: ${entry.binding_object_id}` : '',
            '', 'THE PIECE:', draftText,
          ].filter(Boolean).join('\n'),
        }], {
          system: FILL_SYSTEM,
          json: row.payload_schema,
          maxTokens: 900, temperature: 0.2, budgetDegraded: budget !== 'ok',
          runContext: { agentId: composerId, pipelineItemId: String(item.id), purpose: `compose:fill:${entry.block_code}` },
        });
        const payload = res.parsed ?? parseJsonReply(res.text);

        // Zod is the ENFORCER; the DB payload_schema is a PROJECTION of it that goes to the
        // provider. The round trip through JSON Schema loses the cross-field refinements, so
        // the local parse is what actually decides.
        const schema = (BLOCK_PAYLOAD_SCHEMAS as Record<string, { safeParse(v: unknown): { success: boolean } }>)[entry.block_code];
        if (schema && !schema.safeParse(payload).success) {
          log.warn('compose: block payload failed its Zod schema — dropping the block', { code: entry.block_code });
          continue;
        }
        filled.push({
          code: entry.block_code, payload, boundObjectId: entry.binding_object_id,
          afterParagraph: entry.after_paragraph,
        });
      } catch (err) {
        log.warn('compose: fill failed for a block — dropping it', { code: entry.block_code, err: String(err).slice(0, 160) });
      }
    }

    if (filled.length === 0) {
      log.warn('compose: no block survived fill — passing through as prose');
      await handOff(sql, item, composerId, log, { skipped: 'no_block_survived_fill' });
      return;
    }

    // ── Persist ───────────────────────────────────────────────────────────────
    await sql.begin(async (tx) => {
      const composed = spliceComposition(
        prose.map((b) => ({ kind: b.block_kind, body: b.body })),
        filled,
      );
      await tx`delete from public.content_blocks where content_id = ${item.content_id}::uuid`;
      let seq = 1;
      for (const b of composed) {
        await tx`
          insert into public.content_blocks (content_id, seq, block_kind, body, bound_object_id, gated)
          values (${item.content_id}::uuid, ${seq}, ${b.blockKind}, ${sql.json(b.body as never)}::jsonb,
                  ${b.kind === 'design' ? b.boundObjectId : null}::uuid, false)`;
        seq += 1;
      }
      // Every binding must ALSO be a citation, or the fit stage refuses FIT-BIND-UNCITED. The
      // writer's citations already cover these ids (the outline could only bind what it cited),
      // so this is a guard rather than a rewrite.
      for (const b of filled) {
        if (!b.boundObjectId) continue;
        await tx`
          insert into lake.citations (content_id, object_id, block_key, claim_text, cited_by)
          select ${item.content_id}::uuid, ${b.boundObjectId}::uuid, ${b.code},
                 'bound by ' || ${b.code}, ${composerId}::uuid
          on conflict do nothing`;
      }
    });

    log.info('compose: composed', {
      exhibits: filled.length, prose: prose.length, codes: filled.map((f) => f.code),
    });
    await transition(sql, item.id, 'rules', composerId, { composed: filled.length, codes: filled.map((f) => f.code) });
    await enqueueStage(sql, 'pipeline_rules', item.id);
  };
  return handler;
}

/**
 * Pass the piece to rules with its prose intact.
 *
 * Composition is an ENHANCEMENT, not a gate: a piece that cannot be composed is still a
 * publishable piece, and refusing it here would make a presentation problem look like an
 * editorial one. The reason is recorded on the transition so the skip is never silent.
 */
async function handOff(
  sql: HandlerContext['sql'],
  item: { id: number; content_id: string },
  actorId: string,
  log: Logger,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await transition(sql, item.id, 'rules', actorId, { composed: 0, ...detail });
  await enqueueStage(sql, 'pipeline_rules', item.id);
  log.info('compose: handed to rules uncomposed', detail);
}
