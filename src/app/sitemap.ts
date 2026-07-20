import type { MetadataRoute } from "next";
import { listSecurityParams } from "@/lib/securities/resolve";
import { listRecentFilingRefs } from "@/lib/data/filings";
import { siteUrl } from "@/lib/reader/format";

/**
 * Split-ish sitemap (04-reader-app.md §8): the indexable public surface —
 * static entries, every public stock page (`/stocks/[venue]/[ticker]`, the SEO
 * backbone), and recent filing detail pages (machine-extracted text is strong
 * long-tail SEO). Both data reads go through `use cache` readers over the anon
 * client, so this special file stays cached (no request-time API) and is cheap
 * to regenerate. `noindex` surfaces (screener) are intentionally excluded.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();

  const [secs, filings] = await Promise.all([
    listSecurityParams(),
    listRecentFilingRefs(10000), // ~13.5k total; cap to the most recent, well under the 50k limit
  ]);

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${base}/`, changeFrequency: "hourly", priority: 1 },
    { url: `${base}/markets`, changeFrequency: "hourly", priority: 0.9 },
    { url: `${base}/wire`, changeFrequency: "hourly", priority: 0.8 },
    { url: `${base}/filings`, changeFrequency: "hourly", priority: 0.7 },
  ];

  const stockRoutes: MetadataRoute.Sitemap = secs.map((s) => ({
    url: `${base}/stocks/${s.venue}/${s.ticker}`,
    changeFrequency: "daily",
    priority: 0.7,
  }));

  const filingRoutes: MetadataRoute.Sitemap = filings.map((f) => ({
    url: `${base}/filings/${f.id}`,
    lastModified: f.filedAt ? new Date(f.filedAt) : undefined,
    changeFrequency: "monthly",
    priority: 0.4,
  }));

  return [...staticRoutes, ...stockRoutes, ...filingRoutes];
}
