import { SectionBar } from "@/components/ui";

/**
 * "About · key points" + "Marsad Desk View" callout (screen 3a). Neither has
 * a real content source today: `securities` carries no profile/description
 * column, and there is no per-security editorial "desk take" table (the only
 * analyst-note surfaces — `content_items`/`ai_theses` — are article/premium
 * pipelines, not a company-profile field). This renders the design's exact
 * chrome (rule header, paper-tint quote box, diamond + mono kicker) in an
 * honest awaiting state rather than inventing company copy.
 */

export function AboutDeskView({ name }: { name: string }) {
  return (
    <div>
      <SectionBar variant="rule" label="About · key points" />

      <div className="mt-3 flex flex-col gap-2 border border-dashed border-hairline px-4 py-5">
        <span className="inline-flex items-center gap-2">
          <span className="h-[6px] w-[6px] flex-none rounded-full bg-caution" aria-hidden />
          <span className="font-mono text-[9px] font-semibold tracking-[0.2em] text-caution-text uppercase">
            Awaiting feed
          </span>
        </span>
        <p className="font-display text-[14.5px] leading-[1.6] text-ink-mid">
          A company profile for {name} has not been published yet — no source feed has landed for
          this section.
        </p>
      </div>

      <div className="mt-4 border border-hairline-strong bg-paper-tint px-3.5 py-3">
        <div className="flex items-center gap-2">
          <span className="h-[7px] w-[7px] flex-none rotate-45 bg-ink" aria-hidden />
          <span className="font-mono text-[9px] font-semibold tracking-[0.16em] text-ink uppercase">
            Marsad desk view
          </span>
        </div>
        <p className="mt-[7px] font-display text-[13.5px] leading-[1.5] text-ink-mid italic">
          No desk take has been published for this security yet.
        </p>
        <p className="mt-1.5 font-mono text-[8.5px] tracking-[0.02em] text-ink-faint uppercase">
          Awaiting analyst coverage
        </p>
      </div>
    </div>
  );
}
