# Front-end Conventions — the shared contract for parallel reader build

_Written 2026-07-21. This is the one-page contract every front-end worker follows so N slices
can be built in parallel over a shared read layer without colliding. Read this, then
`docs/architecture/04-reader-app.md` (route→screen spec) and `docs/FORWARD-BUILD.md §3` (the
parallel playbook). If something here disagrees with a stale doc, this file wins for front-end
code; fix the stale doc as you pass._

The app is **one Next.js 16.2.10 app** on Vercel with a **finished foundation**: a `use cache`
data layer, pulse polling, a token'd component library, route-group layouts, and the
`cacheComponents`/`<Suspense>` conventions. Every new surface is the same shape: **add a route
that reads a data-layer fn, composes primitives, and matches a design screen.**

---

## 1. Collision rules (the make-or-break for parallel work)

1. **A slice never edits another slice's route files or data-layer fns.** You own a disjoint
   route subtree + your own `data/*.ts` file. Stay inside it.
2. **New shared component/primitive → through the library owner (the lead).** Leaf components
   private to your slice live under `src/components/reader/<slice>/` (a slice-named folder) or
   inline. Do **not** add to `src/components/ui/*` yourself — request it.
3. **New DB read → a new `use cache` fn in your own `data/<slice>.ts`.** Never an inline
   Supabase read inside a page/component. Never edit another slice's data file.
4. **New migration (RLS/view/RPC) → PR to the lead**, who applies + re-stamps + ledgers. Do not
   run `apply_migration` yourself — migrations are cross-cutting and serialized (see the
   migration-ledger trap in `docs/HANDOFF.md`).
5. **Route-group `layout.tsx` edits are the foundation worker's.** You add PAGES under a layout,
   not layouts. If you need a nav link added, request it.
6. **Do not touch:** `src/app/globals.css`, `src/lib/fonts.ts`, `src/proxy.ts`,
   `src/components/reader/MarsadNav.tsx`, `package.json`. Flag it if you think you need to.

If you genuinely need a shared/foundation file changed, **stop and report it to the lead** with
the exact change — do not edit it. That's the integration seam; the lead serializes it.

---

## 2. The data-fetch pattern (copy this exactly)

Every public read is a `use cache` function in `src/lib/data/<surface>.ts`. Canonical shape
(from `src/lib/data/stocks.ts`):

```ts
import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { createAnonClient } from "@/lib/supabase/public";
import { toNum, toInt } from "./util";

export async function getEarningsCalendar(params): Promise<EarningsDay[]> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 600, expire: 86400 });
  cacheTag("earnings");                 // so a job can revalidateTag('earnings')
  const sb = createAnonClient();        // cookieless anon client — REQUIRED inside use cache
  const { data } = await sb.from("earnings_events").select("…").order("…");
  return (data ?? []).map(/* snake_case row → camelCase interface, toNum/toInt for numerics */);
}
```

**Hard rules (from Next 16 + 04-reader-app §3):**
- **`createAnonClient()` from `src/lib/supabase/public.ts`** for every cached public read. The
  cookie-bound `server.ts` client calls `cookies()`, which is illegal inside `use cache` and
  silently opts the read out to per-visitor dynamic — the single biggest cost bug. Never use it
  in a cached path.
- A `use cache` fn is **deterministic** — never read `new Date()`/`Date.now()`/`cookies()`/
  `connection()` inside one. Bound queries by a deterministic row `LIMIT` + `.order(...)`, not a
  wall-clock cutoff (see `RANGE_BARS` in `stocks.ts`). If you truly need "today", the value comes
  in as a **param** computed by a dynamic caller (see §3), never read inside the cached fn.
- **Date filtering stays in SQL** (`.gte("ex_date", …)` / `::text`) — never a JS `Date`-vs-string
  compare. `postgres.js`/PostgREST return dates as strings/Dates that don't compare to JS strings
  (the postgres.js Date trap). Compare in the query.
- Map snake_case → camelCase in the fn; components receive clean typed interfaces. Coerce numerics
  with `toNum`/`toInt` from `./util` (Postgres numerics arrive as strings).
- Tag every fn with a `cacheTag` so ingestion jobs can invalidate it.

**Gated/metered reads** (financials premium, score grades, article body past the cut) do **not**
go through `createAnonClient`. They go through a `SECURITY DEFINER` RPC (Pattern B, 04 §3.2) —
request the RPC from the lead. Never ship gated data to a client component "hidden by CSS": if the
server didn't send it, it isn't in the HTML.

---

## 3. Rendering: cacheComponents + Suspense (Next 16, non-standard)

`cacheComponents: true` is ON. Consequences you must respect:

- **A page/segment can NOT use `export const dynamic` / `revalidate`.** Those throw. Caching is
  expressed with `use cache` + `cacheLife` inside the data fn.
- `params` / `searchParams` are **Promises**: `const { venue, ticker } = await params;`
- **Static shell → `<Suspense fallback={<Skeleton/>}><Body/></Suspense>` → async `Body` does the
  awaits.** The page function is a sync shell; anything that awaits request-time/dynamic data
  lives in a Suspense-wrapped async child. Pattern lives in
  `src/app/(reader)/stocks/[venue]/[ticker]/page.tsx` and `src/app/admin/lake/page.tsx` — copy it.
- **Dynamic (request-time) reads** — anything that needs the wall clock or the request — go in a
  **non-cached** async fn that calls `await connection()` first, and it is rendered inside a
  `<Suspense>`. The market clock / "today" for a calendar is dynamic: compute it in the dynamic
  child, pass the date string down into the cached fn as a param.
- **Server components by default.** A component may be a client component (`"use client"`) only
  if it (a) polls (`usePulse`), (b) handles input, or (c) wraps a charting canvas. Everything else
  stays on the server. Leaf client islands, never client pages.

---

## 4. Design system — compose, don't restyle

Tokens are frozen in `src/app/globals.css @theme` (mirror of `src/styles/design-tokens.json`).
**Never add a hardcoded hex or a new token.** Compose the existing Tailwind classes.

- **Type:** `font-display` (Newsreader — heds, big KPI numerals), `font-ui` (Libre Franklin — all
  interface/body), `font-mono` (IBM Plex Mono — numbers, tickers, timestamps, letterspaced
  uppercase section labels). `tabular-nums` on every column of aligned numbers.
- **Color law:** near-monochrome ink-and-paper. Color is reserved for **price direction**
  (`text-positive`/`text-negative`, dark variants `-dark`) and **one caution amber**
  (`text-caution`) for data-freshness only — **amber is never used for price**. Structural black
  is `bg-ink` (`#14120e`) section bars.
- **Geometry:** **square corners everywhere** (a base reset forces `border-radius: 0`). Only
  status dots / avatars / toggle knobs opt back in with `rounded-full`. **No drop shadows** on
  content — hierarchy comes from borders (`border-hairline`) and surface tints (`bg-paper-tint`).
- **Surface is a prop, not a theme.** Data rooms (`(dataroom)`) are always dark; editorial
  (`(reader)`) is always light. Components take `surface="light"|"dark"`. No `dark:` variants, no
  ThemeProvider. Dark tokens are `--color-dark-*` (`bg-dark-bg`, `text-dark-text`, etc.).
- **Motifs:** the diamond mark = a 6–8px square `rotate-45 bg-ink`. Section headers = a black
  `bg-ink` band with a `font-mono` letterspaced (`tracking-[0.08em]+`) uppercase label — use the
  `SectionBar` primitive. Stat strips = bordered `bg-paper-tint` bands of cells (mono micro-label
  over Newsreader value) — use the `StatStrip` primitive.
- Desktop content column is `max-w-[1180px]` (see the reader layout). Design canvas is 1440px;
  scale to the existing container.

### Component library (`src/components/ui/` — reuse, don't duplicate)
`TickerChip` · `RatingBadge` · `FreshnessBadge` (6-state) · `DataTableRow`
(`default|halted|stale`) · `ScoreModule` (+`locked`/`pending` faces) · **`SectionBar`** ·
**`StatStrip`** · **`EmptyState`** (+ `awaitingFeed` variant for empty data tiers). Reader
composites in `src/components/reader/`: `MarsadNav`, `Sparkline` (server inline-SVG),
`PriceChart`, `IndexTape`, `WireStream`, `FilingsList`, `SectorHeatmap`, `ScreenerGrid`,
`TopMovers`, `QuoteHeader`, `StockTabs`, `PremiumLock`, `JsonLd`.

**Charts are inline SVG server components** (`Sparkline`, `PriceChart`) — do NOT add a charting
library. No `lightweight-charts` in `package.json`; keep it that way for this wave. Sparklines and
price paths are generated server-side from the closes array. Empty chart = `EmptyState awaitingFeed`.

---

## 5. States every surface must ship (design specs them)

- **loading** → `loading.tsx` (17e shimmer) or a `<Suspense>` skeleton fallback.
- **empty** → `EmptyState` (17a–17c). For a data tier with no producer yet (ipo_offers, holders,
  transcripts, estimates, company_people = currently 0 rows) the page is a **graceful
  `EmptyState awaitingFeed`**, not an error — building the page over an empty table is expected and
  correct; it lights up when the producer lands.
- **404** → the route returns `notFound()` (17d "This page has delisted.").
- **error** → per-group `error.tsx` boundary.
- **freshness** everywhere data shows: `FreshnessBadge` fed the freshness block; the persistent
  `DELAYED 15 MIN` chrome is global. Never claim "live".

---

## 6. Table-name map (design/spec names → real `public.*` tables)

The specs use idealized names; the real schema (02-data-lake) is:

| spec name | real table |
|---|---|
| `quote_snapshots` | `quotes_latest` (+ `quotes_intraday`) |
| `venue_freshness` | `venue_feed_status` |
| `marsad_scores` (+factors) | `scores` (headline via `public.v_scores_public`; grades gated) |
| `index_snapshots` | `index_levels` (+ `index_levels_daily`) |
| `market_calendar` | `market_sessions` / `market_holidays` |
| `concalls` / `concall_segments` | `transcripts` / `transcript_segments` |
| `datapoint_values` | `datapoints` |
| `estimates_agg` | `estimates` |
| `articles` / `article_blocks` | `content_items` / `content_blocks` |
| `fundamentals_wide` | `key_ratios` |
| `sector_aggregates` | derive from `securities` + `quotes_latest` + `sectors` (no matview yet) |

**Data-readiness right now** (build data-backed surfaces; empty ones get `awaitingFeed`):
- **Populated:** `financial_statements` (50k), `earnings_events` (4190), `dividends` (1147),
  `key_ratios` (731), `quotes_latest` (701), `ohlcv_daily` (609k), `scores` (445),
  `securities` (762), `indices` (6), `sectors` (13), `venues` (7), `index_levels` (36).
- **Empty (producer pending):** `ipo_offers`, `holders`, `holder_positions`,
  `ownership_snapshots`, `company_people`, `transcripts`, `estimates`, `analysts`,
  `content_items` (3).

Always confirm columns before writing a query — `list_tables`/`information_schema`, or ask the
lead. Never assume a column name from the spec.

---

## 7. Per-surface Definition of Done (the merge gate)

Before a surface merges to `main`:
1. `npx tsc --noEmit` clean; `npm run build` compiles the route.
2. Route renders in the preview browser with **real data** (not just an empty state, unless the
   tier is genuinely empty) — screenshot it next to the design screen.
3. All five states present (§5).
4. Design fidelity: matches the assigned design screen (tokens, type, spacing, copy, square
   corners, color law). Run a `design-critique` + `accessibility-review` eye over it.
5. SEO where the surface is indexable (04 §8): `generateMetadata`, JSON-LD if speced, in the
   sitemap. Data-room + member routes are `noindex`.
6. No collision-rule violation (§1). New shared primitive? It went through the lead.

The lead owns merges, the shared library, migrations, and the design-QA gate.
