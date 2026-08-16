import { seriesProvenance, type SeriesPoint } from "@/lib/blocks/chart-svg";
import type { ChartSeriesNode } from "../types";

/**
 * The shared chassis every D-family exhibit sits in.
 *
 * The three things it guarantees, which are the three things a chart can most easily lie about:
 *
 *  1. THE QUESTION IS PRINTED. Each card names the question its shape answers ("WHEN DID IT
 *     TURN?"). An exhibit that does not state its question invites the reader to supply one.
 *  2. A GAP IS DECLARED. If any point resolved to nothing, the footnote says so. Without that,
 *     a broken line reads as a design choice rather than as absent data.
 *  3. PROVENANCE IS PER-SERIES, NOT PER-CHART. `seriesProvenance` counts the distinct objects
 *     behind the exhibit and whether every one of them is VERIFIED — a chart drawn from twelve
 *     objects of which one is PENDING is not a verified chart, and says so.
 */
export function ChartFrame({
  question, caption, unit, series, gaps, children,
}: {
  question: string;
  caption: string;
  unit?: string | null;
  series: ChartSeriesNode[];
  gaps: boolean;
  children: React.ReactNode;
}) {
  const all = series.flatMap((s) => s.points) as SeriesPoint[];
  const prov = seriesProvenance(all);

  return (
    <figure className="border-y border-rule py-4">
      <figcaption className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">{question}</span>
        {unit ? (
          <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-ink-faint">{unit}</span>
        ) : null}
      </figcaption>

      {all.length === 0 ? (
        <p className="py-8 text-center font-mono text-[11px] text-ink-faint">
          no data resolved for this exhibit
        </p>
      ) : (
        children
      )}

      <p className="mt-3 text-[12.5px] leading-[1.55] text-ink-mid">{caption}</p>
      <p className="mt-1 font-mono text-[8.5px] uppercase tracking-[0.1em] text-ink-faint">
        {prov.objectIds.length} source{prov.objectIds.length === 1 ? "" : "s"}
        {prov.allVerified ? " · verified" : " · not all points verified"}
        {gaps ? " · breaks where a period is missing; not interpolated" : ""}
      </p>
    </figure>
  );
}
