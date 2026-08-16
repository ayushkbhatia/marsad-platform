import "server-only";

/**
 * Resolve a stored block payload into the shape a renderer draws — the I/O half.
 *
 * ── THE CONTRACT THIS IMPLEMENTS ──────────────────────────────────────────────
 * "The writer never emits a number. It emits a BINDING — {object_id, field} — and the renderer
 * reads the value from lake.objects at render time" (09 §0). That is what makes a fabricated
 * figure structurally impossible rather than statistically unlikely, and what makes a
 * correction work by construction: fix the object once and every citing piece updates.
 *
 * ── WHY THE READ GOES THROUGH A VIEW ──────────────────────────────────────────
 * public.v_content_bound_objects is security_invoker and scoped to live content. Resolving via
 * the service-role client instead would run with RLS OFF and would therefore resolve GATED
 * blocks too — the paywall IS RLS on content_blocks, and this must not route around it.
 */

import { createAnonClient } from "@/lib/supabase/public";
import type { AnyBlockNode } from "@/components/blocks";
import {
  applySeries, bindingIdsIn, resolveNode, seriesBindingsIn, seriesKey,
  type BoundObject, type ResolvedPoint,
} from "./bindings";

export { bindingIdsIn, type BoundObject } from "./bindings";

/**
 * Resolve a whole article's blocks in ONE batched read.
 *
 * Per-block reads would be an N+1 against the lake on every article render; the binding
 * contract only pays for itself if resolving it is cheap.
 */
export async function resolveBlocks(nodes: AnyBlockNode[]): Promise<AnyBlockNode[]> {
  const sb = createAnonClient();

  // ── Series first ──────────────────────────────────────────────────────────
  // A ChartSeries carries an object_id, so leaving it to the scalar walk would collapse a
  // twelve-quarter line into one formatted string. Expanding it here also means the points are
  // already plain data by the time resolveNode runs, and it walks straight over them.
  const withSeries = await resolveSeriesBindings(sb, nodes);

  const ids = bindingIdsIn(withSeries);
  if (ids.length === 0) return withSeries;

  const { data, error } = await sb
    .from("v_content_bound_objects")
    .select("object_id,object_type,state,verification_basis,numeric_value,unit,effective_date,verified_at,payload")
    .in("object_id", ids);

  // A failed read must not fabricate: leave the bindings unresolved so every value renders as
  // an em-dash, and say so. Silence here would look identical to "the lake had no value".
  if (error) {
    console.error(`[blocks:resolve] bound-object read failed (${ids.length} ids): ${error.message}`);
    return withSeries;
  }

  const byId = new Map(((data as BoundObject[] | null) ?? []).map((o) => [o.object_id, o]));
  return withSeries.map((n) => ({ ...n, payload: resolveNode(n.payload, byId) }) as AnyBlockNode);
}

/**
 * Expand every chart series binding into its points.
 *
 * One RPC call per DISTINCT series, deduped across the article — a page with the same revenue
 * line in two exhibits pays once. This is not batched into a single round trip the way the
 * scalar read is, because family expansion is per-anchor by construction; the dedupe is what
 * keeps the count at "one per distinct line on the page" rather than one per block.
 *
 * A failed call leaves that series EMPTY rather than partial. ChartFrame then prints "no data
 * resolved for this exhibit", which is honest; a half-drawn line would not be.
 */
async function resolveSeriesBindings(
  sb: ReturnType<typeof createAnonClient>,
  nodes: AnyBlockNode[],
): Promise<AnyBlockNode[]> {
  const wanted = seriesBindingsIn(nodes as { code: string; payload: unknown }[]);
  if (wanted.length === 0) return nodes;

  const distinct = new Map<string, { binding: (typeof wanted)[number]["binding"]; limit: number }>();
  for (const w of wanted) {
    const k = seriesKey(w.binding.object_id, w.binding.field);
    const prev = distinct.get(k);
    // If two exhibits want the same series at different depths, ask for the deeper one once.
    if (!prev || w.limit > prev.limit) distinct.set(k, w);
  }

  const points = new Map<string, ResolvedPoint[]>();
  await Promise.all(
    [...distinct].map(async ([key, { binding, limit }]) => {
      const { data, error } = await sb.rpc("resolve_bound_series", {
        p_object_id: binding.object_id,
        p_field: binding.field,
        p_limit: limit,
      });
      if (error) {
        console.error(`[blocks:resolve] series read failed for ${binding.object_id}: ${error.message}`);
        points.set(key, []);
        return;
      }
      points.set(
        key,
        ((data as SeriesRow[] | null) ?? []).map((r) => ({
          label: r.x_label ?? "",
          date: r.x_date,
          value: r.y === null ? null : Number(r.y),
          objectId: r.object_id,
          state: r.state,
        })),
      );
    }),
  );

  return nodes.map((n) => ({ ...n, payload: applySeries(n.payload, points) }) as AnyBlockNode);
}

interface SeriesRow {
  x_label: string | null;
  x_date: string | null;
  y: number | string | null;
  unit: string | null;
  object_id: string;
  state: string;
}
