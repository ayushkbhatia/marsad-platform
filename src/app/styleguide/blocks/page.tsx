import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Block, IMPLEMENTED_BLOCK_CODES } from "@/components/blocks";
import type { AnyBlockNode } from "@/components/blocks";
import { FAMILY_A, FAMILY_B, FAMILY_C, FAMILY_G, FAMILY_H, FRESH_STATES, PROV_STATES, type Specimen } from "./fixtures";

/**
 * Block library — PD.5 verification surface.
 *
 * Renders every built block against fixture data inside the same card chrome
 * the design handoff uses, so this page can be diffed side-by-side against
 * `docs/design/artifacts/artifact-library-61-blocks.html` at 1440px.
 *
 * The card chrome (header bar, family bar, footer binding rule, in-card
 * annotations) belongs to the LIBRARY, not to the blocks — an article renders
 * the block body alone. It lives here for that reason.
 */
export const metadata: Metadata = {
  title: "Block library — Marsad",
  description: "Story-block renderers (families G, A, C) at production fidelity.",
  robots: { index: false, follow: false },
};

/* ── Card chrome, matched to the artifact ────────────────────────────────── */

function FamilyBar({ label, purpose }: { label: string; purpose: string }) {
  return (
    <div className="mt-[34px] flex items-baseline gap-3 bg-ink px-[18px] py-2.5">
      <span className="font-mono text-[11px] font-semibold tracking-[0.2em] text-paper-tint">{label}</span>
      <span className="text-[12px] text-dark-text-faint">{purpose}</span>
    </div>
  );
}

function Card({
  code,
  title,
  pieceTypes,
  bindingRule,
  annotation,
  children,
}: {
  code: string;
  title: string;
  pieceTypes: string;
  bindingRule: ReactNode;
  annotation?: string;
  children: ReactNode;
}) {
  return (
    <div id={code} className="flex flex-col border border-hairline bg-paper">
      <div className="flex items-baseline gap-[9px] border-b border-hairline bg-paper-tint px-3.5 py-[9px]">
        <span className="font-mono text-[9px] font-semibold tracking-[0.1em] text-ink">{code}</span>
        <span className="text-[11.5px] font-semibold text-ink">{title}</span>
        <span className="ml-auto font-mono text-[8px] text-ink-faint">{pieceTypes}</span>
      </div>
      <div className="flex-1 px-3.5 py-4">
        {children}
        {annotation ? (
          <div className="mt-2.5 font-mono text-[8px] leading-[1.7] text-dark-text-faint">{annotation}</div>
        ) : null}
      </div>
      <div className="border-t border-hairline-faint px-3.5 py-2 font-mono text-[8px] leading-[1.7] tracking-[0.06em] text-ink-faint">
        {bindingRule}
      </div>
    </div>
  );
}

function Grid({ cols, children }: { cols: 2 | 3; children: ReactNode }) {
  return (
    <div className={`mt-4 grid gap-4 ${cols === 3 ? "grid-cols-3" : "grid-cols-2"}`}>{children}</div>
  );
}

function SpecimenCard({ s }: { s: Specimen }) {
  return (
    <Card
      code={s.node.code}
      title={s.title}
      pieceTypes={s.pieceTypes}
      bindingRule={s.bindingRule}
      annotation={s.annotation}
    >
      <Block node={s.node} />
    </Card>
  );
}

/* ── The page ────────────────────────────────────────────────────────────── */

// An intentionally unregistered code: family D is not built (it needs the PD.6
// chart compiler), so this must render the loud non-fatal marker, not throw.
const UNREGISTERED: AnyBlockNode = {
  _key: "demo-missing",
  code: "BLK-WATERFALL",
  payload: {},
};

export default function BlockLibraryPage() {
  return (
    <main className="min-h-screen bg-paper-board px-[34px] py-[34px] text-ink">
      <div className="mx-auto max-w-[1560px]">
        <h1 className="font-display text-[32px] leading-[1.2] font-bold tracking-[-0.016em] text-ink">
          Block library
        </h1>
        <p className="mt-1.5 font-mono text-[9px] tracking-[0.16em] text-ink-faint uppercase">
          {IMPLEMENTED_BLOCK_CODES.length} of 61 built · families G · A · C ·
          verify against docs/design/artifacts/artifact-library-61-blocks.html
        </p>

        <FamilyBar
          label="G · PROVENANCE & TRUST"
          purpose="The family that makes agent-written journalism publishable. Not decoration — the audit trail, rendered."
        />
        <Grid cols={3}>
          <SpecimenCard s={FAMILY_G[0]} />
          <SpecimenCard s={FAMILY_G[1]} />
          <Card
            code="BLK-FRESH"
            title="Freshness badge"
            pieceTypes="ANY LIVE FIGURE"
            bindingRule="SHARED WITH THE READER APP'S FreshnessBadge · NEVER A NUMBER WITHOUT ONE OF THESE FOUR"
          >
            <div className="flex flex-col gap-[7px]">
              {FRESH_STATES.map((n) => (
                <Block key={n._key} node={n} />
              ))}
            </div>
          </Card>
          <SpecimenCard s={FAMILY_G[2]} />
          <SpecimenCard s={FAMILY_G[3]} />
          <SpecimenCard s={FAMILY_G[4]} />
          <Card
            code="BLK-PROV"
            title="Lake object stamp — three statuses"
            pieceTypes="EVERY EXHIBIT"
            bindingRule="GREEN DIAMOND = VERIFIED · INK = DESK COMPUTATION · AMBER = PENDING"
            annotation="A pending stamp with no verification time prints the fields it has and no more — the gap is the point."
          >
            <div className="flex flex-col gap-2">
              {PROV_STATES.map((n) => (
                <Block key={n._key} node={n} />
              ))}
            </div>
          </Card>
          <Card
            code="—"
            title="Unregistered code (not a block)"
            pieceTypes="RENDERER BEHAVIOUR"
            bindingRule="LOUD, LOGGED, NON-FATAL AT RENDER · THE PUBLISHER IS THE THING THAT REFUSES"
            annotation="Family D is not built. The renderer reports and continues; PD.8 refuses to publish."
          >
            <Block node={UNREGISTERED} />
          </Card>
        </Grid>

        <FamilyBar
          label="A · INLINE & SENTENCE-LEVEL"
          purpose="Live inside running prose. No block borders, no vertical margin — they must not break the line rhythm."
        />
        <Grid cols={3}>
          {FAMILY_A.map((s) => (
            <SpecimenCard key={s.node._key} s={s} />
          ))}
        </Grid>

        <FamilyBar
          label="C · TABULAR"
          purpose="Mono numerals, tabular-nums, hairline rows, black header bar. Estimate columns are always marked."
        />
        <Grid cols={2}>
          {FAMILY_C.map((s) => (
            <SpecimenCard key={s.node._key} s={s} />
          ))}
        </Grid>

        <FamilyBar
          label="B · STATEMENT"
          purpose="Where the desk commits to a view. Five of the six are deliberately unbound — a thesis, a quote, a rating and a falsifier are judgements, not data. BLK-BIGNUM is the exception, and it is bound to exactly one lake field."
        />
        <Grid cols={2}>
          {FAMILY_B.map((s) => (
            <SpecimenCard key={s.node._key} s={s} />
          ))}
        </Grid>

        <FamilyBar
          label="H · GATES"
          purpose="The seam between the free read and the wall. Both blocks are presentation: RLS on content_blocks withholds every gated row, so premium copy is never sent to an unentitled reader and then hidden with CSS."
        />
        <Grid cols={2}>
          {FAMILY_H.map((s) => (
            <SpecimenCard key={s.node._key} s={s} />
          ))}
        </Grid>
      </div>
    </main>
  );
}
