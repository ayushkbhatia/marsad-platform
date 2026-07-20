import type { Surface } from "./types";
import { toBadgeState, type FreshnessBlock } from "@/lib/market/freshness";

export type FreshnessState =
  | "live"
  | "reconnecting"
  | "delayed"
  | "offline"
  | "halted"
  | "auction";

export interface FreshnessBadgeProps {
  state?: FreshnessState;
  /** Optional suffix appended as " · DETAIL", e.g. "AS OF 15:12 GST" */
  detail?: string;
  surface?: Surface;
  /**
   * A pulse `freshness` block from `/api/pulse/*` (venue_feed_status). When
   * supplied it drives the badge: the DB `state` is mapped onto the 6-state
   * machine via `toBadgeState` (e.g. `closed` → `delayed`, never `live`), and
   * `block.detail` fills the suffix unless an explicit `detail` overrides it.
   */
  block?: FreshnessBlock;
}

const LABELS: Record<FreshnessState, string> = {
  live: "LIVE",
  reconnecting: "RECONNECTING…",
  delayed: "DELAYED 15 MIN",
  offline: "OFFLINE",
  halted: "HALTED",
  auction: "AUCTION",
};

interface Look {
  dot: string;
  text: string;
  /** circle (default) | square (halted) | diamond (auction) */
  shape?: "square" | "diamond";
}

/* Amber marks degraded states only; red never marks a feed failure — halted
   is a market state, not an error (S1 color law). Dark offline dot #6b665c
   is a one-off DC value between ink-muted and ink-faint. */
const LOOKS: Record<Surface, Record<FreshnessState, Look>> = {
  light: {
    live: { dot: "bg-positive", text: "text-positive" },
    reconnecting: { dot: "bg-caution", text: "text-caution" },
    delayed: { dot: "bg-caution", text: "text-ink-faint" },
    offline: { dot: "bg-ink-faint", text: "text-ink-faint" },
    halted: { dot: "bg-negative", text: "text-negative", shape: "square" },
    auction: { dot: "bg-ink", text: "text-ink", shape: "diamond" },
  },
  dark: {
    live: { dot: "bg-positive-dark", text: "text-positive-dark" },
    reconnecting: { dot: "bg-caution", text: "text-caution" },
    delayed: { dot: "bg-caution", text: "text-ink-faint" },
    offline: { dot: "bg-[#6b665c]", text: "text-ink-faint" },
    halted: { dot: "bg-negative-dark", text: "text-negative-dark", shape: "square" },
    auction: { dot: "bg-paper-tint", text: "text-paper-tint", shape: "diamond" },
  },
};

/** Six-state data-freshness indicator (dot + mono label). */
export function FreshnessBadge({
  state = "live",
  detail = "",
  surface = "light",
  block,
}: FreshnessBadgeProps) {
  // A freshness block overrides the explicit state; an explicit `detail` still
  // wins over the block's detail so callers can format their own suffix.
  const effectiveState: FreshnessState = block ? toBadgeState(block.state) : state;
  const effectiveDetail = detail || block?.detail || "";
  const look = LOOKS[surface][effectiveState];
  const shape =
    look.shape === "diamond"
      ? "rotate-45"
      : look.shape === "square"
        ? ""
        : "rounded-full";

  return (
    <span className="inline-flex items-center gap-[6px]">
      <span className={`h-[6px] w-[6px] flex-none ${look.dot} ${shape}`} />
      <span className={`font-mono text-[9.5px] tracking-[0.08em] ${look.text}`}>
        {LABELS[effectiveState]}
        {effectiveDetail ? ` · ${effectiveDetail}` : ""}
      </span>
    </span>
  );
}
