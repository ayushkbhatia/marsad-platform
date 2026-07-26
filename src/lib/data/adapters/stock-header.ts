import "server-only";
import type { StockHeader } from "@/lib/contracts/stock";
import type { ResolvedSecurity } from "@/lib/securities/resolve";
import { getStockHeader } from "@/lib/data/stocks";
import { getHeadlineScore } from "@/lib/data/stock-ratios";
import {
  fmtPrice,
  fmtSignedNum,
  fmtSignedPct,
  venueName,
  sectorLabel,
  currencyLabel,
  fmtClock,
} from "@/lib/reader/format";

/**
 * ADAPTER: real reads → the `StockHeader` view-model contract (design 3a–3d).
 *
 * All display formatting happens HERE, not in the component: the contract's
 * `price`, `currency` and `change.value` are strings with units and separators
 * baked in, because that is what the design specifies. Passing raw numeric
 * columns through would be a contract edit to suit the DB (Law #1).
 *
 * Honest degradation:
 * - Arabic name — `securities` has no `name_ar` column, so `nameAr` is "".
 *   The component renders nothing rather than transliterating (DEF-STOCK-NAME-AR).
 * - `links` (company site / venue listing) has no backing column → empty.
 * - SEDOL is not in the schema; `ids` shows ISIN when present (TDWL + QE only,
 *   276 of 762 securities) plus the quote timestamp.
 * - Score comes from `v_scores_public` (538 of 762 covered); absent → the chip
 *   is omitted by the component rather than showing a zero.
 */
export async function buildStockHeader(sec: ResolvedSecurity): Promise<StockHeader | null> {
  const [head, score] = await Promise.all([
    getStockHeader(sec.id),
    getHeadlineScore(sec.id),
  ]);
  if (!head) return null;

  const q = head.quote;
  const currency = currencyLabel(head.currency);

  const ids = [
    head.isin ? `ISIN ${head.isin}` : null,
    q?.asOf ? `LAST UPDATED ${fmtClock(q.asOf)} GST` : null,
    q?.delayMinutes != null ? `DELAYED ${q.delayMinutes} MIN` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    breadcrumb: ["Today", venueName(head.venueCode), sectorLabel(head.sector)].filter(Boolean),
    ids,
    name: head.name,
    nameAr: "",
    ticker: head.ticker,
    venueLabel: `${venueName(head.venueCode).toUpperCase()} · ${currency}`,
    score: {
      value: score?.score ?? 0,
      label: score?.rating ?? "",
    },
    links: [],
    price: q?.last != null ? fmtPrice(q.last, 2) : "—",
    currency,
    change:
      q?.change != null || q?.changePct != null
        ? {
            value: `${fmtSignedNum(q.change, 2)} (${fmtSignedPct(q.changePct)})`,
            up: (q.changePct ?? q.change ?? 0) >= 0,
          }
        : { value: "—", up: true },
  };
}
