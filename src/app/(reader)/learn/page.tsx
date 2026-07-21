import type { Metadata } from "next";
import Link from "next/link";
import { listLearnDocsByCategory } from "@/lib/learn/docs";
import { LearnDocCard } from "@/components/reader/learn/LearnDocCard";

/**
 * Learn hub (20f) — methodology, reference and legal index. Fully static:
 * every doc is authored content in `src/lib/learn/docs.ts`, not a database
 * read, so this page has no `use cache` fn and no Suspense boundary — it
 * prerenders outright, same as any other content-only route.
 *
 * Design reference (`20f__20f-help-amp-legal.html`) pictures a broader help
 * center — search, billing FAQs, account FAQs, AI answers, alerts. That's out
 * of this slice's scope (those features/tiers aren't built yet) and would
 * document things that don't exist, so this hub only surfaces the six real
 * docs: Methodology, Glossary, Data sources & coverage, Disclaimers, Terms,
 * Privacy. The two-column layout + "Important" callout are kept from the
 * screen; the FAQ category grid and support-ticket CTA are not.
 */

const TITLE = "Learn — methodology, data & policies";
const DESCRIPTION =
  "How the Marsad Score works, what the glossary terms mean, which GCC venues Marsad covers, and Marsad's disclaimers, terms and privacy policy.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION },
  twitter: { card: "summary", title: TITLE, description: DESCRIPTION },
};

export default function LearnPage() {
  const grouped = listLearnDocsByCategory();

  return (
    <div className="mx-auto max-w-[1180px] px-5 py-8 sm:px-8">
      <header className="border-b-2 border-ink pb-3.5">
        <h1 className="font-display text-heading-lg font-bold tracking-[-0.015em] text-ink">
          Learn
        </h1>
        <p className="mt-1.5 font-ui text-[13px] text-ink-muted">
          How the Marsad Score works, what Marsad covers, and the policies that govern using it.
        </p>
      </header>

      <div className="mt-6 grid grid-cols-1 gap-9 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-8">
          {grouped.map(({ category, docs }) =>
            docs.length === 0 ? null : (
              <section key={category}>
                <div className="border-b border-hairline-strong pb-2">
                  <span className="font-mono text-[10px] font-bold tracking-[0.18em] text-ink-faint uppercase">
                    {category}
                  </span>
                </div>
                <div className="mt-3.5 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                  {docs.map((doc) => (
                    <LearnDocCard key={doc.slug} doc={doc} />
                  ))}
                </div>
              </section>
            )
          )}
        </div>

        <aside className="flex flex-col gap-4">
          <div className="border border-ink bg-paper-tint px-4 py-4">
            <span className="font-mono text-[8.5px] font-semibold tracking-[0.14em] text-ink-faint uppercase">
              Important
            </span>
            <p className="mt-1.5 font-display text-[14.5px] font-semibold leading-[1.4] text-ink">
              Marsad is research and data, not investment advice.
            </p>
            <p className="mt-1.5 font-ui text-[11.5px] leading-[1.6] text-ink-muted">
              The Marsad Score and every price on this site are for your own decisions and are
              always delayed at least 15 minutes. Nothing here is a recommendation to buy or sell.
            </p>
            <Link
              href="/learn/disclaimers"
              className="mt-2.5 inline-block font-ui text-[11.5px] font-semibold text-ink underline decoration-hairline-strong underline-offset-4 hover:decoration-ink"
            >
              Read the full disclaimers →
            </Link>
          </div>

          <div className="border border-hairline px-4 py-4">
            <span className="font-mono text-[8.5px] font-semibold tracking-[0.14em] text-ink-faint uppercase">
              Quick links
            </span>
            <div className="mt-2 flex flex-col">
              {["methodology", "data-sources", "disclaimers", "terms", "privacy"].map((slug) => {
                const doc = grouped.flatMap((g) => g.docs).find((d) => d.slug === slug);
                if (!doc) return null;
                return (
                  <Link
                    key={slug}
                    href={`/learn/${slug}`}
                    className="flex items-baseline justify-between gap-2 border-b border-hairline-faint py-2.5 text-ink last:border-0 hover:bg-paper-tint"
                  >
                    <span className="font-ui text-[12.5px] font-medium">{doc.title}</span>
                    <span className="text-ink-faint">→</span>
                  </Link>
                );
              })}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
