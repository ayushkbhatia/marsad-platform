import { SAMPLE_THESIS } from "@/lib/data/sample/thesis";
import { StockThesis } from "@/components/reader/stock/StockThesis";

/**
 * Stock AI Thesis tab (design 10d). Sample-seeded — the real thesis is an LLM
 * generation over `filings`/`transcripts`, credit-gated, computed independently
 * of the quant Marsad Score (DEF-THESIS-LIVE-DATA). Template: every
 * `[venue]/[ticker]` renders the Aramco thesis for the design pass.
 */
export default function StockThesisPage() {
  return <StockThesis thesis={SAMPLE_THESIS} />;
}
