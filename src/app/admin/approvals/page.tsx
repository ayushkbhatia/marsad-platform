import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { listApprovals } from "@/lib/desk/approvals";

export const metadata: Metadata = {
  title: "Desk — approval queue",
  description: "Agent-drafted pieces awaiting an owner decision.",
};

// Live queue — never cache. Under cacheComponents the request-time read runs
// inside a <Suspense> boundary (see default export) so the route prerenders a
// static shell and streams the queue.

function ago(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return hrs < 24 ? `${hrs}h ago` : `${Math.floor(hrs / 24)}d ago`;
}

const TH = "px-3 py-1.5 text-left font-ui text-[11px] font-semibold uppercase tracking-wide text-ink-muted";
const TD = "px-3 py-2 font-mono text-[13px] text-ink-mid";

export default function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ err?: string; done?: string }>;
}) {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-paper-tint px-6 py-8 sm:px-10">
          <h1 className="font-display text-2xl font-semibold text-ink">Approval queue</h1>
          <p className="mt-2 font-mono text-[13px] text-ink-faint">Loading queue…</p>
        </main>
      }
    >
      <ApprovalsBody searchParams={searchParams} />
    </Suspense>
  );
}

async function ApprovalsBody({
  searchParams,
}: {
  searchParams: Promise<{ err?: string; done?: string }>;
}) {
  const { err, done } = await searchParams;
  let rows: Awaited<ReturnType<typeof listApprovals>> = [];
  let loadError: string | null = null;
  try {
    rows = await listApprovals();
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
  }

  return (
    <main className="min-h-screen bg-paper-tint px-6 py-8 sm:px-10">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-semibold text-ink">Approval queue</h1>
        <p className="mt-1 font-ui text-sm text-ink-muted">
          Agent-drafted pieces awaiting a decision. Deciding as{" "}
          <span className="font-mono text-ink-mid">DESK-OWNER</span> (interim, behind /admin gate).
        </p>
      </header>

      {done ? (
        <div className="mb-4 rounded-sm bg-positive/10 px-3 py-2 font-mono text-[13px] text-positive">
          decision recorded — {done}
        </div>
      ) : null}
      {err ? (
        <div className="mb-4 rounded-sm bg-negative/10 px-3 py-2 font-mono text-[13px] text-negative">
          {err}
        </div>
      ) : null}

      {loadError ? (
        <pre className="max-w-2xl whitespace-pre-wrap rounded-sm bg-negative/10 p-4 font-mono text-sm text-negative">
          {loadError}
        </pre>
      ) : rows.length === 0 ? (
        <div className="rounded-sm border border-dashed border-hairline px-4 py-10 text-center font-ui text-sm text-ink-faint">
          Queue empty — nothing awaiting approval.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-hairline">
                <th className={TH}>Headline</th>
                <th className={TH}>Ticker</th>
                <th className={TH}>Template</th>
                <th className={`${TH} text-right`}>Words</th>
                <th className={`${TH} text-right`}>Cites</th>
                <th className={TH}>Rules</th>
                <th className={TH}>Waiting</th>
                <th className={TH}>SLA</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.item_id} className="border-b border-hairline-soft hover:bg-paper">
                  <td className={`${TD} max-w-md`}>
                    <Link href={`/admin/approvals/${r.item_id}`} className="font-ui font-medium text-ink underline-offset-2 hover:underline">
                      {r.headline}
                    </Link>
                    {r.is_premium ? <span className="ml-2 rounded-sm bg-ink/10 px-1 py-0.5 text-[10px] font-semibold uppercase text-ink-muted">premium</span> : null}
                  </td>
                  <td className={`${TD} font-semibold text-ink`}>{r.ticker ?? "—"}<span className="ml-1 text-ink-faint">{r.venue_code ?? ""}</span></td>
                  <td className={TD}>{r.template_key ?? "—"}</td>
                  <td className={`${TD} text-right tabular-nums`}>{r.word_count ?? "—"}</td>
                  <td className={`${TD} text-right tabular-nums`}>{r.citation_count}</td>
                  <td className={TD}>
                    {r.rules_stale ? (
                      <span className="rounded-sm bg-negative/10 px-1.5 py-0.5 text-[11px] font-medium text-negative">stale v{r.rules_passed_version ?? "—"}</span>
                    ) : (
                      <span className="text-[11px] text-positive">passed v{r.rules_passed_version}</span>
                    )}
                    {r.warn_count > 0 ? <span className="ml-1 text-[11px] text-ink-faint">· {r.warn_count} warn</span> : null}
                  </td>
                  <td className={`${TD} text-ink-faint`}>{ago(r.stage_entered_at)}</td>
                  <td className={TD}>
                    {r.sla_breached_at ? (
                      <span className="rounded-sm bg-negative/10 px-1.5 py-0.5 text-[11px] font-medium text-negative">BREACHED</span>
                    ) : r.sla_over ? (
                      <span className="text-[11px] text-negative">over</span>
                    ) : (
                      <span className="text-[11px] text-ink-faint">ok</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
