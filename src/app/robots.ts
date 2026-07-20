import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/reader/format";

/**
 * robots.txt (04-reader-app.md §8). Crawlers may read the public reader; the
 * API surface and the admin desk are blocked. `noindex` surfaces like the
 * screener stay crawlable here and opt out via per-page `robots` metadata (a
 * robots.txt block would hide that meta tag from crawlers).
 */
export default function robots(): MetadataRoute.Robots {
  const base = siteUrl();
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/admin/"],
    },
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
