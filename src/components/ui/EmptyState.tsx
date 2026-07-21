import type { ReactNode } from "react";
import type { Surface } from "./types";

export interface EmptyStateProps {
  /** Headline — for a data tier with no producer yet this is the "AWAITING FEED" case. */
  title: string;
  body?: string;
  /** Optional CTA (a Link or button). */
  action?: ReactNode;
  /**
   * `awaitingFeed` = a tier whose producer hasn't landed (ipo_offers, holders,
   * transcripts, estimates…). Renders the mono "AWAITING FEED" kicker + a caution
   * dot per the design's empty-data law — NOT an error. `empty` = a genuine
   * no-results state (filters, search).
   */
  variant?: "empty" | "awaitingFeed";
  surface?: Surface;
  className?: string;
}

/**
 * Empty / awaiting-feed state (server component). The design's law: an empty data
 * surface shows "AWAITING FEED" + a freshness cue, never a red error — the number
 * simply hasn't been produced yet (README §Charts empty state, 17a–17c). Centered
 * block with a diamond mark, headline, body, optional CTA.
 */
export function EmptyState({
  title,
  body,
  action,
  variant = "empty",
  surface = "light",
  className = "",
}: EmptyStateProps) {
  const dark = surface === "dark";
  const awaiting = variant === "awaitingFeed";
  const shell = dark
    ? "border-dark-hairline bg-dark-panel/40 text-dark-text-faint"
    : "border-hairline bg-paper-tint/60 text-ink-faint";
  const heading = dark ? "text-dark-text-mid" : "text-ink-mid";

  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 border border-dashed px-6 py-14 text-center ${shell} ${className}`}
    >
      {awaiting ? (
        <span className="inline-flex items-center gap-2">
          <span className="h-[6px] w-[6px] flex-none rounded-full bg-caution" aria-hidden />
          <span className="font-mono text-[9px] font-semibold tracking-[0.2em] uppercase text-caution-text">
            Awaiting feed
          </span>
        </span>
      ) : (
        <span className="h-2.5 w-2.5 rotate-45 bg-current opacity-40" aria-hidden />
      )}
      <p className={`max-w-[420px] font-display text-[17px] leading-tight ${heading}`}>{title}</p>
      {body && <p className="max-w-[440px] font-ui text-[12.5px] leading-relaxed">{body}</p>}
      {action != null && <div className="mt-1">{action}</div>}
    </div>
  );
}
