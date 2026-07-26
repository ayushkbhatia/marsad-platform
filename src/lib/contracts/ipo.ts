/**
 * IPO Center — view-model contract.
 *
 * CONTRACT LAYER (design 22a-22c). This is the FE↔BE seam: the sample module
 * in `src/lib/data/sample/` and the real adapter in `src/lib/data/adapters/`
 * are two implementations of THIS type. Swapping a page from sample to live is
 * a one-line change in its `page.tsx`.
 *
 * Law #1 (docs/BRIDGE-BUILD-PLAN.md §0.1): never edit this type to fit a DB
 * column. If the data cannot be served, the adapter returns null/"—" and the
 * gap is logged as a DEF-* row.
 */
import type { Kpi } from "./calendars";
export interface PipelineOffer {
  ticker: string; // "—" when no ticker yet
  company: string;
  venue: string;
  priceRange: string; // may be "TBD" / "CMA FILING 2 JUL" / "DRAFT PROSPECTUS"
  raise: string;
  closes: string;
  /** The RETAIL-CLOSES cell is an ink countdown chip (subscription open). */
  closesChip?: boolean;
  covered: string; // "3.1×" / "INST ONLY" / ""
  coveredMuted?: boolean;
}
export interface PipelineStage {
  label: string;
  meta: string;
  offers: PipelineOffer[];
}
export interface JustListed {
  ticker: string;
  company: string;
  venue: string;
  price: string;
  changePct: number;
  listed: string;
}
export interface IpoPipelineData {
  kpis: Kpi[];
  stages: PipelineStage[];
  justListed: JustListed[];
  neverMiss: { kicker: string; headline: string; body: string; cta: string };
  howItWorks: string[];
}


export type TimelineState = "done" | "current" | "future";
export interface TimelineStep {
  label: string;
  value: string;
  state: TimelineState;
}
export interface KeyVal {
  label: string;
  value: string;
}
export interface ProceedsRow {
  label: string;
  pct: string;
  barWidth: number;
}
export interface IpoFinRow {
  label: string;
  values: string[];
}
export interface IpoOfferDetail {
  slug: string;
  ticker: string;
  company: string;
  meta: string;
  statusChip: string;
  timeline: TimelineStep[];
  facts: KeyVal[];
  useOfProceeds: ProceedsRow[];
  proceedsNote: string;
  financials: { periods: string[]; rows: IpoFinRow[] };
  countdown: { kicker: string; value: string; sub: string; cta: string };
  brokers: string[];
  marsadTake: { headline: string; body: string; cta: string };
}


export interface ListingKpi {
  label: string;
  value: string;
  delta?: string;
  dir?: "up" | "down";
}
export interface AllocationRow {
  label: string;
  value: string;
}
export interface ListedPeer {
  ticker: string;
  company: string;
  venue: string;
  price: string;
  changePct: number;
  scoreRating: string;
}
export interface IpoListingData {
  slug: string;
  ticker: string;
  company: string;
  meta: string;
  liveLabel: string;
  kpis: ListingKpi[];
  chart: { offerY: number; points: string; offerLabel: string; openLabel: string; openTop: number };
  chartCaptions: string[];
  wire: { kicker: string; headline: string; cta: string };
  allocation: AllocationRow[];
  scorePending: string;
  scoreExpectedDate: string;
  listedPeers: ListedPeer[];
}
