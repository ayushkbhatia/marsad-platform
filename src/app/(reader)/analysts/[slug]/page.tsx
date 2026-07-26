import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAnalystProfileBySlug } from "@/lib/data/editorial";
import { loadAnalystProfile } from "@/lib/data/adapters/analysts";
import { AnalystProfile } from "@/components/reader/analysts/AnalystProfile";

/**
 * Analyst Profile (1j) — the one reusable track-record template every 1i
 * leaderboard row routes to. Header + stat strip + a 2-column body
 * (performance chart & coverage table | pinned call, published research,
 * disclosure).
 *
 * TEMPLATE COLLAPSE, FIXED (build-plan step **P3.5**). Every `[slug]` used to
 * render one baked sample profile (Noor Al-Suwaidi), so any URL answered with a
 * fabricated person's fabricated track record — wrong canonicals, duplicate
 * content, and invented investment calls on real listed companies presented as
 * a real public record. The slug is now resolved against
 * `public.v_analysts_public` **before anything renders** and a miss is
 * `notFound()`. Owner ruling 2026-07-27: no fictional analysts are seeded, so
 * `analysts` is 0 rows and EVERY slug is a miss today — by data, not by
 * construction. The mapping is fixture-tested
 * (`adapters/__tests__/analysts.test.ts`) and lights up with no further
 * front-end change once the roster is onboarded.
 *
 * NO `generateStaticParams` HERE, DELIBERATELY. The old one enumerated the six
 * fabricated desk slugs; with a 0-row roster a real one would return an empty
 * array, which under Cache Components is a hard build error ("all
 * `generateStaticParams` functions must return at least one result"). Add one
 * over the roster when analysts land — that also puts this segment on the
 * prerender path that lets `notFound()` answer with a real 404 STATUS, which a
 * page-level `notFound()` cannot do while the segment is fully dynamic (the
 * app-wide caveat documented on `/ipo/[offerSlug]`).
 */
type Params = { slug: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  // Uses `getAnalystProfileBySlug`, NOT `loadAnalystProfile`. `generateMetadata`
  // runs outside any <Suspense> boundary, so it may only touch data
  // cacheComponents recognises as cached. `getAnalystProfileBySlug` declares
  // `use cache` + `cacheLife` + `cacheTag`; `loadAnalystProfile` resolves its
  // reads through a dynamic import and is NOT recognised, which made
  // `next build` fail with a hard `blocking-route` error.
  const detail = await getAnalystProfileBySlug(slug);
  if (!detail) return { title: "Analyst not found" };

  const name = detail.displayName ?? detail.slug;
  return {
    title: `${name} — Coverage Desk`,
    description:
      detail.credential ??
      `${name}'s Marsad coverage — every call timestamped and scored against its venue index.`,
  };
}

export default async function AnalystProfilePage({ params }: { params: Promise<Params> }) {
  // ⚠️ `params` IS NOT AWAITED HERE, and that is load-bearing.
  //
  // On a segment with no `generateStaticParams`, `params` is itself uncached
  // dynamic data — so `await params` in the page body is exactly the
  // "Uncached data was accessed outside of <Suspense>" hard ERROR that fails
  // `next build` (verified with `--debug-prerender`: it points at this line, not
  // at any DB read). The promise is therefore handed to the Suspense child and
  // awaited in there.
  //
  // Consequence, accepted: the 404 STATUS cannot be decided before the shell
  // streams, so an unknown slug serves the not-found UI with a 200 — the same
  // caveat as the other detail routes under DEF-NOTFOUND-STATUS. A non-empty
  // `generateStaticParams` would fix both at once, but `public.analysts` is 0
  // rows and Cache Components rejects an empty set. Revisit when the roster lands.
  return (
    <div className="bg-paper">
      <div className="mx-auto max-w-[1440px] px-7 pt-[22px] pb-[30px]">
        <Suspense fallback={<ProfileFallback />}>
          <ProfileBody params={params} />
        </Suspense>
      </div>
    </div>
  );
}

async function ProfileBody({ params }: { params: Promise<Params> }) {
  // `params` is awaited HERE, inside the boundary — see the note in the page body.
  const { slug } = await params;
  const exists = await getAnalystProfileBySlug(slug);
  if (!exists) notFound();

  const profile = await loadAnalystProfile(slug);
  if (!profile) notFound();
  return <AnalystProfile profile={profile} />;
}

function ProfileFallback() {
  return (
    <div>
      <div className="h-16 w-full animate-pulse bg-hairline-soft" />
      <div className="mt-5 grid grid-cols-1 gap-[30px] lg:grid-cols-[1fr_360px]">
        <div className="h-80 w-full animate-pulse bg-hairline-soft" />
        <div className="h-80 w-full animate-pulse bg-hairline-soft" />
      </div>
    </div>
  );
}
