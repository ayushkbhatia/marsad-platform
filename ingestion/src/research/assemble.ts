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
import { legCalendar, legIdentity, legPeers, legRatios, legScore, legStatements, type LegContext } from "./legs.js";
import { LEG_KEYS, type LegKey } from "./types.js";

export interface AssembleOptions {
  sql: Sql;
  securityId: number;
  /** Injected so the brief is reproducible; never read from inside a query. */
  now?: Date;
  /** `ops.materiality_prefilter.citable_states`, per object_type. Fail closed when absent. */
  citableStates?: Record<string, string[]>;
  venueCode?: string | null;
  triggerObjectId?: string | null;
}

/**
 * Legs that are DECLARED but not yet implemented.
 *
 * They are listed rather than omitted on purpose. An undeclared leg cannot be asked for and teaches
 * a downstream agent nothing; a declared leg reporting `absent` tells it the concept exists and is
 * not available, which is a different and more useful statement. `LEG_KEYS` is the closed set, so
 * this list plus the implemented ones must cover it exactly — asserted in the tests.
 */
const NOT_YET_BUILT: Array<[LegKey, string]> = [
  ["EB-PERIODPAIR", "Period-over-period pairing is not built. Do not compute a delta from two facts in EB-STATEMENTS and present it as a bound figure — no lake object holds it."],
  ["EB-PRICE", "Price series are not assembled here yet. OHLCV.CLOSE is bindable but the series shape lands with the chart work."],
  ["EB-QUOTE", "The live quote leg is not built. QUOTE.LAST carries security_id on only 57% of rows, so the join needs the venue+ticker fallback first."],
  ["EB-FILINGS", "Filing text is not assembled here yet. Filings are evidence a researcher READS; they are structurally unbindable (public.filings has no source_object_id)."],
  ["EB-REVISIONS", "The supersede-chain leg is not built. Until it is, an open correction cannot be detected here — R-07 still owns that."],
  ["EB-VENUESTATE", "No MARKET.STATUS object family exists, so venue state cannot be bound at all."],
];

function stub(bundle: LegKey, note: string): EvidenceLeg {
  return {
    bundle,
    status: "absent",
    reason: "no_producer",
    evidence: [],
    notes: [note],
    unavailable_fields: [],
    tolerance_days: null,
    newest_as_of: null,
    query_ms: 0,
  };
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
  // the ingest fleet, and six concurrent security-scoped reads per brief would multiply straight
  // through a batch. Each leg is index-served and short.
  const legs: EvidenceLeg[] = [
    await legIdentity(ctx),
    await legRatios(ctx),
    await legScore(ctx),
    await legStatements(ctx),
    await legPeers(ctx),
    await legCalendar(ctx),
    ...NOT_YET_BUILT.map(([k, note]) => stub(k, note)),
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

/** Every leg the assembler emits, implemented or declared-absent. Asserted against LEG_KEYS. */
export const EMITTED_LEGS: readonly LegKey[] = [
  "EB-IDENTITY", "EB-RATIOS", "EB-SCORE", "EB-STATEMENTS", "EB-PEERS", "EB-CALENDAR",
  ...NOT_YET_BUILT.map(([k]) => k),
] as const;

/** True when the assembler covers the closed vocabulary exactly — no leg silently dropped. */
export function coversAllLegs(): boolean {
  return (
    EMITTED_LEGS.length === LEG_KEYS.length &&
    LEG_KEYS.every((k) => EMITTED_LEGS.includes(k))
  );
}
