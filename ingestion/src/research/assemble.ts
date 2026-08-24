/**
 * PR.1 — assemble one security's evidence brief.
 *
 * Runs the legs, stamps the envelope, and derives the citation allow-set from what the legs
 * actually bound rather than from anything a model produced. That last part is the point: PR.4
 * writes `lake.citations` from `allow_set`, so a writer cannot cite outside its evidence because it
 * never handles a uuid at all.
 *
 * Deterministic apart from `now`, which is injected. Two runs over the same database return the
 * same facts with the same ids — that is the whole value of an evidence layer, and it is why this
 * half carries no LLM.
 *
 * @see docs/architecture/build-specs/PR1-evidence-bundles.md
 */
import type { Sql } from "../core/db.js";

import { BUNDLE_CONTRACT_VERSION, type EvidenceBrief, type EvidenceLeg } from "./envelope.js";
import {
  legCalendar, legFilings, legIdentity, legPeers, legPeriodPair, legPrice, legQuote,
  legRatios, legRevisions, legScore, legStatements, legVenueState, type LegContext,
} from "./legs.js";
import { LEG_KEYS, type LegKey } from "./types.js";

export interface AssembleOptions {
  sql: Sql;
  securityId: number;
  /** Injected so the brief is reproducible; never read from inside a query. */
  now?: Date;
  /** `ops.materiality_prefilter.citable_states`, per object_type. Fail closed when absent. */
  citableStates?: Record<string, string[]>;
  venueCode?: string | null;
  /** Needed for EB-QUOTE's fallback join — QUOTE.LAST has security_id on only 56.5% of rows. */
  ticker?: string | null;
  triggerObjectId?: string | null;
}

export async function assembleBrief(opts: AssembleOptions): Promise<EvidenceBrief> {
  const started = Date.now();
  const now = opts.now ?? new Date();

  let n = 0;
  const ctx: LegContext = {
    sql: opts.sql,
    securityId: opts.securityId,
    now,
    citableStates: opts.citableStates ?? {},
    seq: () => `f${++n}`,
  };

  // Sequential rather than parallel, deliberately: the worker shares a small Supavisor budget with
  // the ingest fleet, and twelve concurrent security-scoped reads per brief would multiply straight
  // through a batch. Each leg is index-served and short.
  //
  // Ordered as a desk would ask: who is this, what is it worth, what did it report, how does that
  // compare, what has the price done, who does it sit against, what has it said, what changed.
  const legs: EvidenceLeg[] = [
    await legIdentity(ctx),
    await legRatios(ctx),
    await legScore(ctx),
    await legStatements(ctx),
    await legPeriodPair(ctx),
    await legPrice(ctx),
    await legQuote(ctx, opts.venueCode ?? null, opts.ticker ?? null),
    await legPeers(ctx),
    await legFilings(ctx),
    await legRevisions(ctx),
    await legCalendar(ctx),
    await legVenueState(ctx, opts.venueCode ?? null),
  ];

  // The allow-set is derived from what the legs BOUND, never from a model's output.
  const allow = new Set<string>();
  for (const l of legs) {
    for (const e of l.evidence) {
      if (e.kind !== "unbound") allow.add(e.binding.object_id);
    }
  }

  return {
    contract_version: BUNDLE_CONTRACT_VERSION,
    security_id: opts.securityId,
    venue_code: opts.venueCode ?? null,
    trigger_object_id: opts.triggerObjectId ?? null,
    assembled_at: now.toISOString(),
    assembly_ms: Date.now() - started,
    legs,
    allow_set: [...allow],
  };
}

/** Every leg the assembler emits — now all twelve, none stubbed. Asserted against LEG_KEYS. */
export const EMITTED_LEGS: readonly LegKey[] = [
  "EB-IDENTITY", "EB-RATIOS", "EB-SCORE", "EB-STATEMENTS", "EB-PERIODPAIR", "EB-PRICE",
  "EB-QUOTE", "EB-PEERS", "EB-FILINGS", "EB-REVISIONS", "EB-CALENDAR", "EB-VENUESTATE",
] as const;

/** True when the assembler covers the closed vocabulary exactly — no leg silently dropped. */
export function coversAllLegs(): boolean {
  return (
    EMITTED_LEGS.length === LEG_KEYS.length &&
    LEG_KEYS.every((k) => EMITTED_LEGS.includes(k))
  );
}
