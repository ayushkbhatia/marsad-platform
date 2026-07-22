/**
 * Pros/Cons cards (screen 3a). No pipeline produces machine pros/cons from
 * filings today (no such table exists in the schema) — this renders the
 * design's exact card chrome (top-border color, mono kicker, disclaimer line)
 * in an honest "awaiting desk analysis" state rather than fabricating bullets.
 */

function ProsConsCard({ kind }: { kind: "pros" | "cons" }) {
  const isPros = kind === "pros";
  return (
    <div
      className={`border border-hairline-strong border-t-[3px] px-[15px] py-[13px] ${
        isPros ? "border-t-positive" : "border-t-negative"
      }`}
    >
      <div
        className={`font-mono text-[9.5px] font-bold tracking-[0.16em] uppercase ${
          isPros ? "text-positive" : "text-negative"
        }`}
      >
        {isPros ? "Pros" : "Cons"}
      </div>
      <p className="mt-2 font-ui text-[11.5px] leading-[1.55] text-ink-faint">
        Awaiting desk analysis — machine-generated {isPros ? "strengths" : "risks"} have not been produced for
        this security yet.
      </p>
    </div>
  );
}

export function ProsConsCards() {
  return (
    <div>
      <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2">
        <ProsConsCard kind="pros" />
        <ProsConsCard kind="cons" />
      </div>
      <p className="mt-2 font-mono text-[8.5px] tracking-[0.02em] text-ink-faint italic">
        Pros &amp; cons are machine-generated from filings · exercise caution and do your own analysis.
      </p>
    </div>
  );
}
