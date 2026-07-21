import { createAdminClient } from "@/lib/supabase/server-admin";
import type { VenueFeedState } from "@/lib/market/freshness";

/**
 * Marsad Desk — shared read layer for the admin/operator screens
 * (24a dashboard, 27a agents console, 33a market data ops).
 *
 * Same posture as `src/lib/desk/approvals.ts` and `admin/lake/page.tsx`: the
 * service-role client, live/never-cached reads (this is operator tooling
 * behind proxy.ts, not a public cached surface — no `use cache` here).
 *
 * IMPORTANT — PostgREST exposure boundary (02-data-lake.md §1, confirmed via
 * read-only SQL 2026-07-21): `db-schemas` is locked to `public, graphql_public`.
 * `iam`, `ops`, `lake`, `ingest`, `analytics`, `billing`, `comms` are
 * service-role-only at the *Postgres grant* level but are NEVER routed by
 * PostgREST regardless of key — not even the service-role key reaches them
 * through supabase-js `.from()`/`.rpc()` unless a `public` wrapper
 * view/RPC exists (the pattern already used for `v_desk_approvals`,
 * `desk_approval_detail`, `v_lake_landing_*`). Confirmed empty: no such
 * wrapper yet exists for `iam.principals`, `iam.agent_accounts`,
 * `iam.global_switches`, `ops.pipeline_items`, `ops.agent_runs`,
 * `ops.classifier_verdicts`, `ops.agent_errors`, `ops.rule_violations`,
 * `ops.rulesets`/`ops.rules`, `ops.incidents`, `ops.incident_banners`,
 * `ops.audit_log`, `lake.objects` (raw ledger), `lake.object_conflicts`,
 * `ingest.sources`, `ingest.schedules`. Every function below only reads
 * tables/views that ARE exposed; screens needing the rest render a flagged
 * `EmptyState` rather than fabricate numbers — see admin/agents and
 * admin/ops page bodies, and the DoD report to the lead.
 */

// ── time helpers ─────────────────────────────────────────────────────────

export function ago(iso: string | null): string {
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

export function hhmm(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dubai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

// ── venue feed health (public.venue_feed_status — live) ────────────────────

export interface FeedHealthRow {
  venueCode: string;
  state: VenueFeedState;
  detail: string | null;
  lastSyncAt: string | null;
  retryCount: number;
  latencyMs: number | null;
  updatedAt: string;
}

export async function getFeedHealth(): Promise<FeedHealthRow[]> {
  const sb = createAdminClient();
  const { data, error } = await sb
    .from("venue_feed_status")
    .select("venue_code, state, detail, last_sync_at, retry_count, latency_ms, updated_at")
    .order("venue_code");
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    venueCode: r.venue_code,
    state: r.state as VenueFeedState,
    detail: r.detail,
    lastSyncAt: r.last_sync_at,
    retryCount: r.retry_count ?? 0,
    latencyMs: r.latency_ms,
    updatedAt: r.updated_at,
  }));
}

// ── halts desk (public.security_status + public.securities — live) ────────

export interface MarketHaltRow {
  securityId: number;
  ticker: string | null;
  nameEn: string | null;
  venueCode: string | null;
  state: string;
  reason: string | null;
  resumeAt: string | null;
  updatedAt: string;
}

export async function getMarketHalts(): Promise<MarketHaltRow[]> {
  const sb = createAdminClient();
  const { data, error } = await sb
    .from("security_status")
    .select("security_id, state, reason, resume_at, updated_at")
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  if (rows.length === 0) return [];

  const ids = [...new Set(rows.map((r) => r.security_id))];
  const { data: secs, error: secErr } = await sb
    .from("securities")
    .select("id, ticker, name_en, venue_code")
    .in("id", ids);
  if (secErr) throw new Error(secErr.message);
  const byId = new Map((secs ?? []).map((s) => [s.id, s]));

  return rows.map((r) => {
    const sec = byId.get(r.security_id);
    return {
      securityId: r.security_id,
      ticker: sec?.ticker ?? null,
      nameEn: sec?.name_en ?? null,
      venueCode: sec?.venue_code ?? null,
      state: r.state,
      reason: r.reason,
      resumeAt: r.resume_at,
      updatedAt: r.updated_at,
    };
  });
}

// ── market hours + holidays (public.market_sessions / market_holidays) ────

export interface MarketSessionRow {
  venueCode: string;
  sessionKind: string;
  openLocal: string;
  closeLocal: string;
  auctionOpenLocal: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export async function getMarketSessions(): Promise<MarketSessionRow[]> {
  const sb = createAdminClient();
  const { data, error } = await sb
    .from("market_sessions")
    .select("venue_code, session_kind, open_local, close_local, auction_open_local, effective_from, effective_to")
    .order("venue_code");
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    venueCode: r.venue_code,
    sessionKind: r.session_kind,
    openLocal: r.open_local,
    closeLocal: r.close_local,
    auctionOpenLocal: r.auction_open_local,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
  }));
}

export interface MarketHolidayRow {
  venueCode: string;
  holidayDate: string;
  name: string;
  isHijriEstimated: boolean;
}

/** Upcoming holidays only — filtered in SQL against `today` (a caller-supplied
 * ISO date), never a JS Date/string compare on the fetched rows (the
 * postgres.js Date trap). */
export async function getUpcomingHolidays(today: string, limit = 10): Promise<MarketHolidayRow[]> {
  const sb = createAdminClient();
  const { data, error } = await sb
    .from("market_holidays")
    .select("venue_code, holiday_date, name, is_hijri_estimated")
    .gte("holiday_date", today)
    .order("holiday_date")
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    venueCode: r.venue_code,
    holidayDate: r.holiday_date,
    name: r.name,
    isHijriEstimated: r.is_hijri_estimated,
  }));
}

// ── content items (public.content_items — live, small table today) ────────

export interface ContentItemRow {
  id: string;
  headline: string;
  dek: string | null;
  contentType: string;
  status: string;
  templateKey: string | null;
  isPremium: boolean;
  wordCount: number | null;
  scheduledAt: string | null;
  publishedAt: string | null;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function getContentItems(limit = 20): Promise<ContentItemRow[]> {
  const sb = createAdminClient();
  const { data, error } = await sb
    .from("content_items")
    .select(
      "id, headline, dek, content_type, status, template_key, is_premium, word_count, scheduled_at, published_at, due_at, created_at, updated_at",
    )
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    id: r.id,
    headline: r.headline,
    dek: r.dek,
    contentType: r.content_type,
    status: r.status,
    templateKey: r.template_key,
    isPremium: r.is_premium,
    wordCount: r.word_count,
    scheduledAt: r.scheduled_at,
    publishedAt: r.published_at,
    dueAt: r.due_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

// ── lake throughput / gaps (public.v_lake_landing_* — live) ────────────────

export interface LakeThroughputRow {
  venueCode: string | null;
  n1h: number;
  n24h: number;
  n7d: number;
  latest: string | null;
}

/** Canonical-object throughput per venue — the `objects` layer slice of
 * `v_lake_landing_recent` (same view `admin/lake` reads). */
export async function getLakeObjectThroughput(): Promise<LakeThroughputRow[]> {
  const sb = createAdminClient();
  const { data, error } = await sb
    .from("v_lake_landing_recent")
    .select("venue_code, n_1h, n_24h, n_7d, latest")
    .eq("layer", "objects")
    .order("venue_code");
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    venueCode: r.venue_code,
    n1h: r.n_1h ?? 0,
    n24h: r.n_24h ?? 0,
    n7d: r.n_7d ?? 0,
    latest: r.latest,
  }));
}

export interface LakeGapRow {
  venueCode: string | null;
  objectLatest: string | null;
  objectStale: boolean;
  noRawTrail: boolean;
  stalledExtract: boolean;
}

export async function getLakeGaps(): Promise<LakeGapRow[]> {
  const sb = createAdminClient();
  const { data, error } = await sb
    .from("v_lake_landing_gaps")
    .select("venue_code, object_latest, object_stale, no_raw_trail, stalled_extract");
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    venueCode: r.venue_code,
    objectLatest: r.object_latest,
    objectStale: r.object_stale,
    noRawTrail: r.no_raw_trail,
    stalledExtract: r.stalled_extract,
  }));
}
