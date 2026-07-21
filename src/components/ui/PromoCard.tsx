import Link from "next/link";
import type { Surface } from "./types";

export interface PromoCardProps {
  /** Mono uppercase kicker beside the diamond mark — e.g. "MARSAD SELECT", "HEAVYWEIGHT AHEAD". */
  label: string;
  /** Newsreader headline — the card's pitch. */
  headline: string;
  /** Optional supporting line under the headline (Libre Franklin, ink-muted). */
  body?: string;
  ctaText: string;
  /** Renders the CTA as a real link. Omit when the caller wires its own trigger (e.g. opens a modal, as the design's "Unlock with Premium" does). Ignored when `disabled`. */
  ctaHref?: string;
  /**
   * Gated / not-yet-available CTA. Swaps the solid-ink fill for a 1px ink
   * outline (never a greyed opacity stub — PremiumLock's "Unlock →"
   * affordance is the precedent) and renders as inert text, not a link.
   */
  disabled?: boolean;
  /** Small mono gated hint next to the CTA, e.g. "Subscription required", "Coming soon". */
  hint?: string;
  surface?: Surface;
  className?: string;
}

/**
 * Right-rail promo/alert card (server component) — the design's recurring
 * "unlock / alert" module (1b Marsad Select, 8a Heavyweight ahead, 23a
 * Ex-date reminders, 22a Never miss a window). Ink-framed paper-tint box:
 * diamond + mono kicker (ScoreModule's header motif — h-2 w-2 rotate-45 +
 * text-[10px] tracking-[0.2em]), Newsreader headline, optional body copy,
 * solid-ink CTA.
 *
 * `disabled` keeps the designed ink identity (solid → 1px-outline swap),
 * never a muted opacity-60 stub.
 */
export function PromoCard({
  label,
  headline,
  body,
  ctaText,
  ctaHref,
  disabled = false,
  hint,
  surface = "light",
  className = "",
}: PromoCardProps) {
  const dark = surface === "dark";

  const shell = dark
    ? "border-dark-hairline-strong bg-dark-panel text-dark-text"
    : "border-ink bg-paper-tint text-ink";
  const diamond = dark ? "bg-dark-text" : "bg-ink";
  const bodyColor = dark ? "text-dark-text-mid" : "text-ink-muted";
  const hintColor = dark ? "text-dark-text-faint" : "text-ink-faint";
  const ctaSolid = dark ? "bg-dark-text text-dark-bg" : "bg-ink text-paper-tint";
  const ctaOutline = dark ? "border border-dark-text text-dark-text" : "border border-ink text-ink";

  const ctaClass = `inline-block px-3 py-[7px] font-ui text-[10px] font-bold tracking-[0.06em] uppercase ${
    disabled ? `cursor-not-allowed ${ctaOutline}` : ctaSolid
  }`;

  const cta = disabled ? (
    <span aria-disabled="true" className={ctaClass}>
      {ctaText}
    </span>
  ) : ctaHref ? (
    <Link href={ctaHref} className={ctaClass}>
      {ctaText}
    </Link>
  ) : (
    <span className={`cursor-pointer ${ctaClass}`}>{ctaText}</span>
  );

  return (
    <div className={`border px-4 py-3.5 ${shell} ${className}`}>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 flex-none rotate-45 ${diamond}`} aria-hidden />
        <span className="font-mono text-[10px] font-semibold tracking-[0.2em] uppercase">{label}</span>
      </div>
      <div className="mt-[7px] font-display text-[16px] font-semibold leading-[1.3]">{headline}</div>
      {body ? <div className={`mt-[5px] font-ui text-[11px] leading-[1.5] ${bodyColor}`}>{body}</div> : null}
      <div className="mt-[9px] flex flex-wrap items-center gap-x-3 gap-y-1">
        {cta}
        {hint ? (
          <span className={`font-mono text-[9px] tracking-[0.1em] uppercase ${hintColor}`}>{hint}</span>
        ) : null}
      </div>
    </div>
  );
}
