import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { DeskTopBar } from "@/components/admin/DeskTopBar";
import { DataGapNotice } from "@/components/admin/DataGapNotice";
import { SectionBar, StatStrip, EmptyState, type StatItem } from "@/components/ui";
import { listApprovals, type ApprovalRow } from "@/lib/desk/approvals";
import { getContentItems, ago, type ContentItemRow } from "@/lib/data/desk";

export const metadata: Metadata = { title: "Agents" };

// Live operator screen — see admin/page.tsx for the shell/Suspense pattern
// this mirrors.

export default function AgentsConsolePage() {
  return (
    <>
      <DeskTopBar crumbs={["DESK", "AGENTS"]} />
      <Suspense fallback={<AgentsSkeleton />}>
        <AgentsBody />
      </Suspense>
    </>
  );
}

function AgentsSkeleton() {
  return (
    <main className="flex-1 px-[26px] py-5">
      <p className="font-mono text-[13px] text-ink-faint">Loading agent operations…</p>
    </main>
  );
}

function StatusChip({ status }: { status: string }) {
  const s = status.toLowerCase();
  const tone =
    s === "live"
      ? "bg-ink text-paper-tint"
      : s === "approval"
        ? "border border-ink text-ink"
        : "border border-hairline-strong text-ink-muted";
  return (
    <span className={`flex-none px-[6px] py-[2px] font-mono text-[8px] font-semibold uppercase ${tone}`}>
      {s}
    </span>
  );
}

async function AgentsBody() {
  await connection();

  const [approvalsRes, contentRes] = await Promise.allSettled([listApprovals(), getContentItems(30)]);
  const approvals: ApprovalRow[] = approvalsRes.status === "fulfilled" ? approvalsRes.value : [];
  const content: ContentItemRow[] = contentRes.status === "fulfilled" ? contentRes.value : [];
  const inPipeline = content.filter((c) => c.status.toLowerCase() !== "live");

  const stats: StatItem[] = [
    { label: "Agents online", value: "—" },
    { label: "Runs today", value: "—" },
    { label: "Content in pipeline", value: String(inPipeline.length) },
    { label: "Awaiting approval", value: String(approvals.length) },
    { label: "Failures · 24h", value: "—" },
    { label: "Lake → live median", value: "—" },
  ];

  return (
    <main className="flex-1 px-[26px] py-5">
      <header className="flex items-baseline gap-3.5 border-b-2 border-ink pb-3">
        <h1 className="font-display text-[26px] font-bold text-ink">Agent operations</h1>
        <span className="font-ui text-[12px] text-ink-muted">
          Data → Writer → Design &amp; Publishing → your approval
        </span>
        <span className="ml-auto flex-none border border-hairline-strong px-3 py-[7px] font-mono text-[10px] text-ink-faint">
          BREAK-GLASS STATE UNKNOWN
        </span>
      </header>

      <StatStrip items={stats} className="mt-4" />
      <p className="mt-2 font-mono text-[9.5px] leading-relaxed text-ink-faint">
        “—” = not readable from this app runtime today (see the migration notice below), not zero.
      </p>

      <div className="mt-5 grid grid-cols-1 gap-7 xl:grid-cols-[1fr_300px]">
        <div>
          <SectionBar label="Fleet — DATA / WRITER / DESIGN &amp; PUBLISHING" />
          <DataGapNotice
            className="mt-0"
            note="Per-agent fleet state (online/idle/erroring, current task, owner, kill switch) needs the identity + agent tables."
            tables={["iam.principals", "iam.agent_accounts", "iam.global_switches"]}
          />

          <SectionBar
            label="Content in the pipeline"
            right={<span>{inPipeline.length} not yet live</span>}
            className="mt-5"
          />
          <p className="mt-1.5 mb-1 font-mono text-[9px] leading-relaxed text-ink-faint">
            Coarse view from public.content_items.status — the design&apos;s per-stage bar
            (DRAFT → EDIT → RULES → APPROVAL with writer/editor attribution) needs ops.pipeline_items.
          </p>
          {inPipeline.length === 0 ? (
            <EmptyState variant="awaitingFeed" title="Nothing in the content pipeline right now." />
          ) : (
            <ul>
              {inPipeline.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center gap-[10px] border-b border-hairline-faint px-3 py-[9px]"
                >
                  <span className="min-w-0 flex-1 truncate font-ui text-[12px] font-semibold text-ink">
                    {c.headline}
                  </span>
                  <StatusChip status={c.status} />
                  <span className="w-16 flex-none text-right font-mono text-[9px] text-ink-muted">
                    {c.templateKey ?? "—"}
                  </span>
                  <span className="w-14 flex-none text-right font-mono text-[9px] text-ink-faint">
                    {ago(c.updatedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <SectionBar label="Error queue" className="mt-5" />
          <DataGapNotice
            className="mt-0"
            note="Retry / mute / reassign-to-human actions read agent failure history."
            tables={["ops.agent_errors"]}
          />

          <SectionBar label="Run log · live" className="mt-5" />
          <DataGapNotice className="mt-0" note="The agent audit stream." tables={["ops.agent_runs"]} />
        </div>

        <div>
          <div className="border border-hairline bg-paper-tint px-[15px] py-[13px]">
            <div className="font-mono text-[8.5px] tracking-[0.14em] text-ink-faint">GUARDRAILS</div>
            <p className="mt-[7px] font-ui text-[11px] leading-relaxed text-ink-mid">
              Agents never publish beyond the ≤40-word auto-publish wire carve-out (05-desk-admin.md
              §2.6); every other piece stops at your approval. Toggle state below is read-only in
              this pass by design — no mutation wiring yet.
            </p>
            <DataGapNotice
              className="mt-2.5"
              note="Auto-publish-wires / kill-switch toggle state."
              tables={["iam.global_switches"]}
            />
          </div>

          <div className="mt-4">
            <div className="border-b-2 border-ink pb-[7px] font-ui text-[10px] font-bold uppercase tracking-[0.18em] text-ink">
              Throughput · 7 days
            </div>
            <DataGapNotice className="mt-3" tables={["ops.agent_daily_stats"]} />
          </div>
        </div>
      </div>
    </main>
  );
}
