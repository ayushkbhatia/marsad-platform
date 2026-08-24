import { extent, scale, type SeriesPoint } from "@/lib/blocks/chart-svg";
import { warnConstraint } from "../constraints";
import { ChartFrame } from "./ChartFrame";
import type { BlockNodeOf } from "../types";

/**
 * BLK-INDEXED · Rebased performance — "VS WHAT?"
 *
 * "ALWAYS REBASE TO 100 AND ALWAYS SHOW THE BENCHMARK · SUBJECT SOLID, BENCHMARK DASHED"
 *
 * Both halves are non-negotiable and for the same reason: the question this shape answers is
 * comparative, so a chart without a benchmark has no answer to give — it is a price line wearing a
 * comparison's clothes. The benchmark is a required payload field rather than an optional one.
 *
 * Rebasing happens HERE, from the first resolved point of each series. The writer emitted bindings
 * and never saw the values, so it could not have rebased them; and rebasing in the renderer means
 * the underlying facts stay the raw bound figures a citation points at.
 */
const W = 640;
const H = 240;
const PAD = { l: 34, r: 12, t: 12, b: 24 };

function rebase(points: SeriesPoint[]): Array<{ p: SeriesPoint; v: number | null }> {
  const firstOk = points.find((p) => typeof p.value === "number" && Number.isFinite(p.value));
  const base = firstOk?.value ?? null;
  return points.map((p) => ({
    p,
    v: base && typeof p.value === "number" && Number.isFinite(p.value) ? (p.value / base) * 100 : null,
  }));
}

export function BlockIndexed({ node }: { node: BlockNodeOf<"BLK-INDEXED"> }) {
  const { caption, subject = { label: "", points: [] }, benchmark, unit } = node.payload;

  if (!benchmark || benchmark.points.length === 0) {
    warnConstraint("BLK-INDEXED", "no benchmark — 'vs what?' has no answer without one.");
  }

  const s = rebase((subject?.points ?? []) as SeriesPoint[]);
  const b = rebase((benchmark?.points ?? []) as SeriesPoint[]);
  const gaps = [...s, ...b].some((x) => x.v === null);
  const dom = extent([100, ...s.map((x) => x.v), ...b.map((x) => x.v)]);

  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const path = (rows: typeof s) => {
    const n = Math.max(rows.length - 1, 1);
    let d = "";
    let pen = false;
    rows.forEach((r, i) => {
      if (r.v === null) { pen = false; return; }   // a gap BREAKS the line — never interpolated
      const x = PAD.l + (i / n) * innerW;
      const y = PAD.t + innerH - (dom ? scale(r.v, dom, innerH) : 0);
      d += `${pen ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };
  const y100 = dom ? PAD.t + innerH - scale(100, dom, innerH) : PAD.t + innerH;

  return (
    <ChartFrame
      question="VS WHAT?"
      caption={caption}
      unit={unit}
      series={[subject, benchmark].filter(Boolean) as typeof subject[]}
      gaps={gaps}
    >
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={caption}>
        {/* the rebase line — 100 is the whole premise of the chart */}
        <line x1={PAD.l} y1={y100} x2={W - PAD.r} y2={y100} stroke="var(--color-hairline)" strokeWidth={1} />
        <text x={4} y={y100 + 3} className="fill-ink-faint font-mono text-[8px]">100</text>

        <path d={path(b)} fill="none" stroke="var(--color-dark-text-faint)" strokeWidth={1.8} strokeDasharray="5 5" />
        <path d={path(s)} fill="none" stroke="var(--color-ink)" strokeWidth={2.2} />
      </svg>
      <p className="mt-1.5 font-mono text-[8px] tracking-[0.08em] text-ink-faint uppercase">
        {subject.label} solid · {benchmark?.label ?? "benchmark"} dashed · rebased to 100
      </p>
    </ChartFrame>
  );
}
