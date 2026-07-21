import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { DeskTopBar } from "@/components/admin/DeskTopBar";
import { SectionBar, StatStrip, EmptyState, FreshnessBadge, type StatItem } from "@/components/ui";
import { toBadgeState } from "@/lib/market/freshness";
import { listApprovals, type ApprovalRow } from "@/lib/desk/approvals";
import {
  getFeedHealth,
  getContentItems,
  getLakeObjectThroughput,
  getLakeGaps,
  ago,
  hhmm,
  type FeedHealthRow,
  type ContentItemRow,
} from "@/lib/data/desk";

export const metadata: Metadata = { title: "Dashboard" };

// Live operator screen — the request-time reads live inside <DashboardBody>,
// wrapped in <Suspense> below, per CONVENTIONS §3 (static shell, dynamic
// child). Mirrors admin/lake/page.tsx and admin/approvals/page.tsx.

export default function DeskDashboardPage() {
  return (
    <>
      <DeskTopBar crumbs={["DESK", "DASHBOARD"]} />
      <Suspense fallback={<DashboardSkeleton />}>
        <DashboardBody />
      </Suspense>
    </>
  );
}

function DashboardSkeleton() {
  return (
    <main className="flex-1 px-[26px] py-5">
      <p className="font-mono text-[13px] text-ink-faint">Loading the desk…</p>
    </main>
  );
}

const FEED_ISSUE_STATES = new Set(["reconnecting", "delayed", "offline", "halted"]);

function StatusPill({ status }: { status: string }) {
  const s = status.toLowerCase();
  if (s === "live")
    return (
      <span className="flex-none bg-ink px-[6px] py-[2px] font-mono text-[8px] font-semibold text-paper-tint">
        LIVE
      </span>
    );
  if (s === "scheduled")
    return (
      <span className="flex-none border border-ink px-[5px] py-px font-mono text-[8px] font-semibold text-ink">
        SCHEDULED
      </span>
    );
  return (
    <span className="flex-none border border-hairline-strong px-[5px] py-px font-mono text-[8px] font-semibold uppercase text-ink-muted">
      {s}
    </span>
  );
}

async function DashboardBody() {
  await connection();

  const [approvalsRes, feedRes, contentRes, throughputRes, gapsRes] = await Promise.allSettled([
    listApprovals(),
    getFeedHealth(),
    getContentItems(12),
    getLakeObjectThroughput(),
    getLakeGaps(),
  ]);

  const approvals: ApprovalRow[] = approvalsRes.status === "fulfilled" ? approvalsRes.value : [];
  const feed: FeedHealthRow[] = feedRes.status === "fulfilled" ? feedRes.value : [];
  const content: ContentItemRow[] = contentRes.status === "fulfilled" ? contentRes.value : [];
  const throughput = throughputRes.status === "fulfilled" ? throughputRes.value : [];
  const gaps = gapsRes.status === "fulfilled" ? gapsRes.value : [];

  const feedIssues = feed.filter((f) => FEED_ISSUE_STATES.has(f.state));
  const slaBreached = approvals.filter((a) => a.sla_over || a.sla_breached_at);
  const objectsAdded24h = throughput.reduce((sum, r) => sum + r.n24h, 0);
  const flaggedGaps = gaps.filter((g) => g.objectStale || g.noRawTrail || g.stalledExtract);

  const stats: StatItem[] = [
    { label: "Awaiting approval", value: String(approvals.length) },
    {
      label: "SLA breached",
      value: String(slaBreached.length),
      delta: slaBreached.length > 0 ? "over SLA" : undefined,
      dir: slaBreached.length > 0 ? "down" : undefined,
    },
    {
      label: "Feed issues",
      value: `${feedIssues.length}/${feed.length || 6}`,
      delta: feedIssues.length > 0 ? "needs a look" : undefined,
      dir: feedIssues.length > 0 ? "down" : undefined,
    },
    { label: "Objects added · 24h", value: objectsAdded24h.toLocaleString("en-US") },
    { label: "Lake gaps flagged", value: String(flaggedGaps.length) },
  ];

  type AttentionRow = { key: string; text: string; detail?: string; href: string; hrefLabel: string };
  const attention: AttentionRow[] = [
    ...feedIssues.map((f) => ({
      key: `feed-${f.venueCode}`,
      text: `${f.venueCode} feed ${f.state}`,
      detail: f.detail ?? `since ${ago(f.updatedAt)}`,
      href: "/admin/ops",
      hrefLabel: "DATA DESK",
    })),
    ...slaBreached.map((a) => ({
      key: `sla-${a.item_id}`,
      text: a.headline,
      detail: `waiting ${ago(a.stage_entered_at)} — approval SLA breached`,
      href: `/admin/approvals/${a.item_id}`,
      hrefLabel: "APPROVALS",
    })),
    ...flaggedGaps.map((g) => ({
      key: `gap-${g.venueCode}`,
      text: `${g.venueCode ?? "?"} lake gap`,
      detail: [
        g.objectStale ? "object stale" : null,
        g.noRawTrail ? "no raw trail" : null,
        g.stalledExtract ? "stalled extract" : null,
      ]
        .filter(Boolean)
        .join(" · "),
      href: "/admin/lake",
      hrefLabel: "DATA LAKE",
    })),
  ];

  const schedule = [...content].sort((a, b) => {
    const ta = a.scheduledAt ?? a.publishedAt ?? a.dueAt ?? a.createdAt;
    const tb = b.scheduledAt ?? b.publishedAt ?? b.dueAt ?? b.createdAt;
    return new Date(ta).getTime() - new Date(tb).getTime();
  });

  return (
    <main className="flex-1 px-[26px] py-5">
      <header className="flex items-baseline gap-3.5 border-b-2 border-ink pb-3">
        <h1 className="font-display text-[26px] font-bold text-ink">The desk</h1>
        <span className="font-ui text-[12px] text-ink-muted">
          {approvals.length > 0
            ? `${approvals.length} piece${approvals.length > 1 ? "s" : ""} waiting on your decision`
            : "Queue is clear"}
        </span>
      </header>

      <StatStrip items={stats} className="mt-4" />

      <div className="mt-5 grid grid-cols-1 gap-7 xl:grid-cols-[1fr_300px]">
        <div>
          <SectionBar label="Needs attention" right={<span>{attention.length} items</span>} />
          {attention.length === 0 ? (
            <EmptyState variant="empty" title="Nothing needs attention right now." />
          ) : (
            <ul>
              {attention.map((row) => (
                <li
                  key={row.key}
                  className="flex items-center gap-[11px] border-b border-hairline-faint px-3 py-[10px]"
                >
                  <span className="h-[7px] w-[7px] flex-none rotate-45 bg-ink" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="font-ui text-[12.5px] font-semibold text-ink">{row.text}</span>
                    {row.detail ? (
                      <span className="font-ui text-[11px] text-ink-muted"> — {row.detail}</span>
                    ) : null}
                  </span>
                  <Link
                    href={row.href}
                    className="flex-none font-mono text-[8.5px] tracking-[0.08em] text-ink-muted underline-offset-2 hover:underline"
                  >
                    {row.hrefLabel} →
                  </Link>
                </li>
              ))}
            </ul>
          )}

          <SectionBar label="Today's publishing schedule" className="mt-4" />
          {schedule.length === 0 ? (
            <EmptyState variant="awaitingFeed" title="No content items yet." className="mt-0" />
          ) : (
            <ul>
              {schedule.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center gap-3 border-b border-hairline-faint px-3 py-[9px]"
                >
                  <span className="w-11 flex-none font-mono text-[10px] text-ink-muted">
                    {hhmm(c.scheduledAt ?? c.publishedAt ?? c.dueAt ?? c.createdAt)}
                  </span>
                  <StatusPill status={c.status} />
                  <span className="min-w-0 flex-1 truncate font-ui text-[12px] text-ink">{c.headline}</span>
                  <span className="flex-none font-mono text-[9px] text-ink-faint">
                    {c.contentType}
                    {c.templateKey ? ` · ${c.templateKey}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <SectionBar label="Feed health" right={<span>{feed.length} venues</span>} className="mt-4" />
          <div className="grid grid-cols-3 border-b border-l border-hairline sm:grid-cols-6">
            {feed.map((f) => (
              <div key={f.venueCode} className="border-r border-t border-hairline px-3 py-[10px]">
                <div className="font-mono text-[9px] font-semibold text-ink">{f.venueCode}</div>
                <div className="mt-1.5">
                  <FreshnessBadge state={toBadgeState(f.state)} detail={f.detail ?? undefined} />
                </div>
                <div className="mt-1.5 font-mono text-[8px] text-ink-faint">
                  {f.latencyMs != null ? `${f.latencyMs}MS` : ago(f.lastSyncAt).toUpperCase()}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="border border-ink bg-paper px-[15px] py-[13px]">
            <div className="flex items-center gap-[7px]">
              <span className="h-[7px] w-[7px] flex-none rotate-45 bg-caution" aria-hidden />
              <span className="font-mono text-[8.5px] font-semibold tracking-[0.14em] text-ink">
                AWAITING YOUR APPROVAL · {approvals.length}
              </span>
            </div>
            {approvals.length === 0 ? (
              <p className="mt-2.5 font-ui text-[12px] text-ink-faint">Nothing in the queue.</p>
            ) : (
              approvals.slice(0, 4).map((a, i) => (
                <Link
                  key={a.item_id}
                  href={`/admin/approvals/${a.item_id}`}
                  className={`block py-2 ${i < approvals.length - 1 ? "border-b border-hairline-faint" : ""} text-ink no-underline`}
                >
                  <div className="font-ui text-[12px] font-semibold">{a.headline}</div>
                  <div
                    className={`mt-[3px] font-mono text-[8px] ${a.sla_over ? "text-negative" : "text-ink-faint"}`}
                  >
                    {a.ticker ? `${a.ticker} · ` : ""}
                    {a.template_key ?? "no template"} · {ago(a.stage_entered_at)} in queue
                    {a.sla_over ? " · SLA over" : ""}
                  </div>
                </Link>
              ))
            )}
            <Link
              href="/admin/approvals"
              className="mt-1.5 inline-block bg-ink px-3 py-[7px] font-ui text-[10px] font-bold uppercase tracking-[0.06em] text-paper no-underline"
            >
              Review queue →
            </Link>
          </div>

          <div className="mt-4 border border-dark-hairline bg-dark-bg px-4 py-3.5">
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-positive-dark" />
              <span className="font-mono text-[8px] tracking-[0.14em] text-dark-text-faint">
                LIVE NOW · TOP PAGES
              </span>
            </div>
            <EmptyState
              surface="dark"
              variant="awaitingFeed"
              title="Analytics not wired yet."
              body="analytics.events has no public (PostgREST) wrapper — flagged for a migration."
              className="mt-2"
            />
          </div>

          <div className="mt-4">
            <div className="border-b-2 border-ink pb-[7px] font-ui text-[10px] font-bold uppercase tracking-[0.18em] text-ink">
              Quick links
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Link
                href="/admin/approvals"
                className="border border-ink py-[10px] text-center font-ui text-[11px] font-semibold text-ink no-underline"
              >
                Approvals
              </Link>
              <Link
                href="/admin/agents"
                className="border border-ink py-[10px] text-center font-ui text-[11px] font-semibold text-ink no-underline"
              >
                Agents
              </Link>
              <Link
                href="/admin/lake"
                className="border border-hairline-strong py-[10px] text-center font-ui text-[11px] font-semibold text-ink-muted no-underline"
              >
                Data lake
              </Link>
              <Link
                href="/admin/ops"
                className="border border-hairline-strong py-[10px] text-center font-ui text-[11px] font-semibold text-ink-muted no-underline"
              >
                Market ops
              </Link>
            </div>
          </div>

          <div className="mt-4">
            <div className="border-b-2 border-ink pb-[7px] font-ui text-[10px] font-bold uppercase tracking-[0.18em] text-ink">
              Audit tail
            </div>
            <EmptyState
              variant="awaitingFeed"
              title="Audit log not wired yet."
              body="ops.audit_log has no public wrapper (02-data-lake.md locks PostgREST to public, graphql_public) — flagged for a migration, same pattern as v_desk_approvals."
            />
          </div>
        </div>
      </div>
    </main>
  );
}
