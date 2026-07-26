/**
 * Research index + Article — view-model contract.
 *
 * CONTRACT LAYER (design 1l + 1k). This is the FE↔BE seam: the sample module
 * in `src/lib/data/sample/` and the real adapter in `src/lib/data/adapters/`
 * are two implementations of THIS type. Swapping a page from sample to live is
 * a one-line change in its `page.tsx`.
 *
 * Law #1 (docs/BRIDGE-BUILD-PLAN.md §0.1): never edit this type to fit a DB
 * column. If the data cannot be served, the adapter returns null/"—" and the
 * gap is logged as a DEF-* row.
 */
export type ArticleTag = "FREE" | "PREMIUM";

// ── Research index (1l) ──────────────────────────────────────────────────────

export interface ResearchCard {
  slug: string;
  topic: string;
  tag: ArticleTag;
  /** Short date, e.g. "28 Jun". */
  date: string;
  headline: string;
  dek: string;
  author: string;
  readMin: number;
}

export interface FeaturedArticle {
  slug: string;
  /** Kicker, e.g. "Featured · Energy". */
  kicker: string;
  tag: ArticleTag;
  headline: string;
  dek: string;
  author: string;
  authorInitials: string;
  /** Mono meta line, e.g. "4 JUL · 21 MIN · MODEL FILE ATTACHED". */
  meta: string;
  photoLabel: string;
}

export interface SubscribeCard {
  cadence: string;
  title: string;
  blurb: string;
}

export interface ResearchIndexData {
  topics: string[];
  featured: FeaturedArticle;
  cards: ResearchCard[];
  subscribe: SubscribeCard[];
}

// ── Article (1k) ─────────────────────────────────────────────────────────────

export interface RatingAttached {
  ticker: string;
  name: string;
  action: string;
  priceTarget: string;
  impliedUpside: number;
}

export type ArticleBlock =
  | { kind: "dropcap"; text: string }
  | { kind: "p"; text: string }
  | { kind: "pullquote"; text: string }
  | { kind: "exhibit"; label: string; title: string; placeholder: string }
  | { kind: "masked"; text: string };

export interface InThisPieceItem {
  ticker: string;
  name: string;
  chgPct: number;
}

export interface RelatedItem {
  slug: string;
  headline: string;
  tag: ArticleTag;
  date: string;
}

export interface Article {
  slug: string;
  section: string;
  tag: ArticleTag;
  headline: string;
  dek: string;
  authorName: string;
  authorRole: string;
  authorInitials: string;
  /** Mono meta line, e.g. "28 JUN 2026 · 24 MIN READ · RATING ATTACHED". */
  meta: string;
  thesis: string[];
  rating: RatingAttached;
  blocks: ArticleBlock[];
  inThisPiece: InThisPieceItem[];
  analyst: { initials: string; name: string; winRate: string };
  related: RelatedItem[];
  paywall: {
    headline: string;
    benefits: string[];
    ctaText: string;
    ctaNote: string;
  };
}
