/**
 * The two colour ramps the D family is allowed to use.
 *
 * Transcribed from `docs/design/block-registry.json` → `tokens.heat_ramp` / `tokens.ink_ramp`,
 * which is the same posture `src/styles/design-tokens.json` takes toward `globals.css`: the JSON is
 * the reference, this is the runtime copy, and they are diffed rather than generated. Kept here
 * rather than inlined per renderer because BLK-HEAT's card says **"NEVER INVENT A SECOND SCALE"** —
 * a rule that only means anything if there is exactly one place to change.
 */

/**
 * ⚠️ The card says "SAME 7-STOP RAMP AS THE SECTOR HEATMAP". The specimen renders **eight**
 * distinct swatches, and the token file records the discrepancy rather than resolving it. Eight is
 * what is used, because it is what the design actually draws — but the count is worth knowing
 * before anyone "fixes" this to seven.
 *
 * Ordered darkest-positive → darkest-negative.
 */
export const HEAT_RAMP = [
  "#1f8a45", "#1c6b38", "#1a5c32", "#203a27",
  "#232e22", "#32241e", "#5c261f", "#7a291f",
] as const;

/** Monochrome emphasis ramp — BLK-BARS, BLK-STACK, BLK-DONUT. Darkest is always largest. */
export const INK_RAMP = ["#14120e", "#57534a", "#a8a396", "#cfcabe", "#e3dfd4"] as const;

/**
 * Pick a heat stop for a value in [-1, 1], where positive is green.
 *
 * A null returns null rather than a mid-ramp colour: the middle of this ramp is a real reading
 * ("flat"), so colouring an absent cell with it would state a measurement that was never taken.
 */
export function heatStop(v: number | null | undefined): string | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const clamped = Math.max(-1, Math.min(1, v));
  // -1 → last stop (deepest red), +1 → first stop (deepest green)
  const idx = Math.round(((1 - clamped) / 2) * (HEAT_RAMP.length - 1));
  return HEAT_RAMP[Math.max(0, Math.min(HEAT_RAMP.length - 1, idx))]!;
}

/** Nth ink-ramp stop, clamped. Index 0 is the darkest and belongs to the largest share. */
export function inkStop(i: number): string {
  return INK_RAMP[Math.max(0, Math.min(INK_RAMP.length - 1, i))]!;
}
