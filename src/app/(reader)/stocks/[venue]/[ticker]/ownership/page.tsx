import { SAMPLE_STOCK } from "@/lib/data/sample/stock";
import { StockOwnership } from "@/components/reader/stock/StockOwnership";

/**
 * Stock Ownership & People tab (design 3d). Sample-seeded. Real ownership
 * (`holders`/`ownership_snapshots`/`company_people` — all 0 rows) is
 * producer-pending — DEF-STOCK-LIVE-DATA.
 */
export default function StockOwnershipPage() {
  return <StockOwnership ownership={SAMPLE_STOCK.ownership} />;
}
