import type { Financials, FinRow } from "@/lib/data/sample/stock";

/**
 * Stock Financials tab (design 3b) — quarterly results (8 quarters + a desk
 * estimate), a 10-year annual P&L, a 4-up CAGR/ROE block, and Balance sheet +
 * Cash flow side by side. Sample-driven (DEF-STOCK-LIVE-DATA).
 */
const Q_COLS = "grid-cols-[190px_repeat(8,1fr)_64px]";
const A_COLS = "grid-cols-[190px_repeat(10,1fr)]";

function SectionHead({ title, meta, right }: { title: string; meta: string; right?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-3 border-b-2 border-ink pb-2">
      <span className="font-display text-[20px] font-semibold text-ink">{title}</span>
      <span className="font-mono text-[9px] text-ink-faint">{meta}</span>
      {right ? <div className="ml-auto flex gap-1">{right}</div> : null}
    </div>
  );
}

function Row({ cols, r, size, pdfCol }: { cols: string; r: FinRow; size: string; pdfCol?: boolean }) {
  return (
    <div className={`grid ${cols} border-b border-hairline-faint ${r.strong ? "bg-paper-tint" : ""}`}>
      <span className={`px-2.5 py-2 text-[12px] ${r.strong ? "font-bold text-ink" : "text-ink-mid"}`}>
        {r.strong ? "▸ " : ""}
        {r.label}
      </span>
      {r.values.map((v, i) => (
        <span
          key={i}
          className={`px-1.5 py-2 ${size} text-right tabular-nums ${r.strong ? "font-semibold text-ink" : "text-ink-muted"}`}
        >
          {v}
        </span>
      ))}
      {pdfCol ? (
        r.pdf ? (
          <span className="px-1.5 py-2 text-right text-[9.5px] text-ink-muted underline underline-offset-2">Q ↗</span>
        ) : (
          <span />
        )
      ) : null}
    </div>
  );
}

function PeriodHead({ cols, periods, pdfCol }: { cols: string; periods: string[]; pdfCol?: boolean }) {
  return (
    <div className={`grid ${cols} border-b border-hairline`}>
      <span className="px-2.5 py-2" />
      {periods.map((p) => (
        <span key={p} className="px-1.5 py-2 text-right font-mono text-[9px] text-ink-muted">
          {p}
        </span>
      ))}
      {pdfCol ? <span className="px-1.5 py-2 text-right font-mono text-[8.5px] text-ink-faint">PDF</span> : null}
    </div>
  );
}

function KeyValTable({ rows }: { rows: Array<{ label: string; value: string }> }) {
  return (
    <>
      {rows.map((r) => (
        <div key={r.label} className="flex items-baseline justify-between border-b border-hairline-faint px-1 py-[9px]">
          <span className="text-[12px] text-ink-mid">{r.label}</span>
          <span className="text-[12px] font-semibold tabular-nums text-ink">{r.value}</span>
        </div>
      ))}
    </>
  );
}

export function StockFinancials({ financials: f }: { financials: Financials }) {
  return (
    <div className="px-7 pt-4 pb-[30px]">
      {/* Quarterly. */}
      <SectionHead
        title="Quarterly results"
        meta="CONSOLIDATED · SAR MN"
        right={
          <>
            <span className="cursor-pointer bg-ink px-[9px] py-[3px] text-[9.5px] font-bold text-paper-tint">STANDARD</span>
            <span className="cursor-pointer border border-hairline-strong px-[9px] py-[2.5px] text-[9.5px] text-ink-muted">SEGMENTS</span>
            <span className="cursor-pointer border border-hairline-strong px-[9px] py-[2.5px] text-[9.5px] text-ink-muted">Y/Y GROWTH</span>
          </>
        }
      />
      <div className="overflow-x-auto">
        <div className="min-w-[900px]">
          <PeriodHead cols={Q_COLS} periods={f.quarterlyPeriods} pdfCol />
          {f.quarterlyRows.map((r) => (
            <Row key={r.label} cols={Q_COLS} r={r} size="text-[11px]" pdfCol />
          ))}
        </div>
      </div>
      <div className="mt-2 font-mono text-[8.5px] text-ink-faint">{f.quarterlyNote}</div>

      {/* Annual P&L. */}
      <div className="mt-[26px]">
        <SectionHead title="Profit & loss" meta="ANNUAL · SAR MN" />
        <div className="overflow-x-auto">
          <div className="min-w-[900px]">
            <PeriodHead cols={A_COLS} periods={f.annualPeriods} />
            {f.annualRows.map((r) => (
              <Row key={r.label} cols={A_COLS} r={r} size="text-[10.5px]" />
            ))}
          </div>
        </div>
      </div>

      {/* CAGR block. */}
      <div className="mt-4 grid grid-cols-1 border border-ink sm:grid-cols-2 lg:grid-cols-4">
        {f.cagr.map((b, i) => (
          <div key={b.title} className={`px-[15px] py-3 ${i < f.cagr.length - 1 ? "border-r border-hairline-soft" : ""}`}>
            <div className="font-mono text-[8.5px] tracking-[0.1em] text-ink-faint uppercase">{b.title}</div>
            <div className="mt-2 flex flex-col gap-1">
              {b.rows.map((row) => (
                <div key={row.label} className="flex justify-between">
                  <span className="text-[11px] text-ink-muted">{row.label}</span>
                  <span className="font-display text-[14px] font-semibold tabular-nums text-ink">{row.value}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Balance sheet + Cash flow. */}
      <div className="mt-[26px] grid grid-cols-1 gap-8 lg:grid-cols-2 lg:gap-x-[30px]">
        <div>
          <SectionHead title="Balance sheet" meta="SELECTED · SAR MN" />
          <KeyValTable rows={f.balanceSheet.rows} />
          <div className="mt-2 font-mono text-[8.5px] text-ink-faint">{f.balanceSheet.note}</div>
        </div>
        <div>
          <SectionHead title="Cash flow" meta="SELECTED · SAR MN" />
          <KeyValTable rows={f.cashFlow.rows} />
          <div className="mt-2 font-mono text-[8.5px] text-ink-faint">{f.cashFlow.note}</div>
        </div>
      </div>
    </div>
  );
}
