import type { MetadataRoute } from "next";
import { listSecurityParams } from "@/lib/securities/resolve";
import { listRecentFilingRefs } from "@/lib/data/filings";
import { listPublishedArticleSlugs } from "@/lib/data/editorial";
import { listPublishedWireSlugs } from "@/lib/data/newsroom";
import { siteUrl } from "@/lib/reader/format";
import { LEARN_DOCS } from "@/lib/learn/docs";

/** Indexable subpages under every `/stocks/[venue]/[ticker]` (04-reader-app §8
 * calls out "stock pages + subpages"). `financials` is a premium STUB page
 * (no statement data ever reaches it — see that route's header comment) but
 * still a real, unique-per-ticker page, so it stays indexable like the rest. */
const STOCK_SUBPAGES = ["chart", "filings", "financials", "dividends", "earnings", "ownership", "thesis"] as const;

/**
 * Split-ish sitemap (04-reader-app.md §8): the indexable public surface —
 * static entries (ledger, markets, wire, the calendars, filings register),
 * every public stock page + its subpages (`/stocks/[venue]/[ticker]/...`, the
 * SEO backbone), and recent filing detail pages (machine-extracted text is
 * strong long-tail SEO), and every PUBLISHED editorial piece — articles and
 * wire briefs (build-plan step **P3.8**: `listPublishedArticleSlugs` /
 * `listPublishedWireSlugs` were written in wave-2 and never called, so nothing
 * the newsroom published was ever discoverable). Both readers go through the
 * cookieless anon client, so RLS — not a status filter in this file — is what
 * keeps drafts out: `content_items` only exposes `status in
 * ('live','updated','retracted')` to anon. All data reads go through `use cache` readers over
 * the anon client, so this special file stays cached (no request-time API)
 * and is cheap to regenerate. `noindex` surfaces (heatmap, screener, screens,
 * compare) are intentionally excluded — they opt out via per-page `robots`
 * metadata instead (robots.ts explains why they aren't blocked outright).
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();

  const [secs, filings, articles, wires] = await Promise.all([
    listSecurityParams(),
    listRecentFilingRefs(10000), // ~13.5k total; cap to the most recent, well under the 50k limit
    listPublishedArticleSlugs(),
    listPublishedWireSlugs(),
  ]);

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${base}/`, changeFrequency: "hourly", priority: 1 },
    { url: `${base}/markets`, changeFrequency: "hourly", priority: 0.9 },
    { url: `${base}/wire`, changeFrequency: "hourly", priority: 0.8 },
    { url: `${base}/filings`, changeFrequency: "hourly", priority: 0.7 },
    { url: `${base}/earnings`, changeFrequency: "daily", priority: 0.6 },
    { url: `${base}/dividends`, changeFrequency: "daily", priority: 0.6 },
    { url: `${base}/ipo`, changeFrequency: "daily", priority: 0.5 },
    { url: `${base}/research`, changeFrequency: "daily", priority: 0.6 },
    { url: `${base}/analysts`, changeFrequency: "weekly", priority: 0.5 },
    { url: `${base}/learn`, changeFrequency: "monthly", priority: 0.5 },
  ];

  // Learn hub docs — only the FINAL factual docs are indexable; the draft-legal
  // skeletons (terms/privacy) set their own `noindex` and are excluded here.
  const learnRoutes: MetadataRoute.Sitemap = LEARN_DOCS.filter(
    (d) => d.status === "final",
  ).map((d) => ({
    url: `${base}/learn/${d.slug}`,
    changeFrequency: "monthly" as const,
    priority: 0.4,
  }));

  const stockRoutes: MetadataRoute.Sitemap = secs.flatMap((s) => {
    const base_ = `${base}/stocks/${s.venue}/${s.ticker}`;
    return [
      { url: base_, changeFrequency: "daily" as const, priority: 0.7 },
      ...STOCK_SUBPAGES.map((sub) => ({
        url: `${base_}/${sub}`,
        changeFrequency: "daily" as const,
        priority: 0.5,
      })),
    ];
  });

  const filingRoutes: MetadataRoute.Sitemap = filings.map((f) => ({
    url: `${base}/filings/${f.id}`,
    lastModified: f.filedAt ? new Date(f.filedAt) : undefined,
    changeFrequency: "monthly",
    priority: 0.4,
  }));

  // Published editorial. Articles are the long-form surface (`/articles/[slug]`);
  // wire briefs carry their own path (`/wire/{slug ?? id}`) from the reader,
  // which is the same href the newswire renders — never a second canonical.
  const articleRoutes: MetadataRoute.Sitemap = articles.map((a) => ({
    url: `${base}/articles/${a.slug}`,
    lastModified: a.updatedAt ? new Date(a.updatedAt) : undefined,
    changeFrequency: "weekly",
    priority: 0.7,
  }));

  const wireRoutes: MetadataRoute.Sitemap = wires.map((w) => ({
    url: `${base}${w.path}`,
    lastModified: w.updatedAt ? new Date(w.updatedAt) : undefined,
    changeFrequency: "daily",
    priority: 0.5,
  }));

  return [
    ...staticRoutes,
    ...learnRoutes,
    ...articleRoutes,
    ...wireRoutes,
    ...stockRoutes,
    ...filingRoutes,
  ];
}
