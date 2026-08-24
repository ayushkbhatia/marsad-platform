import { extent, scale } from "@/lib/blocks/chart-svg";
import { ChartFrame } from "./ChartFrame";
import type { BlockNodeOf } from "../types";

/**
 * BLK-DUMBBELL · Before / after — "WHAT CHANGED?"
 *
 * "HOLLOW = OLD · SOLID = NEW · DIRECTION READS INSTANTLY"
 *
 * The hollow/solid convention does the work a legend would otherwise have to: a reader scanning
 * the column sees which end is current without decoding a colour. Colour is reserved for the delta
 * label, and it encodes DIRECTION ONLY — a large cut and a small one are the same red, because the
 * chart's job is to show which way each row moved, not to rank the moves.
 */
const W = 640;
const ROW = 26;
const PAD = { l: 132, r: 64, t: 10, b: 10 };

export function BlockDumbbell({ node }: { node: BlockNodeOf<"BLK-DUMBBELL"> }) {
  const { caption, rows = [], fromLabel, toLabel, unit } = node.payload;

  const gaps = rows.some(
    (r) => typeof r.from !== "number" || typeof r.to !== "number" || !Number.isFinite(r.from) || !Number.isFinite(r.to),
  );
  const dom = extent(rows.flatMap((r) => [r.from, r.to]));
  const H = PAD.t + rows.length * ROW + PAD.b;
  const innerW = W - PAD.l - PAD.r;
  const x = (v: number) => PAD.l + (dom ? scale(v, dom, innerW) : 0);

  return (
    <ChartFrame
      question="WHAT CHANGED?"
      caption={caption}
      unit={unit}
      series={[{ label: `${fromLabel} → ${toLabel}`, points: rows.map((r) => ({ label: r.label, date: null, value: r.to, objectId: r.objectId, state: r.state })) }]}
      gaps={gaps}
    >
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={caption}>
        {rows.map((r, i) => {
          const cy = PAD.t + i * ROW + ROW / 2;
          const ok = typeof r.from === "number" && typeof r.to === "number";
          const up = ok && r.to! >= r.from!;
          return (
            <g key={`${r.label}-${i}`}>
              <text x={0} y={cy + 3} className="fill-ink font-mono text-[10px]">{r.label}</text>
              {ok ? (
                <>
                  <line x1={x(r.from!)} y1={cy} x2={x(r.to!)} y2={cy}
                        stroke="var(--color-hairline)" strokeWidth={2} />
                  {/* hollow = old */}
                  <circle cx={x(r.from!)} cy={cy} r={5} className="fill-paper"
                          stroke="var(--color-dark-text-faint)" strokeWidth={2} />
                  {/* solid = new */}
                  <circle cx={x(r.to!)} cy={cy} r={5} className="fill-ink" />
                  <text x={W - PAD.r + 8} y={cy + 3}
                        className={`font-mono text-[9.5px] ${up ? "fill-positive" : "fill-negative"}`}>
                    {up ? "▲" : "▼"}
                  </text>
                </>
              ) : (
                <text x={PAD.l} y={cy + 3} className="fill-ink-faint font-mono text-[9px]">—</text>
              )}
            </g>
          );
        })}
      </svg>
      <p className="mt-1.5 font-mono text-[8px] tracking-[0.08em] text-ink-faint uppercase">
        Hollow {fromLabel} · solid {toLabel}
      </p>
    </ChartFrame>
  );
}
