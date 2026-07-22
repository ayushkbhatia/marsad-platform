import Link from "next/link";
import { SectionBar, EmptyState } from "@/components/ui";
import { fmtClock } from "@/lib/reader/format";
import type { FilingItem } from "@/lib/data/filings";

/**
 * Right rail (1d), three `SectionBar variant="rule"` sections:
 *
 * - EXCHANGE FILINGS — a compact "raw feed" view of the same filings the
 *   center column shows, real data.
 * - CORPORATE ACTIONS — no dividend/AGM-calendar producer feeds this rail
 *   yet. The row shape the design specifies (date + ticker + action type) is
 *   built and ready — `WireCorporateAction[]` — but the page passes `[]`
 *   today, so it renders the section shell + an honest `awaitingFeed` empty
 *   state (never fabricated rows) with a real link into `/dividends`.
 * - MOST READ — same posture: the ranked-row shape (22px hairline-strong
 *   rank number + serif headline) is built, page passes `[]` (no
 *   reading-analytics producer exists yet), so it renders the empty state.
 */

export interface WireCorporateAction {
  id: string;
  /** Short mono date label, e.g. "12 Jul". */
  dateLabel: string;
  ticker: string;
  actionType: string;
  href: string;
}

export interface WireMostReadItem {
  id: string;
  rank: number;
  headline: string;
  href: string;
}

function CorporateActionRow({ action }: { action: WireCorporateAction }) {
  return (
    <Link
      href={action.href}
      className="flex items-baseline gap-[10px] border-b border-hairline-faint py-2 hover:bg-paper-tint"
    >
      <span className="w-[42px] flex-none font-mono text-[9.5px] font-semibold text-ink-faint">
        {action.dateLabel}
      </span>
      <span className="w-[52px] flex-none font-mono text-[10.5px] font-semibold text-ink">{action.ticker}</span>
      <span className="font-ui text-[11.5px] text-ink-mid">{action.actionType}</span>
    </Link>
  );
}

function MostReadRow({ item }: { item: WireMostReadItem }) {
  return (
    <Link href={item.href} className="flex items-baseline gap-3 border-b border-hairline-faint py-[10px] hover:bg-paper-tint">
      <span className="w-[18px] flex-none font-display text-[22px] font-semibold text-hairline-strong">
        {item.rank}
      </span>
      <span className="font-display text-[13.5px] font-semibold leading-[1.35] text-ink">{item.headline}</span>
    </Link>
  );
}

function RawFilingRow({ filing }: { filing: FilingItem }) {
  return (
    <Link
      href={`/filings/${filing.id}`}
      className="flex flex-col gap-[3px] border-b border-hairline-faint py-[9px] hover:bg-paper-tint"
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[9.5px] text-ink-faint">{fmtClock(filing.filedAt)}</span>
        {filing.venueCode ? (
          <span className="border border-hairline px-[5px] py-[1.5px] font-mono text-[8.5px] font-semibold tracking-[0.08em] text-ink-muted uppercase">
            {filing.venueCode}
          </span>
        ) : null}
      </div>
      <span className="font-ui text-[12.5px] font-semibold text-ink">
        {filing.name ?? filing.ticker ?? "Unlisted filer"}
      </span>
      <span className="font-ui text-[11px] text-ink-muted">
        {filing.filingType ?? filing.formCode ?? filing.title ?? "Filing"}
      </span>
    </Link>
  );
}

export function WireRightRail({
  rawFilings,
  corporateActions = [],
  mostRead = [],
}: {
  rawFilings: FilingItem[];
  corporateActions?: WireCorporateAction[];
  mostRead?: WireMostReadItem[];
}) {
  return (
    <aside className="lg:border-l lg:border-hairline lg:pl-6">
      <SectionBar
        label="Exchange filings"
        variant="rule"
        right={<span className="font-mono text-[9px] text-ink-faint">Raw feed</span>}
      />
      {rawFilings.length > 0 ? (
        <div>
          {rawFilings.map((f) => (
            <RawFilingRow key={f.id} filing={f} />
          ))}
        </div>
      ) : (
        <p className="py-6 text-center font-ui text-[12px] text-ink-faint">No filings on the wire yet.</p>
      )}

      <SectionBar
        label="Corporate actions"
        variant="rule"
        className="mt-[22px]"
        right={
          <Link href="/dividends" className="text-[10.5px] font-semibold text-ink-muted underline underline-offset-[3px] hover:text-ink">
            Calendar →
          </Link>
        }
      />
      {corporateActions.length > 0 ? (
        <div>
          {corporateActions.map((a) => (
            <CorporateActionRow key={a.id} action={a} />
          ))}
        </div>
      ) : (
        <EmptyState
          variant="awaitingFeed"
          title="No corporate actions loaded here yet."
          body="Ex-dividend dates, AGMs and rights issues will list here once this rail is wired to the calendar feed."
        />
      )}

      <SectionBar label="Most read" variant="rule" className="mt-[22px]" />
      {mostRead.length > 0 ? (
        <div>
          {mostRead.map((m) => (
            <MostReadRow key={m.id} item={m} />
          ))}
        </div>
      ) : (
        <EmptyState
          variant="awaitingFeed"
          title="Most-read ranking isn't live yet."
          body="Once reading analytics land, the week's most-opened stories will rank here."
        />
      )}
    </aside>
  );
}
