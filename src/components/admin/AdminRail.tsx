import { Suspense } from "react";
import { NavLink } from "./NavLink";
import { ApprovalsBadge } from "./ApprovalsBadge";

export interface AdminRailProps {
  operator?: string;
  role?: string;
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .replace(".", "")
    .toUpperCase()
    .slice(0, 2);
}

/**
 * The dark 240px operator rail (05-desk-admin.md §1, design handoff
 * `AdminRail.dc.html`): wordmark, PRODUCTION/STAGING dot, grouped nav, and
 * the operator card at the foot. Static server component — the only live
 * piece (the Approvals queue-depth badge) is isolated in its own
 * `<Suspense>` boundary via `ApprovalsBadge` so the rail itself paints
 * instantly on every /admin route (CONVENTIONS §3).
 *
 * There is no real auth/session yet (05 §7 is the target; today /admin sits
 * behind proxy.ts HTTP Basic Auth only — see server-admin.ts). `operator`/
 * `role` are therefore an interim static label, same posture as the
 * "Deciding as DESK-OWNER (interim, behind /admin gate)" copy already on
 * the approvals queue.
 */
export function AdminRail({ operator = "Desk Owner", role = "Owner" }: AdminRailProps) {
  // NEXT_PUBLIC_VERCEL_ENV/VERCEL_ENV — a real platform signal, not a guess;
  // falls back to "staging" outside of a production Vercel deploy (incl.
  // local dev) so the badge never mis-claims PRODUCTION.
  const isProd = process.env.VERCEL_ENV === "production";

  return (
    <div className="flex h-full min-h-[900px] w-[240px] flex-none flex-col bg-dark-bg font-ui text-dark-text">
      <div className="border-b border-dark-hairline px-[18px] pt-[18px] pb-3.5">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 flex-none rotate-45 bg-dark-text" aria-hidden />
          <span className="font-mono text-[12px] font-semibold tracking-[0.18em]">MARSAD</span>
          <span className="bg-dark-text px-1.5 py-px font-mono text-[12px] font-semibold tracking-[0.18em] text-dark-bg">
            DESK
          </span>
        </div>
        <div className="mt-2.5 flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${isProd ? "bg-positive-dark" : "bg-caution"}`} />
          <span className={`font-mono text-[7.5px] tracking-[0.16em] ${isProd ? "text-dark-text-faint" : "text-caution"}`}>
            {isProd ? "PRODUCTION" : "STAGING"}
          </span>
        </div>
      </div>

      <nav className="flex-1 py-1.5 pb-3">
        <div className="px-[18px] pt-[18px] pb-[7px] font-mono text-[7.5px] tracking-[0.18em] text-dark-hairline-strong">
          OPERATE
        </div>
        <NavLink href="/admin" label="Dashboard" exact />
        <NavLink
          href="/admin/approvals"
          label="Approvals"
          badge={
            <Suspense fallback={null}>
              <ApprovalsBadge />
            </Suspense>
          }
        />
        <NavLink href="/admin/agents" label="Agents" />

        <div className="px-[18px] pt-[18px] pb-[7px] font-mono text-[7.5px] tracking-[0.18em] text-dark-hairline-strong">
          DATA DESK
        </div>
        <NavLink href="/admin/lake" label="Data lake" />
        <NavLink href="/admin/ops" label="Market ops" />
      </nav>

      <div className="border-t border-dark-hairline px-[18px] py-3.5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 flex-none items-center justify-center bg-dark-text font-ui text-[11px] font-bold text-dark-bg">
            {initialsOf(operator)}
          </span>
          <span className="min-w-0">
            <span className="block truncate font-ui text-[12px] font-semibold">{operator}</span>
            <span className="mt-0.5 block font-mono text-[8px] tracking-[0.12em] text-dark-text-faint">
              {role.toUpperCase()}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
