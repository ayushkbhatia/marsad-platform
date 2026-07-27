import {
  clampMax,
  estimateHeaderClass,
  estimateLabel,
  estimateValueClass,
  warnConstraint,
} from "../constraints";
import { BlockFootnote, Val, isBound } from "../primitives";
import type { BlockNodeOf } from "../types";

/*
 * BLK-FINTABLE · Financials with estimate column — C · Tabular
 *
 * "MAX 8 ROWS INLINE · LONGER TABLES GO TO THE XLSX · BINDS FILING.FINANCIALS"
 * "FY26E COLUMN HEADER IS INK, VALUES ARE BOLD — A DESK ESTIMATE MUST NEVER
 *  READ AS AN ACTUAL"
 *
 * Hard rule 3 in its natural habitat. The agent supplies `isEstimate` per
 * period and a bare label ("FY26"); this renderer produces all three signals —
 * the E suffix, the ink header, the bold value — so the marking cannot be
 * half-applied.
 *
 * Fixed 62px columns, mono tabular numerals, right-aligned: the digits must
 * line up down the column or the table stops being readable as a series.
 */
const MAX_ROWS = 8;
const COL = 62;

export function BlockFinTable({ node }: { node: BlockNodeOf<"BLK-FINTABLE"> }) {
  const { unit, periods, rows, footnote } = node.payload;
  const shown = clampMax("BLK-FINTABLE", "rows", rows, MAX_ROWS);
  const grid = { gridTemplateColumns: `1fr ${`${COL}px `.repeat(periods.length).trim()}` };

  rows.forEach((r) => {
    if (r.values.length !== periods.length) {
      warnConstraint(
        "BLK-FINTABLE",
        `row "${r.label}" has ${r.values.length} values for ${periods.length} periods — columns will not align.`,
      );
    }
  });

  return (
    <div>
      <div
        className="grid gap-2 border-b border-hairline pt-[7px] pb-[5px]"
        style={grid}
      >
        <span className="font-mono text-[8px] tracking-[0.08em] text-ink-faint uppercase">{unit}</span>
        {periods.map((p, i) => (
          <span
            key={`${p.label}-${i}`}
            className={`text-right font-mono text-[8px] ${estimateHeaderClass(p.isEstimate)}`}
          >
            {estimateLabel(p.label, p.isEstimate)}
          </span>
        ))}
      </div>

      {shown.map((row, ri) => (
        <div
          key={`${row.label}-${ri}`}
          className={`grid gap-2 border-b border-hairline-faint py-[7px] ${row.emphasis ? "bg-paper-tint" : ""}`}
          style={grid}
        >
          <span className={`text-[12px] ${row.emphasis ? "font-bold text-ink" : "text-ink-mid"}`}>
            {row.label}
          </span>
          {periods.map((p, ci) => (
            <span
              key={`${row.label}-${ci}`}
              className={`text-right font-mono text-[11px] tabular-nums ${
                p.isEstimate
                  ? estimateValueClass(true)
                  : row.emphasis
                    ? "text-ink"
                    : estimateValueClass(false)
              }`}
            >
              <Val v={row.values[ci] ?? null} />
            </span>
          ))}
        </div>
      ))}

      {isBound(footnote) ? <BlockFootnote>{footnote}</BlockFootnote> : null}
    </div>
  );
}
