import type { BlockCode, Direction } from "./types";

/*
 * Constraint reporting for block renderers.
 *
 * The division of labour (architecture/09-signal-to-article.md §6, §6.1):
 *
 *   - the PUBLISHER (fit stage, PD.8) hard-REFUSES a block that violates its
 *     registry constraints. That is the enforcement point.
 *   - the RENDERER never throws. It draws what it was given, and it is LOUD
 *     about anything that should not have reached it.
 *
 * So everything here logs and, where truncation cannot invent data (a table
 * with too many rows), clamps. It never fabricates a missing value to satisfy
 * a minimum — under-count is reported and drawn short.
 */

/**
 * Log a constraint breach. Non-fatal by contract: a renderer that throws takes
 * the whole article down, and the article was already refused upstream if it
 * mattered.
 */
export function warnConstraint(code: BlockCode | string, message: string): void {
  console.warn(`[blocks] ${code}: ${message}`);
}

/** Check an inclusive count range, reporting either side. Never mutates. */
export function checkCount(
  code: BlockCode | string,
  what: string,
  n: number,
  min: number,
  max: number,
): void {
  if (n < min) warnConstraint(code, `${n} ${what} — the registry requires at least ${min}.`);
  else if (n > max) warnConstraint(code, `${n} ${what} — the registry allows at most ${max}.`);
}

/** Check membership of an exact allowed set (BLK-KEYSTATS: 4 or 8, nothing else). */
export function checkExactCounts(
  code: BlockCode | string,
  what: string,
  n: number,
  allowed: number[],
): void {
  if (!allowed.includes(n)) {
    warnConstraint(code, `${n} ${what} — the registry allows exactly ${allowed.join(" or ")}.`);
  }
}

/**
 * Clamp an over-long list, keeping the first `max`. Only safe where the
 * registry's own remedy is "the rest goes somewhere else" (BLK-FINTABLE → the
 * XLSX). Reports before clamping.
 */
export function clampMax<T>(code: BlockCode | string, what: string, items: T[], max: number): T[] {
  if (items.length <= max) return items;
  warnConstraint(
    code,
    `${items.length} ${what} exceeds the ${max} allowed inline — rendering the first ${max}.`,
  );
  return items.slice(0, max);
}

/**
 * Clamp a series to its most recent `max` points (BLK-SPARK: MAX 30 POINTS).
 * Keeps the TAIL, because a sparkline's job is the current direction.
 */
export function clampSeries(code: BlockCode | string, series: number[], max: number): number[] {
  if (series.length <= max) return series;
  warnConstraint(
    code,
    `${series.length} points exceeds the ${max}-point maximum — rendering the most recent ${max}.`,
  );
  return series.slice(series.length - max);
}

/* ── Hard rule 1 · one accent only, ink ──────────────────────────────────── */

/**
 * Direction → text colour. `flat`/absent is INK, never a third accent, and
 * never a decorative colour. Green and red are only ever reachable through
 * this function so no block can spend them on emphasis.
 */
export function directionTextClass(direction: Direction | null | undefined): string {
  if (direction === "up") return "text-positive";
  if (direction === "down") return "text-negative";
  return "text-ink";
}

/* ── Hard rule 3 · a desk estimate is marked three ways at once ──────────── */

/**
 * Signal 1 — the `E` suffix. The agent supplies only `isEstimate`; the label
 * it emits is the bare period ("FY26"), and the suffix is the renderer's to
 * add. Idempotent, so a payload that already carries the suffix is not doubled.
 */
export function estimateLabel(label: string, isEstimate: boolean | undefined): string {
  if (!isEstimate) return label;
  return /E$/.test(label) ? label : `${label}E`;
}

/** Signal 2 — the column header is ink and semibold; actuals stay faint. */
export function estimateHeaderClass(isEstimate: boolean | undefined): string {
  return isEstimate ? "text-ink font-semibold" : "text-ink-faint";
}

/** Signal 3 — the value is bold ink; actuals stay muted. */
export function estimateValueClass(isEstimate: boolean | undefined): string {
  return isEstimate ? "font-bold text-ink" : "text-ink-muted";
}
