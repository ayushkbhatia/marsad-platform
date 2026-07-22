import { SAMPLE_STOCK } from "@/lib/data/sample/stock";
import { StockFilingsConcalls } from "@/components/reader/stock/StockFilingsConcalls";

/**
 * Stock Filings & Concalls tab (design 3c). Sample-seeded. The announcements
 * feed maps to the live `filings` corpus; earnings-call transcripts/AI
 * summaries (`transcripts` = 0 rows) are producer-pending — DEF-STOCK-LIVE-DATA.
 */
export default function StockFilingsPage() {
  return <StockFilingsConcalls filings={SAMPLE_STOCK.filings} />;
}
