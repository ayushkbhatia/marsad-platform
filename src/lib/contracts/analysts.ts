/**
 * Coverage Desk + Analyst Profile — view-model contract.
 *
 * CONTRACT LAYER (design 1i + 1j). This is the FE↔BE seam: the sample module
 * in `src/lib/data/sample/` and the real adapter in `src/lib/data/adapters/`
 * are two implementations of THIS type. Swapping a page from sample to live is
 * a one-line change in its `page.tsx`.
 *
 * Law #1 (docs/BRIDGE-BUILD-PLAN.md §0.1): never edit this type to fit a DB
 * column. If the data cannot be served, the adapter returns null/"—" and the
 * gap is logged as a DEF-* row.
 */
import type { ArticleTag } from "./research";
export interface LeaderboardAnalyst {
  rank: number;
  slug: string;
  initials: string;
  name: string;
  focus: string;
  names: number;
  winRate: number;
  avgReturn: number;
  /** Last five closed calls, newest-left; true = beat the index (green). */
  last5: boolean[];
  /** Follower count, pre-formatted, e.g. "12.4k". */
  followers: string;
}

export interface DeskArticle {
  slug: string;
  tag: ArticleTag;
  headline: string;
  /** Mono byline line, e.g. "Faisal Rahman · Utilities · 18 min read". */
  byline: string;
}

export type RatingChangeType = "UPGRADE" | "DOWNGRADE" | "PT RAISE" | "PT CUT" | "INITIATION";

export interface RatingChange {
  direction: "up" | "down";
  type: RatingChangeType;
  ticker: string;
  date: string;
  note: string;
  analyst: string;
}

export interface SectorBar {
  sector: string;
  count: number;
  /** Bar width in px (design-baked, so the ramp matches 1i exactly). */
  barWidth: number;
}

export interface CoverageDeskData {
  subtitle: string;
  analysts: LeaderboardAnalyst[];
  latest: DeskArticle[];
  ratingsChanges: RatingChange[];
  sectors: SectorBar[];
  totalNames: number;
  requestCoverage: { leadName: string; votes: number };
}

// ── Analyst Profile (1j) ─────────────────────────────────────────────────────

export interface ProfileStat {
  label: string;
  value: string;
  dir?: "up" | "down";
}

export interface CoverageRow {
  ticker: string;
  company: string;
  rating: string;
  target: string;
  since: string;
  callReturn: number;
  venueCode: string;
}

export interface PublishedResearch {
  slug: string;
  tag: ArticleTag;
  headline: string;
  /** Mono meta, e.g. "28 Jun · 24 min · 214 reactions". */
  meta: string;
}

export interface PerfChart {
  width: number;
  height: number;
  gridY: number[];
  analystPoints: string;
  venuePoints: string;
  rightLabels: Array<{ top: number; text: string }>;
  months: string[];
  legendAnalyst: string;
  legendVenue: string;
}

export interface AnalystProfile {
  slug: string;
  initials: string;
  name: string;
  rank: number;
  credential: string;
  bio: string;
  followers: string;
  stats: ProfileStat[];
  chart: PerfChart;
  coverage: CoverageRow[];
  pinnedCall: { date: string; quote: string; ticker: string; returnSince: string };
  publishedResearch: PublishedResearch[];
  publishedCount: string;
  disclosure: string;
}
