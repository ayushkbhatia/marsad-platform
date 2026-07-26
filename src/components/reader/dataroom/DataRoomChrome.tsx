import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Data-room chrome bar (design 1e/1f, 54px) — the shared shell for the
 * platform's only DARK surfaces (heatmap + screener).
 *
 * Per the handoff: the data room deliberately does NOT carry `MarsadNav` —
 * it is a full-bleed focus mode, and arriving from the light reader shell is a
 * MODE SWITCH, not a page navigation. The brand lockup doubles as the way back
 * out to the reader (the design shows no explicit exit; this is the minimum
 * affordance so the mode is escapable).
 *
 * Left: brand diamond + wordmark + mode chip (+ optional feed-status pill).
 * `controls` sits inline after the lockup (segmented controls); `right` is
 * pushed to the far edge (counts, EXPORT, primary action).
 */
export function DataRoomChrome({
  mode,
  status,
  controls,
  right,
}: {
  /** Mode chip — "HEATMAP" | "SCREENER". */
  mode: string;
  /** Optional feed-status pill (e.g. an MSX-delayed notice). */
  status?: { label: string } | null;
  controls?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex h-[54px] items-center gap-4 border-b border-dark-hairline px-6">
      <div className="flex flex-none items-center gap-2.5">
        <Link href="/" className="flex items-center gap-2.5" title="Back to the reader">
          <span className="h-[9px] w-[9px] rotate-45 bg-dark-text" aria-hidden />
          <span className="font-mono text-[11px] font-semibold tracking-[0.18em] text-dark-text">
            MARSAD DATA ROOM
          </span>
        </Link>
        <span className="border border-dark-hairline-strong px-1.5 py-[2.5px] font-mono text-[8.5px] tracking-[0.12em] text-dark-text-faint">
          {mode}
        </span>
        {status ? (
          <span
            className="ml-0.5 flex items-center gap-1.5 border px-2 py-[2.5px]"
            style={{ borderColor: "#6b5a1f", background: "rgba(201,162,39,.12)" }}
          >
            <span className="h-[6px] w-[6px] flex-none rounded-full bg-caution" aria-hidden />
            <span className="font-mono text-[8px] tracking-[0.08em] text-caution">{status.label}</span>
          </span>
        ) : null}
      </div>

      {controls ? <div className="flex flex-none items-center gap-3 pl-2">{controls}</div> : null}

      {right ? <div className="ml-auto flex flex-none items-center gap-3.5">{right}</div> : null}
    </div>
  );
}

/** Segmented control shell — 1px border, flush children (design 1e/1f). */
export function Segmented({ children }: { children: ReactNode }) {
  return <div className="flex border border-dark-hairline-soft">{children}</div>;
}

/** One segment. Active = paper fill on ink text; inactive = muted. */
export function Segment({
  href,
  active,
  children,
  disabled,
  title,
}: {
  href?: string;
  active?: boolean;
  children: ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  const cls = `px-[11px] py-1.5 font-ui text-[10.5px] ${
    active ? "bg-dark-text font-bold text-dark-bg" : "text-dark-text-faint hover:text-dark-text"
  }`;
  if (disabled || !href) {
    return (
      <span title={title} className={`${cls} ${disabled ? "cursor-not-allowed opacity-60" : ""}`}>
        {children}
      </span>
    );
  }
  return (
    <Link href={href} title={title} className={cls}>
      {children}
    </Link>
  );
}

/** Outlined chrome button (EXPORT, EXPORT CSV). */
export function ChromeButton({ children }: { children: ReactNode }) {
  return (
    <span className="cursor-pointer border border-dark-hairline-strong px-3 py-1.5 font-ui text-[10.5px] font-semibold tracking-[0.06em] text-dark-text">
      {children}
    </span>
  );
}

/** Solid chrome action (SAVE AS ALERT). */
export function ChromeAction({ children }: { children: ReactNode }) {
  return (
    <span className="cursor-pointer bg-dark-text px-3 py-[7px] font-ui text-[10.5px] font-bold tracking-[0.06em] text-dark-bg">
      {children}
    </span>
  );
}

/** Mono caption used in the chrome right slot (SIZE:, UNIVERSE:). */
export function ChromeMeta({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[10px] text-dark-text-faint">{children}</span>;
}
