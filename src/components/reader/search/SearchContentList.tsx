import Link from "next/link";
import type { SearchContentHit } from "@/lib/data/search";
import { fmtDate } from "@/lib/reader/format";

/**
 * 16a editorial results — published `content_items` hits (articles, explainers,
 * wire items), added when `20260726203031_search_content_items.sql` gave
 * `fn_search` its third doc_type.
 *
 * LINK-OUT ONLY, on purpose: `fn_search` indexes public metadata (kicker,
 * headline, dek, section) and never body text, so a `premium: true` hit gets a
 * headline, a chip, and a link — the gated prose stays behind
 * `content_blocks` RLS and is fetched (or withheld) by the article route, not
 * here. Never render a dek/excerpt from a search hit; there is none to render.
 *
 * Row shape follows `RelatedArticleRow` (headline + mono meta line) rather than
 * `ArticleCard` — search results are a dense list, not a grid of cards.
 */
export function SearchContentList({ hits }: { hits: SearchContentHit[] }) {
  return (
    <ul className="divide-y divide-hairline-faint border-y border-hairline-faint">
      {hits.map((h) => {
        const label = h.kicker ?? h.section ?? h.contentType;
        return (
          <li key={`${h.docType}-${h.docId}`}>
            <Link href={h.url} className="block py-3 text-ink no-underline hover:bg-paper-tint">
              <div className="flex items-center gap-2">
                {label ? (
                  <span className="font-ui text-[9.5px] font-bold tracking-[0.18em] text-ink-muted uppercase">
                    {label}
                  </span>
                ) : null}
                {h.premium ? (
                  <span className="bg-ink px-[5px] py-[2px] font-mono text-[8px] font-semibold tracking-[0.1em] text-paper-tint uppercase">
                    Premium
                  </span>
                ) : null}
                <span className="ml-auto flex-none font-mono text-[8.5px] text-ink-faint">
                  {fmtDate(h.publishedAt)}
                  {h.readMinutes ? ` · ${h.readMinutes} MIN` : ""}
                </span>
              </div>
              <span className="mt-1 block font-display text-[16px] font-semibold leading-[1.3] text-ink">
                {h.title}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
