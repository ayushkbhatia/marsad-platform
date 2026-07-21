import { listApprovals } from "@/lib/desk/approvals";

/**
 * Live queue-depth badge for the rail's "Approvals" nav row. Isolated in its
 * own async server component so `AdminRail` can wrap just this one row in
 * `<Suspense>` — the rest of the rail stays a static, instantly-painted
 * shell (CONVENTIONS §3) while this one live read streams in.
 */
export async function ApprovalsBadge() {
  // Compute the count before any JSX is constructed — eslint's
  // react-hooks/error-boundaries rule (rightly) flags JSX built inside a
  // try/catch, since React doesn't render synchronously within it.
  let count = 0;
  try {
    count = (await listApprovals()).length;
  } catch {
    // Never let a live-count fetch break the rail — badge just omits.
    count = 0;
  }
  if (count === 0) return null;
  return <>{count}</>;
}
