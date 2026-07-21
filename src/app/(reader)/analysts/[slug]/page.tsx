import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { getAnalystProfileBySlug } from "@/lib/data/editorial";
import { EmptyState } from "@/components/ui";

/**
 * Analyst profile (1j) — awaiting-feed shell. `public.analysts` has no
 * `slug`/`display_name` column at all (only `principal_id -> iam.principals`,
 * which anon cannot read — see `src/lib/data/editorial.ts` header), so no
 * analyst profile can be resolved by URL today regardless of row count. This
 * is the same "whole tier not launched yet" situation as `ipo/[offerSlug]` —
 * every slug renders `EmptyState awaitingFeed`, not `notFound()`, because the
 * surface itself is pre-launch rather than one bad URL.
 *
 * No `generateStaticParams` — there is nothing to enumerate yet.
 */

type Params = { slug: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Analyst · ${slug}` };
}

export default function AnalystProfilePage({ params }: { params: Promise<Params> }) {
  return (
    <div className="mx-auto max-w-[860px] px-5 py-14 sm:px-8">
      <Suspense fallback={<div className="h-72 animate-pulse bg-hairline-soft" />}>
        <ProfileBody params={params} />
      </Suspense>
    </div>
  );
}

async function ProfileBody({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  // Always null today (see header) — kept as a real call so the eventual
  // implementation is a one-place change once analysts get a public slug.
  const profile = await getAnalystProfileBySlug(slug);

  if (!profile) {
    return (
      <EmptyState
        variant="awaitingFeed"
        title="Analyst profiles aren't published yet"
        body="The Coverage Desk hasn't onboarded any analysts. Once it does, this page will show the analyst's bio, track record and published research."
        action={
          <Link
            href="/analysts"
            className="border border-ink px-4 py-2 font-ui text-[11.5px] font-semibold text-ink hover:bg-paper-tint"
          >
            ← Back to the Coverage Desk
          </Link>
        }
      />
    );
  }

  // Unreachable until getAnalystProfileBySlug resolves a real row — this
  // never renders today.
  return null;
}
