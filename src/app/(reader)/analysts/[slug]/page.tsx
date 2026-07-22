import type { Metadata } from "next";
import { SAMPLE_PROFILE, COVERAGE_DESK } from "@/lib/data/sample/analysts";
import { AnalystProfile } from "@/components/reader/analysts/AnalystProfile";

/**
 * Analyst Profile (1j) — the one reusable track-record template every 1i
 * leaderboard row routes to. Header + stat strip + a 2-column body
 * (performance chart & coverage table | pinned call, published research,
 * disclosure).
 *
 * Content is SAMPLE / PLACEHOLDER (`src/lib/data/sample/analysts.ts`). For the
 * fidelity pass EVERY slug renders the single fully-resolved `SAMPLE_PROFILE`
 * (Noor Al-Suwaidi) — the one profile the design bakes end-to-end — since 1j
 * is a layout, not a one-off. Real per-analyst content (`getAnalystProfileBySlug`
 * is a stub today: `public.analysts` carries no `slug`/`display_name` anon can
 * read) re-wires by mapping onto the `AnalystProfile` view-model and swapping
 * the sample (DEF-ANALYSTS-LIVE-DATA). Fully static — the six desk slugs
 * prerender via `generateStaticParams`; any other slug renders the template on
 * demand.
 */
export function generateStaticParams(): Array<{ slug: string }> {
  return COVERAGE_DESK.analysts.map((a) => ({ slug: a.slug }));
}

export const metadata: Metadata = {
  title: `${SAMPLE_PROFILE.name} — Coverage Desk`,
  description: SAMPLE_PROFILE.credential,
};

export default function AnalystProfilePage() {
  return (
    <div className="bg-paper">
      <div className="mx-auto max-w-[1440px] px-7 pt-[22px] pb-[30px]">
        <AnalystProfile profile={SAMPLE_PROFILE} />
      </div>
    </div>
  );
}
