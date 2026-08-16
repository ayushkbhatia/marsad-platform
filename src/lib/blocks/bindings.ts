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

