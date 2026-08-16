/**
 * Binding resolution — the PURE half.
 *
 * Split from resolve.ts so it can be unit-tested: that file imports "server-only", which does
 * not resolve outside Next's bundler, and the logic worth testing (which ids a payload binds,
 * how a binding becomes a value, how snake_case becomes camelCase) has no I/O in it at all.
 *
 * See resolve.ts for why the contract is a binding rather than a number.
 */

import type { AnyBlockNode } from "@/components/blocks";

/** One lake object, as much of it as a renderer may see. */
export interface BoundObject {
  object_id: string;
  object_type: string;
  state: string;
  verification_basis: string | null;
  numeric_value: number | string | null;
  unit: string | null;
  effective_date: string | null;
  verified_at: string | null;
  payload: Record<string, unknown> | null;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A payload node shaped like Zod's ObjectBinding. */
function isBinding(v: unknown): v is { object_id: string; field?: string; label?: string } {
  return isObj(v) && typeof v.object_id === "string";
}

export function camel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Read a dotted path out of a payload: "line_items.revenue". */
function readPath(payload: Record<string, unknown> | null, path: string): unknown {
  if (!payload) return undefined;
  return path.split(".").reduce<unknown>((acc, part) => (isObj(acc) ? acc[part] : undefined), payload);
}

/**
 * Format a resolved value for print.
 *
 * Deliberately minimal: a number becomes a grouped numeral and a unit is appended when the
 * object carries one. It does NOT invent currency symbols, scale to "bn", or round — every one
 * of those is an editorial choice that belongs to the block, not to the resolver, and getting
 * it wrong here would silently restate a figure the piece cites.
 */
export function format(value: unknown, unit: string | null): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    const n = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 4 }).format(value);
    return unit && unit !== "unknown" ? `${n} ${unit}` : n;
  }
  if (typeof value === "string" || typeof value === "boolean") return String(value);
  return null;
}

/** Resolve one binding against its object. */
function resolveBinding(
  b: { object_id: string; field?: string },
  byId: Map<string, BoundObject>,
): string | null {
  const o = byId.get(b.object_id);
  if (!o) return null;
  if (!b.field) return format(o.numeric_value, o.unit);
  const direct = readPath(o.payload, b.field);
  if (direct !== undefined) return format(direct, o.unit);
  // `numeric_value` is the object's headline figure; a field naming it is common enough
  // to be worth honouring rather than returning a dash.
  if (b.field === "numeric_value" || b.field === "value") return format(o.numeric_value, o.unit);
  return null;
}

/** Walk a payload, converting keys to camelCase and bindings to values. */
export function resolveNode(value: unknown, byId: Map<string, BoundObject>): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveNode(v, byId));
  if (!isObj(value)) return value;
  if (isBinding(value)) return resolveBinding(value, byId);

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[camel(k)] = resolveNode(v, byId);
  return out;
}

/** Every object id a set of payloads binds, so the read is ONE query per article. */
export function bindingIdsIn(nodes: AnyBlockNode[]): string[] {
  const ids = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return void v.forEach(walk);
    if (!isObj(v)) return;
    if (isBinding(v)) ids.add(v.object_id);
    Object.values(v).forEach(walk);
  };
  for (const n of nodes) {
    if (n.boundObjectId) ids.add(n.boundObjectId);
    walk(n.payload);
  }
  return [...ids];
}


/* ── Series bindings (D · Charts) ─────────────────────────────────────────── */

/**
 * A chart series binding as stored: `{label, object_id, field}`.
 *
 * These must be pulled out BEFORE the scalar walk. `isBinding` fires on anything carrying an
 * `object_id`, so a ChartSeries left to the walk would collapse into a single formatted string —
 * losing the label and, more to the point, losing every period but the anchor.
 */
export interface SeriesBinding {
  label: string;
  object_id: string;
  field: string | null;
}

/** How many points each shape asks the lake for. */
export const SERIES_LIMIT_BY_SHAPE: Record<string, number> = {
  line: 12,
  area: 12,
  // A bar is one CATEGORY, not a time series: each entry resolves to its own single value, and
  // expanding a bar's family would silently turn "who is biggest" into twelve of one company.
  bars: 1,
};

/** Every series binding in a set of nodes, with the shape that decides its point budget. */
export function seriesBindingsIn(
  nodes: { code: string; payload: unknown }[],
): { binding: SeriesBinding; limit: number }[] {
  const out: { binding: SeriesBinding; limit: number }[] = [];
  for (const n of nodes) {
    const payload = n.payload;
    if (!isObj(payload)) continue;
    const shape = typeof payload.shape === "string" ? payload.shape : null;
    const limit = (shape && SERIES_LIMIT_BY_SHAPE[shape]) ?? 0;
    if (!limit) continue;
    for (const entry of asSeriesArray(payload.series)) out.push({ binding: entry, limit });
  }
  return out;
}

function asSeriesArray(v: unknown): SeriesBinding[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((e) =>
    isObj(e) && typeof e.object_id === "string"
      ? [{
          label: typeof e.label === "string" ? e.label : "",
          object_id: e.object_id,
          field: typeof e.field === "string" ? e.field : null,
        }]
      : [],
  );
}

/** One resolved point, as the D-family node types expect it. */
export interface ResolvedPoint {
  label: string;
  date: string | null;
  value: number | null;
  objectId: string;
  state: string;
}

/**
 * Replace each `series[]` binding with `{label, points}`, in place, for chart payloads only.
 *
 * Runs before {@link resolveNode}: after this, a series entry has no bare `object_id` at its top
 * level, so the scalar walk passes over it untouched.
 */
export function applySeries(
  payload: unknown,
  points: Map<string, ResolvedPoint[]>,
): unknown {
  if (!isObj(payload)) return payload;
  const shape = typeof payload.shape === "string" ? payload.shape : null;
  if (!shape || !(shape in SERIES_LIMIT_BY_SHAPE)) return payload;
  const entries = asSeriesArray(payload.series);
  if (entries.length === 0) return payload;
  return {
    ...payload,
    series: entries.map((e) => ({
      label: e.label,
      points: points.get(seriesKey(e.object_id, e.field)) ?? [],
    })),
  };
}

/** Object and field together: the same object charted on two fields is two different series. */
export function seriesKey(objectId: string, field: string | null): string {
  return `${objectId}::${field ?? ""}`;
}
