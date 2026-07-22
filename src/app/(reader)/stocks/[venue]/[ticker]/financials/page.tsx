import { SAMPLE_STOCK } from "@/lib/data/sample/stock";
import { StockFinancials } from "@/components/reader/stock/StockFinancials";

/**
 * Stock Financials tab (design 3b). Sample-seeded. Real financials
 * (`financial_statements` — worker-only, premium/service-role) re-wire via
 * DEF-STOCK-LIVE-DATA; the wave-1 `PremiumLock` gate is the adapter basis.
 */
export default function StockFinancialsPage() {
  return <StockFinancials financials={SAMPLE_STOCK.financials} />;
}
