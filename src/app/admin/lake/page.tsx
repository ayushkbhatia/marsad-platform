import { Suspense } from "react";
import { connection } from "next/server";
import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/server-admin";

export const metadata: Metadata = {
  title: "Data Lake — landing visibility",
  description: "What's landing in storage + the datalake, per layer / venue / bucket.",
};

// Live ops view — never cache. Under cacheComponents, pages are dynamic by
// default; the request-time DB read lives in a <Suspense> boundary below so
// the route has a static shell and streams the live table.

type RecentRow = {
  layer: string;
  venue_code: string | null;
  n_1h: number;
  n_24h: number;
  n_7d: number;
  latest: string | null;
  age: string | null;
};
type StorageRow = {
  bucket: string;
  files: number;
  size_pretty: string | null;
  files_1h: number;
  files_24h: number;
  latest: string | null;
  age: string | null;
};
type TypeRow = {
  object_type: string;
  venue_code: string | null;
  n_24h: number;
  n_7d: number;
  latest: string | null;
};
type GapRow = {
  venue_code: string | null;
  snapshot_latest: string | null;
  staging_latest: string | null;
  object_latest: string | null;
  untracked_fetched_24h: number;
  object_stale: boolean;
  no_raw_trail: boolean;
  stalled_extract: boolean;
};

const num = (n: number | null | undefined) => (n ?? 0).toLocaleString("en-US");

function ago(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function Flag({ on, label }: { on: boolean; label: string }) {
  return on ? (
    <span className="rounded-sm bg-negative/10 px-1.5 py-0.5 font-mono text-[11px] font-medium text-negative">
      {label}
    </span>
  ) : (
    <span className="font-mono text-[11px] text-ink-faint">ok</span>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <div className="mb-2 flex items-baseline justify-between border-b border-hairline pb-1.5">
        <h2 className="font-display text-lg font-semibold text-ink">{title}</h2>
        {hint ? <span className="font-mono text-[11px] text-ink-faint">{hint}</span> : null}
      </div>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

const TH = "px-3 py-1.5 text-left font-ui text-[11px] font-semibold uppercase tracking-wide text-ink-muted";
const TD = "px-3 py-1.5 font-mono text-[13px] text-ink-mid tabular-nums";

export default function LakeLandingPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-paper-tint px-6 py-8 sm:px-10">
          <h1 className="font-display text-2xl font-semibold text-ink">
            Data Lake — landing visibility
          </h1>
          <p className="mt-2 font-mono text-[13px] text-ink-faint">Loading live landing…</p>
        </main>
      }
    >
      <LakeLandingBody />
    </Suspense>
  );
}

async function LakeLandingBody() {
  // MUST be dynamic. This page reads with the SERVICE-ROLE client, so it must
  // never be prerendered: (a) a service-role snapshot baked into a static page
  // would ship privileged data to the CDN, and (b) it made the production build
  // depend on SUPABASE_SERVICE_ROLE_KEY being present at BUILD time, which hard
  // -failed `next build` wherever that key is runtime-only. Same posture as the
  // sibling admin pages (`admin/page.tsx`, `admin/ops/page.tsx`).
  await connection();
  const sb = createAdminClient();
  const [recent, storage, types, gaps] = await Promise.all([
    sb.from("v_lake_landing_recent").select("*"),
    sb.from("v_lake_landing_storage").select("*"),
    sb.from("v_lake_landing_types").select("*"),
    sb.from("v_lake_landing_gaps").select("*"),
  ]);

  const firstError = recent.error || storage.error || types.error || gaps.error;
  if (firstError) {
    return (
      <main className="min-h-screen bg-paper-tint p-8">
        <h1 className="font-display text-2xl font-semibold text-ink">Data Lake — landing</h1>
        <pre className="mt-4 max-w-2xl whitespace-pre-wrap rounded-sm bg-negative/10 p-4 font-mono text-sm text-negative">
          {firstError.message}
        </pre>
      </main>
    );
  }

  const recentRows = (recent.data ?? []) as RecentRow[];
  const storageRows = (storage.data ?? []) as StorageRow[];
  const typeRows = (types.data ?? []) as TypeRow[];
  const gapRows = (gaps.data ?? []) as GapRow[];

  const layerLabel: Record<string, string> = {
    snapshots: "1 · snapshots (raw fetch)",
    staging_rows: "2 · staging (extracted)",
    objects: "3 · objects (canonical)",
  };

  return (
    <main className="min-h-screen bg-paper-tint px-6 py-8 sm:px-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-semibold text-ink">Data Lake — landing visibility</h1>
        <p className="mt-1 font-ui text-sm text-ink-muted">
          What&apos;s landing in Storage + the datalake, live. Rendered at request time.
        </p>
      </header>

      <Section title="Pipeline health" hint="per venue · 24h window">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-hairline">
              <th className={TH}>Venue</th>
              <th className={TH}>Snapshot</th>
              <th className={TH}>Staging</th>
              <th className={TH}>Object</th>
              <th className={TH}>Untracked 24h</th>
              <th className={TH}>Object stale</th>
              <th className={TH}>No raw trail</th>
              <th className={TH}>Stalled extract</th>
            </tr>
          </thead>
          <tbody>
            {gapRows.map((r) => (
              <tr key={r.venue_code ?? "?"} className="border-b border-hairline-soft">
                <td className={`${TD} font-semibold text-ink`}>{r.venue_code}</td>
                <td className={TD}>{ago(r.snapshot_latest)}</td>
                <td className={TD}>{ago(r.staging_latest)}</td>
                <td className={TD}>{ago(r.object_latest)}</td>
                <td className={TD}>{num(r.untracked_fetched_24h)}</td>
                <td className={TD}><Flag on={r.object_stale} label="stale" /></td>
                <td className={TD}><Flag on={r.no_raw_trail} label="no-trail" /></td>
                <td className={TD}><Flag on={r.stalled_extract} label="stalled" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Throughput" hint="rows landed per layer × venue">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-hairline">
              <th className={TH}>Layer</th>
              <th className={TH}>Venue</th>
              <th className={`${TH} text-right`}>1h</th>
              <th className={`${TH} text-right`}>24h</th>
              <th className={`${TH} text-right`}>7d</th>
              <th className={TH}>Latest</th>
            </tr>
          </thead>
          <tbody>
            {recentRows.map((r, i) => (
              <tr key={`${r.layer}-${r.venue_code}-${i}`} className="border-b border-hairline-soft">
                <td className={`${TD} text-ink-muted`}>{layerLabel[r.layer] ?? r.layer}</td>
                <td className={`${TD} font-semibold text-ink`}>{r.venue_code}</td>
                <td className={`${TD} text-right`}>{num(r.n_1h)}</td>
                <td className={`${TD} text-right`}>{num(r.n_24h)}</td>
                <td className={`${TD} text-right`}>{num(r.n_7d)}</td>
                <td className={`${TD} text-ink-faint`}>{ago(r.latest)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Storage buckets">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-hairline">
              <th className={TH}>Bucket</th>
              <th className={`${TH} text-right`}>Files</th>
              <th className={`${TH} text-right`}>Size</th>
              <th className={`${TH} text-right`}>1h</th>
              <th className={`${TH} text-right`}>24h</th>
              <th className={TH}>Latest</th>
            </tr>
          </thead>
          <tbody>
            {storageRows.map((r) => (
              <tr key={r.bucket} className="border-b border-hairline-soft">
                <td className={`${TD} font-semibold text-ink`}>{r.bucket}</td>
                <td className={`${TD} text-right`}>{num(r.files)}</td>
                <td className={`${TD} text-right`}>{r.size_pretty ?? "—"}</td>
                <td className={`${TD} text-right`}>{num(r.files_1h)}</td>
                <td className={`${TD} text-right`}>{num(r.files_24h)}</td>
                <td className={`${TD} text-ink-faint`}>{ago(r.latest)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Object mix" hint="canonical object_type × venue · last 7d">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-hairline">
              <th className={TH}>Object type</th>
              <th className={TH}>Venue</th>
              <th className={`${TH} text-right`}>24h</th>
              <th className={`${TH} text-right`}>7d</th>
              <th className={TH}>Latest</th>
            </tr>
          </thead>
          <tbody>
            {typeRows.map((r, i) => (
              <tr key={`${r.object_type}-${r.venue_code}-${i}`} className="border-b border-hairline-soft">
                <td className={`${TD} text-ink`}>{r.object_type}</td>
                <td className={`${TD} font-semibold text-ink`}>{r.venue_code}</td>
                <td className={`${TD} text-right`}>{num(r.n_24h)}</td>
                <td className={`${TD} text-right`}>{num(r.n_7d)}</td>
                <td className={`${TD} text-ink-faint`}>{ago(r.latest)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </main>
  );
}
