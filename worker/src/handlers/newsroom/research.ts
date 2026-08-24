/**
 * PR.1 — the research stage. Deterministic SQL, no LLM, no cost.
 *
 * ── WHY THIS STAGE EXISTS ───────────────────────────────────────────────────────────────────────
 * `20260816150000_pipeline_state_machine_complete.sql` reserved the slot (`queued → research →
 * draft`), seeded `newsroom_research_stage`, and left it unread — there was no handler. This is it.
 *
 * It is NOT a replacement for `pack.ts`. That builds the writer's context pack from
 * `lake.fn_writer_context` and fixed a real bug (the pack was truncated mid-token at 12,000 chars,
 * severing the only citable section). But it reads the PROJECTIONS for ratios and score, so those
 * facts carry no object id and cannot be cited; it covers one security with no peer set; and it
 * cannot distinguish "this company has none" from "no producer exists". This stage answers those
 * three, and hands the result forward as an `EvidenceBrief`.
 *
 * ── WHAT IT COSTS ───────────────────────────────────────────────────────────────────────────────
 * Six index-served queries and no model call. That is the argument for putting it before draft
 * rather than inside it: evidence gathering is reproducible and free, and mixing it into the
 * writer's single call is what made the writer's research unauditable.
 *
 * ── SAFE BEFORE ITS MIGRATION ───────────────────────────────────────────────────────────────────
 * `ops.research_briefs` arrives with 20260817090000. Until then the brief is assembled, logged and
 * passed on WITHOUT being stored — the same probe-then-write posture `fit.ts` already uses for
 * `citable_states` and `templates.piece_type`. So the worker is deployable in either order.
 */
import { assembleBrief, type EvidenceBrief } from 'marsad-ingestion';

import type { Handler, HandlerContext } from '../index.js';
import type { Sql } from '../../db.js';
import { loadItem, resolvePrincipal, switchOn, transition } from './shared.js';

/** The switch `classify` consults before routing a new item through research. */
export const RESEARCH_SWITCH = 'newsroom_research_stage';

interface ResearchMsg {
  pipeline_item_id?: number;
}

/**
 * D-14's allowlist, read once per brief.
 *
 * The assembler marks each fact `fit_bindable` against this, so a piece that cannot survive fit is
 * visible in the brief rather than discovered after the writer, editor and compose calls are paid
 * for. Probed because the column is not on every deployment.
 */
async function loadCitableStates(sql: Sql): Promise<Record<string, string[]>> {
  const has = (await sql`
    select 1 from information_schema.columns
     where table_schema = 'ops' and table_name = 'materiality_prefilter'
       and column_name = 'citable_states' limit 1
  `) as unknown as unknown[];
  if (has.length === 0) return {};

  const rows = (await sql`
    select object_type, citable_states from ops.materiality_prefilter where citable_states is not null
  `) as unknown as Array<{ object_type: string; citable_states: string[] | null }>;
  const out: Record<string, string[]> = {};
  for (const r of rows) if (r.citable_states?.length) out[r.object_type] = r.citable_states;
  return out;
}

function summarise(brief: EvidenceBrief) {
  let bound = 0;
  let bindable = 0;
  let present = 0;
  let absent = 0;
  for (const leg of brief.legs) {
    if (leg.status === 'present' || leg.status === 'stale') present += 1;
    if (leg.status === 'absent') absent += 1;
    for (const e of leg.evidence) {
      if (e.kind === 'unbound') continue;
      bound += 1;
      if (e.fit_bindable) bindable += 1;
    }
  }
  return { bound, bindable, present, absent };
}

/** Store the brief when the table exists; report honestly when it does not. */
async function persistBrief(
  sql: Sql,
  brief: EvidenceBrief,
  item: { id: number; content_id: string },
  s: ReturnType<typeof summarise>,
): Promise<boolean> {
  const has = (await sql`select to_regclass('ops.research_briefs') as t`) as unknown as Array<{ t: string | null }>;
  if (!has[0]?.t) return false;

  await sql`
    insert into ops.research_briefs
      (security_id, content_id, pipeline_item_id, contract_version, trigger_object_id,
       brief, bound_fact_count, fit_bindable_count, legs_present, legs_absent, assembly_ms)
    values (${brief.security_id}, ${item.content_id}::uuid, ${item.id}, ${brief.contract_version},
            ${brief.trigger_object_id}, ${sql.json(brief as never)}::jsonb,
            ${s.bound}, ${s.bindable}, ${s.present}, ${s.absent}, ${brief.assembly_ms})
  `;
  return true;
}

export function makeResearchStage(): Handler {
  const handler: Handler = async (payload, ctx: HandlerContext) => {
    const msg = payload as ResearchMsg;
    const log = ctx.log.child({ handler: 'pipeline_research', item: msg.pipeline_item_id });
    if (!msg.pipeline_item_id) { log.warn('research: no id'); return; }
    const { sql } = ctx;

    const item = await loadItem(sql, msg.pipeline_item_id);
    if (!item) { log.warn('research: item gone'); return; }
    // Redelivery-safe: pgmq can hand the same message back, and re-running a stage the item has
    // already left would transition it backwards.
    if (item.stage !== 'research') {
      log.info('research: not at research stage — no-op', { stage: item.stage });
      return;
    }

    const writerId = await resolvePrincipal(sql, 'WRITER-2');

    // No security means no subject: every leg is security-scoped, so a brief would be empty and
    // the draft stage is better placed to decide what to do with a subjectless piece.
    if (item.security_id === null) {
      log.warn('research: item has no primary security — passing through unresearched');
      await transition(sql, item.id, 'draft', writerId, {
        reason: 'no primary security on the piece; no evidence could be assembled',
      });
      return;
    }

    const citableStates = await loadCitableStates(sql);

    // Venue and ticker are not decoration: EB-QUOTE's fallback join needs them because QUOTE.LAST
    // carries security_id on only 56.5% of live rows, and EB-VENUESTATE is keyed by venue. Without
    // them both legs report a false 'empty'.
    const sec = (await sql`
      select venue_code, ticker from public.securities where id = ${item.security_id}
    `) as unknown as Array<{ venue_code: string | null; ticker: string | null }>;

    const brief = await assembleBrief({
      sql: sql as never,
      securityId: item.security_id,
      citableStates,
      venueCode: sec[0]?.venue_code ?? null,
      ticker: sec[0]?.ticker ?? null,
      triggerObjectId: item.trigger_object_id,
    });

    const s = summarise(brief);
    const stored = await persistBrief(sql, brief, item, s);

    log.info('research: brief assembled', {
      security_id: brief.security_id,
      bound_facts: s.bound,
      fit_bindable: s.bindable,
      legs_present: s.present,
      legs_absent: s.absent,
      assembly_ms: brief.assembly_ms,
      stored,
    });

    // A brief with facts but none the fit stage will accept is worth saying out loud: the piece is
    // composable and then guaranteed to be refused, which is the expensive way to find out.
    if (s.bound > 0 && s.bindable === 0) {
      log.warn('research: evidence is readable but NOT fit-bindable — every bound figure would be refused', {
        bound_facts: s.bound,
      });
    }
    if (!stored) {
      log.warn('research: ops.research_briefs is absent — brief assembled but not stored (migration 20260817090000 unapplied)');
    }

    await transition(sql, item.id, 'draft', writerId, {
      reason: 'evidence assembled',
      bound_facts: s.bound,
      fit_bindable: s.bindable,
      legs_absent: s.absent,
      brief_stored: stored,
    });
  };
  return handler;
}
