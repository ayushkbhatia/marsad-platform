/**
 * AI Thesis — view-model contract.
 *
 * CONTRACT LAYER (design 10d). This is the FE↔BE seam: the sample module
 * in `src/lib/data/sample/` and the real adapter in `src/lib/data/adapters/`
 * are two implementations of THIS type. Swapping a page from sample to live is
 * a one-line change in its `page.tsx`.
 *
 * Law #1 (docs/BRIDGE-BUILD-PLAN.md §0.1): never edit this type to fit a DB
 * column. If the data cannot be served, the adapter returns null/"—" and the
 * gap is logged as a DEF-* row.
 */
export interface ThesisClaim {
  text: string;
  citationId?: number; // resolves into `sources`; absent = structural fact
}
export interface FairValue {
  bear: number;
  last: number;
  base: number;
  bull: number;
  basis: string;
}
export interface DatedItem {
  when: string;
  text: string;
}
export interface ThesisSource {
  id: number;
  text: string;
}
export interface AiThesis {
  subject: string; // "AI THESIS · SAUDI ARAMCO"
  generated: string; // "GENERATED 5 JUL · REGENERATES ON MATERIAL FILINGS"
  regenerate: string; // "REGENERATE · 40 CR"
  headline: string;
  bull: ThesisClaim[];
  bear: ThesisClaim[];
  fairValue: FairValue;
  catalysts: DatedItem[];
  falsifiers: string[];
  disclaimer: string;
  twoLenses: {
    score: { value: string; label: string };
    thesis: { verdict: string; label: string };
    note: string;
  };
  sources: ThesisSource[];
}
