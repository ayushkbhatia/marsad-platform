import "server-only";
import type {
  Article,
  ArticleBlock,
  ArticleTag,
  ResearchCard,
  ResearchIndexData,
  FeaturedArticle,
  RelatedItem,
} from "@/lib/contracts/research";
import type { ArticleDetail, ArticleSummary } from "@/lib/data/editorial";
import {
  getArticleBySlug,
  listResearchArticles,
  getArticleSectionFacets,
  getRelatedArticles,
} from "@/lib/data/editorial";
import { fmtDate, fmtPrice, sectorLabel } from "@/lib/reader/format";

/**
 * ADAPTER: `content_items` / `content_blocks` → the research contracts
 * (design 1l index + 1k article).
 *
 * This un-orphans `src/lib/data/editorial.ts`, which was fully written in
 * wave-2 and then had all eight of its reads stranded when the design pass
 * replaced the pages with samples.
 *
 * THE PREMIUM CUT IS REAL HERE, not cosmetic. `content_blocks` RLS returns only
 * ungated blocks to an anon reader (`jwt_tier() = 'free'`), so a gated block is
 * physically ABSENT from the response — it never reaches the HTML. The previous
 * sample implementation faked this with a CSS mask while shipping the full text
 * in the page source, which is not a paywall at all.
 *
 * HONEST DEGRADATION:
 * - `rating` is null unless the piece carries a real `rating_attachment`.
 * - `analyst` is null for house-bylined pieces. A win rate is a performance
 *   claim about a named person; it renders only for a real analyst with real
 *   closed calls (DEF-ANALYSTS-LIVE-DATA).
 * - `featured` is null when nothing is published.
 */
const DEFAULT_TOPICS = ["All research"];

function tagOf(isPremium: boolean): ArticleTag {
  return isPremium ? "PREMIUM" : "FREE";
}

function bylineName(byline: ArticleDetail["byline"] | ArticleSummary["byline"]): string {
  const first = byline?.[0];
  const name = (first as { name?: string } | undefined)?.name;
  return (name ?? "Marsad Desk").trim() || "Marsad Desk";
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

/** `content_blocks.block_kind` → the design's block union. */
function toBlocks(blocks: ArticleDetail["blocks"]): ArticleBlock[] {
  return blocks
    .filter((b) => (b.text ?? "").trim().length > 0)
    .map((b, i): ArticleBlock => {
      const text = (b.text ?? "").trim();
      switch (b.kind) {
        case "pullquote":
          return { kind: "pullquote", text };
        case "dropcap":
          return { kind: "dropcap", text };
        default:
          // The design opens the body with a drop cap; the writer does not mark
          // it, so the first prose block earns it.
          return i === 0 ? { kind: "dropcap", text } : { kind: "p", text };
      }
    });
}

function toCard(a: ArticleSummary): ResearchCard {
  return {
    slug: a.slug,
    topic: sectorLabel(a.section) || a.section || "Research",
    tag: tagOf(a.isPremium),
    date: fmtDate(a.publishedAt),
    headline: a.headline,
    dek: a.dek ?? "",
    author: bylineName(a.byline),
    readMin: a.readMinutes ?? 0,
  };
}

function toFeatured(a: ArticleSummary): FeaturedArticle {
  const author = bylineName(a.byline);
  return {
    slug: a.slug,
    kicker: `Featured · ${sectorLabel(a.section) || a.section || "Research"}`,
    tag: tagOf(a.isPremium),
    headline: a.headline,
    dek: a.dek ?? "",
    author,
    authorInitials: initialsOf(author),
    meta: [fmtDate(a.publishedAt), a.readMinutes ? `${a.readMinutes} MIN` : null]
      .filter(Boolean)
      .join(" · ")
      .toUpperCase(),
    // No image pipeline exists (`content_attachments` is 0 rows), so the design's
    // photo plate stays a labelled placeholder rather than a fake credit.
    photoLabel: "",
  };
}

export async function buildResearchIndex(): Promise<ResearchIndexData | null> {
  const [articles, facets] = await Promise.all([
    listResearchArticles({ limit: 25 }),
    getArticleSectionFacets(),
  ]);
  if (articles.length === 0) return null;

  const topics = [
    ...DEFAULT_TOPICS,
    ...facets.map((f) => sectorLabel(f.section) || f.section).filter(Boolean),
  ];

  const [first, ...rest] = articles;
  return {
    topics,
    featured: toFeatured(first),
    cards: rest.map(toCard),
    // Static editorial promos — product copy, not data about a company.
    subscribe: [
      {
        cadence: "DAILY",
        title: "The Wire Brief",
        blurb: "Every material GCC disclosure, summarised before the open.",
      },
      {
        cadence: "WEEKLY",
        title: "The Marsad Note",
        blurb: "One argument a week from the desk, with the workings attached.",
      },
    ],
  };
}

export async function buildArticle(slug: string): Promise<Article | null> {
  const a = await getArticleBySlug(slug);
  if (!a) return null;

  const related = await getRelatedArticles(a.id, 3);
  const author = bylineName(a.byline);

  const meta = [
    fmtDate(a.publishedAt),
    a.readMinutes ? `${a.readMinutes} MIN READ` : null,
    a.rating ? "RATING ATTACHED" : null,
    a.retractionNotice ? "RETRACTED" : null,
  ]
    .filter(Boolean)
    .join(" · ")
    .toUpperCase();

  return {
    slug: a.slug,
    section: sectorLabel(a.section) || a.section || "Research",
    tag: tagOf(a.isPremium),
    headline: a.headline,
    dek: a.dek ?? "",
    authorName: author,
    authorRole: "Marsad Desk",
    authorInitials: initialsOf(author),
    meta,
    // The design's standfirst bullets have no column — the dek carries the
    // summary and the body carries the argument.
    thesis: [],
    rating:
      a.rating && a.rating.ticker
        ? {
            ticker: a.rating.ticker,
            name: a.rating.name ?? "",
            action: a.rating.rating ?? "",
            // Formatted here, not in the component — the contract is a string.
            priceTarget: a.rating.priceTarget != null ? fmtPrice(a.rating.priceTarget, 2) : "—",
            impliedUpside: a.rating.impliedUpsidePct ?? 0,
          }
        : null,
    blocks: toBlocks(a.blocks),
    inThisPiece: a.tickers.map((t) => ({
      ticker: t.ticker,
      name: t.name,
      chgPct: t.changePct ?? 0,
    })),
    // House byline → no individual, and therefore no win rate.
    analyst: null,
    related: related.map(
      (r): RelatedItem => ({
        slug: r.slug,
        headline: r.headline,
        tag: tagOf(r.isPremium),
        date: fmtDate(r.publishedAt),
      }),
    ),
    paywall: {
      headline: "Read the rest with Premium",
      benefits: [
        "Every desk piece in full, including the workings",
        "Marsad Scores and factor grades on 762 GCC names",
        "Full financial-statement history and CSV export",
      ],
      ctaText: "Go Premium",
      ctaNote: "Subscription required",
    },
  };
}

/** Does this article withhold blocks from an anon reader? Drives the paywall. */
export function isGated(a: Article, detail: { hasGatedRemainder: boolean }): boolean {
  return a.tag === "PREMIUM" && detail.hasGatedRemainder;
}
