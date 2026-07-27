# Handoff: Marsad — The Artifact Library (61 story blocks)

## What this is
One static, fully-resolved HTML export containing **every visual unit an article may
contain** — 61 blocks in 8 families, each shown at production fidelity with its `BLK-*`
code, the piece types it's allowed in, and a footer stating its binding rule.

`Artifact Library - 61 blocks.html` is self-contained (no `support.js`, no `.dc.html`
siblings) and opens standalone in a browser.

## Why this file is a spec, not a mood board
Writer agents don't emit layout. They emit **prose + a list of block codes + lake object
IDs**. The publishing agent then:

1. resolves each `BLK-*` code against this library,
2. fits it into the piece's template,
3. **refuses to publish** a block whose data binding is unverified, or whose family isn't
   permitted for that piece type.

**No agent may invent a new block.** That closed vocabulary is what makes an agent-run
newsroom safe to operate — which is why every card here states its constraints rather than
just showing a picture.

## The three hard rules
1. **One accent only — ink.** Green (`#0a7a3c`) and red (`#c0342b`) are reserved for
   *direction*, never for emphasis or decoration.
2. **Every number carries a freshness state and a provenance stamp** (`BLK-FRESH`,
   `BLK-PROV`).
3. **A desk estimate is marked three ways at once** — `E` suffix, ink column header, bold
   value — so it can never be mistaken for a filed figure. Never colour alone.

## The eight families

| Family | Count | Purpose |
|---|---|---|
| **A · Inline** | 6 | Units that live inside a sentence: ticker chip, delta, citation chip, defined term, sparkline, margin note |
| **B · Statement** | 6 | Where the desk commits to a view: thesis, pull quote, big number, rating card, gated Marsad Take, falsifiers |
| **C · Tabular** | 8 | Stat strip, facts grid, financials (with marked estimate column), scenarios, league table, beat/miss, ex-date row, transposed compare |
| **D · Charts** | 15 | One shape per question — line, area, bars, proportional stack, waterfall, scatter, distribution, dumbbell, slope, valuation range, heat grid, rebased performance, donut, IPO cover meter, candles |
| **E · Mechanism** | 8 | Teach a process: timeline, steps, money flow, annotated document, worked example, assumption-vs-mechanism, if/then, glossary |
| **F · Wire & live state** | 8 | Timestamped and perishable: tape entry, chip row, snapshot, countdown, halt, correction, breadth, venue header |
| **G · Provenance & trust** | 6 | The audit trail rendered: lake stamp, build chain, freshness, desk-estimate marker, source conflict, rule applied |
| **H · Gates & CTAs** | 4 | Premium cut, paywall band, alert CTA, data download |

## Constraints worth carrying into code
- **`BLK-CUT` (premium cut)** — blur 3.5px + gradient to paper, and the cut must fall
  *after a complete thought* and *after at least one data block*. Enforced as rule R-09.
- **`BLK-CORRECTION`** — amber, never red: a correction is integrity. Must state whether
  the argument survived. Enforced as rule R-07.
- **`BLK-CONFLICT`** — when sources disagree, the figure is *withheld*. Publishing a gap
  beats publishing a guess; the block shows both values and picks neither.
- **`BLK-HALT`** — must distinguish *frozen* from *stale*, and state the expected lift.
- **`BLK-COVER`** — the 1.0× line is always drawn in red; below it an offer is
  undersubscribed, which is the story.
- **`BLK-CANDLE`** — on a debut the reference line is the **offer price**, not a prior
  close (there isn't one).
- **`BLK-INDEXED`** — always rebase to 100 and always show the benchmark; subject solid,
  benchmark dashed.
- **`BLK-DECISION`** — one question, two outcomes, never nested. A second level means the
  explainer is wrong.
- **`BLK-AGENTS`** — agent chips carry `◆`, humans don't, and the human is always last in
  the chain.
- **`BLK-HEAT`** — the only place the dark-room change ramp appears on paper, deliberately,
  so the scale stays single-sourced with the sector heatmap (screen 1e).

## Data note
Every specimen uses **representative sample content** drawn from the platform's own
scenarios (Aramco gas mix, OQBI subscription, stc dividend, Bina listing day). Each block's
real binding is named in its footer — e.g. `BLK-PROV` binds a lake object ID plus the
verifying agent, `BLK-FRESH` binds `market.status` per venue.

## Suggested build order
1. **G family first** — provenance, freshness and estimate markers are prerequisites for
   every other family's footer.
2. **A + C** — inline units and tables cover most of an article's surface area.
3. **D** — charts, against the chart engineering spec in the main handoff (the SVG here is
   a rendered snapshot; use a real charting library).
4. **B, E, F, H** — statement, mechanism, wire and gate blocks compose from the above.

## Where this fits
This is the component vocabulary behind the article templates. For the complete system
(all reader/mobile/email screens, the Marsad Desk admin console, extracted components, and
design tokens), see the `design_handoff_marsad_platform/` package already in this project.
