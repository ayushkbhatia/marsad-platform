import { warnConstraint } from "../constraints";
import { ChartFrame } from "./ChartFrame";
import type { BlockNodeOf } from "../types";

/**
 * BLK-STACK · Proportional bar — "WHAT'S IT MADE OF?"
 *
 * "MAX 4 SEGMENTS · IF A SEGMENT IS UNDER 5% MERGE IT INTO 'OTHER'"
 *
 * The 5% merge is done HERE rather than asked of the writer, because it is arithmetic over resolved
 * values and the writer never saw them — it emitted bindings. Merging is also the honest move: a
 * 2% sliver is unreadable at this size, and drawing it invites a reader to compare two slivers that
 * differ by less than the stroke width.
 *
 * Labels sit inside the segments, so a segment too narrow to hold its own label is dropped from the
 * label pass rather than overflowing into its neighbour.
 */
export function BlockStack({ node }: { node: BlockNodeOf<"BLK-STACK"> }) {
  const { caption, segments = [], unit } = node.payload;

  const usable = segments.filter((s) => typeof s.value === "number" && Number.isFinite(s.value));
  const total = usable.reduce((a, s) => a + (s.value ?? 0), 0);
  const gaps = usable.length !== segments.length;

  const pct = (v: number) => (total > 0 ? (v / total) * 100 : 0);
  const big = usable.filter((s) => pct(s.value ?? 0) >= 5);
  const smallTotal = usable.filter((s) => pct(s.value ?? 0) < 5).reduce((a, s) => a + (s.value ?? 0), 0);

  const drawn = smallTotal > 0
    ? [...big, { label: "Other", value: smallTotal, objectId: "", state: "DERIVED" }]
    : big;

  if (drawn.length > 4) {
    warnConstraint("BLK-STACK", `${drawn.length} segments above 5% — the block draws at most four.`);
  }

  const TONES = ["bg-ink", "bg-ink-mid", "bg-ink-muted", "bg-dark-text-faint", "bg-hairline-strong"];

  return (
    <ChartFrame
      question="WHAT'S IT MADE OF?"
      caption={caption}
      unit={unit}
      series={[{ label: "composition", points: segments.map((s) => ({ label: s.label, date: null, value: s.value, objectId: s.objectId, state: s.state })) }]}
      gaps={gaps}
    >
      <div className="flex h-9 w-full overflow-hidden" role="img" aria-label={caption}>
        {drawn.map((s, i) => {
          const w = pct(s.value ?? 0);
          return (
            <div key={`${s.label}-${i}`} className={`flex items-center justify-center ${TONES[i] ?? "bg-hairline"}`} style={{ width: `${w}%` }}>
              {/* Only label a segment wide enough to hold one — an overflowing label reads as the
                  neighbour's. */}
              {w >= 12 ? (
                <span className="truncate px-1.5 font-mono text-[8.5px] tracking-[0.06em] text-paper-tint uppercase">
                  {s.label} {Math.round(w)}%
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      {smallTotal > 0 ? (
        <p className="mt-1.5 font-mono text-[8px] tracking-[0.08em] text-ink-faint uppercase">
          Segments under 5% merged into “other”
        </p>
      ) : null}
    </ChartFrame>
  );
}
