"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export interface NavLinkProps {
  href: string;
  label: string;
  /** Exact match only (e.g. the dashboard root "/admin") vs prefix match. */
  exact?: boolean;
  badge?: ReactNode;
}

/**
 * One AdminRail nav row. Client leaf (per CONVENTIONS §3: a component may be
 * client-side only if it handles route-derived UI state) — `usePathname()`
 * drives the active highlight so `AdminRail`/`layout.tsx` stay static server
 * components and every /admin route shares one rail without prop-drilling
 * "which page am I" down from the layout.
 */
export function NavLink({ href, label, exact = false, badge }: NavLinkProps) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      className={
        active
          ? "flex items-center gap-[9px] border-l-2 border-paper-tint bg-ink-soft px-4 py-[9px] text-paper-tint no-underline"
          : "flex items-center gap-[9px] border-l-2 border-transparent px-4 py-[9px] text-dark-text-faint no-underline hover:bg-[#1c1b17] hover:text-hairline-strong"
      }
    >
      <span className={`font-ui text-[11.5px] ${active ? "font-semibold" : "font-medium"}`}>{label}</span>
      {badge != null && (
        <span
          className={`ml-auto font-mono text-[8px] ${
            active
              ? "border border-ink-muted px-[5px] py-px text-hairline-strong"
              : "border border-dark-hairline-strong px-[5px] py-px text-ink-faint"
          }`}
        >
          {badge}
        </span>
      )}
    </Link>
  );
}
