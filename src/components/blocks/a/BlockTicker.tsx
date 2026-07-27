import { directionTextClass } from "../constraints";
import { interpolate, Val, isBound } from "../primitives";
import type { BlockNodeOf, TickerUnit } from "../types";

/*
 * BLK-TICKER · Inline instrument chip — A · Inline
 *
 * "FIRST MENTION OF ANY LISTED NAME · HOVER → QUOTE CARD · BINDS MARKET.QUOTE LIVE"
 *
 * Family A rule: no block borders, no vertical margin. The chip is an
 * inline-flex so it rides the serif line without breaking its rhythm.
 *
 * The hover quote card is CSS-only (group-hover) so this stays a server
 * component — no client boundary for what is a presentational reveal. Touch
 * devices get the chip alone, which is the honest degradation: the chip already
 * carries the ticker and the change.
 */
function Chip({ unit }: { unit: TickerUnit }) {
  const chip = (
    <span className="inline-flex items-baseline gap-1.5 border border-ink px-1.5 py-px">
      <span className="font-mono text-[11px] font-semibold text-ink tabular-nums">{unit.ticker}</span>
      <span className={`text-[10.5px] font-semibold tabular-nums ${directionTextClass(unit.direction)}`}>
        <Val v={unit.changePct} />
      </span>
    </span>
  );

  if (!unit.quote) return chip;

  return (
    <span className="group relative inline-block">
      {chip}
      <span className="pointer-events-none absolute bottom-full left-0 z-10 mb-1.5 hidden w-[196px] border border-ink bg-paper px-3 py-2.5 shadow-card-raised group-hover:block">
        {isBound(unit.quote.name) ? (
          <span className="block text-[11.5px] font-semibold text-ink">{unit.quote.name}</span>
        ) : null}
        <span className="mt-1 block font-mono text-[15px] text-ink tabular-nums">
          <Val v={unit.quote.last} />
        </span>
        <span className={`mt-0.5 block font-mono text-[10.5px] tabular-nums ${directionTextClass(unit.direction)}`}>
          <Val v={unit.quote.change} />
        </span>
        {isBound(unit.quote.venue) ? (
          <span className="mt-1.5 block font-mono text-[8px] tracking-[0.1em] text-ink-faint">
            {unit.quote.venue}
          </span>
        ) : null}
      </span>
    </span>
  );
}

export function BlockTicker({ node }: { node: BlockNodeOf<"BLK-TICKER"> }) {
  const { hostText, tickers } = node.payload;
  return (
    <p className="font-display text-[16px] leading-[1.8] text-ink-soft">
      {interpolate("BLK-TICKER", hostText, tickers.length, (i) => (
        <Chip unit={tickers[i]} />
      ))}
    </p>
  );
}
