import Link from "next/link";
import type { Article, ArticleBlock } from "@/lib/contracts/research";

/**
 * Article (1k) — the one reusable longform research layout every 1l card
 * routes to. A 5-column grid (margin | 720px copy | 84px gutter | 300px
 * sidebar | margin) over a full-width premium paywall band.
 *
 * Copy column: section + PREMIUM chip, headline, dek, byline + Save/Share/
 * Print, a "thesis in three lines" callout, a "rating attached" strip, then
 * the body (drop-cap open, pull-quote, labelled exhibit, and a fade-masked
 * final paragraph — the free-preview cutoff). Sidebar: in-this-piece tickers,
 * the analyst card, and Related pieces (each → the 1k template). Paywall band:
 * the premium gate.
 *
 * Sample-driven for the fidelity pass; the real premium cut (RLS on
 * `content_blocks`, session plan → gate/mask) re-wires later
 * (DEF-RESEARCH-LIVE-DATA). Here the mask + gate render unconditionally, as
 * the sample piece is PREMIUM.
 */
const EXHIBIT_HATCH = {
  backgroundImage: "repeating-linear-gradient(45deg,#f6f4ee 0 12px,#efece3 12px 24px)",
};
const MASK = {
  WebkitMaskImage: "linear-gradient(#000 0%, transparent 88%)",
  maskImage: "linear-gradient(#000 0%, transparent 88%)",
} as const;

function fmtSigned(n: number): string {
  return `${n < 0 ? "−" : "+"}${Math.abs(n).toFixed(1)}%`;
}

function Block({ b }: { b: ArticleBlock }) {
  switch (b.kind) {
    case "dropcap":
      return (
        <p className="mt-[26px] font-display text-[17px] leading-[1.72] text-ink-soft">
          <span className="float-left pt-1.5 pr-2.5 font-display text-[52px] font-bold leading-[0.82] text-ink">
            {b.text.charAt(0)}
          </span>
          {b.text.slice(1)}
        </p>
      );
    case "p":
      return <p className="mt-[18px] font-display text-[17px] leading-[1.72] text-ink-soft">{b.text}</p>;
    case "pullquote":
      return (
        <div className="my-[24px] border-l-[3px] border-ink py-1 pl-[22px]">
          <p className="font-display text-[23px] italic leading-[1.4] tracking-[-0.005em] text-ink">
            {"“"}
            {b.text}
            {"”"}
          </p>
        </div>
      );
    case "exhibit":
      return (
        <figure className="mt-[22px] border border-hairline">
          <figcaption className="flex items-baseline gap-2.5 border-b border-hairline-soft px-4 py-2.5">
            <span className="font-mono text-[9px] font-semibold tracking-[0.14em] text-ink">{b.label}</span>
            <span className="text-[12px] text-ink-muted">{b.title}</span>
          </figcaption>
          <div className="grid h-[210px] place-items-center" style={EXHIBIT_HATCH}>
            <span className="px-4 text-center font-mono text-[10px] tracking-[0.12em] text-ink-faint uppercase">
              {b.placeholder}
            </span>
          </div>
        </figure>
      );
    case "masked":
      return (
        <div className="relative mt-[26px]">
          <p className="font-display text-[17px] leading-[1.72] text-ink-soft" style={MASK}>
            {b.text}
          </p>
        </div>
      );
  }
}

function CopyColumn({ article }: { article: Article }) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="font-ui text-[11px] font-bold tracking-[0.2em] text-ink uppercase">{article.section}</span>
        {article.tag === "PREMIUM" ? (
          <span className="bg-ink px-1.5 py-[2.5px] font-mono text-[8.5px] font-semibold tracking-[0.1em] text-paper-tint uppercase">
            Premium research
          </span>
        ) : null}
      </div>

      <h1 className="mt-3 text-balance font-display text-[41px] font-bold leading-[1.12] tracking-[-0.015em] text-ink">
        {article.headline}
      </h1>
      <p className="mt-3 font-display text-[18px] leading-[1.5] text-ink-muted">{article.dek}</p>

      {/* Byline + actions. */}
      <div className="mt-[18px] flex flex-wrap items-center gap-3 border-t border-b border-ink border-b-hairline py-3.5">
        <span className="grid h-[38px] w-[38px] flex-none place-items-center rounded-full border-[1.5px] border-ink font-display text-[14px] font-semibold text-ink">
          {article.authorInitials}
        </span>
        <div>
          <div className="text-[12.5px] font-bold text-ink">
            {article.authorName} <span className="font-normal text-ink-faint">· {article.authorRole}</span>
          </div>
          <div className="mt-0.5 font-mono text-[9px] text-ink-faint">{article.meta}</div>
        </div>
        <div className="ml-auto flex gap-2">
          {["Save", "Share", "Print"].map((a) => (
            <span
              key={a}
              className="cursor-pointer border border-hairline-strong px-[11px] py-1.5 text-[10.5px] font-semibold text-ink-muted"
            >
              {a}
            </span>
          ))}
        </div>
      </div>

      {/* Thesis callout. */}
      <div className="mt-[22px] border border-ink bg-paper-tint px-5 py-4">
        <div className="font-ui text-[10px] font-bold tracking-[0.18em] text-ink-muted uppercase">
          The thesis in three lines
        </div>
        {article.thesis.map((t, i) => (
          <div
            key={t}
            className={`flex gap-2.5 text-[13.5px] leading-[1.55] text-ink-mid ${i === 0 ? "mt-2.5" : "mt-1.5"}`}
          >
            <span className="mt-2 h-[5px] w-[5px] flex-none bg-ink" />
            <span>{t}</span>
          </div>
        ))}
      </div>

      {/* Rating strip — only when the piece genuinely carries a
          `content_items.rating_attachment`. A price target is an editorial
          claim about a real security; the slot is left empty, never filled. */}
      {article.rating ? (
        <div className="mt-3.5 flex flex-wrap items-center gap-3.5 border border-hairline px-4 py-3">
          <span className="flex-none font-mono text-[8.5px] font-semibold tracking-[0.1em] text-ink-muted uppercase">
            Rating attached
          </span>
          <span className="font-mono text-[11px] font-semibold text-ink">{article.rating.ticker}</span>
          <span className="text-[12.5px] text-ink">{article.rating.name}</span>
          <span className="border border-ink px-2 py-[3px] text-[9px] font-bold tracking-[0.1em] text-ink uppercase">
            {article.rating.action}
          </span>
          <span className="text-[12px] font-semibold tabular-nums text-ink">{article.rating.priceTarget}</span>
          <span className="ml-auto text-[11.5px] font-semibold tabular-nums text-positive">
            +{article.rating.impliedUpside.toFixed(1)}% implied
          </span>
        </div>
      ) : null}

      {/* Body. */}
      <div>
        {article.blocks.map((b, i) => (
          <Block key={i} b={b} />
        ))}
      </div>
    </div>
  );
}

function Sidebar({ article }: { article: Article }) {
  return (
    <aside className="pt-1.5">
      {/* In this piece. */}
      <div className="border border-hairline px-4 py-3.5">
        <div className="font-ui text-[10px] font-bold tracking-[0.18em] text-ink-faint uppercase">In this piece</div>
        {article.inThisPiece.map((it, i) => (
          <div
            key={it.ticker}
            className={`flex items-baseline gap-[9px] py-2 ${i === 0 ? "mt-1" : ""} ${
              i < article.inThisPiece.length - 1 ? "border-b border-hairline-faint" : ""
            }`}
          >
            <span className="w-[52px] flex-none font-mono text-[10.5px] font-semibold text-ink">{it.ticker}</span>
            <span className="text-[11.5px] text-ink-mid">{it.name}</span>
            <span className={`ml-auto text-[11px] font-semibold ${it.chgPct < 0 ? "text-negative" : "text-positive"}`}>
              {fmtSigned(it.chgPct)}
            </span>
          </div>
        ))}
      </div>

      {/* Analyst — omitted entirely for a house-bylined piece. `winRate` is a
          performance claim about a named individual, so this card renders only
          for a real analyst with real closed calls behind them. */}
      {article.analyst ? (
        <div className="mt-3.5 border border-hairline px-4 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="grid h-[34px] w-[34px] flex-none place-items-center rounded-full border-[1.5px] border-ink font-display text-[13px] font-semibold text-ink">
              {article.analyst.initials}
            </span>
            <div>
              <div className="text-[12px] font-bold text-ink">{article.analyst.name}</div>
              <div className="font-mono text-[8.5px] text-ink-faint">{article.analyst.winRate}</div>
            </div>
          </div>
          <span className="mt-3 block cursor-pointer bg-ink py-2 text-center font-ui text-[10.5px] font-bold tracking-[0.08em] text-paper-tint uppercase">
            Follow
          </span>
        </div>
      ) : null}

      {/* Related. */}
      <div className="mt-5">
        <div className="border-b-2 border-ink pb-[7px]">
          <span className="font-ui text-[10px] font-bold tracking-[0.18em] text-ink uppercase">Related</span>
        </div>
        {article.related.map((r) => (
          <Link
            key={r.slug}
            href={`/articles/${r.slug}`}
            className="block border-b border-hairline-faint py-2.5 hover:bg-paper-tint"
          >
            <div className="font-display text-[14px] font-semibold leading-[1.32] text-ink">{r.headline}</div>
            <div className="mt-1 font-mono text-[8.5px] text-ink-faint">
              {r.tag} · {r.date}
            </div>
          </Link>
        ))}
      </div>
    </aside>
  );
}

export function ArticleView({ article }: { article: Article }) {
  return (
    <>
      <div className="grid grid-cols-1 px-7 pt-[30px] lg:grid-cols-[1fr_720px_84px_300px_1fr]">
        <div className="hidden lg:block" />
        <CopyColumn article={article} />
        <div className="hidden lg:block" />
        <Sidebar article={article} />
        <div className="hidden lg:block" />
      </div>

      {/* Paywall band. */}
      <div className="px-7 pb-[34px]">
        <div className="relative mx-auto mt-[-6px] max-w-[720px] border-2 border-ink bg-paper-tint px-[30px] py-[26px]">
          <div className="flex items-center gap-2.5">
            <span className="h-[9px] w-[9px] rotate-45 bg-ink" aria-hidden />
            <span className="font-mono text-[10px] font-semibold tracking-[0.2em] text-ink uppercase">
              Continue with Marsad Premium
            </span>
          </div>
          <div className="mt-2.5 font-display text-[22px] font-semibold leading-[1.3] text-ink">
            {article.paywall.headline}
          </div>
          <div className="mt-3.5 flex flex-wrap gap-x-6 gap-y-1 text-[12.5px] leading-[1.6] text-ink-mid">
            {article.paywall.benefits.map((b) => (
              <span key={b}>— {b}</span>
            ))}
          </div>
          <div className="mt-[18px] flex flex-wrap items-center gap-4">
            <span className="cursor-pointer bg-ink px-[22px] py-3 font-ui text-[12px] font-bold tracking-[0.08em] text-paper-tint uppercase">
              {article.paywall.ctaText}
            </span>
            <span className="text-[12px] text-ink-muted">
              {article.paywall.ctaNote} ·{" "}
              <span className="cursor-pointer underline underline-offset-[3px]">Sign in</span>
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
