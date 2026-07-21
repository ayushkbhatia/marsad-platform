import type { Metadata } from "next";
import { libreFranklin, newsreader, plexMono } from "@/lib/fonts";
import {
  DataTableRow,
  FreshnessBadge,
  RatingBadge,
  ScoreModule,
  TickerChip,
  type FreshnessState,
  type Rating,
  type Surface,
} from "@/components/ui";

export const metadata: Metadata = {
  title: "Styleguide — Marsad",
  description: "Design tokens and core components — P0 visual verification.",
  // Internal dev-only verification page, never a public reader surface —
  // same noindex pattern as the data-room's screener/heatmap (04-reader-app
  // §8): stays crawlable so bots can see the tag, just never indexed.
  robots: { index: false, follow: false },
};

interface Swatch {
  token: string;
  hex: string;
  usage: string;
}

const INK: Swatch[] = [
  { token: "ink", hex: "#14120e", usage: "Primary text, fills, rules" },
  { token: "ink-soft", hex: "#26241f", usage: "Dark-surface secondary fills" },
  { token: "ink-mid", hex: "#33302a", usage: "Body copy on light" },
  { token: "ink-muted", hex: "#57534a", usage: "Secondary text, meta" },
  { token: "ink-faint", hex: "#8a857a", usage: "Tertiary labels, timestamps" },
];

const HAIRLINES: Swatch[] = [
  { token: "hairline-strong", hex: "#cfcabe", usage: "Input/chip borders" },
  { token: "hairline", hex: "#dcd8cc", usage: "Standard rules, card borders" },
  { token: "hairline-soft", hex: "#e3dfd4", usage: "Dense-table row dividers" },
  { token: "hairline-faint", hex: "#efece3", usage: "Lightest dividers" },
];

const PAPER: Swatch[] = [
  { token: "paper", hex: "#fdfcf9", usage: "Card/content bg, input fill" },
  { token: "paper-tint", hex: "#f6f4ee", usage: "Page bg, panels, hover rows" },
];

const DIRECTION: Swatch[] = [
  { token: "positive", hex: "#0a7a3c", usage: "Price up (light surfaces)" },
  { token: "negative", hex: "#c0342b", usage: "Price down (light surfaces)" },
  { token: "positive-dark", hex: "#4fc47f", usage: "Price up (dark rooms)" },
  { token: "negative-dark", hex: "#e8685f", usage: "Price down (dark rooms)" },
  { token: "positive-fill", hex: "#0f5f31", usage: "Buy badge solid fill" },
  { token: "caution", hex: "#c9a227", usage: "Freshness only — never price" },
  { token: "caution-text", hex: "#8a6d12", usage: "Caution text on light (AA)" },
];

const DARK_ROOM: Swatch[] = [
  { token: "dark-bg", hex: "#131311", usage: "Data-room background" },
  { token: "dark-panel", hex: "#1b1b18", usage: "Raised panel / sheet" },
  { token: "dark-panel-alt", hex: "#1f1e1a", usage: "Row background alt" },
  { token: "dark-hairline", hex: "#26261f", usage: "Data-room dividers" },
  { token: "dark-hairline-soft", hex: "#2a2a24", usage: "Secondary dividers" },
  { token: "dark-hairline-strong", hex: "#3a382f", usage: "Borders, inputs" },
  { token: "dark-text", hex: "#f0ede2", usage: "Primary text on dark" },
  { token: "dark-text-mid", hex: "#d8d4c8", usage: "Secondary text on dark" },
  { token: "dark-text-faint", hex: "#a8a396", usage: "Tertiary text on dark" },
];

const HEATMAP: Swatch[] = [
  { token: "heatmap-1", hex: "#7a291f", usage: "−3%" },
  { token: "heatmap-2", hex: "#5c261f", usage: "" },
  { token: "heatmap-3", hex: "#32241e", usage: "" },
  { token: "heatmap-4", hex: "#232e22", usage: "" },
  { token: "heatmap-5", hex: "#203a27", usage: "flat" },
  { token: "heatmap-6", hex: "#1a5c32", usage: "" },
  { token: "heatmap-7", hex: "#1c6b38", usage: "" },
  { token: "heatmap-8", hex: "#1f7a3f", usage: "" },
  { token: "heatmap-9", hex: "#1f8a45", usage: "+3%" },
];

const TYPE_SCALE = [
  { cls: "text-micro font-mono uppercase", name: "micro", spec: "8px mono · 0.1em tracking — eyebrows, column headers" },
  { cls: "text-caption font-mono", name: "caption", spec: "10px mono/ui — meta text, timestamps" },
  { cls: "text-body-sm font-ui", name: "body-sm", spec: "12px ui · 1.5 — table cells, dense copy" },
  { cls: "text-body font-ui", name: "body", spec: "13.5px ui · 1.55 — standard paragraph copy" },
  { cls: "text-body-lg font-display", name: "body-lg", spec: "16px display · 1.65 — article body, lead deks" },
  { cls: "text-heading-sm font-display", name: "heading-sm", spec: "18px display 600 — card titles" },
  { cls: "text-heading font-display", name: "heading", spec: "24px display 700 — page/section titles" },
  { cls: "text-heading-lg font-display", name: "heading-lg", spec: "34px display 700 — front-page headlines" },
  { cls: "text-display font-display", name: "display", spec: "46px display 700 — lead story, splash" },
] as const;

const RATINGS: Rating[] = ["Buy", "Overweight", "Hold", "Underweight", "Sell"];
const FRESHNESS: FreshnessState[] = [
  "live",
  "reconnecting",
  "delayed",
  "offline",
  "halted",
  "auction",
];

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-12 mb-4 border-b border-ink pb-2 font-mono text-[10px] font-semibold tracking-[0.2em] text-ink uppercase">
      {children}
    </h2>
  );
}

function SwatchGrid({ swatches }: { swatches: Swatch[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
      {swatches.map((s) => (
        <div key={s.token} className="flex items-start gap-3">
          <span
            className="h-10 w-10 flex-none border border-hairline"
            style={{ backgroundColor: s.hex }}
          />
          <span className="min-w-0">
            <span className="block font-mono text-[10px] font-semibold text-ink">
              {s.token}
            </span>
            <span className="block font-mono text-[9px] text-ink-faint">
              {s.hex}
            </span>
            {s.usage && (
              <span className="block text-[10px] leading-[1.4] text-ink-muted">
                {s.usage}
              </span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

function SurfaceLabel({ surface }: { surface: Surface }) {
  return (
    <div
      className={`mb-3 font-mono text-[9px] tracking-[0.14em] ${
        surface === "dark" ? "text-dark-text-faint" : "text-ink-faint"
      }`}
    >
      SURFACE=&quot;{surface.toUpperCase()}&quot;
    </div>
  );
}

export default function StyleguidePage() {
  return (
    // Font variables applied locally so this page verifies the trio even
    // before the orchestrator wires src/lib/fonts.ts into layout.tsx.
    <main
      className={`${newsreader.variable} ${libreFranklin.variable} ${plexMono.variable} mx-auto max-w-[1080px] bg-paper-tint px-6 py-10 font-ui text-ink`}
    >
      <p className="font-mono text-[9px] tracking-[0.14em] text-ink-faint">
        MARSAD · P0 FOUNDATIONS · DESIGN TOKEN VERIFICATION
      </p>
      <h1 className="mt-2 font-display text-heading-lg">Styleguide</h1>
      <p className="mt-2 max-w-[560px] text-body text-ink-mid">
        Near-monochrome ink-and-paper system. Color is reserved for price
        direction, one caution amber for freshness, and structural black.
        Square corners; circles only for avatars, dots and toggles.
      </p>

      <Eyebrow>Color — Ink scale</Eyebrow>
      <SwatchGrid swatches={INK} />

      <Eyebrow>Color — Hairlines</Eyebrow>
      <SwatchGrid swatches={HAIRLINES} />

      <Eyebrow>Color — Paper</Eyebrow>
      <SwatchGrid swatches={PAPER} />

      <Eyebrow>Color — Direction &amp; caution</Eyebrow>
      <SwatchGrid swatches={DIRECTION} />

      <Eyebrow>Color — Dark-room surfaces</Eyebrow>
      <div className="bg-dark-bg p-5">
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
          {DARK_ROOM.map((s) => (
            <div key={s.token} className="flex items-start gap-3">
              <span
                className="h-10 w-10 flex-none border border-dark-hairline-strong"
                style={{ backgroundColor: s.hex }}
              />
              <span className="min-w-0">
                <span className="block font-mono text-[10px] font-semibold text-dark-text">
                  {s.token}
                </span>
                <span className="block font-mono text-[9px] text-dark-text-faint">
                  {s.hex}
                </span>
                <span className="block text-[10px] leading-[1.4] text-dark-text-mid">
                  {s.usage}
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>

      <Eyebrow>Color — Heatmap scale (−3% … +3%)</Eyebrow>
      <div className="bg-dark-bg p-5">
        <div className="flex">
          {HEATMAP.map((s) => (
            <div key={s.token} className="flex-1">
              <div className="h-12" style={{ backgroundColor: s.hex }} />
              <div className="mt-1 font-mono text-[8px] text-dark-text-faint">
                {s.hex}
              </div>
              <div className="font-mono text-[8px] text-dark-text-mid">
                {s.usage}
              </div>
            </div>
          ))}
        </div>
      </div>

      <Eyebrow>Type scale</Eyebrow>
      <div className="flex flex-col gap-4 bg-paper p-5 shadow-card-raised">
        {TYPE_SCALE.map((t) => (
          <div key={t.name} className="flex items-baseline gap-6">
            <span className="w-[150px] flex-none font-mono text-[9px] text-ink-faint">
              {t.name} · {t.spec}
            </span>
            <span className={t.cls}>Gulf markets, read closely.</span>
          </div>
        ))}
        <div className="flex items-baseline gap-6 border-t border-hairline-faint pt-4">
          <span className="w-[150px] flex-none font-mono text-[9px] text-ink-faint">
            mono numerals
          </span>
          <span className="font-mono text-body-sm tabular-nums">
            11,842.60 · +1.2% · 04:00 GST · 2222.SR
          </span>
        </div>
        <div className="flex items-baseline gap-6">
          <span className="w-[150px] flex-none font-mono text-[9px] text-ink-faint">
            link underline offset
          </span>
          <a href="#" className="text-body underline">
            Text links carry a 2px underline offset globally.
          </a>
        </div>
      </div>

      <Eyebrow>Component — TickerChip</Eyebrow>
      <div className="grid gap-0 sm:grid-cols-2">
        <div className="bg-paper p-5">
          <SurfaceLabel surface="light" />
          <div className="flex flex-col items-start gap-3">
            <TickerChip />
            <TickerChip code="MT30" level="14,210.55" chg="0.88%" dir="down" />
            <TickerChip code="2222" level="29.85" chg="1.2%" sparkline={false} />
          </div>
        </div>
        <div className="bg-dark-bg p-5">
          <SurfaceLabel surface="dark" />
          <div className="flex flex-col items-start gap-3">
            <TickerChip surface="dark" />
            <TickerChip
              surface="dark"
              code="MT30"
              level="14,210.55"
              chg="0.88%"
              dir="down"
            />
            <TickerChip
              surface="dark"
              code="2222"
              level="29.85"
              chg="1.2%"
              sparkline={false}
            />
          </div>
        </div>
      </div>

      <Eyebrow>Component — RatingBadge</Eyebrow>
      <div className="grid gap-0 sm:grid-cols-2">
        <div className="bg-paper p-5">
          <SurfaceLabel surface="light" />
          <div className="flex flex-wrap items-center gap-2">
            {RATINGS.map((r) => (
              <RatingBadge key={r} rating={r} />
            ))}
          </div>
        </div>
        <div className="bg-dark-bg p-5">
          <SurfaceLabel surface="dark" />
          <div className="flex flex-wrap items-center gap-2">
            {RATINGS.map((r) => (
              <RatingBadge key={r} rating={r} surface="dark" />
            ))}
          </div>
        </div>
      </div>

      <Eyebrow>Component — FreshnessBadge</Eyebrow>
      <div className="grid gap-0 sm:grid-cols-2">
        <div className="bg-paper p-5">
          <SurfaceLabel surface="light" />
          <div className="flex flex-col items-start gap-3">
            {FRESHNESS.map((s) => (
              <FreshnessBadge key={s} state={s} />
            ))}
            <FreshnessBadge state="delayed" detail="AS OF 15:12 GST" />
          </div>
        </div>
        <div className="bg-dark-bg p-5">
          <SurfaceLabel surface="dark" />
          <div className="flex flex-col items-start gap-3">
            {FRESHNESS.map((s) => (
              <FreshnessBadge key={s} state={s} surface="dark" />
            ))}
            <FreshnessBadge state="delayed" detail="AS OF 15:12 GST" surface="dark" />
          </div>
        </div>
      </div>

      <Eyebrow>Component — DataTableRow</Eyebrow>
      <div className="flex flex-col gap-6">
        <div className="bg-paper">
          <div className="p-5 pb-0">
            <SurfaceLabel surface="light" />
          </div>
          <DataTableRow />
          <DataTableRow
            ticker="1120"
            company="Al Rajhi Bank"
            price="84.10"
            chg="-0.6%"
            dir="down"
            score="61 · HOLD"
          />
          <DataTableRow
            ticker="4030"
            company="Bahri — National Shipping Co. of Saudi Arabia"
            price="23.40"
            score="58 · HOLD"
            state="halted"
          />
          <DataTableRow
            ticker="9510"
            company="Nomu-listed Sample Co."
            venue=""
            price="12.02"
            score="—"
            state="stale"
          />
        </div>
        <div className="bg-dark-bg">
          <div className="p-5 pb-0">
            <SurfaceLabel surface="dark" />
          </div>
          <DataTableRow surface="dark" />
          <DataTableRow
            surface="dark"
            ticker="1120"
            company="Al Rajhi Bank"
            price="84.10"
            chg="-0.6%"
            dir="down"
            score="61 · HOLD"
          />
          <DataTableRow
            surface="dark"
            ticker="4030"
            company="Bahri — National Shipping Co. of Saudi Arabia"
            price="23.40"
            score="58 · HOLD"
            state="halted"
          />
          <DataTableRow
            surface="dark"
            ticker="9510"
            company="Nomu-listed Sample Co."
            venue=""
            price="12.02"
            score="—"
            state="stale"
          />
        </div>
      </div>

      <Eyebrow>Component — ScoreModule</Eyebrow>
      <p className="mb-4 border border-hairline-strong bg-paper px-3 py-2 font-mono text-[9px] tracking-[0.08em] text-caution-text">
        SPEC GAP: `locked` (screen 4b paywall gate) and `pending` (screen 22c
        90-day state) faces pending design — no DC markup exists (04-reader-app.md
        §9.2). Required before the 4b/22c screens are built.
      </p>
      <div className="grid gap-6 sm:grid-cols-2">
        <div>
          <SurfaceLabel surface="dark" />
          <div className="max-w-[320px]">
            <ScoreModule />
          </div>
        </div>
        <div>
          <SurfaceLabel surface="light" />
          <div className="max-w-[320px]">
            <ScoreModule surface="light" />
          </div>
        </div>
        <div>
          <SurfaceLabel surface="dark" />
          <div className="max-w-[320px]">
            <ScoreModule
              score={31}
              rating="Sell"
              delta="▼ −4 THIS WEEK"
              grades="C−,D,C,C+,D"
              footnote="12TH PERCENTILE OF 61 ENERGY NAMES · UPDATED 05 JUL 04:00 GST"
            />
          </div>
        </div>
        <div>
          <SurfaceLabel surface="light" />
          <div className="max-w-[320px]">
            <ScoreModule
              surface="light"
              score={52}
              rating="Hold"
              delta="▲ +1 THIS WEEK"
              grades="B,C+,B−,C,B"
              footnote="48TH PERCENTILE OF 61 ENERGY NAMES · UPDATED 05 JUL 04:00 GST"
            />
          </div>
        </div>
      </div>

      <footer className="mt-16 border-t border-hairline pt-4 font-mono text-[9px] tracking-[0.1em] text-ink-faint">
        TOKENS: design-tokens.json v1.0 · COMPONENTS: 5/5 DC PORTS ·
        SURFACE IS A PROP, NOT A THEME
      </footer>
    </main>
  );
}
