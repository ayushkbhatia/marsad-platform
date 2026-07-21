"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Mobile nav (client island). The desktop nav is `hidden lg:flex`; below `lg`
 * there was no way to reach any section (a11y launch blocker — WCAG 2.4.5). This
 * adds a hamburger (visible `lg:hidden`) that opens a full-width sheet of the same
 * links. Editorial ink-and-paper, square corners, ≥44px hit targets.
 *
 * The link list is the single source shared with the desktop nav in MarsadNav.
 */
export const NAV_LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/markets", label: "Markets" },
  { href: "/wire", label: "Wire" },
  { href: "/screener", label: "Screener" },
  { href: "/earnings", label: "Earnings" },
  { href: "/dividends", label: "Dividends" },
  { href: "/ipo", label: "IPOs" },
  { href: "/filings", label: "Register" },
  { href: "/search", label: "Search" },
  { href: "/learn", label: "Learn" },
];

export function MobileNavDrawer() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close on route change.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Lock body scroll + close on Escape while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="lg:hidden">
      <button
        type="button"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-11 w-11 flex-none items-center justify-center text-ink hover:bg-paper-tint"
      >
        <span className="relative block h-[11px] w-[18px]" aria-hidden>
          <span
            className={`absolute left-0 block h-[1.5px] w-full bg-current transition-transform ${
              open ? "top-[5px] rotate-45" : "top-0"
            }`}
          />
          <span
            className={`absolute left-0 top-[5px] block h-[1.5px] w-full bg-current transition-opacity ${
              open ? "opacity-0" : "opacity-100"
            }`}
          />
          <span
            className={`absolute left-0 block h-[1.5px] w-full bg-current transition-transform ${
              open ? "top-[5px] -rotate-45" : "top-[10px]"
            }`}
          />
        </span>
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 top-[49px] z-40 bg-ink/20"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <nav
            className="fixed inset-x-0 top-[49px] z-50 border-b border-hairline bg-paper shadow-[var(--shadow-dropdown)]"
            aria-label="Sections"
          >
            <ul className="mx-auto max-w-[1180px] px-3 py-2">
              {NAV_LINKS.map((l) => {
                const active = pathname === l.href || pathname.startsWith(l.href + "/");
                return (
                  <li key={l.href}>
                    <Link
                      href={l.href}
                      className={`flex min-h-[44px] items-center border-b border-hairline-faint px-2 font-ui text-[15px] ${
                        active ? "font-semibold text-ink" : "text-ink-mid"
                      }`}
                    >
                      {l.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </>
      )}
    </div>
  );
}
