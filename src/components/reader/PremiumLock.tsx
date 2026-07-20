/**
 * Premium paywall affordance (server component). Owner decision: financials,
 * valuation ratios, and score factor-grades are premium-gated. These surfaces
 * render this locked STUB — NO gated data is fetched or sent to the client.
 *
 * `variant="panel"` — full-height locked panel (Financials tab).
 * `variant="inline"` — compact locked strip (Overview valuation affordance).
 */
export interface PremiumLockProps {
  title: string;
  teaser: string;
  variant?: "panel" | "inline";
  /** Optional visible-but-blurred scaffold behind the lock (e.g. statement tabs). */
  scaffold?: React.ReactNode;
}

export function PremiumLock({ title, teaser, variant = "panel", scaffold }: PremiumLockProps) {
  if (variant === "inline") {
    return (
      <div className="flex items-center justify-between gap-3 border border-hairline bg-paper px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px]" aria-hidden>
              🔒
            </span>
            <span className="font-mono text-[9.5px] font-semibold tracking-[0.16em] text-ink-muted uppercase">
              {title}
            </span>
            <span className="bg-ink px-1.5 py-0.5 font-mono text-[8px] font-semibold tracking-[0.1em] text-paper-tint uppercase">
              Premium
            </span>
          </div>
          <p className="mt-1 truncate font-ui text-[11.5px] text-ink-faint">{teaser}</p>
        </div>
        <span className="flex-none cursor-not-allowed border border-ink px-3 py-1.5 font-ui text-[11px] font-semibold text-ink">
          Unlock →
        </span>
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden border border-hairline bg-paper">
      {scaffold ? (
        <div className="pointer-events-none select-none opacity-30 blur-[2.5px]" aria-hidden>
          {scaffold}
        </div>
      ) : (
        <div className="h-[260px]" aria-hidden />
      )}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-paper/55 px-6 text-center">
        <span className="text-[22px]" aria-hidden>
          🔒
        </span>
        <div className="flex items-center gap-2">
          <span className="font-display text-heading-sm font-semibold text-ink">{title}</span>
          <span className="bg-ink px-1.5 py-0.5 font-mono text-[8.5px] font-semibold tracking-[0.12em] text-paper-tint uppercase">
            Premium
          </span>
        </div>
        <p className="max-w-[420px] font-ui text-[13px] leading-[1.6] text-ink-muted">{teaser}</p>
        <span className="mt-1 cursor-not-allowed border border-ink px-5 py-2 font-ui text-[12.5px] font-semibold text-ink">
          Unlock Premium →
        </span>
        <span className="font-mono text-[9px] tracking-[0.1em] text-ink-faint uppercase">
          Subscription required
        </span>
      </div>
    </div>
  );
}
