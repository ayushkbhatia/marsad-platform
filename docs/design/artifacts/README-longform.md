# Handoff: Marsad — Longform Article Types

## What this is
Four static, fully-resolved HTML exports of the platform's **longform editorial types** —
the article layouts that carry argument, analysis and teaching. Wire briefs and daily
briefings are excluded (they're a different chassis and ship separately).

| File | Type | Length | Access |
|---|---|---|---|
| `Feature Long Read - 1a.html` | Feature — the base chassis | ~18 min | Metered |
| `Research Note - 1b.html` | Analyst note with a formal call | ~14 min | Premium |
| `Sector Deep Dive - 3a.html` | Multi-part series investigation | ~40 min | Premium |
| `Explainer - 3b.html` | Mechanism teaching | ~11 min | Free |

Each file is self-contained (no `support.js`, no `.dc.html` siblings) and opens standalone.
All are 1440px desktop designs.

## Fidelity
High-fidelity, pixel-accurate to the source design (`Marsad Longform.dc.html`). These are
**design references for recreating the layouts in the target codebase**, not production
code to copy verbatim. Styling is inline throughout for devtools inspection.

---

## 1a is the chassis — build it first

Everything else inherits from it. The three-column grid is the whole design:

```
88px marker gutter | ~760px measure | 300px rail
```

- **The measure is fixed.** Body copy sits at Newsreader 17px / 1.72 and **never** reflows
  to the full 1440px. This is the single most important thing to preserve.
- **The gutter is not padding.** It carries section markers, `BLK-MARGIN` notes and
  citation anchors that must **align to the paragraph they annotate**.
- **Exhibits break the measure deliberately** — charts and tables span gutter + measure
  (never the rail). That's what makes them read as evidence interrupting the argument
  rather than decoration beside it.
- **The rail is the only independently scrolling column** (sticky).

## What each type changes

**1b Research note** — the analyst's output, not the journalist's.
- A **rating header above the headline**: ticker, recommendation, price target, implied
  upside, analyst track record. It comes first because it's the thing being asserted.
- Standfirst is replaced by a **thesis box** (`BLK-THESIS`) — the claim, stated once,
  before any argument.
- A **falsifiers block** (`BLK-FALSIFY`) is *mandatory*. A note without stated falsifiers
  doesn't pass the ruleset.
- **Disclosure is structural**, not a footnote: holdings position and coverage status sit
  in the byline bar.
- Rail carries valuation scaffolding (scenarios, key financials), not reading furniture.

**3a Sector deep dive** — the heaviest type, and it signals that three ways.
- **Headline set in reverse on ink**, not paper. Reserved for series work.
- **Series position** ("part 2 of 3 · The Water Economy") in masthead *and* rail.
- A **"what this establishes" contract** opens the piece — state the payoff before
  demanding forty minutes.
- Four **numbered chapters**, each with its own display heading and per-chapter minutes in
  the rail; the rail is a *chapter navigator*, not a contents list.
- Exhibits carry the argument: proportional stacked bar for the WPA anatomy (68% capacity /
  24% pass-through / 8% O&M), paired bars for the discount-rate gap, and a four-market
  offtaker table whose risk column is **explicitly labelled a desk assessment, not a credit
  rating** (rule R-06).
- **Cut falls at chapter 4**, after three complete chapters — "2 of 4 chapters read" — so
  the reader sees the work before the wall (rule R-09).

**3b Explainer** — the inverse of a research note. No byline furniture, no thesis, no
rating, because it asserts nothing.
- Opens on a **four-date timeline** where the ex-date is the **only column in red** — the
  date that costs money if missed. Exactly one stage in red, always.
- A **worked example** on 1,000 real Aramco shares proving the position is unchanged across
  the ex-date. Round numbers, real ticker, ending in a total row that settles the point.
- Three named **failure modes**.
- A **"what this is not"** box that refuses to endorse dividend capture — an explainer that
  teaches a mechanism must decline to recommend using it.
- **Evergreen, so it carries a review date, not a timestamp**: "reviewed 12 July, next
  January". A stale explainer is worse than none.
- Free tier by design — this is the acquisition surface.

## Relationship to the block library
Every visual unit in these four pages is an instance of a `BLK-*` block. The article
templates are **arrangements**; the blocks are the vocabulary. See the
`handoff_article_blocks/` package for all 61 blocks, their allowed piece types and their
binding rules — including `BLK-THESIS`, `BLK-FALSIFY`, `BLK-TIMELINE`, `BLK-WORKED`,
`BLK-GLOSSARY` and `BLK-CUT` used here.

## Suggested build order
1. **The 1a three-column chassis** — gutter alignment and fixed measure first; everything
   else is furniture swaps.
2. **3b Explainer** — simplest furniture set, exercises the gutter and glossary.
3. **1b Research note** — adds the rating header, thesis and falsifiers.
4. **3a Deep dive** — adds series position, chapter navigation and the reverse headline.

## Where this fits
Four screens from a 177-screen platform. For the complete system (all reader/mobile/email
screens, the Marsad Desk admin console, extracted components and design tokens), see the
`design_handoff_marsad_platform/` package already in this project.
