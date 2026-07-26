import type {
  AlertsData,
  AlertCap,
  StockAlert,
  AlertState,
} from "@/lib/contracts/alerts";

/**
 * Alerts manager (design 5a) — "what Marsad will interrupt you for, and how".
 * Three alert types, each with its own free ceiling shown inline (turning red
 * at the cap) and a Premium ceiling beneath — the caps ARE the monetisation
 * surface. Composer is a sentence of dropdown pills, not a modal. Alert states:
 * TRIGGERED (ink-filled), ● ARMED (green outline), PAUSED (grey outline).
 * Sample-driven (DEF-ALERTS-LIVE-DATA).
 */
const STOCK_COLS = "grid-cols-[70px_1fr_1.3fr_110px_96px_92px_90px]";

function CapBadge({ cap }: { cap: AlertCap }) {
  const atLimit = cap.used >= cap.limit;
  return (
    <span className="flex items-baseline gap-2">
      <span className={`font-mono text-[9px] font-semibold tracking-[0.08em] ${atLimit ? "text-negative" : "text-ink-muted"}`}>
        {cap.used} / {cap.limit} USED
      </span>
      {cap.premiumLimit ? (
        <span className="font-mono text-[9px] tracking-[0.08em] text-ink-faint">· PREMIUM: {cap.premiumLimit}</span>
      ) : null}
    </span>
  );
}

function StateChip({ state }: { state: AlertState }) {
  if (state === "TRIGGERED") {
    return <span className="bg-ink px-[7px] py-[3px] font-mono text-[8px] font-semibold tracking-[0.08em] text-paper-tint">TRIGGERED</span>;
  }
  if (state === "ARMED") {
    return <span className="border border-positive px-[7px] py-[2px] font-mono text-[8px] font-semibold tracking-[0.08em] text-positive">● ARMED</span>;
  }
  return <span className="border border-hairline-strong px-[7px] py-[2px] font-mono text-[8px] font-semibold tracking-[0.08em] text-ink-faint">PAUSED</span>;
}

function Pill({ children, caret }: { children: React.ReactNode; caret?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 border border-hairline-strong bg-paper px-2.5 py-1.5 font-ui text-[11px] font-semibold text-ink">
      {children}
      {caret ? <span className="text-ink-faint">▾</span> : null}
    </span>
  );
}

function SectionHead({ title, right }: { title: string; right: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b-2 border-ink pb-2">
      <span className="font-ui text-[13px] font-bold text-ink">{title}</span>
      {right}
    </div>
  );
}

function StockRow({ a }: { a: StockAlert }) {
  return (
    <div className={`grid ${STOCK_COLS} items-center gap-2.5 border-b border-hairline-faint px-1 py-[9px]`}>
      <span className="font-mono text-[11px] font-semibold text-ink">{a.ticker}</span>
      <span className="truncate text-[12px] text-ink-mid">{a.name}</span>
      <span className="truncate text-[11.5px] text-ink">{a.condition}</span>
      <span className="font-mono text-[8.5px] tracking-[0.06em] text-ink-muted">{a.delivery}</span>
      <span><StateChip state={a.state} /></span>
      <span className="font-mono text-[9px] text-ink-faint">{a.lastFired}</span>
      <span className="text-right font-mono text-[9px] text-ink-muted">Edit · Pause · ✕</span>
    </div>
  );
}

export function AlertsManager({ data }: { data: AlertsData }) {
  return (
    <div className="px-7 pt-[22px] pb-[30px]">
      <div className="flex flex-wrap items-baseline gap-3.5 border-b-2 border-ink pb-3.5">
        <span className="font-display text-[27px] font-bold text-ink">Alerts</span>
        <span className="text-[12px] text-ink-muted">What Marsad will interrupt you for — and how</span>
        <div className="ml-auto flex gap-2">
          <span className="cursor-pointer border border-hairline-strong px-[13px] py-[7px] text-[11px] font-semibold text-ink-muted">Pause all</span>
          <span className="cursor-pointer border border-ink px-[13px] py-[7px] text-[11px] font-semibold text-ink">+ New alert</span>
        </div>
      </div>

      {/* KPI strip */}
      <div className="mt-4 flex flex-wrap border border-hairline bg-paper-tint sm:flex-nowrap">
        {data.kpis.map((k, i) => (
          <div key={k.label} className={`flex-1 px-[16px] py-[11px] ${i < data.kpis.length - 1 ? "border-r border-hairline" : ""}`}>
            <div className="font-mono text-[8px] tracking-[0.1em] text-ink-faint uppercase">{k.label}</div>
            <div className="mt-1 font-ui text-[13px] font-semibold text-ink">{k.value}</div>
          </div>
        ))}
      </div>

      <div className="mt-5 grid grid-cols-1 gap-8 lg:grid-cols-[1fr_330px] lg:gap-x-[30px]">
        {/* Main column */}
        <div>
          {/* Stock alerts */}
          <SectionHead title="Stock alerts" right={<CapBadge cap={data.stock.cap} />} />
          <div className="mt-2 font-mono text-[8px] tracking-[0.1em] text-ink-faint">PRICE · SCORE · EVENTS · RATIOS</div>
          {/* Composer sentence */}
          <div className="mt-2.5 flex flex-wrap items-center gap-2 border border-hairline bg-paper-tint px-3 py-2.5">
            <span className="bg-ink px-[7px] py-[3px] font-mono text-[8px] font-bold tracking-[0.1em] text-paper-tint">NEW</span>
            <Pill caret>{data.composer.ticker}</Pill>
            <Pill caret>{data.composer.condition}</Pill>
            <span className="border border-hairline-strong bg-paper px-2.5 py-1.5 font-mono text-[11px] text-ink">{data.composer.value}</span>
            <Pill caret>{data.composer.channel}</Pill>
            <span className="ml-auto cursor-pointer bg-ink px-3 py-[7px] font-ui text-[10px] font-bold tracking-[0.06em] text-paper-tint uppercase">Arm →</span>
          </div>
          {/* Table */}
          <div className={`mt-3 grid ${STOCK_COLS} gap-2.5 border-b border-hairline px-1 pb-[5px]`}>
            {["Ticker", "Name", "Condition", "Delivery", "State", "Last fired", ""].map((h, i) => (
              <span key={h || i} className={`font-mono text-[8px] tracking-[0.08em] text-ink-faint uppercase ${i === 6 ? "text-right" : ""}`}>{h}</span>
            ))}
          </div>
          {data.stock.rows.map((a) => (
            <StockRow key={a.ticker} a={a} />
          ))}

          {/* Screen + Phrase side by side */}
          <div className="mt-6 grid grid-cols-1 gap-x-[30px] gap-y-6 sm:grid-cols-2">
            <div>
              <SectionHead title="Screen alerts" right={<CapBadge cap={data.screen.cap} />} />
              {data.screen.rows.map((s) => (
                <div key={s.name} className="border-b border-hairline-faint py-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[12.5px] font-semibold text-ink">{s.name}</span>
                    <span className="font-mono text-[8px] tracking-[0.08em] text-ink-faint">{s.cadence}</span>
                  </div>
                  <div className="mt-1 font-mono text-[9.5px] text-positive">{s.detail}</div>
                </div>
              ))}
              <div className="mt-2 font-mono text-[8.5px] leading-[1.6] text-[#a8a396]">{data.screen.ceilingNote}</div>
            </div>

            <div>
              <SectionHead title="Phrase alerts" right={<CapBadge cap={data.phrase.cap} />} />
              <div className="mt-2 font-mono text-[8px] tracking-[0.1em] text-ink-faint">SCANS EVERY FILING</div>
              {data.phrase.rows.map((p) => (
                <div key={p.phrase} className="flex items-baseline gap-2 border-b border-hairline-faint py-2.5">
                  <span className="font-display text-[13px] font-semibold text-ink">{p.phrase}</span>
                  <span className="text-[10.5px] text-ink-muted">{p.scope}</span>
                  <span className="ml-auto font-mono text-[8px] tracking-[0.06em] text-ink-faint">{p.delivery}</span>
                  <span className="font-mono text-[8.5px] text-positive">{p.hits}</span>
                </div>
              ))}
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-[8px] tracking-[0.1em] text-ink-faint">POPULAR:</span>
                {data.phrase.popularLocked.map((chip) => (
                  <span key={chip} className="inline-flex items-center gap-1 border border-hairline-strong px-2 py-[3px] font-mono text-[9px] text-ink-faint">
                    + {chip} <span aria-hidden>🔒</span>
                  </span>
                ))}
              </div>
              <div className="mt-2 font-mono text-[8.5px] leading-[1.6] text-[#a8a396]">{data.phrase.note}</div>
            </div>
          </div>
        </div>

        {/* Right rail */}
        <aside className="lg:border-l lg:border-hairline lg:pl-6">
          <div className="flex items-baseline justify-between border-b-2 border-ink pb-2">
            <span className="font-ui text-[10px] font-bold tracking-[0.18em] text-ink uppercase">Trigger log</span>
            <span className="flex items-center gap-1.5 font-mono text-[8.5px] tracking-[0.08em] text-positive">
              <span className="h-1.5 w-1.5 rounded-full bg-positive" />● LIVE
            </span>
          </div>
          {data.triggerLog.map((t, i) => (
            <div key={i} className="flex items-baseline gap-2.5 border-b border-hairline-faint py-2.5">
              <span className="w-14 flex-none font-mono text-[9px] font-semibold text-ink">{t.when}</span>
              <span className="w-12 flex-none font-mono text-[7.5px] tracking-[0.08em] text-ink-faint">{t.kind}</span>
              <span className="flex-1 text-[10.5px] leading-[1.4] text-ink-mid">{t.text}</span>
            </div>
          ))}

          <div className="mt-6 flex items-baseline justify-between border-b-2 border-ink pb-2">
            <span className="font-ui text-[10px] font-bold tracking-[0.18em] text-ink uppercase">Delivery</span>
            <span className="cursor-pointer text-[10.5px] text-ink-muted underline underline-offset-[3px]">Edit</span>
          </div>
          {data.delivery.channels.map((c) => (
            <div key={c.label} className="flex items-center gap-2 border-b border-hairline-faint py-2.5">
              <span className={`inline-block h-3.5 w-3.5 flex-none border ${c.on ? "border-ink bg-ink" : "border-hairline-strong"}`} aria-hidden>
                {c.on ? <span className="block text-center text-[10px] leading-[13px] text-paper-tint">✓</span> : null}
              </span>
              <span className="text-[11.5px] text-ink">{c.label}</span>
              {c.premium ? <span className="ml-auto bg-ink px-1.5 py-[2px] font-mono text-[7px] font-bold tracking-[0.1em] text-paper-tint">PREMIUM</span> : null}
            </div>
          ))}
          <div className="mt-2.5 flex items-baseline justify-between">
            <span className="text-[11px] text-ink-mid">Quiet hours</span>
            <span className="font-mono text-[10px] text-ink">{data.delivery.quietHours}</span>
          </div>
          <div className="mt-2 font-mono text-[8.5px] leading-[1.6] text-[#a8a396]">{data.delivery.note}</div>

          <div className="mt-6 border border-ink bg-paper-tint px-4 py-3.5">
            <div className="font-ui text-[11px] font-bold tracking-[0.14em] text-ink uppercase">{data.goPremium.headline}</div>
            <div className="mt-2 text-[11px] leading-[1.5] text-ink-muted">{data.goPremium.body}</div>
            <span className="mt-2.5 inline-block cursor-pointer bg-ink px-3 py-[7px] font-ui text-[10px] font-bold tracking-[0.06em] text-paper-tint uppercase">{data.goPremium.cta}</span>
          </div>
        </aside>
      </div>
    </div>
  );
}
