import Link from "next/link";
import type { PeerComparisonData, PeerRow } from "@/lib/data/stock-overview";
import { fmtCompactUsd, pctFrac } from "@/lib/data/stock-overview";
import { fmtPrice, fmtSignedPct, sectorLabel } from "@/lib/reader/format";
import { SectionBar } from "@/components/ui";

/**
 * Sector peer-comparison table (screen 3a). Ticker/company/price/mkt cap/
 * ret-3M/score are real (securities + quotes_latest + v_scores_public +
 * v_key_ratios_public free cols); P/E, P/B, yield, ROE, EV/EBITDA are premium
 * `key_ratios` columns this table's data layer never fetches, so every cell
 * renders the locked stub instead of a number — never "—" (which would read
 * as "no data" rather than "gated").
 *
 * The design's "YTD" column is relabeled "RET 3M": `v_key_ratios_public` has
 * no true YTD field (only ret_3m/ret_6m/ret_12_1), and mislabeling a
 * different metric as YTD would be a silent fabrication — see CONVENTIONS'
 * "premium never fetched, never fabricated" rule.
 */

const GRID = "grid grid-cols-[88px_1fr_92px_58px_54px_56px_60px_74px_76px_62px_58px] items-center gap-[10px]";

const HEAD_CELL = "font-mono text-[8.5px] tracking-[0.08em] text-ink-faint uppercase";

function LockedNum() {
  return (
    <span className="text-right text-[10px] text-ink-faint opacity-70" aria-hidden>
      🔒
    </span>
  );
}

function PeerRowView({ p }: { p: PeerRow }) {
  const retPct = pctFrac(p.ret3m);
  const numCls = `text-right font-mono text-[11px] tabular-nums ${p.isSelf ? "font-semibold text-ink" : "text-ink-muted"}`;

  const inner = (
    <>
      <span className={`font-mono text-[10.5px] ${p.isSelf ? "font-bold" : "font-semibold"} text-ink`}>
        {p.ticker}
      </span>
      <span className={`truncate text-[12px] ${p.isSelf ? "font-bold text-ink" : "text-ink"}`}>{p.name}</span>
      <span className={numCls}>{p.price != null ? fmtPrice(p.price) : "—"}</span>
      <LockedNum />
      <LockedNum />
      <LockedNum />
      <LockedNum />
      <LockedNum />
      <span className={numCls}>{fmtCompactUsd(p.marketCapUsd)}</span>
      <span
        className={`text-right font-mono text-[11px] font-semibold tabular-nums ${
          retPct == null ? "text-ink-faint" : retPct >= 0 ? "text-positive" : "text-negative"
        }`}
      >
        {retPct != null ? fmtSignedPct(retPct) : "—"}
      </span>
      <span
        className={`justify-self-center font-mono text-[10px] font-semibold ${
          p.isSelf ? "bg-ink px-2 py-[2px] text-paper-tint" : "border border-ink px-[7px] py-[1px] text-ink"
        }`}
      >
        {p.score ?? "—"}
      </span>
    </>
  );

  const rowCls = `${GRID} border-b border-hairline-faint px-2.5 py-[9px] ${
    p.isSelf ? "border-l-[3px] border-l-ink bg-paper-tint" : ""
  }`;

  if (p.isSelf) {
    return <div className={rowCls}>{inner}</div>;
  }
  return (
    <Link href={`/stocks/${p.venueCode}/${p.ticker}`} className={`${rowCls} cursor-pointer hover:bg-paper-tint`}>
      {inner}
    </Link>
  );
}

export function PeerComparisonTable({ data }: { data: PeerComparisonData }) {
  const self = data.peers.find((p) => p.isSelf) ?? null;

  return (
    <div>
      <SectionBar
        variant="rule"
        label="Peer comparison"
        right={
          <span className="flex items-center gap-3">
            {data.sector ? (
              <span className="font-mono text-[9px] tracking-[0.08em] text-ink-faint uppercase">
                {sectorLabel(data.sector)}
              </span>
            ) : null}
            <Link
              href="/screener"
              className="font-ui text-[10.5px] text-ink-muted underline underline-offset-[3px] hover:text-ink"
            >
              Open in screener →
            </Link>
          </span>
        }
      />

      {data.peers.length === 0 ? (
        <p className="mt-3 font-mono text-[10.5px] tracking-[0.02em] text-ink-faint">
          No other listed peers found in this sector yet.
        </p>
      ) : (
        <div className="mt-1 overflow-x-auto">
          <div className="min-w-[900px]">
            <div className={`${GRID} border-b border-hairline px-2.5 pt-2 pb-1.5`}>
              <span className={HEAD_CELL}>Ticker</span>
              <span className={HEAD_CELL}>Company</span>
              <span className={`${HEAD_CELL} text-right`}>Price</span>
              <span className={`${HEAD_CELL} text-right`}>P/E</span>
              <span className={`${HEAD_CELL} text-right`}>P/B</span>
              <span className={`${HEAD_CELL} text-right`}>Yield</span>
              <span className={`${HEAD_CELL} text-right`}>ROE</span>
              <span className={`${HEAD_CELL} text-right`}>EV/EBITDA</span>
              <span className={`${HEAD_CELL} text-right`}>Mkt cap</span>
              <span className={`${HEAD_CELL} text-right`}>Ret 3M</span>
              <span className={`${HEAD_CELL} text-center`}>Score</span>
            </div>
            {data.peers.map((p) => (
              <PeerRowView key={p.securityId} p={p} />
            ))}
          </div>
        </div>
      )}

      <p className="mt-2 font-mono text-[8.5px] tracking-[0.02em] text-ink-faint">
        {self ? `MEDIAN (EX-${self.ticker}): ` : "MEDIAN: "}
        MKT CAP {fmtCompactUsd(data.medianMarketCapUsd)} · RET 3M{" "}
        {data.medianRet3m != null ? fmtSignedPct(pctFrac(data.medianRet3m)) : "—"} · P/E · P/B · YIELD · ROE ·
        EV/EBITDA — <span className="text-ink">Premium</span>
      </p>
    </div>
  );
}
