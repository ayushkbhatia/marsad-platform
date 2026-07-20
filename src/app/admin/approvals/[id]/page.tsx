import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getApprovalDetail } from "@/lib/desk/approvals";
import { decideAction } from "../actions";

export const metadata: Metadata = { title: "Desk — review piece" };

const stateTone: Record<string, string> = {
  VERIFIED: "text-positive",
  PENDING: "text-ink-muted",
  CONFLICT: "text-negative",
  RETIRED: "text-ink-faint",
};

export default function ApprovalDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ err?: string }>;
}) {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-paper-tint px-6 py-8 sm:px-10">
          <p className="font-mono text-[13px] text-ink-faint">Loading piece…</p>
        </main>
      }
    >
      <ApprovalDetailBody params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function ApprovalDetailBody({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ err?: string }>;
}) {
  const { id } = await params;
  const { err } = await searchParams;
  const itemId = Number(id);
  if (!itemId) notFound();

  const detail = await getApprovalDetail(itemId);
  if (!detail.item) notFound();
  const it = detail.item;
  const bodyText = detail.blocks.map((b) => (b.body as { text?: string })?.text ?? "").join("\n\n");
  const blockedRules = detail.violations.filter((v) => v.outcome === "blocked");

  return (
    <main className="min-h-screen bg-paper-tint px-6 py-8 sm:px-10">
      <Link href="/admin/approvals" className="font-ui text-[13px] text-ink-muted underline-offset-2 hover:underline">← queue</Link>

      <header className="mt-3 mb-5 border-b border-hairline pb-4">
        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-ink-faint">
          <span>#{it.item_id}</span>
          <span>· {it.content_type}</span>
          <span>· {it.template_key ?? "no template"}</span>
          {it.ticker ? <span>· {it.ticker} {it.venue_code}</span> : null}
          {it.is_premium ? <span className="rounded-sm bg-ink/10 px-1 py-0.5 font-semibold uppercase text-ink-muted">premium</span> : null}
        </div>
        <h1 className="mt-2 font-display text-2xl font-semibold leading-snug text-ink">{it.headline}</h1>
        {it.dek ? <p className="mt-1 font-ui text-sm text-ink-muted">{it.dek}</p> : null}
        <div className="mt-2 font-mono text-[11px] text-ink-faint">
          {it.word_count ?? "—"} words · {it.citation_count} citations ·{" "}
          {it.rules_stale ? (
            <span className="text-negative">RULES STALE (passed v{it.rules_passed_version ?? "—"}, live v{it.live_ruleset})</span>
          ) : (
            <span className="text-positive">rules passed v{it.rules_passed_version}</span>
          )}
        </div>
      </header>

      {err ? (
        <div className="mb-4 rounded-sm bg-negative/10 px-3 py-2 font-mono text-[13px] text-negative">{err}</div>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
        {/* Body */}
        <section>
          <h2 className="mb-2 font-ui text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Body</h2>
          <div className="whitespace-pre-wrap rounded-sm border border-hairline bg-paper px-4 py-3 font-ui text-[15px] leading-relaxed text-ink">
            {bodyText || <span className="text-ink-faint">(no body blocks)</span>}
          </div>

          <h2 className="mt-6 mb-2 font-ui text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
            Citations
          </h2>
          <ul className="space-y-1.5">
            {detail.citations.length === 0 ? (
              <li className="font-ui text-[13px] text-ink-faint">none</li>
            ) : (
              detail.citations.map((c, i) => (
                <li key={i} className="flex flex-wrap items-baseline gap-x-2 rounded-sm bg-paper px-2 py-1 font-mono text-[12px]">
                  <span className="font-semibold text-ink">[{c.claim_key ?? "?"}]</span>
                  <span className="text-ink-muted">{c.object_type ?? "?"}</span>
                  <span className={stateTone[c.object_state ?? ""] ?? "text-ink-faint"}>{c.object_state ?? "missing"}</span>
                  {c.quoted_value ? <span className="text-ink-mid">= {c.quoted_value}</span> : null}
                  {c.claim ? <span className="text-ink-faint">— {c.claim}</span> : null}
                </li>
              ))
            )}
          </ul>

          {detail.violations.length > 0 ? (
            <>
              <h2 className="mt-6 mb-2 font-ui text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Rule log</h2>
              <ul className="space-y-1">
                {detail.violations.map((v, i) => (
                  <li key={i} className="font-mono text-[12px]">
                    <span className={v.outcome === "blocked" ? "text-negative" : v.outcome === "warned" ? "text-ink-muted" : "text-positive"}>
                      {v.rule_key} · {v.outcome}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>

        {/* Decision panel */}
        <aside className="lg:sticky lg:top-8 lg:self-start">
          <h2 className="mb-2 font-ui text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Decision</h2>
          {blockedRules.length > 0 ? (
            <p className="mb-3 rounded-sm bg-negative/10 px-2 py-1.5 font-mono text-[11px] text-negative">
              {blockedRules.length} blocking rule{blockedRules.length > 1 ? "s" : ""} — approving overrides the guardrail.
            </p>
          ) : null}

          <form className="space-y-3">
            <input type="hidden" name="item_id" value={it.item_id} />

            <textarea
              name="note"
              rows={2}
              placeholder="Note (required to send back)"
              className="w-full rounded-sm border border-hairline bg-paper px-2 py-1.5 font-ui text-[13px] text-ink placeholder:text-ink-faint"
            />
            <input
              type="datetime-local"
              name="scheduled_for"
              className="w-full rounded-sm border border-hairline bg-paper px-2 py-1.5 font-mono text-[12px] text-ink-mid"
            />

            <div className="grid grid-cols-2 gap-2">
              <button formAction={decideAction} name="decision" value="approve"
                className="rounded-sm bg-positive px-3 py-2 font-ui text-[13px] font-semibold text-paper hover:opacity-90">
                Approve → live
              </button>
              <button formAction={decideAction} name="decision" value="approve_scheduled"
                className="rounded-sm border border-positive px-3 py-2 font-ui text-[13px] font-semibold text-positive hover:bg-positive/5">
                Schedule
              </button>
              <button formAction={decideAction} name="decision" value="send_back"
                className="rounded-sm border border-hairline px-3 py-2 font-ui text-[13px] font-medium text-ink-mid hover:bg-paper">
                Send back
              </button>
              <button formAction={decideAction} name="decision" value="reassign"
                className="rounded-sm border border-hairline px-3 py-2 font-ui text-[13px] font-medium text-ink-mid hover:bg-paper">
                Reassign
              </button>
            </div>
          </form>

          <p className="mt-3 font-mono text-[10px] leading-relaxed text-ink-faint">
            Approve/Schedule require the piece to have passed the live ruleset; the RPC re-checks
            capability + RULES_STALE. Send-back requires a note. Schedule uses the datetime above.
          </p>
        </aside>
      </div>
    </main>
  );
}
