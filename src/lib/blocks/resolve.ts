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
import { bindingIdsIn, resolveNode, type BoundObject } from "./bindings";

export { bindingIdsIn, type BoundObject } from "./bindings";

/**
 * Resolve a whole article's blocks in ONE batched read.
 *
 * Per-block reads would be an N+1 against the lake on every article render; the binding
 * contract only pays for itself if resolving it is cheap.
 */
export async function resolveBlocks(nodes: AnyBlockNode[]): Promise<AnyBlockNode[]> {
  const ids = bindingIdsIn(nodes);
  if (ids.length === 0) return nodes;

  const sb = createAnonClient();
  const { data, error } = await sb
    .from("v_content_bound_objects")
    .select("object_id,object_type,state,verification_basis,numeric_value,unit,effective_date,verified_at,payload")
    .in("object_id", ids);

  // A failed read must not fabricate: leave the bindings unresolved so every value renders as
  // an em-dash, and say so. Silence here would look identical to "the lake had no value".
  if (error) {
    console.error(`[blocks:resolve] bound-object read failed (${ids.length} ids): ${error.message}`);
    return nodes;
  }

  const byId = new Map(((data as BoundObject[] | null) ?? []).map((o) => [o.object_id, o]));
  return nodes.map((n) => ({ ...n, payload: resolveNode(n.payload, byId) }) as AnyBlockNode);
}
