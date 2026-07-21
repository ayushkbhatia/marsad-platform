import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AdminRail } from "@/components/admin/AdminRail";

export const metadata: Metadata = {
  title: { template: "%s · Marsad Desk", default: "Marsad Desk" },
  robots: { index: false, follow: false },
};

/**
 * The Marsad Desk shell (05-desk-admin.md §1): dark 240px `AdminRail` on the
 * left, paper canvas on the right. Wraps every `/admin/*` route. Plain sync
 * server component — no data reads here (the rail's one live number, the
 * approvals badge, carries its own `<Suspense>`, see `AdminRail.tsx`), so
 * this layout never itself needs `connection()`/`use cache` gymnastics.
 *
 * Desk is desktop-only by design (05 §1): below 1024px this renders an
 * interstitial instead of attempting a responsive admin UI. Auth today is
 * `proxy.ts` HTTP Basic Auth in front of the whole `/admin/*` tree (interim,
 * until 05 §7's real principal/RLS model lands) — this layout does not
 * re-check it.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-paper">
      <div className="hidden min-h-screen lg:flex lg:items-stretch">
        <AdminRail />
        <div className="flex min-h-screen min-w-0 flex-1 flex-col bg-paper">{children}</div>
      </div>
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-dark-bg px-10 text-center lg:hidden">
        <span className="h-2.5 w-2.5 rotate-45 bg-dark-text" aria-hidden />
        <p className="max-w-[320px] font-ui text-[13px] leading-relaxed text-dark-text-faint">
          Marsad Desk is an operator console built for a desktop browser (1024px or wider).
        </p>
      </div>
    </div>
  );
}
