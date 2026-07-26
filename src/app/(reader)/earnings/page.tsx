import type { Metadata } from "next";
import { SAMPLE_EARNINGS } from "@/lib/data/sample/calendars";
import { EarningsCalendar } from "@/components/reader/calendars/EarningsCalendar";

/**
 * Earnings calendar — design screen 8a. Sample-seeded: `earnings_events` has
 * rows but the design's signature columns (street consensus, the MARSAD desk
 * estimate, the confirmed/estimate week-forward view) are unbacked
 * (`eps_consensus`/`eps_marsad` NULL; `report_date` a uniform ingest stamp).
 * Real reads (`getEarningsCalendar`/`getEarningsAhead`/`getEarningsKpis`) are
 * the adapter basis (DEF-CALENDARS-LIVE-DATA). Fully static, prerenders.
 */
export const metadata: Metadata = {
  title: "Earnings Calendar",
  description: "The MENA reporting week — street consensus vs the Marsad desk estimate, by day.",
};

export default function EarningsPage() {
  return (
    <div className="bg-paper">
      <div className="mx-auto max-w-[1440px]">
        <EarningsCalendar data={SAMPLE_EARNINGS} />
      </div>
    </div>
  );
}
