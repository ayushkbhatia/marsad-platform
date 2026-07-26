import type { Metadata } from "next";
import { SAMPLE_ALERTS } from "@/lib/data/sample/alerts";
import { AlertsManager } from "@/components/reader/alerts/AlertsManager";

/**
 * Alerts manager — design screen 5a. MEMBER surface (per-user alerts), shipped
 * ungated with a shared sample set during the design pass — no `(auth)` group
 * yet, and the caps (`billing.consume_meter` / `usage_meters`) have 0 rows.
 * Real wiring re-gates + swaps the sample (DEF-ALERTS-LIVE-DATA). Static,
 * prerenders. `noindex` — a member surface, not public content.
 */
export const metadata: Metadata = {
  title: "Alerts",
  description: "Price, score, event, screen and phrase alerts across GCC venues — with delivery channels and quiet hours.",
  robots: { index: false, follow: false },
};

export default function AlertsPage() {
  return (
    <div className="bg-paper">
      <div className="mx-auto max-w-[1440px]">
        <AlertsManager data={SAMPLE_ALERTS} />
      </div>
    </div>
  );
}
