import Link from "next/link";
import type { ResearchIndexData } from "@/lib/data/sample/research";
import { TagChip } from "./TagChip";

/**
 * Research index (1l) — the research master page: a topic filter row + venue/
 * sort controls, a large featured card, a 3-column article grid, and a
 * "Columns & series" email-digest footer. Every card links to
 * `/articles/{slug}` — the 1k article template.
 *
 * Sample-driven for the fidelity pass (DEF-RESEARCH-LIVE-DATA). The topic
 * pills + venue/sort are static design controls, not wired filters yet.
 */
const HATCH = { backgroundImage: "repeating-linear-gradient(45deg,#f1eee6 0 12px,#e9e5da 12px 24px)" };

export function ResearchIndex({ data }: { data: ResearchIndexData }) {
  const f = data.featured;

  return (
    <>
      {/* Header — title + topic pills + venue/sort. */}
      <div className="flex flex-wrap items-baseline gap-4">
        <span className="font-display text-[27px] font-bold text-ink">Research</span>
        <div className="ml-2 flex flex-wrap gap-1.5">
          {data.topics.map((t, i) =>
            i === 0 ? (
              <span key={t} className="cursor-pointer bg-ink px-3 py-[5.5px] text-[11px] font-bold text-paper-tint">
                {t}
              </span>
            ) : (
              <span
                key={t}
                className="cursor-pointer border border-hairline-strong px-3 py-[5.5px] text-[11px] text-ink-muted hover:text-ink"
              >
                {t}
              </span>
            ),
          )}
        </div>
        <div className="ml-auto flex items-center gap-2.5">
          <span className="cursor-pointer font-mono text-[9.5px] text-ink-faint">VENUE: ALL ▾</span>
          <span className="cursor-pointer font-mono text-[9.5px] text-ink-faint">SORT: LATEST ▾</span>
        </div>
      </div>

      {/* Featured card. */}
      <Link
        href={`/articles/${f.slug}`}
        className="mt-[18px] grid grid-cols-1 border border-ink sm:grid-cols-[560px_1fr]"
      >
        <div
          className="grid min-h-[300px] place-items-center border-b border-hairline sm:border-r sm:border-b-0"
          style={HATCH}
        >
          <span className="px-4 text-center font-mono text-[10px] tracking-[0.12em] text-ink-faint uppercase">
            {f.photoLabel}
          </span>
        </div>
        <div className="flex flex-col gap-3 bg-paper-tint px-[30px] py-[26px]">
          <div className="flex items-center gap-2.5">
            <span className="font-ui text-[10px] font-bold tracking-[0.2em] text-ink uppercase">{f.kicker}</span>
            <TagChip tag={f.tag} />
          </div>
          <div className="text-balance font-display text-[30px] font-bold leading-[1.15] tracking-[-0.012em] text-ink">
            {f.headline}
          </div>
          <div className="font-ui text-[13.5px] leading-[1.6] text-ink-muted">{f.dek}</div>
          <div className="mt-auto flex flex-wrap items-center gap-2.5">
            <span className="grid h-[30px] w-[30px] flex-none place-items-center rounded-full border-[1.5px] border-ink font-display text-[11.5px] font-semibold text-ink">
              {f.authorInitials}
            </span>
            <span className="text-[11.5px] font-semibold text-ink">{f.author}</span>
            <span className="font-mono text-[9px] text-ink-faint">{f.meta}</span>
            <span className="ml-auto text-[11px] font-semibold text-ink underline underline-offset-[3px]">Read →</span>
          </div>
        </div>
      </Link>

      {/* Article grid — 3-up, every card → the 1k template. */}
      <div className="mt-[22px] grid grid-cols-1 border-l border-t border-hairline sm:grid-cols-2 lg:grid-cols-3">
        {data.cards.map((c) => (
          <Link
            key={c.slug}
            href={`/articles/${c.slug}`}
            className="flex flex-col gap-[9px] border-r border-b border-hairline px-[22px] py-5 hover:bg-paper-tint"
          >
            <div className="flex items-center gap-2.5">
              <span className="font-ui text-[9.5px] font-bold tracking-[0.18em] text-ink-muted uppercase">
                {c.topic}
              </span>
              <TagChip tag={c.tag} />
              <span className="ml-auto font-mono text-[8.5px] text-[#a8a396]">{c.date}</span>
            </div>
            <div className="font-display text-[19.5px] font-semibold leading-[1.25] tracking-[-0.005em] text-ink">
              {c.headline}
            </div>
            <div className="font-ui text-[12.5px] leading-[1.55] text-ink-muted">{c.dek}</div>
            <div className="mt-auto font-mono text-[9px] text-ink-faint uppercase">
              {c.author} · {c.readMin} min
            </div>
          </Link>
        ))}
      </div>

      {/* Columns & series — email digests. */}
      <div className="mt-[26px] border-t-2 border-ink pt-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-ui text-[11px] font-bold tracking-[0.18em] text-ink uppercase">
            Columns &amp; series
          </span>
          <span className="text-[11px] text-ink-muted">Delivered by email — pick your cadence</span>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3.5 sm:grid-cols-3">
          {data.subscribe.map((s) => (
            <div key={s.title} className="border border-hairline px-[18px] py-4">
              <div className="font-mono text-[8.5px] tracking-[0.14em] text-ink-faint">{s.cadence}</div>
              <div className="mt-[7px] font-display text-[18px] font-bold text-ink">{s.title}</div>
              <div className="mt-[5px] text-[12px] leading-[1.5] text-ink-muted">{s.blurb}</div>
              <span className="mt-[11px] inline-block cursor-pointer border border-ink px-3 py-1.5 font-ui text-[10px] font-bold tracking-[0.08em] uppercase">
                Subscribe
              </span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
