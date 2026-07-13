import type { Surface } from "./types";

export type DataTableRowState = "default" | "halted" | "stale";

export interface DataTableRowProps {
  ticker?: string;
  company?: string;
  /** Venue tag, e.g. "TDWL" — empty string hides the tag */
  venue?: string;
  /** Formatted price, e.g. "29.85" */
  price?: string;
  /** Signed change, e.g. "+1.2%" (hidden for halted/stale states) */
  chg?: string;
  dir?: "up" | "down";
  /** Score cell, e.g. "76 · BUY" */
  score?: string;
  state?: DataTableRowState;
  surface?: Surface;
}

/* Grid template is fixed by the DC: ticker 64 / name 1fr / price 78 /
   chg 60 / score 70, 10px gaps, 9px 12px cell padding. */
const GRID =
  "grid grid-cols-[64px_1fr_78px_60px_70px] items-center gap-[10px] px-3 py-[9px] font-ui";

/** Screener/watchlist/register workhorse row. */
export function DataTableRow({
  ticker = "2222",
  company = "Saudi Aramco",
  venue = "TDWL",
  price = "29.85",
  chg = "+1.2%",
  dir = "up",
  score = "76 · BUY",
  state = "default",
  surface = "light",
}: DataTableRowProps) {
  const dark = surface === "dark";
  const up = dir === "up";

  const shell = dark
    ? // dark rows sit on the data-room bg; divider is ink-soft per the DC
      `${GRID} border-b border-ink-soft bg-dark-bg text-paper-tint`
    : `${GRID} border-b border-hairline-faint text-ink`;
  const interactive = dark
    ? "cursor-pointer hover:bg-dark-panel-alt"
    : "cursor-pointer hover:bg-paper-tint";

  const companyText = dark ? "text-hairline-strong" : "text-ink-mid";
  const venueTag = `flex-none border px-[4px] py-px font-mono text-[7.5px] text-ink-faint ${
    dark ? "border-dark-hairline-strong" : "border-hairline-soft"
  }`;
  const scoreText = dark ? "text-ink-faint" : "text-ink-muted";
  const mutedPrice = "text-ink-faint";

  const tickerCell = (
    <span className="font-mono text-[11px] font-semibold">{ticker}</span>
  );
  const nameCell = (staleTag: boolean) => (
    <span className="flex items-baseline gap-[7px] overflow-hidden">
      <span className={`truncate text-[12px] ${companyText}`}>{company}</span>
      {staleTag ? (
        <span className="flex-none font-mono text-[8px] text-caution">STALE</span>
      ) : (
        venue.length > 0 && <span className={venueTag}>{venue}</span>
      )}
    </span>
  );
  const scoreCell = (
    <span className={`text-right font-mono text-[9px] ${scoreText}`}>{score}</span>
  );

  if (state === "halted") {
    return (
      <div className={shell}>
        {tickerCell}
        {nameCell(false)}
        <span className={`text-right font-mono text-[11.5px] tabular-nums ${mutedPrice}`}>
          {price}
        </span>
        <span
          className={`text-right font-mono text-[8px] font-semibold tracking-[0.06em] ${
            dark ? "text-negative-dark" : "text-negative"
          }`}
        >
          HALTED
        </span>
        {scoreCell}
      </div>
    );
  }

  if (state === "stale") {
    return (
      <div className={`${shell} opacity-55`}>
        {tickerCell}
        {nameCell(true)}
        <span className={`text-right font-mono text-[11.5px] tabular-nums ${mutedPrice}`}>
          {price}
        </span>
        <span />
        {scoreCell}
      </div>
    );
  }

  return (
    <div className={`${shell} ${interactive}`}>
      {tickerCell}
      {nameCell(false)}
      <span className="text-right font-mono text-[11.5px] tabular-nums">{price}</span>
      <span
        className={`text-right text-[11px] font-semibold tabular-nums ${
          up
            ? dark
              ? "text-positive-dark"
              : "text-positive"
            : dark
              ? "text-negative-dark"
              : "text-negative"
        }`}
      >
        {chg}
      </span>
      {scoreCell}
    </div>
  );
}
