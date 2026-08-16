/**
 * Rules engine types (P3.2, 03 §8). The engine is a PURE function of an assembled
 * RuleContext — the worker's rules handler reads content_items + content_blocks +
 * lake.citations (+ the cited objects' live payload/state) into this shape, then the
 * engine decides. Kept pure so every rule is golden-testable with a fixture and the
 * same code path serves agent content (pipeline) and human content (Desk "RUN RULES NOW").
 *
 * Divergence from spec §8.1 (documented, mirrors the ratios TS-over-SQL choice): the
 * engine is TS in the ingestion package (the worker's dependency), not a plpgsql
 * fn_run_rules — R-03 tokenization + R-04 unit-aware number parsing are intractable in
 * SQL. The Desk button (P4, Next) invokes the same logic via a thin worker RPC/queue.
 */

/** One citation the writer froze at draft time (03 §7.1). */
export interface CitationRow {
  claim_key: string;        // 'c1', 'c2', …
  lake_object_id: string;   // the cited object
  cited_value: unknown;     // frozen jsonb value at citation instant
  cited_hash: string | null;
  // Resolved by the assembler from lake.objects (present = the object exists):
  object_state?: string | null;      // 'VERIFIED' | 'PENDING' | 'CONFLICT' | 'RETIRED' | missing
  object_type?: string | null;       // R-03 reads the per-type citable-state allowlist
  object_payload?: Record<string, unknown> | null;  // live payload for R-04 drift check
  /**
   * Which field of the payload this citation is actually about — a dotted path, e.g.
   * `line_items.net_income` or `ratios.pe`. Written at draft time.
   *
   * Without it R-04's drift check had no way to know WHICH number it was checking, and probed
   * for whatever value in the payload sat nearest the cited one. Live consequence: a citation
   * reading "trailing twelve-month revenue growth rate · 10.6%" was compared against 9.5957 —
   * the object's price/earnings ratio, an unrelated field that merely happened to be close.
   * Two unrelated numbers within 10% of each other are not drift, and no tolerance band can
   * tell the difference.
   */
  payload_path?: string | null;
  lineage_root_count?: number;        // distinct snapshot roots (R-03 ≥2 auto-publish gate)
  /** The object was superseded by a newer revision — you may not cite a retired fact. */
  superseded?: boolean;
  /** Its lake.parse_runs lineage resolves to a run that SUCCEEDED. The provenance floor's
   *  load-bearing clause: it is what makes "traceable to a primary document we hold" true
   *  rather than merely asserted. Re-checked at rules time because a run can be marked
   *  failed (or reaped) after the object was admitted. */
  parse_run_ok?: boolean;
  /** An open correction on THIS object — you may not cite a fact already known to be wrong.
   *  DORMANT: ops.correction_flags is content-scoped (content_id / revision_id, no object_id),
   *  so the assembler cannot populate this today and R-07's piece-level warning is the only
   *  correction signal. The clause is wired so that object-level flags, when they exist, are a
   *  schema change rather than a rules change. Never set true by the current assembler. */
  has_open_correction?: boolean;
}

/** One rendered content block (public.content_blocks). */
export interface BlockRow {
  seq: number;
  block_kind: string;       // 'BLK-TICKER' | 'BLK-DELTA' | 'text' | …
  body: string;             // rendered prose / markdown, may carry [cN] markers
  bound_object_id: string | null;
  gated: boolean;           // paywall cut marker (R-09)
}

/** The assembled bundle one piece is judged on. */
export interface RuleContext {
  content_id: string;
  content_type: string;     // 'WIRE' | 'ARTICLE' | 'NOTE' | 'TAKE' | …
  template_key: string | null;
  headline: string;
  dek: string | null;
  word_count: number;
  is_premium: boolean;
  blocks: BlockRow[];
  citations: CitationRow[];
  /** venue+ticker tags on the piece and whether each resolves to a LISTED security (R-02). */
  tickers: { security_id: number | null; ticker: string; resolved_listed: boolean }[];
  /** Whether a standard-disclaimer block is already present (R-01). */
  has_disclaimer_block: boolean;
  /** Open correction/confirm flags on any cited object (blocks auto-publish; R-07). */
  open_correction: boolean;
  /** Distinct snapshot lineage roots across the whole piece (R-03 ≥2 auto-publish gate, Revision #5). */
  distinct_lineage_roots: number;
}

export type Outcome = 'blocked' | 'warned' | 'auto_fixed' | 'passed_after_fix' | 'passed';

export interface RuleResult {
  rule_key: string;
  mode: 'BLOCK' | 'WARN' | 'AUTO' | 'AUTO_FIX';
  outcome: Outcome;
  detail: Record<string, unknown>;
}

/** Optional model seam for the two LLM-assisted rules (R-06 framing, R-10 rewrite). */
export interface RuleLlm {
  /** R-06: "is this sentence framed as risk, not advice?" → true = ok (risk framing). */
  framingIsRisk?(sentence: string): Promise<boolean>;
  /** R-10: rewrite a too-long/clickbait headline within the existing facts. */
  rewriteHeadline?(headline: string, maxChars: number): Promise<string>;
}

export interface EngineOptions {
  rulesetVersion: number;
  bannedPhrases: string[];   // normalized lower-case phrases from ops.banned_phrases
  headlineMaxChars?: number; // default 90 (R-10 / content_items CHECK)
  autoWordCap?: number;      // TPL-01 auto-publish word ceiling, default 40
  /**
   * Per-object-type citable states, from ops.materiality_prefilter.citable_states.
   * R-03's provenance floor (09 §3.2). Injected rather than read here so the engine stays
   * pure and golden-testable.
   *
   * A MISSING entry means {VERIFIED} — fail closed, matching lake.fn_intake_eligible_state's
   * fallback for an unknown type. Never default to "anything", or a new object family becomes
   * publishable the moment it is written.
   */
  citableStatesByType?: Record<string, string[]>;
  llm?: RuleLlm;
}

export interface EngineResult {
  results: RuleResult[];
  /** true iff no rule BLOCKED. */
  passed: boolean;
  /** true iff passed AND every auto-publish precondition holds (R-03 ≥2 roots, no open correction). */
  autoPublishEligible: boolean;
  /** headline after any R-10 auto-fix rewrite (unchanged when no fix). */
  finalHeadline: string;
}
