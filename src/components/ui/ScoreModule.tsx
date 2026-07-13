import type { Rating, Surface } from "./types";

/* TODO(spec gap — 04-reader-app.md §9.2): two required faces are missing.
 *   - `locked`  — paywall-gate face for screen 4b
 *   - `pending` — 90-day pending state for screen 22c
 * ScoreModule.dc.html contains no markup for either, so they cannot be
 * ported pixel-faithfully yet. Design + implementation must land before the
 * 4b (paywall) and 22c screen builders mount this component. The gap is
 * also surfaced on /styleguide under the ScoreModule section. */
export interface ScoreModuleProps {
  /** 0–100 */
  score?: number;
  rating?: Rating;
  /** Weekly delta line, e.g. "▲ +2 THIS WEEK" — a leading ▼ renders it negative */
  delta?: string;
  /** CSV of five factor grades in order Value,Growth,Profitability,Momentum,Revisions */
  grades?: string;
  footnote?: string;
  /** DC default is dark — the Score card lives in data rooms first */
  surface?: Surface;
}

const FACTOR_NAMES = [
  "Value",
  "Growth",
  "Profitability",
  "Momentum",
  "Revisions",
] as const;

/* Grade → filled-cells count, ported from ScoreModule.dc.html (accepts both
   the unicode minus "−" used by the design fixtures and ASCII "-"). */
const GRADE_CELLS: Record<string, number> = {
  "A+": 5, A: 5, "A−": 4, "A-": 4, "B+": 4, B: 3, "B−": 3, "B-": 3,
  "C+": 2, C: 2, "C−": 2, "C-": 2, D: 1,
};

/** Marsad Score card: hero numeral, AI rating pill, 5 factor grade bars. */
export function ScoreModule({
  score = 76,
  rating = "Buy",
  delta = "▲ +2 THIS WEEK",
  grades = "B+,B−,A,C+,B",
  footnote = "84TH PERCENTILE OF 61 ENERGY NAMES · UPDATED 05 JUL 04:00 GST",
  surface = "dark",
}: ScoreModuleProps) {
  const dark = surface === "dark";
  const buyish = rating === "Buy" || rating === "Overweight";
  const sellish = rating === "Sell" || rating === "Underweight";
  const deltaDown = delta.startsWith("▼");

  const gradeList = grades.split(",");
  const factors = FACTOR_NAMES.map((name, i) => {
    const grade = (gradeList[i] ?? "B").trim();
    return { name, grade, filled: GRADE_CELLS[grade] ?? 3 };
  });

  const ratingPill = buyish
    ? "bg-positive-fill px-3 py-[5px] text-paper-tint"
    : sellish
      ? "bg-negative px-3 py-[5px] text-paper-tint"
      : dark
        ? "border border-paper-tint px-[11px] py-[4px]"
        : "border border-ink px-[11px] py-[4px]";

  const deltaColor = deltaDown
    ? dark
      ? "text-negative-dark"
      : "text-negative"
    : dark
      ? "text-positive-dark"
      : "text-positive";

  return (
    <div
      className={`box-border px-[18px] pt-[18px] pb-4 font-ui ${
        // Dark card sits on structural ink (#14120e), not the data-room bg,
        // per the DC; light card gets the 1px ink frame.
        dark ? "bg-ink text-paper-tint" : "border border-ink bg-paper text-ink"
      }`}
    >
      <div
        className={`flex items-center gap-2 border-b pb-[11px] ${
          dark ? "border-ink-mid" : "border-hairline"
        }`}
      >
        <span
          className={`h-2 w-2 flex-none rotate-45 ${dark ? "bg-paper-tint" : "bg-ink"}`}
        />
        <span className="font-mono text-[10px] font-semibold tracking-[0.2em]">
          MARSAD SCORE
        </span>
        <span
          className={`border px-[5px] py-[2px] font-mono text-[8.5px] tracking-[0.1em] ${
            dark
              ? "border-ink-muted text-hairline-strong"
              : "border-hairline-strong text-ink-muted"
          }`}
        >
          AI RATING
        </span>
      </div>

      <div className="mt-[14px] flex items-baseline gap-[10px]">
        <span className="font-display text-[62px] leading-[0.9] font-bold">
          {score}
        </span>
        <span className="font-mono text-[12px] text-ink-faint">/100</span>
        <div className="ml-auto text-right">
          <span
            className={`inline-block text-[11px] font-bold uppercase tracking-[0.14em] ${ratingPill}`}
          >
            {rating}
          </span>
          <div className={`mt-[6px] font-mono text-[9.5px] ${deltaColor}`}>
            {delta}
          </div>
        </div>
      </div>

      <div
        className={`mt-4 flex flex-col gap-[9px] border-t pt-[14px] ${
          dark ? "border-ink-soft" : "border-hairline-faint"
        }`}
      >
        {factors.map((f) => (
          <div key={f.name} className="flex items-center gap-[10px]">
            <span
              className={`w-[86px] flex-none text-[11px] ${
                dark ? "text-hairline-strong" : "text-ink-muted"
              }`}
            >
              {f.name}
            </span>
            <span className="w-[26px] font-mono text-[11px] font-semibold">
              {f.grade}
            </span>
            <span className="ml-auto flex gap-[3px]">
              {[1, 2, 3, 4, 5].map((k) => (
                <span
                  key={k}
                  className={`h-[9px] w-[9px] ${
                    k <= f.filled
                      ? dark
                        ? "bg-paper-tint"
                        : "bg-ink"
                      : dark
                        ? "bg-[#33312a]" // one-off DC cell-off tone, not a token
                        : "bg-hairline-soft"
                  }`}
                />
              ))}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-[14px] font-mono text-[9px] leading-[1.6] text-ink-faint">
        {footnote}
        <br />
        <span
          className={`cursor-pointer underline underline-offset-2 ${
            dark ? "text-hairline-strong" : "text-ink-muted"
          }`}
        >
          METHODOLOGY →
        </span>
      </div>
    </div>
  );
}
