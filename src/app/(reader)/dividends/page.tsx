import type { Metadata } from "next";
import { SAMPLE_DIVIDENDS } from "@/lib/data/sample/calendars";
import { DividendCalendar } from "@/components/reader/calendars/DividendCalendar";

/**
 * Dividend calendar — design screen 23a. Sample-seeded: `public.dividends` has
 * 0 `state='live'` rows and NULL ex/pay dates (producer-pending), so the
 * ex-date ledger is unbacked today. Real reads
 * (`getDividendCalendar`/`getDividendYieldLeaders`/`getDividendKpis`) are the
 * adapter basis (DEF-CALENDARS-LIVE-DATA). Fully static, prerenders.
 */
export const metadata: Metadata = {
  title: "Dividend Calendar",
  description: "GCC ex-dates, payouts and yields by day — with cut-risk flags on payout > 100%.",
};

export default function DividendsPage() {
  return (
    <div className="bg-paper">
      <div className="mx-auto max-w-[1440px]">
        <DividendCalendar data={SAMPLE_DIVIDENDS} />
      </div>
    </div>
  );
}
