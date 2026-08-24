### PR.5 — Finish the design surface _(expansion; 2026-07-27)_

_Written against commit `8633a6b`. Every number below was measured in the tree or in the live-DB
snapshot at §12 of `architecture/09-signal-to-article.md`. Where a figure is inferred rather than
measured it says so on the same line._

---

#### PR.5.0 What this is, and why now

PR.5 builds the **41 missing block renderers** (families B 6, D 15, E 8, F 8, H 4), the **binding
resolution layer** that turns a `{object_id, field}` pair into a printable value under D-8, and the
**PD.6 chart compiler** that the 15 D-family blocks consume. It ends with 61 of 61 renderers and
`ImplementedBlockCode = BlockCode`.

**Why now:** PR.4 is about to start emitting `BLK-*` codes into `content_blocks` — which today holds
`text(43) / heading(8) / pull_quote(5)` and **zero** `BLK-*` rows across 56 blocks in 13 pieces — and
the day the first composed piece lands, 41 of 61 codes render as an amber "Unrendered block" box.
PR.5 has no dependency on PR.2/PR.3/PR.4 and every slice is independently shippable, so it is the
one phase that can run the whole time the research chain is being built.

---

#### PR.5.1 The measured constraints

**The renderer convention is fixed and must not be re-litigated.** All 20 built renderers
(`src/components/blocks/{a,c,g}/`) are server components — `grep "use client"` over
`src/components/blocks/` returns nothing — with the identical signature
`function BlockX({ node }: { node: BlockNodeOf<"BLK-X"> })`, reading `node.payload`, printing
`<Val v={…}/>` (→ `—` in `text-ink-faint`) for a missing value, colouring only through
`directionTextClass` (`constraints.ts:85-89`), and reporting constraint violations via
`warnConstraint` rather than throwing. The 41 follow it verbatim.

**Two gaps sit outside PR.5 and both are owned upstream:**

| gap | measured | owner |
|---|---|---|
| **READ** — no path from Next to `lake.objects` | anon has no `USAGE` on schema `lake`; PostgREST `db-schemas` = `public, graphql_public` (`src/lib/data/newsroom.ts:29-33`, `src/lib/data/desk.ts:12-24`, BUILD-STATUS:689). No `public.v_block_bindings` exists. | **PR.0**, same privileged batch as `20260727161500` + `20260727170000` |
| **SERIES** — no lake object holds an array | `ChartSeries` (`ingestion/src/blocks/binding.ts:87-101`) is one uuid + one dotted field. `OHLCV.CLOSE` is one object per `(venue,ticker,tradeDate)` — **640,992** of them (`ingestion/src/runtime.ts:645-646`). The only chart fixture in the suite binds `field: "numeric_value"` (`schemas.test.ts:68`), i.e. a scalar. | **PR.1** |

PR.5 ships against both gaps open and degrades honestly (§PR.5.4). That is already the shipped
posture for `v_content_citations` — `newsroom.ts:36-40` returns `citations: []` until the wrapper
view lands, and the `[cN]` markers render as literal text. Nothing in PR.5 is *blocked* by the read
gap; **seven** blocks are *deferred* by the series gap, because building them against a scalar
binding produces shapes that can never draw real data.

**Family F is a series consumer too.** `ingestion/src/blocks/f-wire.ts:126-139` — BLK-SNAPSHOT carries
`series: ObjectBinding` described as "resolved and drawn by the chart compiler", and its specimen is
a 7-bar column chart. The series gap blocks **seven** blocks (LINE, AREA, DIST, HEAT, INDEXED,
CANDLE, SNAPSHOT), not six.

**Only 9 of the 15 chart blocks are SVG.** Measured by segmenting
`docs/design/artifacts/artifact-library-61-blocks.html` on each `id="BLK-*"` anchor:

```
BLK-LINE       vb=0 0 420 130  PAR=none    text=0
BLK-AREA       vb=0 0 420 130  PAR=none    text=0
BLK-DIST       vb=0 0 420 130  PAR=none    text=0
BLK-INDEXED    vb=0 0 420 130  PAR=none    text=0
BLK-CANDLE     vb=0 0 320 132  PAR=none    text=0
BLK-WATERFALL  vb=0 0 420 130  PAR=ABSENT  text=6
BLK-SCATTER    vb=0 0 420 130  PAR=ABSENT  text=2
BLK-DUMBBELL   vb=0 0 420 130  PAR=ABSENT  text=7
BLK-SLOPE      vb=0 0 420 130  PAR=ABSENT  text=6
```

BARS · STACK · RANGE · HEAT · DONUT · COVER carry no `<svg>` at all — flex / grid /
`conic-gradient`. The whole family-D SVG surface uses **six** element types (`line`, `rect`,
`circle`, `polyline`, `polygon`, `text`) and no `<path>`, `<g>` or `<ellipse>`. That closes the
`Mark` union at six members.

**`preserveAspectRatio="none"` appears on exactly the five text-free SVGs.** The safe direction of
that invariant is `text ⇒ PAR ≠ 'none'` — non-uniform scaling stretches glyphs. The biconditional
does **not** hold in the built tree: `BLK-SPARK` (family A, shipped) is `72×20`, `PAR=ABSENT`,
`text=0`. Assert the implication, not the equivalence.

**No charting library, and Vega-Lite is dropped.** `docs/frontend/CONVENTIONS.md:150-152` forbids
one; the web app's dependencies are exactly five (`@supabase/ssr`, `@supabase/supabase-js`,
`next` 16.2.10, `react` 19.2.4, `react-dom` 19.2.4). Precedent is already in the tree:
`PriceChart.tsx:3-15` ("no client charting dep in this pass"), `Sparkline.tsx`, and the shipped
`BlockSpark.tsx:15-39`. `09-signal-to-article.md:625,:649` and `d-charts.ts:8,:111` still name
Vega-Lite; they get amended in the same commits (§PR.5.7). The substantive claim — "chart specs are
compiled, never emitted" — survives; only the target format changes.

**The Tailwind v4 static-scan trap already shipped a live defect.** `SectorTreemap.tsx:30-38`: a
runtime `var(--color-heatmap-${bucket})` "never made it into the compiled stylesheet at all
(verified: zero occurrences of 'heatmap' in the built CSS)" — every treemap tile rendered with no
background until the hexes were inlined. This governs the compiler's colour rule (§PR.5.3.5).

**Landing family D + BLK-CUT changes live refusal behaviour.** `fit-engine.ts:780-781` makes
`isDataBlock` true for `fam === 'C' || fam === 'D'`, and `:835` raises `FIT-CUT-NO-DATA` when no
bound C/D block sits above the cut. Once D and H exist, R-09 flips from permissive to enforcing and
pieces that previously passed route to `reassigned_human`. That is correct, and it must land while
`pipeline_intake_enabled=false` and the fit stage is still off — i.e. **before** PR.6.

**File paths are mechanical.** `rendererFor()` (`scripts/design/generate-registry-seed.mjs:53-56`,
`WORD_SPLITS` at `:48-51`) already wrote `ops.story_blocks.renderer_component` for all 61. Every new
file is `src/components/blocks/{b,d,e,f,h}/<rendererFor(code)>.tsx`. No naming decision remains.

---

#### PR.5.2 The surface law — the single most consequential correction to the PD.6 design

**A `ChartSpec` with a fixed `viewBox` can only ever reproduce the library card.** The deliverable is
the article. Measured across the four rendered longform exports:

| surface | authored viewBox | slot measure | x-stretch | text | measured at |
|---|---|---|---|---|---|
| `card` | 420×130 (candle 320×132) | ≈396 (styleguide card inner) | ≈0.94 | per table above | `artifact-library-61-blocks.html` |
| `column` | **640×220**, `PAR=none` | **706** | **1.103** | 0 | `longform-1a-feature.html:144` |
| `master` | **1050×300**, `PAR` absent | **1050** | **1.000** | 14 | `longform-1b-research-note.html:122` |

Slot arithmetic, measured not assumed. 1a: page `max-width:1160px; padding:26px 34px` and
`grid-template-columns:1fr 300px; column-gap:52px` (`:88`) → 1160 − 68 = 1092; 1092 − 300 − 52 =
**740** main column; exhibit frame 1px × 2 + inner padding 16px × 2 → **706**. 1b: 1092 − 2 border −
40 padding = **1050**, which is the authored viewBox exactly.

That yields a design law worth stating, because it is what makes `PAR="none"` honest:
**the authored viewBox tracks the slot to within ~10%, so non-uniform stretch never exceeds ≈1.1×;
text-carrying shapes match the slot exactly and omit `PAR`.** Ship the card's 420×130 spec into the
706px column slot and x-stretch becomes 706/420 = **1.681** against y = 1.0 — the `r=4` terminal
marker renders as a 6.7 × 4.0 ellipse, the 2.2 stroke renders 3.70px on verticals and 2.2px on
horizontals, and the exhibit is 130px tall where the design draws 220px (5.4:1 vs the authored
2.9:1).

The geometry differences are not only scale:

| | card | column | master |
|---|---|---|---|
| line/area baseline | y=110 | **y=180** | — |
| gridlines | 2, at y=74/38 (36px pitch) | **4, at y=140/100/60/20 (40px pitch)** | **3, at y=200/140/80 (60px pitch)** |
| primary series stroke | **2.2** | **2.4** | 2.4 |
| scatter axes/medians | 2 axes + 2 medians, **no gridlines** | — | 2 axes + 3 gridlines + 2 medians |
| scatter radii | {7,8,9,11,15,17} | inferred (8,20) | measured **{10,11,12,12,13,13,14,17,24,26}** |
| stack bar height | 46px | **52px** (`longform-3a-deep-dive.html:122`) | — |

Note the master scatter's radius floor is **10**, not 12 — the critique's `12,13,14,17,24,26` reads
only the six labelled bubbles and misses `r=11` (SAIB) and `r=10` (BJAZ). The map is `(rMin,rMax) =
(7,17)` card / `(10,26)` master; `column` has no design reference and is inferred `(8,20)`, flagged
in the file header.

**Decision:** `compile(input, surface)` takes a required closed
`ChartSurface = 'card' | 'column' | 'master'`. Every entry in the geometry table above is a
per-surface constant in `SURFACE[surface]`, never a literal in a shape file. Goldens are authored per
`(shape × surface)`, and the **`column` and `master` goldens come from the longform exports, not from
`artifact-library-61-blocks.html`**. Surfaces with no design reference are compiled from the surface
table and their goldens are marked `inferred: true` in the JSON.

`surface` reaches the renderer through `BlockProps` (default `'column'` — the article is the
deliverable), not through the payload: it is a layout fact known at render, not at projection.

---

#### PR.5.3 The design, concretely

##### PR.5.3.1 `src/lib/blocks/` — new directory

```
src/lib/blocks/
  resolve.ts            read path + LakeRow + readField + formatBound   (server, "use cache")
  collect.ts            walk a wire payload → distinct uuid[]           (pure)
  entitlement.ts        the per-request gate                            (pure)
  project/
    index.ts            Record<BlockCode, Projector>, tsc-total
    a.ts b.ts c.ts d.ts e.ts f.ts g.ts h.ts
  chart/
    types.ts compile.ts scales.ts ramps.ts heat-ramp.ts surfaces.ts
    ChartSvg.tsx toSvgString.ts
    shapes/<15>.ts
    __tests__/golden/<shape>.<surface>.json
```

**Decision: a projection layer, not prop-drilling and not per-renderer reads.** Renderers stay pure,
synchronous, and keep taking already-formatted `BoundValue = string | null` (`types.ts:133`). Nothing
in the 20 built renderers changes. The rejected alternative — pass a `BindingMap` down through
`Block`/`BlockList` and have each renderer call `bind()` — forces every renderer's payload type to
become the *wire* type `{object_id, field}`, which rewrites all 20 shipped files and invalidates
every styleguide fixture.

```ts
// resolve.ts
export interface LakeRow {
  id: string;                    // uuid
  objectType: string;
  numericValue: number | null;
  effectiveDate: string | null;
  unit: string | null;
  payload: unknown;              // jsonb
  state: string;                 // VERIFIED | PENDING | …
}
export type BindingMap = ReadonlyMap<string, LakeRow>;

/** ONE round trip per piece. Reads public.v_block_bindings. Reader injectable for tests. */
export function resolveBindings(
  objectIds: string[],
  reader?: (ids: string[]) => Promise<LakeRow[]>,
): Promise<BindingMap>;

/** Pure. Grammar is exactly binding.ts:48-57's objectField regex:
 *  'numeric_value' | 'effective_date' | 'unit' | 'payload.a.b' */
export function readField(row: LakeRow | undefined, field: string): unknown;

export type Resolved =
  | { kind: 'ok'; raw: number | string; text: string }
  | { kind: 'unbound' }      // the payload carried no binding at all
  | { kind: 'missing' }      // uuid absent from the map — gated, deleted, or not VERIFIED
  | { kind: 'no-field' }     // row present, dotted path → undefined
  | { kind: 'wrong-type' };  // resolved, but not the shape asked for (a chart got a scalar)
```

`formatBound(v, hint)` is the one formatter. `hint ∈ 'price' | 'pct' | 'signed-pct' | 'int' |
'compact' | 'date' | 'datetime' | 'text'`, delegating to the existing `src/lib/reader/format.ts`
(`fmtPrice:81`, `fmtSignedNum:86`, `fmtSignedPct:92`, `fmtInt:98`, `fmtCompact:104`, `fmtDate:116`,
`fmtDateTime:124`) rather than growing a second numeral vocabulary. **The hint comes from the
projector, per field, per block** — a render decision, never writer-supplied, so no payload can ask
for the wrong precision.

**The read path PR.5 codes against** (the migration itself is PR.0's; this is the contract):

```sql
-- public.v_block_bindings — the ONLY path from the Next runtime to lake.objects.
create view public.v_block_bindings as
select o.id, o.object_type, o.numeric_value, o.effective_date, o.unit, o.payload, o.state
from lake.objects o
where o.state in ('VERIFIED','PENDING')
  and not exists (                       -- the gate: an object reachable only from a gated block
    select 1 from ops.story_blocks_bound b
    where b.object_id = o.id and b.is_gated and not b.also_free
  );
grant select on public.v_block_bindings to anon, authenticated;
```

Note the join differs from `public.v_content_citations`, which excludes per **item**
(`newsroom.ts:27-40`); this one filters per **object**, so the exclusion predicate is an explicit
decision, not a copy. Until the view exists, the default reader returns `[]`, every binding is
`{kind:'missing'}`, every figure is an em-dash and every exhibit is an `EmptyExhibit`. Loud, honest,
non-fatal — and when the view lands, nothing in the render tree changes.

**Three-phase render path:**
1. `collectBindings(wireNodes) → string[]` — pure walk of the Zod payload shapes. Zero DB, fully testable.
2. `resolveBindings(ids)` — one `.in('id', ids)` inside the existing `"use cache"` / `cacheTag`
   discipline (`newsroom.ts:1-3`).
3. `project(wireNode, map, ctx) → BlockNode` — 61 small adapters keyed by
   `Record<BlockCode, Projector>` so tsc proves totality the same way `BlockRendererMap` does
   (`registry.tsx:45-47`).

**Why 61 projectors is the right cost, not a smell:** 15 are non-negotiable regardless — family D's
render payload is *numbers*, because the compiler must sort, bin, rebase and take medians. Once you
have 15 you may as well have 61, and in exchange every renderer stays a pure function of a plain
object (styleguide fixtures stay valid; every golden test runs without React or a DB), and there is
exactly **one** place in the codebase where D-8 is executed.

##### PR.5.3.2 The premium gate lives in the projector, never in the renderer

`b-statement.ts:120-127` gives BLK-TAKE `headline` ("the judgement itself — e.g. fair value plus the
action it implies") and `body` as ordinary prose, plus `entitlement: z.enum(['locked','unlocked'])`.
The specimen (`artifact-library-61-blocks.html:146`) blurs the real string
`Fair value OMR 0.128 — subscribe at the top of the range` behind
`filter:blur(3px);pointer-events:none;user-select:none`. **A locked reader deletes one CSS
declaration in devtools and reads the price target.** That violates the law recorded at
`src/lib/data/editorial.ts:23-26` — gated rows are "physically absent from the result set — Postgres
never returns them".

**Decision, three parts:**

1. `project['BLK-TAKE']` takes the request's real entitlement from `ProjectCtx`, and when unentitled
   emits **no copy at all** — only shape:
   ```ts
   type TakePayload =
     | { locked: false; kicker: string; headline: string; body: string }
     | { locked: true;  kicker: string; ghost: { headlineChars: number; bodyChars: number } };
   ```
   `ghost` char counts are rounded to the nearest 10 so length is not a side channel. `RedactedGate`
   draws skeleton bars sized from `ghost`, blurred — it looks like the specimen and contains zero
   real characters.
2. **`payload.entitlement` is never read.** It is a stored copy of per-request state and is wrong for
   every reader but one — the exact defect `h-gates.ts:44-52` already names for BLK-PAYWALL's meter.
   New ledger row: **DEF-TAKE-ENTITLEMENT-STORED** (trigger: next PD.3 schema revision; home: 09 §5.4).
3. **BLK-CUT is not the leak and must not be treated as one.** `h-gates.ts:29-32` makes `teaser`
   prose "deliberately authored to be blurred". The same primitive is honest for CUT and a leak for
   TAKE, so it splits: `BlurTeaser` (real prose, CUT only) and `RedactedGate` (ghost, everything
   gated).

The PR.5b test asserts **absence**, not CSS: `renderToStaticMarkup` of an unentitled BLK-TAKE must
not contain the judgement string. Same assertion for every gated family-H and family-B block.

##### PR.5.3.3 Shared primitives — extract before the first B renderer

`primitives.tsx` today has `Val`, `isBound`, `BlockFootnote`, `Diamond`, `interpolate`. Six more:

**1. `Kicker` — parameterised, because one spec matches none of its callers.** The chassis kicker
(`article-templates.json:130`: "IBM Plex Mono 9.5px 600, letter-spacing .2em, preceded by a 7-8px ink
diamond") is the **article** eyebrow, not the block house label. Measured from the six callers:

| block | size | tracking | weight | colour | diamond |
|---|---|---|---|---|---|
| BLK-THESIS `THE ARGUMENT IN THREE LINES` (`:122`) | 8.5px | .16em | 600 | `#8a857a` | none |
| BLK-FALSIFY `WHAT WOULD CHANGE THIS VIEW` (`:152`) | 8.5px | .14em | 600 | `#8a857a` | none |
| BLK-TAKE `MARSAD TAKE` (`:146`) | 8.5px | .14em | 600 | ink | 7px |
| BLK-PAYWALL `CONTINUE WITH PREMIUM` (`:885`) | 9px | .18em | 600 | ink | 8px |
| BLK-ALERTCTA `KEEP WATCHING THIS` (`:897`) | 8px | .14em | **not declared** | `#8a857a` | none |
| BLK-DOWNLOAD `EVERY SERIES IS DOWNLOADABLE` (`:910`) | 8px | .14em | 600 | `#8a857a` | none |

Zero of six are 9.5px, zero are .2em, four have no diamond, four are muted not ink. Signature:
`Kicker({ size: 8|8.5|9, tracking: '.14em'|'.16em'|'.18em', tone: 'muted'|'ink', weight?: 600,
diamond?: 7|8 })`, with the six tuples recorded in the file header cited to the card anchors.
`chassis.type_scale.kicker` stays reserved for the template-renderer phase, where it applies.

**2. `Chip({ tone, children })`** — five measured tones: `outline` (1px `#cfcabe`, `#57534a`, mono
9.5px, 3px 8px), `ink` (BLK-VERDICT rating badge, inverted), `red` (BLK-HALT `HALTED`, BLK-DECISION
`NO`), `amber` (BLK-CORRECTION `REVISED`, amber ground with **ink** text), `green` (BLK-DECISION `YES`
on `#0f5f31`). ~20 lines; also retro-fits `BlockAgents.tsx`'s inline chips.

**3. `AccentPanel({ edge, width, tone, tint?, children })`** — eight measured callers: BLK-PULLQUOTE
(3px ink left), BLK-HALT (3px red left on `#f6f4ee`), BLK-CORRECTION (3px amber left), BLK-THESIS
(2px ink top + 1px `#dcd8cc` bottom, `:122`), BLK-TIMELINE (3px red/ink top per stage), BLK-MYTH
(3px red / 3px green top on two equal panels), BLK-DECISION (1px ink on `#f6f4ee`), BLK-DOWNLOAD
(2px ink top).

**4. `BlurTeaser({ blurPx = 3.5, scrimPx = 120, children })`** — real prose, CUT only.
**The 120px default is measured, and the 56px reading is wrong for this deliverable.**
`height:120px;background:linear-gradient(rgba(253,252,249,0),#fdfcf9)` occurs in **both**
`longform-1a-feature.html:256` and `longform-3a-deep-dive.html:262`; `height:56px` occurs once, in
`artifact-library-61-blocks.html:874` (a small card). `filter:blur(3.5px)` is identical in all three.
`chassis.shared_components.blur_teaser` says 120px, and both templates' `premium_cut.mechanism`
restate it. `docs/design/README.md`'s "the HTML wins" does not disambiguate — all three sources are
HTML; the discriminator is the surface. Default 120; pass 56 only from the styleguide card fixture.

**5. `UnresolvedFigure({ code, field, size })`** — the em-dash at the *figure's own* type size,
carrying `data-unresolved={field}`. Must not look like `MissingBlock`: different failure, different
colour law.

**6. `EmptyExhibit({ reason, height })`** — `PriceChart.tsx:35-43` verbatim
(`border border-dashed border-hairline bg-paper`, mono 11px uppercase `text-ink-faint`), with the
`h-[280px]` parameterised. One empty-chart look across the whole product.

`Diamond` (`primitives.tsx:45-53`) already takes `size`, so BLK-RANGE's 11px marker and BLK-FALSIFY's
6px red bullets are call-site classes. `constraints.ts` gains `directionToken(d): Tok` (the token-side
counterpart of `directionTextClass:85-89` — same hard rule 1) and `warnUnresolved(code, field, id)`.

**Deliberately not extracted: `ExhibitFrame`.** `chassis.shared_components.exhibit_frame` is "1px
solid #14120e wrapper; ink header bar; #fdfcf9 body; optional provenance strip footer" — measured at
`longform-1a-feature.html:137-141` as `EXHIBIT 1` + title + unit label. No chart payload carries a
`title` or `label`; they carry only `caption` (`d-charts.ts:108-114`). The frame is *template* chrome,
exactly as the styleguide card chrome is *library* chrome (`src/app/styleguide/blocks/page.tsx:44-70`
keeps it out of the blocks). Built in the template-renderer phase — but see §PR.5.3.4 for the
contract PR.5 must ship so that phase can suppress it.

##### PR.5.3.4 Degrade — four levels, and the derived chrome degrades with them

Governing sentence: **a missing datum is drawn as a gap; a missing datum that would make the drawn
shape a lie is drawn as no shape at all.**

**Level 1 — a scalar among others** (A, C, G, most of F, BLK-VERDICT cells). `<Val v={null}/>` →
em-dash. Unchanged, already shipped, plus one `warnUnresolved`.

**Level 2 — the scalar that *is* the block** (BLK-BIGNUM `value`, BLK-RANGE `last_price`, BLK-DONUT
`centre_value`, BLK-COVER `headline_cover`, BLK-CANDLE `reference_value`). Frame, caption and labels
render; the figure slot renders `<UnresolvedFigure/>` at the figure's own type size (BIGNUM:
Newsreader 60px/700). **Not** `MissingBlock` — that says "no renderer registered", which would be false.

**Level 3 — a chart with nothing to draw.** `<EmptyExhibit reason="0 OF 29 POINTS RESOLVED · OBJECT
<uuid> NOT READABLE"/>`. **It replaces the whole derived surface, not just the marks.** The derived
chrome sits *outside* the SVG as sibling divs and is in no payload: `longform-1a-feature.html:155-156`
prints, after `</svg>`, a tick row (`2019 2020 2021 2022 2023 2024 2025 Q1 '26`), a summary strip
(`4.1% → 11.4% · +730 BP · DASHED: JAFURAH PHASE 1 FIRST GAS, Q4 2022`), and — at `:159-161` — a
provenance strip (`LAKE OBJECT FILING.SEGMENT.REVENUE · 2222 · 29 QUARTERS · VERIFIED BY DATA-TDWL
09:04 GST`). With zero points resolved, a naive level-3 prints "29 QUARTERS · VERIFIED" beside a
dashed empty box. So:

- The block's projector emits `resolution: 'ok' | 'partial' | 'empty'` and the renderer stamps
  `data-exhibit-resolution` on its root. **This is the contract the template phase needs** to
  suppress the frame's provenance strip; ship it in PR.5 even though the frame is not built here.
- `caption` is suppressed at level 3, and at level 4 whenever any point was dropped, **if it contains
  a digit** (`/\d/.test(caption)`). `d-charts.ts:112` makes `caption` required prose stating "what
  the reader should take from it", and house policy (`b-statement.ts:59-62`) is that such prose
  carries numerals checked at *write* time by R-03/R-04 against citations — not at render time. A
  digit-free caption still prints. A render-time regex is chosen over a fit-stage stamp because it
  costs nothing from PR.4 and is locally testable.

**Level 4 — partial resolution**, per shape, derived from each card's own claim:

| shape | policy | why |
|---|---|---|
| BARS | drop the unresolved category, re-sort, note it | the claim is "who is biggest" among what is shown |
| SCATTER | drop a point missing any of x/y/r; recompute medians over survivors | a bubble needs all three |
| DUMBBELL | drop a row missing either end | `old`/`new` is the whole shape |
| SLOPE | drop an entity missing either endpoint; recompute the crossing | crossing is a fact about survivors |
| LINE / AREA / INDEXED / CANDLE | draw resolved points, **never interpolate a gap** | an interpolated point is a fabricated number |
| **STACK** | **→ level 3** on any missing segment | `d-charts.ts:192` "must sum to 100%" — a partial stack is a false proportion |
| **DONUT** | **→ level 3** on any missing segment | same, and the hole's headline would contradict the ring |
| **WATERFALL** | **→ level 3** if `start` or `end` missing; drop a missing driver and note it | a bridge without endpoints bridges nothing |
| HEAT | render resolved cells; unresolved cells = **paper `#fdfcf9` with a 1px dashed hairline outline** | see below |
| RANGE | → level 3 if any of bear/base/bull missing; missing `last_price` → track + band draw, diamond omitted, `LAST —` | the span is the claim, the marker the annotation |
| COVER | → level 3 if `headline_cover` missing; a missing tranche drops from the footer; the 1.0× line always draws | |

**The HEAT unresolved colour must not come from the ramp.** `--color-dark-panel` is `#1b1b18`
(`globals.css:67`); ramp buckets 3/4/5 are `#32241e` / `#232e22` / `#203a27` (`:79-81`). At the card's
22px cell / 3px gap those are not separable — the reader sees "roughly flat", not "no data", which
contradicts the governing sentence and the two-dashed-borders rule below. Paper + dashed hairline.

**Nothing throws, ever** (`constraints.ts:9-16`), and the two dashed states stay visually distinct:
**amber dashed = no renderer** (`MissingBlock`, `border-caution`), **neutral dashed = no data**
(`EmptyExhibit`, `border-hairline`). A reader — and an ops dashboard — must be able to tell "we
haven't built it" from "the lake didn't answer".

##### PR.5.3.5 The chart compiler (PD.6)

It is **not** an SVG emitter. All 15 shapes go through one `compile()`; nine produce marks, six
produce only derived geometry that a flex/grid renderer consumes. The split never leaks to the caller.

```ts
// src/lib/blocks/chart/compile.ts — pure, dependency-free, no React
export type ChartSurface = 'card' | 'column' | 'master';
export function compile(input: ChartInput, surface: ChartSurface): ChartSpec;

export interface ChartSpec {
  shape: ChartShape;                        // d-charts.ts:43-59, the closed 15
  surface: ChartSurface;
  viewBox: readonly [0, 0, number, number]; // from SURFACE[surface], never a literal in a shape file
  height: number;
  preserveAspectRatio: 'none' | 'xMidYMid meet';
  marks: Mark[];                            // [] for the six CSS shapes
  derived: Derived;                         // everything the chrome prints
  resolution: 'ok' | 'partial' | 'empty';
  notes: string[];                          // dropped points, clamps, ties — never fatal
}
```

`ChartInput` is a 15-arm discriminated union on `shape`, each arm carrying **resolved** data — numbers
and labels from the projector, never a binding.

`Mark` — six members, because that is exactly what the design's own SVGs use:

```ts
export type Mark =
  | { t:'line';     x1:number; y1:number; x2:number; y2:number; stroke:Tok; w:StrokeW; dash?:Dash }
  | { t:'rect';     x:number; y:number; w:number; h:number; fill:Tok }
  | { t:'circle';   cx:number; cy:number; r:number; fill:Tok|'none'; stroke?:Tok; sw?:StrokeW }
  | { t:'polyline'; pts:Pt[]; stroke:Tok; w:StrokeW; dash?:Dash }
  | { t:'polygon';  pts:Pt[]; fill:Tok }
  | { t:'text';     x:number; y:number; s:string; size:number; fill:Tok;
                    anchor:'start'|'middle'|'end'; bold?:boolean };
```

`Tok` is a **closed union of token names, never a hex**: `'ink' | 'ink-muted' | 'ink-faint' |
'muted-mark' | 'hairline-strong' | 'hairline' | 'hairline-soft' | 'hairline-faint' | 'paper' |
'positive' | 'negative' | 'ink/7' | 'ink/8' | 'ink/16' | 'negative/12'`. `muted-mark` = `#a8a396`,
which has no light-surface token name (**DEF-TOKEN-A8A396-UNNAMED-LIGHT**, BUILD-STATUS:606) and maps
today to `stroke-dark-text-faint` — the same awkward alias `primitives.tsx:28-37` already documents.
Closing that DEF is a one-line change in the lookup table.

`Dash` is `'2 2' | '4 4' | '5 5'` and `StrokeW` is `1 | 1.3 | 1.4 | 1.5 | 1.6 | 1.8 | 2 | 2.2 | 2.4` —
exactly the sets in `block-registry.json → dimensions.chart_geometry`. Closed, so no shape can invent
a fourth dash or a tenth width.

**Asserted invariant** (per surface, tested over every golden): `spec.marks.some(m => m.t === 'text')
⇒ spec.preserveAspectRatio !== 'none'`. Stated as an implication, not an equivalence — `BLK-SPARK`
(72×20, no `PAR`, no text) is the shipped counterexample to the converse.

**Rendering:**

```tsx
// src/lib/blocks/chart/ChartSvg.tsx — server component, zero deps
export function ChartSvg({ spec, label }: { spec: ChartSpec; label: string })
```

It maps `Tok` → Tailwind class through two `const` objects whose values are **string literals in
source**, so Tailwind v4's static scan emits each `--color-*`:

```ts
const STROKE: Record<Tok, string> = { ink:'stroke-ink', 'ink-muted':'stroke-ink-muted',
  'muted-mark':'stroke-dark-text-faint', hairline:'stroke-hairline',
  'hairline-faint':'stroke-hairline-faint', positive:'stroke-positive', negative:'stroke-negative', … };
const FILL: Record<Tok, string> = { ink:'fill-ink', 'ink/7':'fill-ink/7', 'ink/8':'fill-ink/8',
  'ink/16':'fill-ink/16', 'negative/12':'fill-negative/12', paper:'fill-paper', … };
```

**The colour rule, stated correctly** (the "a named token must never go through a `var()`" phrasing is
self-contradictory for the CSS shapes): **fixed colours → literal Tailwind class; computed stop
positions → hex from `TOKEN_HEX`.** BLK-DONUT's specimen is
`conic-gradient(#14120e 0 81.5%,#57534a 81.5% 93.5%,#a8a396 93.5% 97.5%,#cfcabe 97.5% 100%)` — the
first four `ink_ramp` stops as literal hexes with runtime percentage boundaries, which cannot be a
static class. So `TOKEN_HEX` is load-bearing on a **live paper surface**, not only in the unused
`specToSvgString`, and it gets a drift test (§PR.5.5).

`specToSvgString(spec): string` — same switch, inline hexes from `TOKEN_HEX`, ~40 lines, unused by the
web app today. It exists so a later worker-side Playwright PNG lane (`playwright ^1.49.1` is already
in `ingestion/package.json`) costs zero refactor across the `worker/tsconfig rootDir:"src"` boundary.

**`scales.ts` (~120 lines, pure, `node:test`)** — the arithmetic that is not per-shape, with its real
consumer counts: `linear` (all 15), `extent`/`padExtent` (line, area, indexed — top pad so the `r=4`
terminal marker is not clipped), `band(n,[x0,x1],bodyW)` (one function reproduces waterfall n=6
step 70 body 52 x0=6, dist n=12 step 32 body 26 x0=6, and candle n=8 step 40 body 14 x0=15 exactly),
`symmetricAboutZero` (dist), `bins` + `chooseBinCount` (Freedman–Diaconis clamped to the schema's
`[3,24]`, `d-charts.ts:290-293`), `median` (**three** consumers: scatter quadrants, dist summary,
BLK-BREADTH), `rebase100` (indexed — "ALWAYS REBASE TO 100" is a stated rule and the legend's total
returns derive from the rebased series), `mergeUnderFivePercent` (stack's "<5% → Other", plus
normalise and a warn when the raw sum is outside 99–101, `d-charts.ts:192`), `crossing` (slope —
pairwise sign flip of `(startᵢ−startⱼ)` vs `(endᵢ−endⱼ)`; more than one crossing takes the largest
rank swap and the rest go in `notes`; this is *why* the writer may not nominate the pair,
`d-charts.ts:331-333`), `directionToken` (hard rule 1, token side).

**`ramps.ts` — `inkRamp` is a table, not a formula.** The 5-stop `tokens.ink_ramp`
(`#14120e #57534a #a8a396 #cfcabe #e3dfd4`) has **three different assignment rules**, measured:
- **bars** (specimen n=5, lead=3 → `#14120e ×3, #57534a, #a8a396`): `i < lead ? ink : ramp[min(1+i-lead, 4)]`
- **donut** (n=4 → `#14120e #57534a #a8a396 #cfcabe`): `ramp[i]`, the first *n*
- **stack** (n=3 → `#14120e #a8a396 #e3dfd4`, i.e. indices 0,2,4): a per-*n* table
  `{2:[0,4], 3:[0,2,4], 4:[0,1,2,4]}`. **n=2 and n=4 are inferred — only n=3 is drawn.** Flagged in
  the file header. Confirmed at column scale: `longform-3a-deep-dive.html:122` draws n=3 as
  `#14120e / #a8a396 / #e3dfd4`, same indices, 52px height instead of 46px.

**`heat-ramp.ts` — moved, not copied.** `heatBucket(pct) → 1..9` and `HEATMAP_HEX` move out of
`SectorTreemap.tsx:49-67` into `src/lib/blocks/chart/heat-ramp.ts`, with `SectorTreemap` importing
from there — that is what "NEVER INVENT A SECOND SCALE" actually requires. Carry forward the
signed-sqrt curve (`:63-68`) and the AA rule (`:74-85`: bucket 9 `#1f8a45` gives `text-dark-text` only
3.75:1, so that one bucket uses `text-ink`).

**But BLK-HEAT's ramp is an owner ruling, not a doc fix.** The evidence does not support "the card's
7 is simply a miscount of the dark 9":
- the BLK-HEAT specimen draws **24 cells in 8 distinct hexes**, all eight exact members of
  `--color-heatmap-1..9`; only bucket 8 (`#1f7a3f`) is unused;
- but **the paper edition of the sector heatmap ships a different scale with exactly seven stops** —
  `SectorTreemap.tsx:95-105` `lightHeatClass` returns `bg-negative/35, bg-negative/22, bg-negative/10,
  bg-paper-tint, bg-positive/12, bg-positive/24, bg-positive/40`, with a header comment stating why:
  "The light/paper edition has no sequential heatmap token to reach for";
- BLK-HEAT renders on paper.

So the card's "SAME 7-STOP RAMP AS THE SECTOR HEATMAP" plausibly names the **paper** scale, and
importing the 9-stop dark ramp onto a paper article page would itself be the second-scale invention
the card forbids. New ledger row **DEF-HEAT-PAPER-RAMP** (trigger: owner decision; home: 09 §6.1),
stating the three candidates and this evidence. Until ruled, BLK-HEAT stays blocked — it already sits
in the last slice behind the series gap, so this costs nothing.

**`shapes/<shape>.ts` — genuinely per-shape, `(input, surface) => { marks, derived }`.** Mark counts
from the card specimens: waterfall 18, candle 17, dumbbell 16, dist 13, scatter 12, slope 12, line 6,
area 5, indexed 3 — so each layout function is 30–70 lines: **~450 lines per-shape against ~120
shared**. That ratio is the honest answer to "15 shapes is a lot of surface": the surface is real but
shallow. No abstraction collapses them — a waterfall's dashed connectors and a slope's crossing
detection have nothing structurally in common, and a generic "cartesian chart" layer would cost more
code than it saves and would make each card's hard rule harder to read against its implementation.

**`Derived` — what the compiler computes that the schema deliberately withholds.** Sixteen rows;
`area` is included, which the earlier draft omitted, leaving the tick row, the `4.1% → 11.4%` endpoint
pair and the `+730 BP` delta at `longform-1a-feature.html:155-156` with no producer.

| shape | derived |
|---|---|
| line | annotation x position, hollow-marker y, tick labels |
| **area** | **tick labels, first/last endpoint pair, bp delta, the dashed-event legend string** |
| bars | sort order, ramp assignment, on-top value labels (never an axis) |
| stack | merged/normalised segments, percentages, ordering |
| donut | ramp, the literal `conic-gradient(…)` string, which legend value is bold |
| cover | fill %, the `1/scale_max` position of the red 1.0× line, endpoint labels |
| range | four positions (bear/base/bull band, `last_price` diamond) |
| heat | bucket matrix, row-major, shaped to `row_labels × column_labels` |
| waterfall | per-driver sign→token, connector coords, the `E` suffix when `end.is_estimate` |
| scatter | median x/y, radius mapped into `SURFACE[surface].bubbleR`, which points are labelled |
| dist | bin edges + the three summary labels — the card lists these as payload; PD.3 correctly moved them here (`d-charts.ts:279-283`) |
| dumbbell | per-row delta text and direction token |
| slope | the crossing pair; everything else greys to `muted-mark` at 1.4 |
| indexed | both rebased series, legend total returns, "BASE 100" |
| candle | per-candle direction token, reference label placement |
| snapshot | peak bar index, latest bar index, its direction token |

##### PR.5.3.6 Registry and vocabulary

**Change 1 — widen `ImplementedBlockCode` one family at a time**: `| BlockCodeB`, then `| BlockCodeH`,
`| BlockCodeE`, `| BlockCodeD`, `| BlockCodeF`. A half-landed family becomes a compile error rather
than a silent `MissingBlock`. Four edits per family, in order: payload interface → `BlockNode` arm
(`types.ts:480-503`) → widen the union (`types.ts:114`) → registry entry (`registry.tsx:49-73`).

**Change 2 — at the end, `ImplementedBlockCode = BlockCode`** and `BlockRendererMap` over all 61.
`MissingBlock`, `hasRenderer` (`registry.tsx:78-80`) and the guard at `:110-114` all **stay** —
unreachable from typed callers, reachable from untyped ones: a code arriving from
`content_blocks.block_kind` at runtime, or a corrected article re-rendered against an older build,
which is the case `MissingBlock.tsx:3-17` was written for. Add a comment saying so, or someone deletes
it as dead code.

**Change 3 — close the vocabulary drift hole, in the same PR.** `src/components/blocks/types.ts:23-111`
hand-duplicates `ingestion/src/blocks/codes.ts:113-125` with **no test anywhere**, and the web
`package.json` has no `test` script (`dev`/`build`/`start`/`lint` only). Adding 41 payload interfaces
+ 41 union arms roughly triples that untested surface. Keep the split — importing `marsad-ingestion`
would drag playwright/undici/xlsx/zod into the Next build — and close the hole with generation:
- `scripts/design/generate-web-block-codes.mjs`, mirroring `generate-block-schemas.mjs`'s `--check`
  mode, emitting `src/components/blocks/codes.generated.ts` from `docs/design/block-registry.json`:
  `BLOCK_CODES` array + `BlockCode` union + `FAMILY_OF: Record<BlockCode, BlockFamily>`;
- `types.ts` imports the union; family sub-unions stay hand-written where `BlockNodeOf` needs them;
- add `"test": "tsx --test \"src/**/*.test.ts\""` to the web `package.json` — the same runner
  `worker/` and `ingestion/` already use;
- one `src/components/blocks/__tests__/registry.test.ts` asserting (a) implemented count ===
  `Object.keys(BLOCK_RENDERERS).length`; (b) implemented ⊆ the 61; (c) **every renderer file basename
  equals `rendererFor(code)`**, so `ops.story_blocks.renderer_component` stays truthful;
  (d) `/styleguide/blocks` fixtures cover every implemented code.

State in the script header that this is a **local** gate: GitHub Actions is billing-blocked (every job
dies in ~3s with 0 steps) and Vercel runs only `next build`.

**Change 4 — `onUnresolvedBinding`**, alongside `onMissingComponent` (`registry.tsx:89-98`), same
override shape, default `console.warn`. It gives a host surface one hook to route "this article
rendered but four figures are em-dashes" to an ops incident — the signal the desk needs once PR.6
opens the gate. `BlockProps` grows two optional fields (`onUnresolvedBinding`, `surface`); no renderer
changes.

**Not changing:** `Block`/`BlockList` stay binding-unaware; `BlockList` keys on the opaque `_key`
(`registry.tsx:120-134`); the single unchecked cast (`registry.tsx:115`, documented `:100-108`) stays
the only one in the layer.

---

#### PR.5.4 Build order — seven slices, each independently verifiable

**Unlock argument**, measured from `article-templates.json → templates[].block_instances`:

| template | stated blocks it needs | families still missing |
|---|---|---|
| **1a Feature** (21 instances) | BLK-CUT (order 14), BLK-TICKER ✅, BLK-STATSTRIP ✅, pull quote (9), area exhibit (10), sensitivity bars (12), scenario table ✅ (13) | **H**, **B**, **D**(AREA, BARS) |
| **1b Research note** (14) | BLK-THESIS (4), BLK-FALSIFY (13, "MANDATORY"), rating panel (2), pull quote (8), bubble scatter (7), valuation bridge (11) | **B** (4 of 6), **D**(SCATTER, WATERFALL). `premium_cut.present=false` → **no H** |
| **3a Deep dive** (22) | BLK-CUT (15), stacked bar (8), paired bars (11), pull quote (10) | **H**, **B**, **D**(STACK, BARS) |
| **3b Explainer** (13) | BLK-TIMELINE (3), BLK-WORKED (5), BLK-GLOSSARY (10), BLK-TERM ✅ (11) | **E only.** `premium_cut.present=false` |

Which fixes the order: **B** unlocks 3 of 4 templates and depends on nothing (five of six are
`requires_binding=false` by design, `b-statement.ts:1-9`; only BLK-BIGNUM binds, one scalar). **H** is
4 blocks and unlocks the 2 templates with a cut (BLK-DOWNLOAD/BLK-ALERTCTA bind `ObjectRef` —
identity, no field read — so they need no resolver). **E** completes 3b outright and has zero bindings
in the whole family. **D's CSS five** ship before anything SVG, because four of them yield the
primitives family F reuses. **F unlocks zero longform templates** (it serves TPL-01/TPL-02 only) and
sits on the unresolved BLK-FRESH colour law, so it goes late.

| slice | blocks | n | depends on | unlocks |
|---|---|---|---|---|
| **PR.5a · B** | THESIS, PULLQUOTE, BIGNUM, VERDICT, TAKE, FALSIFY | 6 | primitives; `RedactedGate` | 1a, 1b, 3a prose spine |
| **PR.5b · H** | CUT, PAYWALL, ALERTCTA, DOWNLOAD | 4 | `BlurTeaser`, `Kicker` | 1a + 3a gate; makes the cut **visible** (see correction below) |
| **PR.5c · E** | TIMELINE, STEPS, FLOW, ANATOMY, WORKED, MYTH, DECISION, GLOSSARY | 8 | `AccentPanel`, `Chip` | **3b complete** |
| **PR.5d · substrate + CSS five** | BARS, STACK, RANGE, DONUT, COVER | 5 | `chart/{surfaces,scales,ramps,heat-ramp,types}.ts` + 4 CSS primitives | 1a + 3a exhibits |
| **PR.5e · F −SNAPSHOT** | TAPEROW, CHIPROW, COUNTDOWN, HALT, CORRECTION, BREADTH, VENUEHEAD | 7 | `ProportionalBar` (from STACK); **DEF-FRESH-COLOUR-LAW ruling** | the wire lane |
| **PR.5f · compiler + SVG four** | WATERFALL, SCATTER, DUMBBELL, SLOPE | 4 | `compile()`, `ChartSpec`, `<ChartSvg>` | 1b exhibits |
| **PR.5g · the series seven** | LINE, AREA, DIST, HEAT, INDEXED, CANDLE, SNAPSHOT | 7 | **PR.1 series object + pinned `field`**; HEAT also needs DEF-HEAT-PAPER-RAMP | remaining exhibits |

6+4+8+5+7+4+7 = **41**.

> ⚠️ **CORRECTION (2026-07-27, while building PR.5b).** This table said PR.5b "flips fit R-09 to
> enforcing". It does not — **R-09 is already fully enforcing** and always was. `checkCut`
> (`fit-engine.ts:830`) derives the cut index from `content_blocks.gated` or
> `content_items.premium_cut_after_block` and **never** from the presence of a `BLK-CUT` block, so
> `FIT-CUT-NO-DATA`, `FIT-CUT-MID-SENTENCE`, `FIT-CUT-NOT-PERMITTED` and `FIT-CUT-UNPLACEABLE` all
> fire today with no renderer in existence. What PR.5b adds is the renderer for a boundary the
> engine already polices. The distinction matters: nobody should read this table and conclude the
> paywall rule was unenforced before the renderer landed.

Running in parallel from day one, ahead of PR.5a's first renderer:
`src/lib/blocks/{resolve,collect,entitlement,project/*}.ts` — buildable and testable against a stub
reader before `public.v_block_bindings` exists, and the interface the 15 chart projectors need anyway.

**Per-slice deliverables:**

| slice | new | touched | tests |
|---|---|---|---|
| **PR.5a** | 6 renderers + 6 primitives; `codes.generated.ts`; `test` script | `types.ts`, `registry.tsx`, `index.ts`, `fixtures.ts`, `styleguide/blocks/page.tsx` | `registry.test.ts`; **BLK-TAKE absence test**; 6 Kicker tuple diffs at 1440px |
| **PR.5b** | 4 renderers | same 5 | gate-absence test extended to H; scrim = 120 on article fixture, 56 on card fixture |
| **PR.5c** | 8 renderers | same 5 | fixture coverage |
| **PR.5d** | `chart/{surfaces,scales,ramps,heat-ramp,compile,types}.ts`, 4 CSS primitives, 5 renderers | same 5 + `SectorTreemap.tsx` (import the moved ramp) | `scales.test.ts`; 5 card goldens + 2 `column` goldens from 3a; **`TOKEN_HEX` ⟷ `globals.css @theme` drift test** |
| **PR.5e** | 7 renderers | same 5 | fixture coverage; the colour-law ruling encoded once |
| **PR.5f** | `ChartSvg.tsx`, `toSvgString.ts`, `shapes/{waterfall,scatter,dumbbell,slope}.ts`, 4 renderers | same 5 | 4 card goldens + the **1b `master` scatter golden**; the text⇒PAR invariant per surface |
| **PR.5g** | `shapes/{line,area,dist,indexed,candle,snapshot,heat}.ts`, 7 renderers | same 5; `ImplementedBlockCode = BlockCode` | 5 card goldens + the **1a `column` area golden**; level-3 goldens; the closing 61-of-61 assertion |

Per-step verification is the doc's standing loop (`§0.2`): `npx tsc --noEmit && npx eslint <paths>`,
then the preview at 1440px with a clean console. Every slice is shippable on live pages: an unbuilt
code renders `MissingBlock` (amber dashed, logged, non-fatal — `MissingBlock.tsx:25-41`), never a crash.

---

#### PR.5.5 Acceptance criteria

- [ ] `src/components/blocks/` contains **61** renderers; `ImplementedBlockCode = BlockCode`;
      `BlockRendererMap` is `{[C in BlockCode]: …}` and `npx tsc --noEmit` is clean.
- [ ] `npm test` in the web app exists and passes, asserting: 61 codes ⟷
      `docs/design/block-registry.json`; renderer count === registry key count; **every renderer file
      basename === `rendererFor(code)`**; every implemented code has a `/styleguide/blocks` fixture.
- [ ] `scripts/design/generate-web-block-codes.mjs --check` exits 0 against the committed
      `codes.generated.ts`.
- [ ] `compile()` reproduces the **card** golden for all 15 shapes, the **column** golden for area
      (1a, 640×220, baseline 180, 4 gridlines, stroke 2.4) and stack + paired bars (3a), and the
      **master** golden for scatter (1b, 1050×300, 2 axes + 3 gridlines + 2 medians, radii 10–26).
      Goldens with no design reference are marked `inferred: true`.
- [ ] For every golden: `marks.some(m => m.t === 'text')` implies `preserveAspectRatio !== 'none'`.
- [ ] No `Mark` outside the six-member union; no `Tok` outside the 15; no `Dash`/`StrokeW` outside the
      committed sets. Enforced by tsc, asserted once in `compile.test.ts`.
- [ ] `heat-ramp.ts`'s array === `globals.css --color-heatmap-1..9`, parsed from source, and
      `SectorTreemap.tsx` imports it rather than declaring its own.
- [ ] **`TOKEN_HEX` (all 15 `Tok` members, `ink_ramp` included) === the `@theme` block in
      `src/app/globals.css`**, same parser, one extra assertion. Closes
      DEF-TOKEN-A8A396-UNNAMED-LIGHT honestly rather than by alias.
- [ ] `renderToStaticMarkup` of an unentitled **BLK-TAKE** contains neither `headline` nor `body`;
      same assertion for every gated H and B block. The test asserts **absence of copy**, not presence
      of CSS.
- [ ] `BlurTeaser` default `scrimPx === 120`; the 56 value appears only in the styleguide card fixture.
- [ ] Level 3 renders no numeral: for each of the 15 shapes, a golden with zero resolved bindings
      produces output containing no digit — no tick row, no summary strip, no `caption` carrying a
      digit — and stamps `data-exhibit-resolution="empty"`.
- [ ] STACK, DONUT, WATERFALL (missing endpoint), RANGE (missing band member) and COVER (missing
      headline) each degrade to level 3 rather than drawing a partial shape; BARS/SCATTER/DUMBBELL/
      SLOPE drop and note; LINE/AREA/INDEXED/CANDLE never interpolate.
- [ ] BLK-HEAT unresolved cells render paper + dashed hairline, never a ramp colour.
- [ ] Every `data-unresolved` figure fires `onUnresolvedBinding` exactly once.
- [ ] `resolveBindings` issues **one** query per piece and is covered by a stub-reader test that runs
      with no DB.
- [ ] With `public.v_block_bindings` absent, every route under `/(reader)` still renders, console is
      clean of errors, and every bound figure is an em-dash.
- [ ] Docs updated in the same commits (§PR.5.7); `grep -ri "vega" docs/ ingestion/src/blocks/`
      returns nothing.
- [ ] Landed with `pipeline_intake_enabled=false` and the fit stage off; the R-09 behaviour change is
      re-verified against the fit goldens **before** PR.6.

---

#### PR.5.6 What PR.5 deliberately does not do

- **It does not build `ExhibitFrame`, the article chassis, or any template renderer.** The frame is
  template chrome (`chassis.shared_components.exhibit_frame`), and no chart payload carries a title
  or label — only `caption` (`d-charts.ts:108-114`). PR.5 ships the contract that phase needs: the
  `data-exhibit-resolution` stamp, so the frame can suppress its provenance strip on an empty exhibit.
- **It does not create the read path.** `public.v_block_bindings` is PR.0's migration; PR.5 codes
  against the contract in §PR.5.3.1 and ships degraded until it lands.
- **It does not invent a series object.** `field` path and object type are PR.1's decision;
  PR.5g consumes whatever PR.1 pins.
- **It does not rule on BLK-FRESH's colour law or BLK-HEAT's ramp.** Both are owner decisions with new
  §7 rows; F ships behind the first, HEAT behind the second.
- **It does not touch email or PNG.** `09-signal-to-article.md:886` stage ⑫ names "SVG web / PNG
  email"; the web app has four API routes total (`search`, `revalidate`, `screener/run`,
  `pulse/[surface]`), no email route, no template, no rasteriser — and `playwright` lives only in
  `ingestion/package.json`, on the far side of `worker/tsconfig rootDir:"src"`. `specToSvgString` is
  the zero-cost hook for a later worker-side Playwright pass over a deployed render route.
- **It does not change the writer, the fit engine, or any pipeline stage.** It changes what fit
  *refuses*, only by making C/D blocks exist.

**Handed to the next phase:** 61 working renderers; a pure `compile(input, surface)` with per-surface
goldens; `resolveBindings`/`readField`/`formatBound` as the single execution point of D-8; the
`resolution` stamp; and a web-side test runner that did not exist before.

---

#### PR.5.7 Dependencies and docs

**Must be true before a slice starts:**

| slice | precondition | owner |
|---|---|---|
| PR.5a–PR.5c, PR.5d, PR.5f | none — buildable today against fixtures and a stub reader | — |
| any bound figure showing a real number | `public.v_block_bindings` applied | **PR.0** (owner-gated: MCP returns "You do not have permission"; `marsad_worker` holds only SELECT+DELETE on `ops.story_blocks`; local checkout has only an anon key; supabase CLI not installed) |
| PR.5e (F) | **DEF-FRESH-COLOUR-LAW** ruled | **owner** |
| PR.5g LINE/AREA/DIST/INDEXED/CANDLE/SNAPSHOT | series-bearing lake object + pinned `field` path | **PR.1** |
| PR.5g HEAT | **DEF-HEAT-PAPER-RAMP** ruled | **owner** |
| PR.6 | PR.5b + PR.5d landed and fit goldens re-run with R-09 enforcing | this phase |

**Docs updated in the same commits (AGENTS.md discipline):**

| file | change |
|---|---|
| `docs/architecture/09-signal-to-article.md:625, :649` | replace "Vega-Lite spec" with the `ChartSpec` / token-mark contract |
| `09-signal-to-article.md:886` (stage ⑫) | drop PNG from PR.5's scope; name the later worker-side Playwright lane |
| `ingestion/src/blocks/d-charts.ts:8, :111`; `binding.ts:100` | the three docstrings that still say "Vega-Lite" |
| `docs/design/block-registry.json → tokens.heat_ramp` | replace the 8-stop list + "card says 7" note with a pointer to DEF-HEAT-PAPER-RAMP and the three candidates (specimen = 8 dark hexes on paper; shipped paper heatmap = 7 composed stops; card says 7) |
| `docs/design/README.md` | record the blur scrim as a **per-surface** value (card 56 / article 120), with the three measured occurrences — not as an unresolved precedence conflict |
| `docs/BUILD-STATUS.md §7` | **add** DEF-FRESH-COLOUR-LAW (trigger: owner decision; home: 09 §6.1 — it has no ledger row today, which per AGENTS.md means it is dropped, and it blocks BLK-HALT / BLK-VENUEHEAD / BLK-CORRECTION); **add** DEF-BLOCK-BINDING-READ-PATH; **add** DEF-HEAT-PAPER-RAMP; **add** DEF-TAKE-ENTITLEMENT-STORED; update DEF-BLOCK-RENDERERS-ABSENT (line 605) per slice; **close** DEF-TOKEN-A8A396-UNNAMED-LIGHT (line 606) in PR.5d — its own trigger reads "when B/E/F/H land" |
| `src/components/blocks/index.ts:4-7` | the "Built families / Still absent" comment, per slice |