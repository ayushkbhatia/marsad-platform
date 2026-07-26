/**
 * AI Thesis (10d) — a stock-workspace tab. SAMPLE content.
 *
 * TWO INDEPENDENT LENSES on one name: the quant Marsad Score is computed
 * independently of this narrative AI thesis — when they disagree, the
 * disagreement is itself the signal. Do NOT derive one from the other. Every
 * AI claim carries a numbered citation resolving to THESIS SOURCES; the one
 * uncited bear bullet is a structural fact, not an assertion. Sample-driven —
 * the real thesis comes from an LLM over `filings`/`transcripts` gated on
 * credits (DEF-THESIS-LIVE-DATA).
 */
import type { AiThesis } from "@/lib/contracts/thesis";
export const SAMPLE_THESIS: AiThesis = {
  subject: "AI THESIS · SAUDI ARAMCO",
  generated: "GENERATED 5 JUL · REGENERATES ON MATERIAL FILINGS",
  regenerate: "REGENERATE · 40 CR",
  headline: "Gas is becoming the earnings story; the market still prices a crude proxy.",
  bull: [
    { text: "Gas revenue share +180 bp y/y to 11.4%; Jafurah P3 sanctioned two quarters early", citationId: 1 },
    { text: "Base dividend held through a $40 trough; FCF covers it to $58 Brent on FY25 costs", citationId: 2 },
    { text: "Net debt/EBITDA 0.28× leaves sukuk headroom for the build-out", citationId: 3 },
  ],
  bear: [
    { text: "Earnings still 88% crude-linked; sub-$65 Brent compresses the equity story", citationId: 4 },
    { text: "Performance dividend suspended Q2 — a signal payouts flex before capex does", citationId: 5 },
    { text: "2.6% free float: any government sell-down doubles tradable supply" },
  ],
  fairValue: { bear: 23.5, last: 27.15, base: 29.8, bull: 34.2, basis: "DCF × 3 OIL DECKS · FY25 BASIS" },
  catalysts: [
    { when: "4 AUG", text: "H1 results: gas segment split disclosed for the first time" },
    { when: "SEP", text: "Jafurah P2 first-gas guidance update" },
    { when: "Q4", text: "Performance-dividend review at H2 board" },
  ],
  falsifiers: [
    "Jafurah unit costs printing above the P1/P2 curve",
    "Base dividend cut (not the performance layer)",
    "A government placement widening the float",
  ],
  disclaimer:
    "Generated from filings & transcripts · not investment advice · the quant Marsad Score (76 · BUY) is computed independently — see Score →",
  twoLenses: {
    score: { value: "76", label: "QUANT · BUY" },
    thesis: { verdict: "Constructive, gas-led", label: "NARRATIVE · CITED" },
    note: "When the two disagree, that disagreement is itself the signal — the desk flags it in coverage.",
  },
  sources: [
    { id: 1, text: "FY25 annual report, p.47 — gas segment" },
    { id: 2, text: "Desk model — dividend stress test" },
    { id: 3, text: "FY25 balance sheet — leverage" },
    { id: 4, text: "Q1 2026 call transcript, p.9" },
    { id: 5, text: "CG-1 dividend resolution, 5 Jul" },
  ],
};
