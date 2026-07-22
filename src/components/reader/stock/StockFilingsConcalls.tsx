import type { FilingsConcalls } from "@/lib/data/sample/stock";

/**
 * Stock Filings & Concalls tab (design 3c) — a 2-column workspace: the
 * Tadawul announcements feed + earnings-call archive (one expanded with a
 * Marsad AI summary) on the left; Reports & documents, Phrase alerts, Next
 * events and Related research on the right. Sample-driven (DEF-STOCK-LIVE-DATA).
 */
function RailHead({ label, right }: { label: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between border-b-2 border-ink pb-2">
      <span className="font-ui text-[11px] font-bold tracking-[0.18em] text-ink uppercase">{label}</span>
      {right}
    </div>
  );
}

export function StockFilingsConcalls({ filings: f }: { filings: FilingsConcalls }) {
  return (
    <div className="grid grid-cols-1 gap-8 px-7 pt-4 pb-[30px] lg:grid-cols-[1fr_424px] lg:gap-x-[30px]">
      {/* Left — announcements + calls. */}
      <div>
        <div className="flex flex-wrap items-baseline gap-3 border-b-2 border-ink pb-2">
          <span className="font-display text-[20px] font-semibold text-ink">Announcements</span>
          <span className="font-mono text-[9px] text-ink-faint">TADAWUL FEED · 2222 ONLY</span>
          <div className="ml-auto flex gap-1">
            <span className="cursor-pointer bg-ink px-[9px] py-[3px] text-[9.5px] font-bold text-paper-tint">ALL</span>
            {["RESULTS", "DIVIDENDS", "GOVERNANCE"].map((c) => (
              <span key={c} className="cursor-pointer border border-hairline-strong px-[9px] py-[2.5px] text-[9.5px] text-ink-muted">
                {c}
              </span>
            ))}
          </div>
        </div>

        <div className="mt-3 flex gap-2">
          <input
            placeholder='Search announcements — try "dividend" or "capex"…'
            className="h-9 flex-1 border border-hairline-strong bg-paper-tint px-3 font-ui text-[12.5px] text-ink outline-none placeholder:text-ink-faint"
          />
          <span className="flex cursor-pointer items-center bg-ink px-3.5 text-[10.5px] font-bold tracking-[0.06em] text-paper-tint">
            SAVE AS ALERT
          </span>
        </div>

        {f.announcements.map((a) => (
          <div key={a.title} className="grid grid-cols-[84px_1fr_auto] gap-3.5 border-b border-hairline-soft px-1 py-3.5">
            <div>
              <div className="font-mono text-[10px] font-semibold text-ink">{a.date}</div>
              <div className="mt-[3px] font-mono text-[8px] text-ink-faint">{a.regId}</div>
            </div>
            <div>
              <span className="border border-hairline-strong px-1.5 py-0.5 font-mono text-[8px] font-semibold tracking-[0.1em] text-ink-muted">
                {a.tag}
              </span>
              <div className="mt-1.5 font-display text-[16.5px] font-semibold leading-[1.3] text-ink">{a.title}</div>
              <div className="mt-1 text-[12px] leading-[1.5] text-ink-muted">{a.summary}</div>
            </div>
            <span className="text-[10px] font-semibold whitespace-nowrap text-ink-muted underline underline-offset-[3px]">
              PDF ↗
            </span>
          </div>
        ))}
        <div className="flex justify-center pt-3.5">
          <span className="cursor-pointer border border-ink px-5 py-2 text-[10.5px] font-semibold tracking-[0.08em] uppercase">
            Earlier filings
          </span>
        </div>

        <div className="mt-[26px] flex flex-wrap items-baseline gap-3 border-b-2 border-ink pb-2">
          <span className="font-display text-[20px] font-semibold text-ink">Earnings calls</span>
          <span className="font-mono text-[9px] text-ink-faint">TRANSCRIPTS · DECKS · AI SUMMARIES</span>
        </div>
        {f.earningsCalls.map((c) => (
          <div key={c.quarter} className="border-b border-hairline-soft px-1 py-3.5">
            <div className="flex flex-wrap items-baseline gap-2.5">
              <span className="font-display text-[16px] font-semibold text-ink">{c.quarter}</span>
              <span className="font-mono text-[9px] text-ink-faint">{c.date}</span>
              <div className="ml-auto flex items-baseline gap-2.5">
                <span className="text-[10.5px] text-ink-muted underline underline-offset-[3px]">Transcript</span>
                <span className="text-[10.5px] text-ink-muted underline underline-offset-[3px]">Deck</span>
                <span className="text-[10.5px] font-semibold text-ink underline underline-offset-[3px]">AI summary</span>
                <span className="bg-ink px-[5px] py-0.5 font-mono text-[7.5px] font-semibold text-paper-tint">PREMIUM</span>
              </div>
            </div>
            {c.aiSummary ? (
              <div className="mt-2.5 border-l-[3px] border-ink bg-paper-tint px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="h-[7px] w-[7px] rotate-45 bg-ink" aria-hidden />
                  <span className="font-mono text-[8.5px] font-semibold tracking-[0.16em] text-ink">MARSAD AI SUMMARY</span>
                </div>
                <div className="mt-[7px] font-display text-[13.5px] leading-[1.6] text-ink-mid">{c.aiSummary}</div>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {/* Right rail. */}
      <div>
        <RailHead label="Reports & documents" />
        {f.reports.map((r) => (
          <div key={r.title} className="flex items-baseline justify-between border-b border-hairline-faint px-0.5 py-2.5">
            <span className="text-[12.5px] text-ink">{r.title}</span>
            <div className="flex items-baseline gap-3">
              <span className="font-mono text-[9px] text-ink-faint">{r.date}</span>
              <span className="text-[10.5px] text-ink-muted underline underline-offset-[3px]">PDF ↗</span>
            </div>
          </div>
        ))}

        <div className="mt-[18px] border border-ink bg-paper-tint px-4 py-3.5">
          <div className="font-ui text-[10px] font-bold tracking-[0.18em] text-ink-muted uppercase">Phrase alerts on 2222</div>
          <div className="mt-1.5 text-[11.5px] leading-[1.55] text-ink-muted">
            Get pinged when a filing mentions a phrase you track.
          </div>
          <div className="mt-2.5 flex flex-wrap gap-[5px]">
            {f.phraseAlerts.active.map((t) => (
              <span key={t} className="border border-ink px-2 py-[3px] font-mono text-[9.5px] text-ink">
                {t} ×
              </span>
            ))}
            {f.phraseAlerts.suggestions.map((t) => (
              <span key={t} className="border border-hairline-strong px-2 py-[3px] font-mono text-[9.5px] text-ink-muted">
                + {t}
              </span>
            ))}
          </div>
          <div className="mt-2.5 font-mono text-[8.5px] text-ink-faint">{f.phraseAlerts.note}</div>
        </div>

        <div className="mt-[22px]">
          <RailHead label="Next events" />
        </div>
        {f.nextEvents.map((e) => (
          <div key={e.label} className="flex items-baseline gap-2.5 border-b border-hairline-faint px-0.5 py-[9px]">
            <span className="w-[52px] flex-none font-mono text-[9.5px] font-semibold text-ink-faint">{e.date}</span>
            <span className="text-[12px] text-ink">{e.label}</span>
          </div>
        ))}

        <div className="mt-[22px] border-b-2 border-ink pb-[7px] font-ui text-[10px] font-bold tracking-[0.18em] text-ink uppercase">
          Related research
        </div>
        {f.relatedResearch.map((r) => (
          <div key={r.headline} className="border-b border-hairline-faint px-0.5 py-2.5">
            <div className="font-display text-[14px] font-semibold leading-[1.32] text-ink">{r.headline}</div>
            <div className="mt-1 font-mono text-[8.5px] text-ink-faint">{r.meta}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
