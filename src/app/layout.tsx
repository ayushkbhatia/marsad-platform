import type { Metadata } from "next";
import { newsreader, libreFranklin, plexMono, notoNaskh } from "@/lib/fonts";
import { siteUrl } from "@/lib/reader/format";
import "./globals.css";

/**
 * Site-wide metadata defaults (04-reader-app.md §8). Route groups with their
 * own chrome — `(reader)/layout.tsx`, `(dataroom)/layout.tsx` — override
 * `title`/`description` for their surfaces; this root only needs to supply
 * the bits every page inherits unless it overrides them: `metadataBase` (so
 * relative `openGraph.images` like `/api/og` resolve to absolute URLs for
 * social crawlers), a title template for segments with no closer template
 * (admin, styleguide, and any (dataroom) page that only sets a plain string
 * title), and a default social card so no route ever falls back to a blank
 * share preview.
 */
const DEFAULT_TITLE = "Marsad — GCC markets, read closely";
const DEFAULT_DESCRIPTION =
  "Delayed-data research on Gulf-listed equities — filings, prices, and the Marsad Score across six GCC venues.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: {
    default: DEFAULT_TITLE,
    template: "%s · Marsad",
  },
  description: DEFAULT_DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: "Marsad",
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    images: [{ url: "/api/og", width: 1200, height: 630, alt: DEFAULT_TITLE }],
  },
  twitter: {
    card: "summary_large_image",
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    images: ["/api/og"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${newsreader.variable} ${libreFranklin.variable} ${plexMono.variable} ${notoNaskh.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
