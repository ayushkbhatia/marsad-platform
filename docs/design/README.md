# `docs/design/` — the stored design system

The canonical, in-repo source of truth for **what an article is made of**. Read this before
writing any composing agent, any block renderer, or any article template.

Architecture: [`../architecture/09-signal-to-article.md`](../architecture/09-signal-to-article.md).
Execution: `../BRIDGE-BUILD-PLAN.md` phase **PD**.

---

## Three layers, single-sourced

| Layer | Path | Who reads it |
|---|---|---|
| **Visual reference** (immutable) | `artifacts/*.html` | humans, and agents that need to see production fidelity |
| **Machine-readable** | `block-registry.json`, `article-templates.json` | build-time: schema authoring, renderer scaffolding, seed generation |
| **Runtime** | `ops.story_blocks`, `ops.article_templates` (Postgres) | the composing and fitting agents on the VPS |

The runtime layer is seeded **from** the JSON. Drift between them is a diff, not a mystery.
The JSON alone is not sufficient: agents run on the VPS against Postgres, not against this repo.

### `artifacts/`

| File | What |
|---|---|
| `artifact-library-61-blocks.html` | All 61 story blocks in 8 families, at production fidelity, each with its `BLK-*` code, permitted piece types and binding rule |
| `longform-1a-feature.html` | Feature long read — **the chassis every other type inherits** |
| `longform-1b-research-note.html` | Analyst note with a formal call |
| `longform-3a-deep-dive.html` | Multi-part series investigation |
| `longform-3b-explainer.html` | Mechanism teaching (free tier) |
| `README-artifact-library.md`, `README-longform.md` | The original handoff notes — **normative**, they state rules the markup alone does not show |

Self-contained; open standalone in a browser. All 1440px desktop.

> **Never edit these files.** They are a design handoff, replaced wholesale when a new one
> arrives. Corrections go to the designer, not to the HTML. If the JSON disagrees with the HTML,
> **the HTML wins** and the JSON is regenerated.

### `block-registry.json`

```jsonc
{ "tokens":   { "colors": {…}, "fonts": {…}, "type_scale_px": {…},
                "three_hard_rules": [...], "accent_policy": {…} },
  "families": [ { "key": "A", "name": "Inline", "purpose": "…", "count": 6 }, … ],   // 8
  "blocks":   [ { "code": "BLK-FINTABLE", "family": "C", "family_name": "Tabular",
                  "name": "Financials with estimate column",
                  "allowed_piece_types": "NOTE · DEEP DIVE",
                  "binding_rule": "MAX 8 ROWS INLINE · … · BINDS FILING.FINANCIALS",
                  "binds_to": "filing.financials",
                  "required_payload_fields": [ … ],   // what a writer agent must supply
                  "constraints": [ … ],               // machine-checkable hard rules
                  "gating_related": false,
                  "rule_id": null }, … ]              // 61
}
```

**Family D is question-indexed.** Its `allowed_piece_types` holds the *question the shape
answers* — `"WHAT MOVED IT?"` for `BLK-WATERFALL`, `"WHEN DID IT TURN?"` for `BLK-LINE`,
`"WHO'S POSITIONED?"` for `BLK-SCATTER`. That is deliberate and it **is the chart-selection
contract**: the agent picks a question, the compiler picks the shape.

### `article-templates.json`

```jsonc
{ "chassis":   { "grid": {…}, "fonts": {…}, "chassis_rules": [...], … },
  "templates": [ { "id": "1b", "name": "Research note", "access_tier": {…},
                   "page_grid": {…}, "body_typography": {…},
                   "section_sequence": [ { "name": "masthead", "required": true }, … ],
                   "unique_to_this_type": [...], "inherited_from_1a": [...],
                   "rail": {…}, "gutter": {…},
                   "block_instances": [...],          // BLK-* in document order, by region
                   "premium_cut": {…},
                   "writer_metadata_fields": {…},     // ← the research stage's output contract
                   "hard_rules": [...] }, … ]         // 4
}
```

`writer_metadata_fields` is the important one: it enumerates every field the research stage must
produce for that template to be fillable. 1b needs nine groups
(`identity`, `call`, `thesis`, `analyst`, `whats_changed`, `exhibits`, `narrative`, `valuation`,
`risk`, `compliance`) — that list is what makes a research note buildable at all.

---

## The rules that make this a spec, not a mood board

**Writer agents don't emit layout.** They emit **prose + block codes + lake object IDs**. The
publishing agent resolves each `BLK-*` against the registry, fits it into the template, and
**refuses to publish** a block whose data binding is unverified or whose family isn't permitted
for that piece type.

**No agent may invent a block.** The closed vocabulary is what makes an agent-run newsroom safe
to operate.

**The writer never emits a number** — it emits a binding `{block_code, object_id, field}`, and
the renderer reads the value from `lake.objects` at render time. A fabricated figure becomes
structurally impossible rather than statistically unlikely.

### The three hard rules

1. **One accent only — ink.** Green `#0a7a3c` and red `#c0342b` are reserved for **direction**,
   never for emphasis or decoration.
2. **Every number carries a freshness state and a provenance stamp** (`BLK-FRESH`, `BLK-PROV`).
3. **A desk estimate is marked three ways at once** — `E` suffix, ink column header, bold value.
   **Never colour alone.**

### Chassis rules (1a, inherited by all)

```
88px marker gutter │ 740–762px measure │ 296–300px rail   (gaps 52–54px)
container 1160–1180px centred, 34px page padding
```

- The **measure is fixed** — Newsreader 17px / 1.72, never reflows to full width.
- The **gutter is not padding** — it carries section markers, `BLK-MARGIN` notes and citation
  anchors that must align to the paragraph they annotate.
- **Exhibits break the measure deliberately** — spanning gutter + measure, never the rail.
- The **rail is the only independently scrolling column**.

---

## Build order

**Blocks: G → A + C → D → B, E, F, H.**
G (provenance, freshness, estimate markers) first, because they are prerequisites for every other
family's footer. D against a real charting library — the SVG in the library file is a rendered
snapshot, not an implementation.

**Templates: 1a → 3b → 1b → 3a.**
1a is the chassis; everything else is furniture swaps. 3b exercises the gutter and glossary with
the simplest furniture set. 1b adds the rating header, thesis and falsifiers. 3a adds series
position, chapter navigation and the reverse headline.

---

## Relationship to the rest of the design system

These are 65 units from a 177-screen platform. Design **tokens** live in
[`../../src/styles/design-tokens.json`](../../src/styles/design-tokens.json) (the in-repo mirror of
the hand-maintained `@theme` block in `src/app/globals.css`).

**Verified 2026-07-27:** the two palettes agree exactly on all **17** core values — the full
ink ramp (`#14120e #26241f #33302a #57534a #8a857a`), the hairline ramp
(`#cfcabe #dcd8cc #e3dfd4 #efece3`), paper (`#fdfcf9 #f6f4ee #e8e5dc`), `#a8a396`, and the three
accents `#0a7a3c` / `#c0342b` / `#c9a227` plus dark-surface `#4fc47f`.

`block-registry.json` carries **9 additional** hexes that `design-tokens.json` does not
(`#0f5f31 #1f8a45 #1c6b38 #1a5c32 #203a27 #232e22 #32241e #5c261f #7a291f`). These are the
`BLK-HEAT` change ramp, and their absence is correct — per the handoff, `BLK-HEAT` is *"the only
place the dark-room change ramp appears on paper, deliberately, so the scale stays single-sourced
with the sector heatmap (screen 1e)"*. Do not copy them into the token file; bind `BLK-HEAT` to
the same ramp screen 1e uses.

The 17-value agreement is worth asserting in CI — it is the drift guard the token file's own
header asks for.

Reader screens and the Desk admin console are tracked in
[`../SCREENS-REGISTER.md`](../SCREENS-REGISTER.md).
