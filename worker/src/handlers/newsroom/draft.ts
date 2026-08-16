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
import { buildPack, factsForObject, renderCitableFacts } from './pack.js';
import { renderRevisionBrief } from './revision.js';

/** Every rule key the engine runs, so a brief can state what PASSED as well as what failed. */
const ALL_RULE_KEYS = ['R-01','R-02','R-03','R-04','R-05','R-06','R-07','R-08','R-09','R-10'];
/** Mirrors MAX_RULES_LOOPS in rules-stage.ts — shown to the writer so it knows the stakes. */
const MAX_REVISIONS = 2;

/**
 * Output budget for one draft attempt.
 *
 * Was 2,500 — tuned before citations carried `payload_path`. That field adds roughly 60 tokens
 * per citation, and an XBRL line item is not a short key: item 3 cites
 * `line_items.impairment_loss_impairment_gain_and_reversal_of_impairment_loss_determined_in_ac`.
 * Across nineteen citations the contract stopped fitting, so the JSON truncated mid-object and
 * the run died `json_contract_failed_after_repair` — a whole piece lost to a budget rather than
 * to anything the writer did wrong.
 *
 * A truncated draft is the worst failure available: it costs a full call, produces nothing, and
 * reports as a contract error rather than as "the ceiling was too low".
 */
const DRAFT_MAX_TOKENS = 4000;

/** The previous draft, re-serialised in the shape the writer emits, so the revision turn reads
 *  as its own last answer rather than as a description of one. Must be called BEFORE draft.ts
 *  deletes content_blocks / lake.citations. */
async function loadPreviousDraft(sql: HandlerContext['sql'], contentId: string): Promise<string | null> {
  const ci = ((await sql`select headline, dek from public.content_items where id = ${contentId}::uuid`) as unknown as Array<{ headline: string | null; dek: string | null }>)[0];
  if (!ci?.headline) return null;
  const blocks = (await sql`select block_kind, body from public.content_blocks where content_id = ${contentId}::uuid order by seq`) as unknown as Array<{ block_kind: string; body: { text?: string } | null }>;
  const cites = (await sql`select claim_key, object_id::text as object_id, quoted_value from lake.citations where content_id = ${contentId}::uuid`) as unknown as Array<{ claim_key: string | null; object_id: string; quoted_value: string | null }>;
  if (blocks.length === 0) return null;
  return JSON.stringify({
    headline: ci.headline,
    dek: ci.dek,
    blocks: blocks.map((b) => ({ kind: b.block_kind, body: b.body?.text ?? '' })),
    citations: Object.fromEntries(cites.map((c) => [c.claim_key ?? '', { object_id: c.object_id, quoted_value: c.quoted_value }])),
  });
}

interface DraftMsg { pipeline_item_id?: number }

const WRITER_SYSTEM = [
  'You are a Marsad markets writer covering GCC exchanges. You get a TRIGGER object (the event) and a',
  'CONTEXT pack (the company: identity, price, ratios, score, statements, recent filings) — every fact',
  'carries an id. Write a tight, factual news piece. Return ONLY JSON:',
  '{"headline":"<=90 chars, no clickbait","dek":"one sentence or null",',
  ' "blocks":[{"kind":"text","body":"prose with [c1] markers"}],',
  ' "citations":{"c1":{"object_id":"<lake object id from the pack/trigger>","payload_path":"<the path= shown beside that fact>","quoted_value":"<the number/fact as used>","claim":"<what c1 supports>"}}}',
  'HARD RULES: every sentence containing a number/percent/currency MUST carry a [cN] marker; every [cN]',
  'must map to an object_id present in the TRIGGER or CONTEXT — NEVER invent an id or a number. Numbers',
  'must match the cited object exactly. British English, no advice, no hype.',
  'FREEZE "quoted_value" AS YOU WROTE THE FIGURE IN THE PROSE ("11.6%", "QAR 4.43bn"), never the raw',
  'lake number. The lake stores a growth rate as a FRACTION (0.1159); writing "11.6%" and freezing',
  '0.1159 is the single most common reason a draft is rejected — the rules engine compares your prose',
  'against what you froze, and 11.6 is not 0.1159.',
  'COPY "payload_path" FROM THE `path=` SHOWN BESIDE THE FACT YOU CITED. It names WHICH number of',
  'that object you used — an object holds many (a balance sheet has thirty line items; a ratios',
  'object has two dozen). Without it the rules engine cannot tell your revenue growth figure from',
  'the price/earnings ratio sitting beside it. If the fact you cited shows no `path=`, omit the',
  'field rather than guessing one.',
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
  ' "citations":{"c1":{"object_id":"...","payload_path":"line_items.net_income","quoted_value":"QAR 12.7bn","claim":"nine-month net profit"},"c2":{"object_id":"...","payload_path":"line_items.total_assets","quoted_value":"QAR 1.44 trillion","claim":"total assets"}}}',
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

    // Ordered, budgeted, always-parseable pack + the citable-id index (see pack.ts for why
    // the old `.slice(0, 12000)` handed the writer invalid JSON with its only citable section
    // missing on every call).
    const built = buildPack(pack[0]?.p);
    if (built.dropped.length > 0) {
      // A silent trim reads as a complete pack. Say what was lost.
      log.info('draft: context pack trimmed to fit', { dropped: built.dropped, facts: built.facts.length });
    }

    // Thread the item's priority/template into the USER message (previously it only reached `purpose`).
    const modeMsg = isWire ? WIRE_MODE : `MODE: STORY (priority=${item.priority ?? 'normal'}, template=${item.template_hint ?? 'auto'}).`;
    const userMsg = [
      modeMsg,
      '',
      'TRIGGER object:',
      JSON.stringify({ object_id: trig[0].id, type: trig[0].object_type, payload: trig[0].payload }),
      '',
      'CONTEXT pack:',
      built.text,
      '',
      renderCitableFacts([
        ...factsForObject('trigger', trig[0].object_type, trig[0].id, trig[0].payload),
        ...built.facts,
      ]),
    ].join('\n');

    // ── REVISION vs FIRST DRAFT ────────────────────────────────────────────────────────
    // A retry used to rebuild this message from scratch, so three attempts were three
    // independent samples rather than a revision — item 3's word count went 168 → 163 → 178.
    // Hand the model its own previous output plus a generated brief naming the surface, the
    // remedy, and what already passed. Read BEFORE the delete below, or the evidence is gone.
    const loopNo = item.rules_fail_loops ?? 0;
    const messages: { role: 'user' | 'assistant'; content: string }[] = [{ role: 'user', content: userMsg }];
    if (loopNo > 0) {
      const prior = await loadPreviousDraft(sql, item.content_id);
      const violations = (await sql`
        select rule_key, outcome, detail
          from ops.rule_violations
         where content_id = ${item.content_id}::uuid
           and occurred_at = (select max(occurred_at) from ops.rule_violations where content_id = ${item.content_id}::uuid)
      `) as unknown as Array<{ rule_key: string; outcome: string; detail: unknown }>;
      const blocked = violations.filter((v) => v.outcome === 'blocked');
      const passed = ALL_RULE_KEYS.filter((k) => !blocked.some((b) => b.rule_key === k));
      const note = ((await sql`select send_back_note from ops.pipeline_items where id = ${item.id}`) as unknown as Array<{ send_back_note: string | null }>)[0]?.send_back_note ?? null;
      if (prior) messages.push({ role: 'assistant', content: prior });
      messages.push({ role: 'user', content: renderRevisionBrief(blocked, passed, loopNo, MAX_REVISIONS, note) });
      log.info('draft: revising with brief', { loop: loopNo, blocked: blocked.map((b) => b.rule_key) });
    }

    let draft: { headline?: string; dek?: string | null; blocks?: { kind?: string; body?: string }[]; citations?: Record<string, { object_id?: string; quoted_value?: unknown; claim?: string; payload_path?: unknown }> };
    try {
      const res = await chatComplete('writer', messages,
        { system: WRITER_SYSTEM, json: true, maxTokens: DRAFT_MAX_TOKENS, temperature: 0.2, budgetDegraded: budget !== 'ok', runContext: { agentId: writerId, pipelineItemId: String(item.id), purpose: `draft:${item.template_hint ?? 'TPL'}:${trig[0].object_type}` } });
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

    // The allow-set is the SAME list the writer was shown, built once in pack.ts — not
    // re-derived here by scanning untyped JSON for four key names (which missed `filing_id`
    // entirely and skipped every bigint, so price/identity/filings were uncitable and any
    // draft quoting a share price was terminally reassigned as if it had invented the id).
    const allowed = new Set<string>([trig[0].id, ...built.facts.map((f) => f.objectId)]);
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
        // payload_path names WHICH field of the object this citation is about. R-04's drift
        // check reads exactly it; a citation without one is reported unchecked rather than
        // compared against whichever number of that object happens to sit nearest.
        const path = typeof c.payload_path === 'string' && c.payload_path.trim() ? c.payload_path.trim() : null;
        await tx`insert into lake.citations (content_id, object_id, block_key, claim_key, claim_text, quoted_value, payload_path, cited_by)
          values (${item.content_id}::uuid, ${c.object_id}::uuid, ${key}, ${key}, ${c.claim ?? null}, ${c.quoted_value == null ? null : String(c.quoted_value)}, ${path}, ${writerId}::uuid)`;
      }
    });

    await transition(sql, item.id, 'edit', writerId, { headline, word_count: wc });
    await enqueueStage(sql, 'pipeline_edit', item.id);
    log.info('draft: written → edit', { headline, wc, citations: Object.keys(citations).length });
  };
  return handler;
}

async function reassignHuman(sql: HandlerContext['sql'], itemId: number, actorId: string, note: string): Promise<void> {
  await sql`select ops.fn_transition(${itemId}::bigint, 'reassigned_human', ${actorId}::uuid, ${sql.json({ note })}::jsonb)`;
}
