/**
 * The revision brief — what the writer is told when the ruleset sends a draft back.
 *
 * ── WHY THE RETRY LOOP DID NOT WORK ───────────────────────────────────────────────────
 * rules-stage.ts put {rules_failed, loop} in the transition detail, which lands in
 * ops.agent_runs.stats — a place nothing reads. draft.ts then rebuilt its user message from
 * scratch. So the three attempts were three INDEPENDENT samples from the same distribution,
 * not a revision: item 3's word count went 168 → 163 → 178. It got LONGER. Item 4 did the
 * same and both died at the cap having never been told what was wrong.
 *
 * ── THE THREE PROPERTIES THAT MATTER ──────────────────────────────────────────────────
 * 1. NAME THE SURFACE. The violation rows already carry `where` (headline / dek / block:4),
 *    so the writer is pointed at the sentence rather than the piece.
 * 2. NAME THE REMEDY, from a fixed table keyed on the violation `kind` the engine emits.
 *    "R-03 blocked" is a verdict; "attach a [cN] or drop the number" is an instruction.
 * 3. PIN WHAT PASSED. Without this the model rewrites clean prose and reintroduces defects
 *    it had already avoided — the likeliest explanation for the 168→163→178 oscillation.
 *
 * Deterministic and generated: never free prose, so a revision is reproducible and the brief
 * can be golden-tested against a frozen set of violations.
 */

export interface ViolationRow {
  rule_key: string;
  outcome: string;
  detail: unknown;
}

/** kind → what the writer should actually DO about it. */
const REMEDY: Record<string, string> = {
  number_without_citation:
    'attach a [cN] whose citation quoted_value is this number AS WRITTEN, or remove the number',
  marker_unresolved:
    'this [cN] has no entry in "citations" — add one, or drop the marker and the number with it',
  cited_object_state_not_citable:
    'that object may not be cited in its current state — cite a different object from CITABLE FACTS, or drop the claim',
  cited_object_in_conflict:
    'two sources disagree about this figure, so it cannot be published — remove the number and the sentence that depends on it',
  cited_object_superseded:
    'that object was replaced by a newer revision — cite the current one from CITABLE FACTS',
  cited_object_lineage_unproven:
    'that object has no proven source document — cite a different object from CITABLE FACTS',
  number_mismatch:
    'quoted_value must be the figure AS IT APPEARS IN YOUR PROSE (write "11.6%", freeze "11.6%"), not the raw lake value',
  number_unaccounted:
    'this number is not covered by any citation in its sentence — cite it, or remove it',
  headline_number_uncited:
    'the headline may only contain a number you cite exactly; derived figures (growth %, YoY deltas) do not belong there',
  lake_drift:
    'the frozen value no longer matches the object — re-read the value from CITABLE FACTS',
  banned_phrase: 'remove this phrase',
  headline_too_long: 'shorten the headline to 90 characters or fewer',
  headline_clickbait: 'rewrite the headline as a plain statement of fact',
};

interface Violation { where?: string; kind?: string; key?: string; [k: string]: unknown }

function violationsOf(detail: unknown): Violation[] {
  if (typeof detail !== 'object' || detail === null) return [];
  const v = (detail as { violations?: unknown }).violations;
  return Array.isArray(v) ? (v as Violation[]) : [];
}

/** Short, quotable evidence for one violation — enough to locate it, never the whole payload. */
function evidenceOf(v: Violation): string {
  const bits: string[] = [];
  if (v.key) bits.push(String(v.key));
  if (v.token !== undefined) bits.push(`"${String(v.token).trim()}"`);
  else if (v.value !== undefined) bits.push(String(v.value));
  if (v.cited !== undefined) bits.push(`cited ${String(v.cited)}`);
  if (v.sentence) bits.push(`"${String(v.sentence).slice(0, 120)}"`);
  return bits.join(' · ');
}

/**
 * @param blocked   violations from the LATEST rules run, blocked outcomes only
 * @param passedKeys rule keys that did NOT block — pinned so the writer stops rewriting them
 * @param loopNo    which revision this is (1-based)
 * @param maxLoops  how many are allowed, so the writer knows the stakes
 * @param deskNote  a human instruction from ops.pipeline_items.send_back_note, authoritative
 */
export function renderRevisionBrief(
  blocked: ViolationRow[],
  passedKeys: string[],
  loopNo: number,
  maxLoops: number,
  deskNote?: string | null,
): string {
  const out: string[] = [];

  if (deskNote && deskNote.trim()) {
    out.push(`DESK NOTE (from a human editor — authoritative, overrides everything below):`);
    out.push(deskNote.trim(), '');
  }

  out.push(
    `REVISION ${loopNo} of ${maxLoops}. Your previous draft was BLOCKED by the ruleset.`,
    `Fix ONLY the defects listed below. Every sentence not named here must come back byte-identical.`,
    '',
  );

  for (const r of blocked) {
    const vs = violationsOf(r.detail);
    out.push(`${r.rule_key}`);
    if (vs.length === 0) { out.push('  (no detail recorded)'); continue; }
    // Collapse repeats: the same defect on the same surface is one instruction, not five.
    const seen = new Set<string>();
    for (const v of vs) {
      const kind = String(v.kind ?? 'unknown');
      const where = String(v.where ?? 'piece');
      const line = `  [${where}] ${kind} — ${evidenceOf(v)}`;
      if (seen.has(line)) continue;
      seen.add(line);
      out.push(line);
      const remedy = REMEDY[kind];
      if (remedy) out.push(`      → ${remedy}`);
    }
  }

  if (passedKeys.length > 0) {
    out.push('', `RULES THAT PASSED AND MUST NOT CHANGE: ${passedKeys.join(', ')}.`);
  }
  out.push(
    '',
    'Return the SAME JSON shape as before. Keep every citation that was not named above, with the',
    'same [cN] keys and the same quoted_value, so the parts that already passed keep passing.',
  );
  return out.join('\n');
}

/**
 * Has this revision actually moved? Compares the blocked rule keys and the total violation
 * count against the previous attempt.
 *
 * A model that returns the same defects twice will return them a third time; burning the last
 * attempt to prove it wastes a writer call and delays the human. Escalate on the repeat.
 */
export function revisionSignature(blocked: ViolationRow[]): string {
  const keys = blocked.map((b) => b.rule_key).sort().join(',');
  const n = blocked.reduce((acc, b) => acc + violationsOf(b.detail).length, 0);
  return `${keys}#${n}`;
}
