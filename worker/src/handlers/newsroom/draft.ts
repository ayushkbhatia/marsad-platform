/**
 * pipeline_draft (P3.3, 03 §7.1) — the writer stage. Runs as the byline WRITER agent.
 *
 * Loads the pipeline item + its trigger object + the fn_writer_context pack for the
 * primary ticker, asks chatComplete('writer') for a draft, and MATERIALIZES it:
 * content_items headline/dek/word_count, one content_block per body block, and one
 * lake.citations row per [cN] marker (claim_key + object_id + frozen quoted_value).
 * A citation to an object the writer was NOT given fails the draft (no invented
 * sources, §7.1). Then transition draft→edit and enqueue pipeline_edit.
 */
import type { Handler, HandlerContext } from '../index.js';
import { autoMarkNumbers, chatComplete, parseMagnitude } from 'marsad-ingestion';
import { budgetState, enqueueStage, loadItem, outputHalted, parseJsonReply, resolvePrincipal, transition, wordCount } from './shared.js';

interface DraftMsg { pipeline_item_id?: number }

const WRITER_SYSTEM = [
  'You are a Marsad markets writer covering GCC exchanges. You get a TRIGGER object (the event) and a',
  'CONTEXT pack (the company: identity, price, ratios, score, statements, recent filings) — every fact',
  'carries an id. Write a tight, factual news piece. Return ONLY JSON:',
  '{"headline":"<=90 chars, no clickbait","dek":"one sentence or null",',
  ' "blocks":[{"kind":"text","body":"prose with [c1] markers"}],',
  ' "citations":{"c1":{"object_id":"<lake object id from the pack/trigger>","quoted_value":"<the number/fact as used>","claim":"<what c1 supports>"}}}',
  'HARD RULES: every sentence containing a number/percent/currency MUST carry a [cN] marker; every [cN]',
  'must map to an object_id present in the TRIGGER or CONTEXT — NEVER invent an id or a number. Numbers',
  'must match the cited object exactly. British English, no advice, no hype.',
  'FREEZE "quoted_value" AS YOU WROTE THE FIGURE IN THE PROSE ("11.6%", "QAR 4.43bn"), never the raw',
  'lake number. The lake stores a growth rate as a FRACTION (0.1159); writing "11.6%" and freezing',
  '0.1159 is the single most common reason a draft is rejected — the rules engine compares your prose',
  'against what you froze, and 11.6 is not 0.1159.',
  'The DEK is citation-scanned exactly like the body: if the dek states a number/percent/currency it MUST',
  'carry a [cN] marker; otherwise omit that number from the dek.',
  'Every sentence stating a number — including comparisons, prior-period figures, totals, and any',
  'RESTATEMENT of a figure you already cited — must carry a [cN]; reusing the same [cN] across sentences',
  'is expected and correct.',
  'The HEADLINE may contain only a number equal to a value you cite; do NOT put derived figures (growth %,',
  'YoY deltas) in the headline unless you cite that exact computed object. Prefer a qualitative headline',
  'with precise numbers in the body. Do NOT put [cN] markers in the headline.',
  'If a number cannot be backed by an object_id from TRIGGER or CONTEXT, DO NOT WRITE IT — omit it.',
  'For a WIRE keep the whole body under 40 words.',
  'EXAMPLE (note the dek carries a marker and [c1] is reused in the body):',
  '{"headline":"QNB lifts nine-month net profit","dek":"Qatar\'s largest lender posted a net profit of QAR 12.7bn [c1].",',
  ' "blocks":[{"kind":"text","body":"QNB reported a net profit of QAR 12.7bn for the nine months [c1]. Total assets reached QAR 1.44 trillion [c2]. The QAR 12.7bn result was up on a year earlier [c1]."}],',
  ' "citations":{"c1":{"object_id":"...","quoted_value":"QAR 12.7bn","claim":"nine-month net profit"},"c2":{"object_id":"...","quoted_value":"QAR 1.44 trillion","claim":"total assets"}}}',
].join('\n');

const WIRE_MODE = [
  'MODE: WIRE. ONE fact, ONE sentence, ONE [c1]. Keep the whole body under 40 words. Set "dek" to null.',
  'The headline states ONLY the single cited number (no derived figures). Do NOT put [cN] markers in the headline.',
].join('\n');

export function makeDraft(): Handler {
  const handler: Handler = async (payload, ctx: HandlerContext) => {
    const msg = payload as DraftMsg;
    const log = ctx.log.child({ handler: 'pipeline_draft', item: msg.pipeline_item_id });
    if (!msg.pipeline_item_id) { log.warn('draft: no pipeline_item_id'); return; }
    const { sql } = ctx;

    if (await outputHalted(sql)) { log.info('draft: output halted (kill switch) — leaving in place'); return; }

    const item = await loadItem(sql, msg.pipeline_item_id);
    if (!item) { log.warn('draft: item gone'); return; }
    if (item.stage !== 'draft') { log.info('draft: item not at draft stage — no-op', { stage: item.stage }); return; }

    const writerHandle = (await sql`select handle from iam.principals p join ops.pipeline_items pi on pi.writer_agent = p.id where pi.id = ${item.id}`) as unknown as Array<{ handle: string }>;
    const writer = writerHandle[0]?.handle ?? 'WRITER-2';
    const writerId = await resolvePrincipal(sql, writer);

    // WIRE discipline (03 §7.1): a wire is one cited fact, no dek. TPL-01 == the wire template.
    const isWire = item.priority === 'wire' || item.template_hint === 'TPL-01';

    // Budget ladder (03 §1.7): at 'halted' spend, story drafts PARK (leave at draft stage — a
    // stalled sweep re-enqueues when the budget resets); wires still draft. classify is untouched.
    // At 'degraded'/'halted' the writer runs on the cheaper fallback chain (budgetDegraded below).
    const budget = await budgetState(sql);
    if (budget === 'halted' && !isWire) { log.info('draft: budget halted — parking non-wire draft (no-op)'); return; }

    // Trigger object + the writer-context pack for the primary ticker.
    const trig = (await sql`select id::text as id, object_type, payload from lake.objects where id = ${item.trigger_object_id}`) as unknown as Array<{ id: string; object_type: string; payload: unknown }>;
    if (!trig[0]) { log.warn('draft: trigger object gone'); return; }
    const pack = item.security_id
      ? (await sql`select lake.fn_writer_context(${item.security_id}::bigint) as p`) as unknown as Array<{ p: unknown }>
      : [{ p: null }];

    // Thread the item's priority/template into the USER message (previously it only reached `purpose`).
    const modeMsg = isWire ? WIRE_MODE : `MODE: STORY (priority=${item.priority ?? 'normal'}, template=${item.template_hint ?? 'auto'}).`;
    const userMsg = `${modeMsg}\n\nTRIGGER object:\n${JSON.stringify({ object_id: trig[0].id, type: trig[0].object_type, payload: trig[0].payload })}\n\nCONTEXT pack:\n${JSON.stringify(pack[0]?.p ?? {}).slice(0, 12000)}`;

    let draft: { headline?: string; dek?: string | null; blocks?: { kind?: string; body?: string }[]; citations?: Record<string, { object_id?: string; quoted_value?: unknown; claim?: string }> };
    try {
      const res = await chatComplete('writer', [{ role: 'user', content: userMsg }],
        { system: WRITER_SYSTEM, json: true, maxTokens: 2500, temperature: 0.2, budgetDegraded: budget !== 'ok', runContext: { agentId: writerId, pipelineItemId: String(item.id), purpose: `draft:${item.template_hint ?? 'TPL'}:${trig[0].object_type}` } });
      draft = (res.parsed ?? parseJsonReply(res.text)) as typeof draft;
      log.info('draft: writer replied', { cost: res.costUsd, model: res.model });
    } catch (err) {
      // A quality failure (LlmJsonError) or provider outage (LlmUnavailableError) is not a crash —
      // route to a human rather than redeliver the message forever.
      log.error('draft: writer LLM failed — kicking back to human', { err: String(err).slice(0, 200) });
      await reassignHuman(sql, item.id, writerId, `writer LLM: ${String(err).slice(0, 160)}`);
      return;
    }

    const headline = String(draft.headline ?? '').trim().slice(0, 90);
    const blocks = Array.isArray(draft.blocks) ? draft.blocks : [];
    const citations = draft.citations ?? {};
    if (!headline || blocks.length === 0) { await reassignHuman(sql, item.id, writerId, 'empty draft'); return; }

    // The set of object ids the writer was ALLOWED to cite = trigger + every id in the pack.
    const allowed = new Set<string>([trig[0].id, ...idsInPack(pack[0]?.p)]);
    for (const [key, c] of Object.entries(citations)) {
      if (!c.object_id || !allowed.has(c.object_id)) {
        log.error('draft: invented/out-of-set citation — kicking back', { key, object_id: c.object_id });
        await reassignHuman(sql, item.id, writerId, `citation ${key} not in supplied set`);
        return;
      }
    }

    // DEF-WRITER-NUMBER-MARKING: deterministic auto-marker. Attach an EXISTING citation key to any
    // bare number whose sentence lacks a marker, but ONLY when exactly one frozen quoted_value matches
    // within 0.5%. Never invents a marker → cannot create an R-04 mismatch or a fake source; it strictly
    // removes R-03 false-blocks. Run it over the persisted surfaces (blocks + dek) BEFORE the writes so
    // the rules stage re-reads already-marked text. A wire carries no dek (removes that R-03 surface).
    const cites = Object.entries(citations).map(([key, c]) => ({ key, mag: parseMagnitude(String(c.quoted_value ?? '')) }));
    const markedBlocks = blocks.map((b) => ({ kind: String(b.kind ?? 'text'), body: autoMarkNumbers(String(b.body ?? ''), cites).text }));
    let dek: string | null = isWire ? null : (draft.dek ?? null);
    if (dek) dek = autoMarkNumbers(dek, cites).text;

    const bodyText = markedBlocks.map((b) => b.body).join(' ');
    const wc = wordCount(bodyText);

    await sql.begin(async (tx) => {
      await tx`select set_config('app.principal_id', ${writerId}, true)`;
      await tx`select set_config('app.principal_kind', 'agent', true)`;
      await tx`update public.content_items set headline = ${headline}, dek = ${dek}, word_count = ${wc}, updated_at = now() where id = ${item.content_id}::uuid`;
      await tx`delete from public.content_blocks where content_id = ${item.content_id}::uuid`;
      await tx`delete from lake.citations where content_id = ${item.content_id}::uuid`;
      let seq = 1;
      for (const b of markedBlocks) {
        await tx`insert into public.content_blocks (content_id, seq, block_kind, body) values (${item.content_id}::uuid, ${seq}, ${b.kind}, ${sql.json({ text: b.body })}::jsonb)`;
        seq++;
      }
      for (const [key, c] of Object.entries(citations)) {
        if (!c.object_id) continue; // validated above; guard for the type narrower
        // block_key ALSO carries the claim key: the citations_uni index is
        // (content_id, object_id, coalesce(block_key,'')), so two markers citing the
        // SAME object need distinct block_keys to both persist (a legitimate case).
        await tx`insert into lake.citations (content_id, object_id, block_key, claim_key, claim_text, quoted_value, cited_by)
          values (${item.content_id}::uuid, ${c.object_id}::uuid, ${key}, ${key}, ${c.claim ?? null}, ${c.quoted_value == null ? null : String(c.quoted_value)}, ${writerId}::uuid)`;
      }
    });

    await transition(sql, item.id, 'edit', writerId, { headline, word_count: wc });
    await enqueueStage(sql, 'pipeline_edit', item.id);
    log.info('draft: written → edit', { headline, wc, citations: Object.keys(citations).length });
  };
  return handler;
}

/** All lake object ids referenced inside the writer-context pack (statements/filings/etc.). */
function idsInPack(pack: unknown): string[] {
  const ids: string[] = [];
  const walk = (v: unknown) => {
    if (v == null) return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if ((k === 'source_object_id' || k === 'row_id' || k === 'object_id' || k === 'source_filing_id') && typeof val === 'string') ids.push(val);
        else walk(val);
      }
    }
  };
  walk(pack);
  return ids;
}

async function reassignHuman(sql: HandlerContext['sql'], itemId: number, actorId: string, note: string): Promise<void> {
  await sql`select ops.fn_transition(${itemId}::bigint, 'reassigned_human', ${actorId}::uuid, ${sql.json({ note })}::jsonb)`;
}
