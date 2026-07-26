import Link from "next/link";
import type { CorporateAction, ExchangeFiling, MostReadItem } from "@/lib/contracts/newswire";

/**
 * Newswire (1d) right context rail (300px) — three stacked modules under 2px
 * ink rules: the raw Exchange filings feed, the Corporate actions list
 * (links to the dividend/corp-actions calendar), and the ranked Most read
 * list (large serif numeral + headline).
 *
 * Sample-driven for the fidelity pass; filings re-wire onto the real
 * `public.filings` feed, corporate actions onto the dividends/corp-actions
 * producer, most-read onto an analytics source (DEF-NEWSWIRE-LIVE-DATA).
 */
function RailHeader({ label, right }: { label: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between border-b-2 border-ink pb-2">
      <span className="font-ui text-[10px] font-bold tracking-[0.18em] text-ink uppercase">{label}</span>
      {right}
    </div>
  );
}

export function NewswireContextRail({
  filings,
  corporateActions,
  mostRead,
}: {
  filings: ExchangeFiling[];
  corporateActions: CorporateAction[];
  mostRead: MostReadItem[];
}) {
  return (
    <div className="lg:border-l lg:border-hairline lg:pl-6">
      {/* Exchange filings. */}
      <RailHeader
        label="Exchange filings"
        right={<span className="font-mono text-[9px] text-ink-faint">RAW FEED</span>}
      />
      {filings.map((f) => (
        <Link
          key={`${f.time}-${f.company}`}
          href={f.href}
          className="flex flex-col gap-[3px] border-b border-hairline-faint py-[9px] hover:bg-paper-tint"
        >
          <div className="flex items-center gap-2">
            <span className="font-mono text-[9.5px] text-ink-faint">{f.time}</span>
            <span className="border border-hairline px-[5px] py-[1.5px] font-mono text-[8.5px] font-semibold tracking-[0.08em] text-ink-muted">
              {f.venue}
            </span>
          </div>
          <span className="text-[12.5px] font-semibold text-ink">{f.company}</span>
          <span className="text-[11px] text-ink-muted">{f.filingType}</span>
        </Link>
      ))}

      {/* Corporate actions. */}
      <div className="mt-[22px]">
        <RailHeader
          label="Corporate actions"
          right={
            <Link
              href="/dividends"
              className="font-ui text-[10.5px] font-semibold text-ink-muted underline underline-offset-[3px] hover:text-ink"
            >
              Calendar →
            </Link>
          }
        />
      </div>
      {corporateActions.map((a) => (
        <div
          key={`${a.date}-${a.ticker}`}
          className="flex items-baseline gap-2.5 border-b border-hairline-faint py-2"
        >
          <span className="w-[42px] flex-none font-mono text-[9.5px] font-semibold text-ink-faint">
            {a.date}
          </span>
          <span className="w-[52px] flex-none font-mono text-[10.5px] font-semibold text-ink">
            {a.ticker}
          </span>
          <span className="text-[11.5px] text-ink-mid">{a.type}</span>
        </div>
      ))}

      {/* Most read. */}
      <div className="mt-[22px]">
        <RailHeader label="Most read" />
      </div>
      {mostRead.map((m) => (
        <Link
          key={m.rank}
          href={m.href}
          className="flex items-baseline gap-3 border-b border-hairline-faint py-2.5 hover:bg-paper-tint"
        >
          <span className="w-[18px] flex-none font-display text-[22px] font-semibold text-hairline-strong">
            {m.rank}
          </span>
          <span className="font-display text-[13.5px] font-semibold leading-[1.35] text-ink">
            {m.headline}
          </span>
        </Link>
      ))}
    </div>
  );
}
