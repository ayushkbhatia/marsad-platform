# Build specs — the PR phases (the research desk)

Full build specifications for the phases sketched in `docs/BRIDGE-BUILD-PLAN.md` under
**"PR — The research desk"**. The build plan carries the one-paragraph version of each; these carry
the design, the SQL, the types, the build order and the acceptance criteria.

Produced 2026-07-27 against the live database and the tree at `8633a6b`. Each was written by a
planning pass that investigated the repo, designed, was then attacked by an adversarial reviewer
told to refute it, and revised. The verdict column is that reviewer's, not the author's.

| spec | phase | verdict | objections | status |
|---|---|---|---|---|
| [PR0c-templates-reseed.md](PR0c-templates-reseed.md) | PR.0c — reseed `ops.templates`, add `piece_type` | sound with changes | 9 (1 blocking) | ready to build |
| [PR1-evidence-bundles.md](PR1-evidence-bundles.md) | PR.1 — evidence bundles | **broken** ×2 lenses, revised | 23 (8 blocking) | ready to build, **blocked on D-14** |
| [PR4-compose-stage.md](PR4-compose-stage.md) | PR.4 — the compose stage | **broken**, revised | 13 (3 blocking) | depends on PR.1 |
| [PR5-renderers-chart-compiler.md](PR5-renderers-chart-compiler.md) | PR.5 — 41 renderers + chart compiler | sound with changes | 7 (2 blocking) | independent, can start now |
| [PR6-open-the-gate.md](PR6-open-the-gate.md) | PR.6 — open intake narrowly | sound with changes | 10 (3 blocking) | last |

**PR.2 (researcher agent) and PR.3 (analyst pass) are deliberately unplanned.** Their entire content
is the interface PR.1 defines — the `BoundFact`/`FactRef` envelope and the absence contract — so
planning them before PR.1's contract existed would have meant inventing it twice.

## The decisions these specs surfaced

**D-14 — the VERIFIED wall. Owner decision, and it caps every phase downstream.**
`worker/src/handlers/newsroom/fit-engine.ts:386-395` refuses a bound object whose citations are all
non-`VERIFIED`. Measured live: `COMPUTED.RATIOS` 736, `COMPUTED.SCORE` 540, `QUOTE.LAST` 264,
**`FILING.FINANCIALS` 1 of 36,330**. A piece can therefore bind a P/E and a Marsad score but **not
one reported revenue figure**. Options are in `PR1-evidence-bundles.md §11`: widen fit to read a new
`ops.materiality_prefilter.citable_states text[]` (the identical D-10 argument PE.6 already won for
*intake* — and it must be a separate column, since widening `accepted_states` would open intake to
640,992 `OHLCV.CLOSE` objects), or cap PR.1's ambition to what binds today.

**Bindings expire nightly.** `COMPUTED.RATIOS` carries 13.9 revisions per natural key (10,263 rows,
9,527 retired), rebuilt inside a single hour each night. A brief assembled at 23:00 and composed at
06:00 binds retired uuids — or, worse, follows `superseded_by` and renders a *new* value under
*frozen* prose, which fit passes. Hence `hydrate()` is async against a live resolver, by design.

**`effective_date` is NULL across the whole fundamentals tier** — 0 of 36,330 `FILING.FINANCIALS`,
0 of 41,621 `FINANCIALS.XCHECK`, 0 of 736 ratios, 0 of 540 scores. Only `OHLCV.CLOSE` populates it.
Any staleness check reading that column reports the fundamentals corpus as permanently fresh.

**`'fit'` is not a legal `ops.pipeline_items.stage`.** The CHECK at
`20260713000009_rules_pipeline.sql:81-82` lists eight stages and `fit` is not one;
`worker/src/handlers/newsroom/fit-stage.sql` was never applied and is absent from the ledger.

**The sector gap is venue-shaped, not universe-wide.** TDWL 227/387 and QE 48/49 are sectored;
**ADX 0/93, DFM 0/72, MSX 0/120, BHB 0/41** are not. It is a producer gap on four venues, fixable on
its own, not a taxonomy problem.

## A correction these specs forced

Earlier revisions of `BRIDGE-BUILD-PLAN.md` and `09 §12` claimed every seeded template *would be
refused at the fit stage today*. That was **wrong**. `fit-engine.ts:330-343` raises
`FIT-TEMPLATE-LEGACY-KEY` as a **warning** — with a comment saying so, and a golden test at
`fit.test.ts:112` asserting `passed === true`. `09 §6.0` had it right all along. Both documents now
carry the correction inline; PR.0c remains necessary for a different reason, stated there.
