import Link from "next/link";
import type { ArticleSummary } from "@/lib/data/editorial";
import { fmtDate } from "@/lib/reader/format";

/** Byline label from raw agent/editor codes — see editorial.ts header for why
 *  there is no human display name available yet. */
function bylineLabel(a: ArticleSummary): string | null {
  const first = a.byline[0];
  if (!first?.principal) return null;
  return first.role ? `${first.role.replace(/_/g, " ")} · ${first.principal}` : first.principal;
}

/** Research-index grid card (server component) — one article summary. */
export function ArticleCard({ article }: { article: ArticleSummary }) {
  const by = bylineLabel(article);
  return (
    <Link
      href={`/articles/${article.slug}`}
      className="flex flex-col gap-2.5 border-r border-b border-hairline px-5 py-5 hover:bg-paper-tint"
    >
      <div className="flex items-center gap-2">
        {article.section ? (
          <span className="font-ui text-[9.5px] font-bold tracking-[0.18em] text-ink-muted uppercase">
            {article.section}
          </span>
        ) : null}
        {article.isPremium ? (
          <span className="bg-ink px-[5px] py-[2px] font-mono text-[8px] font-semibold tracking-[0.1em] text-paper-tint uppercase">
            Premium
          </span>
        ) : (
          <span className="border border-hairline-strong px-[5px] py-[1.5px] font-mono text-[8px] font-semibold tracking-[0.1em] text-ink-muted uppercase">
            Free
          </span>
        )}
        <span className="ml-auto font-mono text-[8.5px] text-ink-faint">{fmtDate(article.publishedAt)}</span>
      </div>
      <span className="font-display text-[19.5px] font-semibold leading-[1.25] tracking-[-0.005em] text-ink">
        {article.headline}
      </span>
      {article.dek ? (
        <span className="line-clamp-2 font-ui text-[12.5px] leading-[1.55] text-ink-muted">{article.dek}</span>
      ) : null}
      <span className="mt-auto font-mono text-[9px] tracking-[0.04em] text-ink-faint uppercase">
        {by ?? "Marsad Newsroom"}
        {article.readMinutes ? ` · ${article.readMinutes} MIN` : ""}
      </span>
    </Link>
  );
}

/** Compact list row — the article page's "Related" rail. */
export function RelatedArticleRow({ article }: { article: ArticleSummary }) {
  return (
    <Link
      href={`/articles/${article.slug}`}
      className="block border-b border-hairline-faint py-2.5 last:border-b-0 hover:bg-paper-tint"
    >
      <span className="block font-display text-[14px] font-semibold leading-[1.32] text-ink">
        {article.headline}
      </span>
      <span className="mt-1 block font-mono text-[8.5px] tracking-[0.06em] text-ink-faint uppercase">
        {article.isPremium ? "Premium" : "Free"} · {fmtDate(article.publishedAt)}
      </span>
    </Link>
  );
}
