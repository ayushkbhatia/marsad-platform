/**
 * The writer's context pack: ordered, budgeted, and valid JSON.
 *
 * ── WHAT WAS WRONG ────────────────────────────────────────────────────────────────────
 * draft.ts built the user message as `JSON.stringify(pack).slice(0, 12000)`.
 *
 * `lake.fn_writer_context` builds its result with `jsonb_build_object`, and jsonb orders keys
 * by (length, bytes) — not by write order. Measured serialisation order is:
 *
 *     price · score · ratios · filings · identity · freshness · statements · generated_for
 *
 * Measured pack sizes across the 15 securities with the most statements: 15,837–26,886 chars.
 * ALL FIFTEEN exceed 12,000. So on every single call the writer received:
 *
 *   1. a string cut mid-token — syntactically invalid JSON, which the model then had to
 *      interpret rather than read; and
 *   2. no `statements` section at all (it starts around offset 10,485 on QNBK and later on
 *      larger companies) — and `statements` is the ONLY section carrying a per-fact
 *      `source_object_id`, i.e. the only part of the pack that is legally citable.
 *
 * The writer was handed truncated garbage, asked to cite from a section it could not see, and
 * then terminally reassigned for citing anything else. Both real drafts died that way.
 *
 * ── WHAT THIS DOES INSTEAD ────────────────────────────────────────────────────────────
 * Emits sections in EDITORIAL priority, trims at ELEMENT granularity (whole statement periods,
 * whole filings — oldest first), and always returns parseable JSON. A longer slice would only
 * move the guillotine; the fix is to drop whole facts, and to say which ones were dropped.
 *
 * It also builds the citation allow-set HERE, as a typed by-product of walking the pack, rather
 * than re-deriving it in draft.ts by scanning untyped JSON for four key names — a scan that
 * missed `filing_id` entirely and skipped every bigint, because it only collected strings.
 */

/** One fact the writer is permitted to cite, with where it came from. */
export interface CitableFact {
  objectId: string;
  section: string;
  label: string;
  value: string;
}

export interface BuiltPack {
  /** The JSON the model sees. Always parseable. */
  text: string;
  /** Every object id the writer may cite, in presentation order. */
  facts: CitableFact[];
  /** What did not fit, so a trim is never silent. */
  dropped: { section: string; n: number }[];
}

/** Section order is EDITORIAL, not jsonb's. identity and the trigger's own statements first;
 *  price and freshness last because they are the cheapest to lose and the least citable. */
const SECTION_ORDER = [
  'identity', 'statements', 'filings', 'ratios', 'score', 'price', 'freshness',
] as const;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/**
 * Collect the citable ids out of one section.
 *
 * Only `source_object_id` counts as citable, and it is coerced to a string: the previous
 * implementation collected `typeof val === 'string'` only, so `row_id` and `source_filing_id`
 * (bigints in fn_writer_context) were silently skipped even where they were present.
 */
function collectFacts(section: string, node: unknown, out: CitableFact[], labelHint = ''): void {
  if (Array.isArray(node)) {
    for (const el of node) collectFacts(section, el, out, labelHint);
    return;
  }
  if (!isObj(node)) return;

  const id = node.source_object_id ?? node.object_id;
  if (id !== null && id !== undefined && String(id).length >= 32) {
    const label = [labelHint, str(node.statement_type), str(node.fiscal_period), str(node.title)]
      .filter(Boolean).join(' ').trim() || section;
    // A short, human-readable value so the model can match a fact to its id without
    // re-deriving it from the payload.
    const value = str(node.value ?? node.numeric_value ?? node.period_end ?? node.filed_at ?? '');
    out.push({ objectId: String(id), section, label: label.slice(0, 80), value: value.slice(0, 40) });
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'source_object_id' || k === 'object_id') continue;
    if (isObj(v) || Array.isArray(v)) collectFacts(section, v, out, k);
  }
}

/** Drop the oldest element of the largest trimmable section. Returns false when nothing is left. */
function dropOne(pack: Record<string, unknown>, dropped: Map<string, number>): boolean {
  // Only these are element-trimmable; the rest are small and load-bearing.
  const trimmable = ['statements', 'filings'];
  let best: { key: string; len: number } | null = null;
  for (const key of trimmable) {
    const v = pack[key];
    if (Array.isArray(v) && v.length > 1 && (!best || v.length > best.len)) best = { key, len: v.length };
  }
  if (!best) return false;
  (pack[best.key] as unknown[]).pop();          // arrays arrive newest-first, so pop drops the oldest
  dropped.set(best.key, (dropped.get(best.key) ?? 0) + 1);
  return true;
}

/**
 * @param raw       the jsonb returned by lake.fn_writer_context
 * @param maxChars  budget for the serialised pack. Default 25,000 — above the largest measured
 *                  pack (26,886 for the widest security, which then trims by a period or two)
 *                  and far inside every writer model's context. The old 12,000 was not a
 *                  considered budget; it was a number that happened to be below every pack.
 */
export function buildPack(raw: unknown, opts: { maxChars?: number } = {}): BuiltPack {
  const maxChars = opts.maxChars ?? 25_000;
  if (!isObj(raw)) return { text: '{}', facts: [], dropped: [] };

  // Rebuild in editorial order; anything unrecognised keeps its place at the end so a new
  // section added to fn_writer_context is never silently discarded.
  const ordered: Record<string, unknown> = {};
  for (const k of SECTION_ORDER) if (k in raw) ordered[k] = structuredClone(raw[k]);
  for (const k of Object.keys(raw)) if (!(k in ordered)) ordered[k] = structuredClone(raw[k]);

  const droppedMap = new Map<string, number>();
  let text = JSON.stringify(ordered);
  while (text.length > maxChars && dropOne(ordered, droppedMap)) {
    text = JSON.stringify(ordered);
  }

  const facts: CitableFact[] = [];
  for (const [section, node] of Object.entries(ordered)) collectFacts(section, node, facts);

  // Stable de-dupe: the same object can legitimately appear in two sections.
  const seen = new Set<string>();
  const uniq = facts.filter((f) => (seen.has(f.objectId) ? false : (seen.add(f.objectId), true)));

  return {
    text,
    facts: uniq,
    dropped: [...droppedMap.entries()].map(([section, n]) => ({ section, n })),
  };
}

/**
 * The CITABLE FACTS index the writer copies ids from.
 *
 * The writer used to be told "cite an object_id present in the pack" and left to find them by
 * scanning nested JSON — then terminally reassigned when it guessed. Listing them flat turns
 * citation from an inference into a copy.
 */
export function renderCitableFacts(facts: CitableFact[], limit = 120): string {
  if (facts.length === 0) return 'CITABLE FACTS: none — do not cite any number.';
  const lines = facts.slice(0, limit).map((f) => {
    const v = f.value ? ` = ${f.value}` : '';
    return `${f.objectId}  [${f.section}] ${f.label}${v}`;
  });
  const more = facts.length > limit ? `\n… and ${facts.length - limit} more (cite only ids listed above).` : '';
  return `CITABLE FACTS — you may cite ONLY these object ids:\n${lines.join('\n')}${more}`;
}
