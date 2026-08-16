import { createAdminClient } from "@/lib/supabase/server-admin";
import type { BoundObject } from "@/lib/blocks/bindings";

/**
 * P3.5 Desk approvals — data access. All reads/actions go through the public
 * wrappers (v_desk_approvals / desk_approval_detail / desk_approve) because ops.*
 * and lake.* are not PostgREST-exposed. The service-role client bypasses RLS; the
 * /admin route is gated by HTTP Basic Auth (proxy.ts) until real per-user auth (P5).
 */

export interface ApprovalRow {
  item_id: number;
  content_id: string;
  content_type: string;
  template_key: string | null;
  headline: string;
  dek: string | null;
  word_count: number | null;
  is_premium: boolean;
  priority: string | null;
  stage_entered_at: string;
  approval_sla: string; // interval as text
  sla_breached_at: string | null;
  sla_over: boolean;
  rules_passed_version: number | null;
  live_ruleset: number | null;
  rules_stale: boolean;
  ticker: string | null;
  venue_code: string | null;
  security_name: string | null;
  citation_count: number;
  warn_count: number;
}

export interface CitationRow {
  claim_key: string | null;
  object_id: string;
  object_type: string | null;
  object_state: string | null;
  quoted_value: string | null;
  claim: string | null;
}
export interface BlockRow {
  seq: number;
  kind: string;
  body: { text?: string } | Record<string, unknown>;
  gated: boolean;
  /** Which lake object this block binds, if any — the desk resolves it to show the figure. */
  bound_object_id?: string | null;
}
export interface ViolationRow {
  rule_key: string;
  outcome: string;
  detail: Record<string, unknown>;
}
export interface ApprovalDetail {
  item: ApprovalRow | null;
  blocks: BlockRow[];
  /**
   * Resolved lake values for every object the blocks bind, keyed by object id.
   *
   * Supplied by the RPC rather than read from v_content_bound_objects, which is scoped to LIVE
   * content by design — a piece at approval is not live, so the reader's view returns nothing
   * for it.
   */
  bound_values: Record<string, BoundObject>;
  citations: CitationRow[];
  violations: ViolationRow[];
}

export async function listApprovals(): Promise<ApprovalRow[]> {
  const sb = createAdminClient();
  const { data, error } = await sb.from("v_desk_approvals").select("*");
  if (error) throw new Error(error.message);
  return (data ?? []) as ApprovalRow[];
}

export async function getApprovalDetail(itemId: number): Promise<ApprovalDetail> {
  const sb = createAdminClient();
  const { data, error } = await sb.rpc("desk_approval_detail", { p_item: itemId });
  if (error) throw new Error(error.message);
  return (data ?? {
    item: null, blocks: [], citations: [], violations: [], bound_values: {},
  }) as ApprovalDetail;
}

export type Decision = "approve" | "approve_scheduled" | "send_back" | "reassign";

/** Returns { ok } or { error } — the RPC raises on bad input / capability / RULES_STALE. */
export async function decideApproval(
  itemId: number,
  decision: Decision,
  opts: { scheduledFor?: string | null; note?: string | null } = {},
): Promise<{ ok: true; decision: string } | { ok: false; error: string }> {
  const sb = createAdminClient();
  const { data, error } = await sb.rpc("desk_approve", {
    p_item: itemId,
    p_decision: decision,
    p_scheduled_for: opts.scheduledFor ?? null,
    p_note: opts.note ?? null,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, decision: String(data) };
}
