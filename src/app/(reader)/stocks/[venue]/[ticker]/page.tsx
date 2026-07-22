import { SAMPLE_STOCK } from "@/lib/data/sample/stock";
import { StockOverview } from "@/components/reader/stock/StockOverview";

/**
 * Stock Overview tab (design 3a). Sample-seeded — the shared shell + tab bar
 * live in the segment `layout.tsx`; this renders the Overview body from
 * `SAMPLE_STOCK.overview`. Real per-ticker overview (`getStockOverview`,
 * `getOhlcvSeries`, `v_key_ratios_public`, peers) re-wires via
 * DEF-STOCK-LIVE-DATA.
 */
export default function StockOverviewPage() {
  return <StockOverview overview={SAMPLE_STOCK.overview} />;
}
