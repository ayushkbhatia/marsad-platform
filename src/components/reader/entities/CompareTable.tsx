import type { CompareEntity } from "@/lib/data/entities";
import { RatingBadge } from "@/components/ui";
import { fmtPrice, fmtSignedPct, fmtCompact, toRating, venueName, currencyLabel } from "@/lib/reader/format";
import { CompareHeaderRow, type CompareColumn } from "./CompareHeaderRow";

/**
 * 18a Compare table body. `CompareHeaderRow` (client island) owns add/remove; everything below
 * it is a plain server component reading the already-resolved `CompareEntity[]` — no client JS
 * for the data rows themselves (CONVENTIONS §3: client only for input/poll/canvas).
 *
 * "Best-in-row" bolding (design's footnote) is scoped to metrics that are meaningfully
 * comparable across currencies/venues: 12-1M return (momentum), net margin, EPS growth YoY.
 * Market cap is bolded uniformly per column (the row's headline stat, not a per-row winner —
 * matches the design mock, where every MKT CAP cell is bold regardless of magnitude). Price and
 * EPS stay in local currency and are never bolded (not directly comparable across venues).
 */

const GRID = "grid grid-cols-[150px_repeat(4,1fr)]";

/** `key_ratios` ratio/growth/return columns are fractions (e.g. `-0.0422` = −4.22%, per the
 *  ratio catalog in `07-lake-enrichment.md` §3.2) — `fmtSignedPct` expects an already-scaled
 *  percent (see `quotes_latest.change_pct`, which IS pre-scaled). Scale at the display boundary
 *  only; the data layer keeps the raw DB fraction. */
function pct(n: number | null): number | null {
  return n == null ? null : n * 100;
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center border-b border-hairline-faint py-2.5 font-mono text-[8px] tracking-[0.12em] text-ink-faint uppercase">
      {children}
    </div>
  );
}

function Cell({
  children,
  bold = false,
  empty = false,
}: {
  children?: React.ReactNode;
  bold?: boolean;
  empty?: boolean;
}) {
  if (empty) {
    return <div className="border-b border-hairline-faint border-l border-dashed border-l-hairline-strong" />;
  }
  return (
    <div
      className={`border-b border-hairline-faint border-l border-l-hairline-soft px-4 py-2.5 font-mono text-[13px] tabular-nums text-ink ${
        bold ? "font-semibold" : ""
      }`}
    >
      {children ?? <span className="text-ink-faint">—</span>}
    </div>
  );
}

/** Index of the entity with the strictly-highest value for `pick`, or -1 if no clear winner
 *  (fewer than 2 comparable values, or a tie). */
function bestIndex(entities: CompareEntity[], pick: (e: CompareEntity) => number | null): number {
  let bestI = -1;
  let bestV = -Infinity;
  let tie = false;
  entities.forEach((e, i) => {
    const v = pick(e);
    if (v == null) return;
    if (v > bestV) {
      bestV = v;
      bestI = i;
      tie = false;
    } else if (v === bestV) {
      tie = true;
    }
  });
  return tie ? -1 : bestI;
}

export function CompareTable({ entities }: { entities: CompareEntity[] }) {
  const columns: CompareColumn[] = entities.map((e) => ({
    venue: e.venueCode,
    ticker: e.ticker,
    name: e.name,
    venueLabel: venueName(e.venueCode),
    score: e.score,
    rating: e.rating,
  }));

  const bestMomentum = bestIndex(entities, (e) => e.ret12_1);
  const bestMargin = bestIndex(entities, (e) => e.netMargin);
  const bestGrowth = bestIndex(entities, (e) => e.epsGrowthYoy);

  const pad = 4 - entities.length;
  const computedAt = entities.map((e) => e.ratiosComputedAt).find((d): d is string => d != null) ?? null;

  return (
    <div className="border-t-2 border-ink">
      <CompareHeaderRow columns={columns} />

      <div className={GRID}>
        <Label>Price</Label>
        {entities.map((e) => (
          <Cell key={`price-${e.securityId}`}>
            {e.last != null ? (
              <span className="flex items-baseline gap-1.5">
                <span className="text-[10px] text-ink-faint">{currencyLabel(e.currency)}</span>
                {fmtPrice(e.last)}
                {e.changePct != null ? (
                  <span className={`text-[10px] font-semibold ${e.changePct >= 0 ? "text-positive" : "text-negative"}`}>
                    {fmtSignedPct(e.changePct)}
                  </span>
                ) : null}
              </span>
            ) : null}
          </Cell>
        ))}
        {Array.from({ length: pad }).map((_, i) => (
          <Cell key={`price-pad-${i}`} empty />
        ))}

        <Label>Mkt cap (USD)</Label>
        {entities.map((e) => (
          <Cell key={`mcap-${e.securityId}`} bold={e.marketCapUsd != null}>
            {e.marketCapUsd != null ? `$${fmtCompact(e.marketCapUsd)}` : null}
          </Cell>
        ))}
        {Array.from({ length: pad }).map((_, i) => (
          <Cell key={`mcap-pad-${i}`} empty />
        ))}

        <Label>EPS TTM</Label>
        {entities.map((e) => (
          <Cell key={`eps-${e.securityId}`}>{e.epsTtm != null ? fmtPrice(e.epsTtm, 2) : null}</Cell>
        ))}
        {Array.from({ length: pad }).map((_, i) => (
          <Cell key={`eps-pad-${i}`} empty />
        ))}

        <Label>Ret 3M · 6M · 12-1M</Label>
        {entities.map((e, i) => (
          <Cell key={`ret-${e.securityId}`} bold={i === bestMomentum}>
            {e.ret3m != null || e.ret6m != null || e.ret12_1 != null
              ? `${fmtSignedPct(pct(e.ret3m))} · ${fmtSignedPct(pct(e.ret6m))} · ${fmtSignedPct(pct(e.ret12_1))}`
              : null}
          </Cell>
        ))}
        {Array.from({ length: pad }).map((_, i) => (
          <Cell key={`ret-pad-${i}`} empty />
        ))}

        <Label>Net · gross margin</Label>
        {entities.map((e, i) => (
          <Cell key={`margin-${e.securityId}`} bold={i === bestMargin}>
            {e.netMargin != null || e.grossMargin != null ? `${fmtSignedPct(pct(e.netMargin))} · ${fmtSignedPct(pct(e.grossMargin))}` : null}
          </Cell>
        ))}
        {Array.from({ length: pad }).map((_, i) => (
          <Cell key={`margin-pad-${i}`} empty />
        ))}

        <Label>Rev · EPS growth YoY</Label>
        {entities.map((e, i) => (
          <Cell key={`growth-${e.securityId}`} bold={i === bestGrowth}>
            {e.revGrowthYoy != null || e.epsGrowthYoy != null
              ? `${fmtSignedPct(pct(e.revGrowthYoy))} · ${fmtSignedPct(pct(e.epsGrowthYoy))}`
              : null}
          </Cell>
        ))}
        {Array.from({ length: pad }).map((_, i) => (
          <Cell key={`growth-pad-${i}`} empty />
        ))}

        <Label>Marsad rating</Label>
        {entities.map((e) => {
          const r = toRating(e.rating);
          return (
            <Cell key={`rating-${e.securityId}`}>
              {r ? <RatingBadge rating={r} /> : e.score != null ? null : <span className="font-mono text-[10px] text-ink-faint">PENDING</span>}
            </Cell>
          );
        })}
        {Array.from({ length: pad }).map((_, i) => (
          <Cell key={`rating-pad-${i}`} empty />
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[9px] text-ink-faint">
        <span>BEST-IN-ROW IN BOLD (12-1M RETURN / MARGIN / EPS GROWTH) · MKT CAP AT LATEST FX SPOT</span>
        {computedAt ? <span className="ml-auto">RATIOS AS OF {computedAt.slice(0, 10)}</span> : null}
      </div>
    </div>
  );
}
