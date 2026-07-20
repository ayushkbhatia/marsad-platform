"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { decideApproval, type Decision } from "@/lib/desk/approvals";

/**
 * The one Server Action behind the approval-queue buttons. Calls public.desk_approve
 * (→ ops.desk_decide_approval: capability + RULES_STALE guarded, all-or-nothing). On
 * an RPC error (stale rules, missing note, wrong stage) it re-renders the detail page
 * with the message rather than throwing; on success it revalidates + returns to the queue.
 */
export async function decideAction(formData: FormData): Promise<void> {
  const itemId = Number(formData.get("item_id"));
  const decision = String(formData.get("decision")) as Decision;
  const note = (formData.get("note") as string | null)?.trim() || null;
  const scheduledFor = (formData.get("scheduled_for") as string | null)?.trim() || null;

  if (!itemId || !decision) redirect(`/admin/approvals?err=${encodeURIComponent("missing item or decision")}`);

  const res = await decideApproval(itemId, decision, { note, scheduledFor });
  if (!res.ok) {
    redirect(`/admin/approvals/${itemId}?err=${encodeURIComponent(res.error)}`);
  }
  revalidatePath("/admin/approvals");
  revalidatePath(`/admin/approvals/${itemId}`);
  redirect(`/admin/approvals?done=${encodeURIComponent(`${decision} · #${itemId}`)}`);
}
