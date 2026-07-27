import { checkCount, clampMax, warnConstraint } from "../constraints";
import { BlockFootnote, Val, isBound } from "../primitives";
import type { BlockNodeOf } from "../types";

/*
 * BLK-COMPARE · Transposed comparison — C · Tabular
 *
 * "METRICS AS ROWS, NAMES AS COLUMNS · MAX 4 NAMES, 8 METRICS"
 * "PRICES STAY LOCAL, MARKET CAP IS USD-NORMALISED · BEST-IN-ROW IS BOLD"
 * "EMPTY SLOT KEEPS ITS DASHED COLUMN SO THE GRID NEVER REFLOWS"
 *
 * Transposed because metrics are the thing being compared and names are the
 * variable — reading down a column is reading one company, reading across a row
 * is the comparison. The dashed empty slot is not decoration: it holds the
 * column width so adding a fourth name does not re-lay-out everything the
 * reader had already parsed.
 *
 * NOTE ON THE SPEC — the artifact draws this grid as `104px` + equal `1fr`
 * columns with 12.5px SANS values, LEFT-aligned. It is not the 62px mono
 * right-aligned grid; that is BLK-FINTABLE's. The card wins, so this follows
 * the card.
 */
const MAX_NAMES = 4;
const MAX_METRICS = 8;
const DASHED_LEFT = { borderLeftStyle: "dashed" } as const;

export function BlockCompare({ node }: { node: BlockNodeOf<"BLK-COMPARE"> }) {
  const { names, metrics, addSlot = false, footnote } = node.payload;

  checkCount("BLK-COMPARE", "names", names.length, 2, MAX_NAMES);
  const shownNames = clampMax("BLK-COMPARE", "names", names, MAX_NAMES);
  const shownMetrics = clampMax("BLK-COMPARE", "metric rows", metrics, MAX_METRICS);
  // The add slot must not push the grid past four columns of names.
  const slot = addSlot && shownNames.length < MAX_NAMES;
  if (addSlot && !slot) {
    warnConstraint("BLK-COMPARE", "add slot dropped — the grid is already at the 4-name maximum.");
  }

  const columns = shownNames.length + (slot ? 1 : 0);
  const grid = { gridTemplateColumns: `104px repeat(${columns}, 1fr)` };

  return (
    <div>
      <div className="grid" style={grid}>
        {/* Header row: an empty corner, then one column per name. */}
        <div className="border-b border-hairline" />
        {shownNames.map((n) => (
          <div key={n.ticker} className="border-b border-l border-hairline-soft border-b-hairline px-3 py-[9px]">
            <div className="font-mono text-[9px] font-semibold text-ink">{n.ticker}</div>
            <div className="mt-0.5 text-[12px] font-semibold text-ink">{n.name}</div>
          </div>
        ))}
        {slot ? (
          // Only the LEFT edge is dashed; Tailwind has no per-side border-style
          // utility, so the one property that must differ is set inline.
          <div
            className="grid place-items-center border-b border-l border-l-hairline-strong border-b-hairline px-3 py-[9px] text-ink-faint"
            style={DASHED_LEFT}
          >
            <span className="text-[11px] font-semibold">+ Add</span>
          </div>
        ) : null}

        {shownMetrics.map((m, mi) => {
          if (m.values.length !== shownNames.length) {
            warnConstraint(
              "BLK-COMPARE",
              `metric "${m.label}" has ${m.values.length} values for ${shownNames.length} names — columns will not align.`,
            );
          }
          return (
            <ContentsRow key={`${m.label}-${mi}`}>
              <div className="self-center font-mono text-[8px] tracking-[0.1em] text-ink-faint uppercase">
                {m.label}
              </div>
              {shownNames.map((n, ni) => (
                <div
                  key={`${m.label}-${n.ticker}`}
                  className={`border-b border-l border-hairline-soft border-b-hairline-faint px-3 py-[9px] text-[12.5px] ${
                    m.bestIndex === ni ? "font-semibold text-ink" : "text-ink"
                  }`}
                >
                  <Val v={m.values[ni] ?? null} />
                </div>
              ))}
              {slot ? (
                <div
                  className="border-b border-l border-l-hairline-strong border-b-hairline-faint"
                  style={DASHED_LEFT}
                />
              ) : null}
            </ContentsRow>
          );
        })}
      </div>
      {isBound(footnote) ? <BlockFootnote>{footnote}</BlockFootnote> : null}
    </div>
  );
}

/** `display:contents` so a keyed row wrapper does not break the parent grid. */
function ContentsRow({ children }: { children: React.ReactNode }) {
  return <div className="contents">{children}</div>;
}
