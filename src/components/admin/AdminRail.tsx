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

/** Rail nav model — shared by the live (usePathname) render and the static
 * prerender fallback so they never drift. */
const RAIL_NAV: ReadonlyArray<{
  group: string;
  items: ReadonlyArray<{ href: string; label: string; exact?: boolean; badge?: boolean }>;
}> = [
  {
    group: "OPERATE",
    items: [
      { href: "/admin", label: "Dashboard", exact: true },
      { href: "/admin/approvals", label: "Approvals", badge: true },
      { href: "/admin/agents", label: "Agents" },
    ],
  },
  {
    group: "DATA DESK",
    items: [
      { href: "/admin/lake", label: "Data lake" },
      { href: "/admin/ops", label: "Market ops" },
    ],
  },
];

/** Static (non-active) rail nav for the prerender shell — NavLink reads
 * usePathname (request-time), so the live nav must sit under a Suspense
 * boundary and this paints until it hydrates (cacheComponents rule). */
function RailNavFallback() {
  return (
    <nav className="flex-1 py-1.5 pb-3" aria-hidden>
      {RAIL_NAV.map((g) => (
        <div key={g.group}>
          <div className="px-[18px] pt-[18px] pb-[7px] font-mono text-[7.5px] tracking-[0.18em] text-ink-muted">
            {g.group}
          </div>
          {g.items.map((it) => (
            <span
              key={it.href}
              className="flex items-center gap-[9px] border-l-2 border-transparent px-4 py-[9px] text-dark-text-faint"
            >
              <span className="font-ui text-[11.5px] font-medium">{it.label}</span>
            </span>
          ))}
        </div>
      ))}
    </nav>
  );
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
    <div className="flex h-full min-h-[900px] w-[240px] flex-none flex-col bg-ink font-ui text-paper-tint">
      <div className="border-b border-ink-soft px-[18px] pt-[18px] pb-3.5">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 flex-none rotate-45 bg-paper-tint" aria-hidden />
          <span className="font-mono text-[12px] font-semibold tracking-[0.18em]">MARSAD</span>
          <span className="bg-paper-tint px-1.5 py-px font-mono text-[12px] font-semibold tracking-[0.18em] text-ink">
            DESK
          </span>
        </div>
        <div className="mt-2.5 flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${isProd ? "bg-positive-dark" : "bg-caution"}`} />
          <span className={`font-mono text-[7.5px] tracking-[0.16em] ${isProd ? "text-ink-faint" : "text-caution"}`}>
            {isProd ? "PRODUCTION" : "STAGING"}
          </span>
        </div>
      </div>

      <Suspense fallback={<RailNavFallback />}>
        <nav className="flex-1 py-1.5 pb-3">
          {RAIL_NAV.map((g) => (
            <div key={g.group}>
              <div className="px-[18px] pt-[18px] pb-[7px] font-mono text-[7.5px] tracking-[0.18em] text-ink-muted">
                {g.group}
              </div>
              {g.items.map((it) => (
                <NavLink
                  key={it.href}
                  href={it.href}
                  label={it.label}
                  exact={it.exact}
                  badge={
                    it.badge ? (
                      <Suspense fallback={null}>
                        <ApprovalsBadge />
                      </Suspense>
                    ) : undefined
                  }
                />
              ))}
            </div>
          ))}
        </nav>
      </Suspense>

      <div className="border-t border-ink-soft px-[18px] py-3.5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 flex-none items-center justify-center bg-paper-tint font-ui text-[11px] font-bold text-ink">
            {initialsOf(operator)}
          </span>
          <span className="min-w-0">
            <span className="block truncate font-ui text-[12px] font-semibold">{operator}</span>
            <span className="mt-0.5 block font-mono text-[8px] tracking-[0.12em] text-ink-faint">
              {role.toUpperCase()}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
