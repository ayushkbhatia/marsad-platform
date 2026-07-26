import type { AiThesis, ThesisClaim } from "@/lib/contracts/thesis";

/**
 * AI Thesis tab (design 10d). Two independent lenses on one name — the dark
 * "TWO LENSES" rail states the quant Score is computed independently of this
 * narrative thesis. Bull/bear cards differ by a 3px TOP border (not fill);
 * every claim carries a numbered citation resolving to THESIS SOURCES, except
 * the one structural bear fact. Falsifiability ("what would change this view")
 * is first-class. Sample-driven (DEF-THESIS-LIVE-DATA).
 */
function Cite({ id }: { id: number }) {
  return (
    <sup className="ml-1 inline-flex h-[13px] min-w-[13px] items-center justify-center border border-hairline-strong px-[3px] align-super font-mono text-[7.5px] font-semibold text-ink-muted">
      {id}
    </sup>
  );
}

function ClaimRow({ c }: { c: ThesisClaim }) {
  return (
    <li className="flex gap-1.5 py-1.5 text-[12px] leading-[1.5] text-ink">
      <span className="flex-none text-ink-faint">—</span>
      <span>
        {c.text}
        {c.citationId ? <Cite id={c.citationId} /> : null}
      </span>
    </li>
  );
}

export function StockThesis({ thesis }: { thesis: AiThesis }) {
  const fv = thesis.fairValue;
  // Position the four markers along the bear→bull span.
  const lo = fv.bear;
  const hi = fv.bull;
  const pos = (v: number) => `${((v - lo) / (hi - lo)) * 100}%`;
  const markers: { label: string; v: number; tone: "bear" | "last" | "base" | "bull" }[] = [
    { label: "BEAR", v: fv.bear, tone: "bear" },
    { label: "LAST", v: fv.last, tone: "last" },
    { label: "BASE", v: fv.base, tone: "base" },
    { label: "BULL", v: fv.bull, tone: "bull" },
  ];

  return (
    <div className="px-7 pt-5 pb-10">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 border-b border-hairline pb-3">
        <span className="font-mono text-[10px] font-semibold tracking-[0.14em] text-ink-muted uppercase">{thesis.subject}</span>
        <span className="font-mono text-[8.5px] tracking-[0.1em] text-ink-faint uppercase">{thesis.generated}</span>
        <span className="ml-auto cursor-pointer border border-ink px-3 py-1.5 font-mono text-[9px] font-bold tracking-[0.08em] text-ink uppercase">
          {thesis.regenerate}
        </span>
      </div>

      <h2 className="mt-4 max-w-[820px] font-display text-[25px] font-semibold leading-[1.25] tracking-[-0.01em] text-ink">
        {thesis.headline}
      </h2>

      <div className="mt-6 grid grid-cols-1 gap-[30px] lg:grid-cols-[1fr_344px]">
        <div>
          {/* Bull / bear — differ by a 3px top border, not fill */}
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <div className="border border-hairline border-t-[3px] border-t-positive px-4 py-3.5">
              <div className="font-ui text-[9.5px] font-bold tracking-[0.12em] text-ink uppercase">Bull case — what the filings support</div>
              <ul className="mt-2">
                {thesis.bull.map((c, i) => <ClaimRow key={i} c={c} />)}
              </ul>
            </div>
            <div className="border border-hairline border-t-[3px] border-t-negative px-4 py-3.5">
              <div className="font-ui text-[9.5px] font-bold tracking-[0.12em] text-ink uppercase">Bear case — what would hurt</div>
              <ul className="mt-2">
                {thesis.bear.map((c, i) => <ClaimRow key={i} c={c} />)}
              </ul>
            </div>
          </div>

          {/* Fair-value bar (dark) */}
          <div className="mt-6 bg-ink px-5 py-4 text-paper-tint">
            <div className="flex items-baseline justify-between">
              <span className="font-ui text-[9.5px] font-bold tracking-[0.14em] uppercase">AI fair-value range</span>
              <span className="font-mono text-[8px] tracking-[0.1em] text-[#a8a396] uppercase">{fv.basis}</span>
            </div>
            <div className="relative mt-8 mb-6 h-px bg-[#4a4740]">
              {markers.map((m) => (
                <div key={m.label} className="absolute -translate-x-1/2" style={{ left: pos(m.v) }}>
                  <div
                    className={`mx-auto h-2.5 w-2.5 -translate-y-1/2 rotate-45 ${
                      m.tone === "last" ? "bg-caution" : m.tone === "bull" ? "bg-positive" : m.tone === "bear" ? "bg-[#c96a5f]" : "bg-paper-tint"
                    }`}
                  />
                  <div className="mt-1.5 text-center font-mono text-[8px] tracking-[0.06em] text-[#a8a396]">{m.label}</div>
                  <div className="text-center font-mono text-[12px] font-semibold text-paper-tint">{m.v.toFixed(2)}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Catalysts / falsifiers */}
          <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div>
              <div className="border-b-2 border-ink pb-1.5 font-ui text-[9.5px] font-bold tracking-[0.14em] text-ink uppercase">Catalysts — next 90 days</div>
              {thesis.catalysts.map((c) => (
                <div key={c.when} className="flex gap-2.5 border-b border-hairline-faint py-2">
                  <span className="w-14 flex-none font-mono text-[9px] font-semibold text-ink">{c.when}</span>
                  <span className="flex-1 text-[11.5px] leading-[1.45] text-ink-mid">{c.text}</span>
                </div>
              ))}
            </div>
            <div>
              <div className="border-b-2 border-ink pb-1.5 font-ui text-[9.5px] font-bold tracking-[0.14em] text-ink uppercase">What would change this view</div>
              <ul className="pt-1">
                {thesis.falsifiers.map((f) => (
                  <li key={f} className="flex gap-1.5 border-b border-hairline-faint py-2 text-[11.5px] leading-[1.45] text-ink-mid">
                    <span className="flex-none text-ink-faint">—</span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="mt-5 font-mono text-[8.5px] leading-[1.7] tracking-[0.04em] text-ink-faint uppercase">{thesis.disclaimer}</div>
        </div>

        {/* Right rail */}
        <aside>
          <div className="bg-ink px-5 py-4 text-paper-tint">
            <div className="font-ui text-[9.5px] font-bold tracking-[0.16em] uppercase">Two lenses, one name</div>
            <div className="mt-3.5 flex items-stretch gap-3">
              <div className="flex-1 border border-[#4a4740] px-3 py-2.5">
                <div className="font-mono text-[8px] tracking-[0.1em] text-[#a8a396]">MARSAD SCORE</div>
                <div className="mt-1 font-display text-[28px] font-bold leading-none">{thesis.twoLenses.score.value}</div>
                <div className="mt-1 font-mono text-[7.5px] tracking-[0.08em] text-[#a8a396]">{thesis.twoLenses.score.label}</div>
              </div>
              <div className="flex-1 border border-[#4a4740] px-3 py-2.5">
                <div className="font-mono text-[8px] tracking-[0.1em] text-[#a8a396]">AI THESIS</div>
                <div className="mt-1 font-display text-[15px] font-semibold leading-[1.2]">{thesis.twoLenses.thesis.verdict}</div>
                <div className="mt-1 font-mono text-[7.5px] tracking-[0.08em] text-[#a8a396]">{thesis.twoLenses.thesis.label}</div>
              </div>
            </div>
            <div className="mt-3 text-[11px] leading-[1.5] text-[#c9c4b6]">{thesis.twoLenses.note}</div>
          </div>

          <div className="mt-5">
            <div className="border-b-2 border-ink pb-2 font-ui text-[10px] font-bold tracking-[0.16em] text-ink uppercase">
              Thesis sources · {thesis.sources.length}
            </div>
            {thesis.sources.map((s) => (
              <div key={s.id} className="flex gap-2.5 border-b border-hairline-faint py-2">
                <span className="flex-none font-mono text-[9px] font-semibold text-ink">[{s.id}]</span>
                <span className="flex-1 text-[11px] leading-[1.4] text-ink-mid">{s.text}</span>
              </div>
            ))}
          </div>

          <div className="mt-5 border border-ink bg-paper-tint px-4 py-3.5">
            <div className="font-ui text-[10px] font-bold tracking-[0.14em] text-ink uppercase">Ask a follow-up</div>
            <div className="mt-2 flex items-center gap-2 border border-hairline-strong bg-paper px-2.5 py-2">
              <span className="flex-1 font-ui text-[11px] text-ink-faint">Open the 2222 AI panel →</span>
              <span className="cursor-pointer bg-ink px-2.5 py-1 font-mono text-[9px] font-bold tracking-[0.06em] text-paper-tint">ASK</span>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
