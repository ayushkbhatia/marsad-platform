"use client";

import { useState } from "react";
import Link from "next/link";
import { SAMPLE_NOTIFICATIONS } from "@/lib/data/sample/alerts";
import type { NotificationItem, NotificationTab } from "@/lib/contracts/alerts";

/**
 * Notifications (design 16b) — the bell's desktop home. An ANCHORED PANEL, not
 * a page: 392px pinned below the nav (top-right, aligned to the bell), 1px ink
 * border + heavy shadow, over a LIGHT scrim with only a 1.5px backdrop blur
 * behind (a peek, not a gate — the paywall uses 2.5px). Rows carry a read dot
 * (ink = unread), a source tag, a relative timestamp and an optional body line;
 * unread rows tint. Footer hands off to the Alerts Manager (5a) — the panel is
 * a digest, never the settings UI. Sample-driven (DEF-ALERTS-LIVE-DATA); the
 * client read state is local (no per-user store yet).
 */
const TABS: NotificationTab[] = ["All", "Alerts", "Research", "Filings"];

export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<NotificationTab>("All");
  const [readIds, setReadIds] = useState<Set<string>>(
    () => new Set(SAMPLE_NOTIFICATIONS.filter((n) => !n.unread).map((n) => n.id)),
  );

  const isUnread = (n: NotificationItem) => !readIds.has(n.id);
  const unreadCount = SAMPLE_NOTIFICATIONS.filter(isUnread).length;
  const visible = SAMPLE_NOTIFICATIONS.filter((n) => tab === "All" || n.category === tab);

  const markAllRead = () => setReadIds(new Set(SAMPLE_NOTIFICATIONS.map((n) => n.id)));
  const markRead = (id: string) => setReadIds((prev) => new Set(prev).add(id));

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Notifications${unreadCount ? `, ${unreadCount} unread` : ""}`}
        aria-expanded={open}
        className="relative flex h-8 w-8 flex-none items-center justify-center text-ink"
      >
        {/* Bell glyph (inline SVG — no icon dep) */}
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadCount > 0 ? (
          <span className="absolute -top-0.5 -right-0.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-negative px-[3px] font-mono text-[8px] font-bold text-paper-tint">
            {unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <>
          {/* Light scrim — a peek: 1.5px blur behind (vs 2.5px for the paywall). */}
          <div
            className="fixed inset-0 z-40 bg-[rgba(20,18,14,0.18)] backdrop-blur-[1.5px]"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            role="dialog"
            aria-label="Notifications"
            className="fixed right-7 top-[150px] z-50 w-[392px] border border-ink bg-paper shadow-[0_20px_50px_rgba(20,18,14,0.28)]"
          >
            <div className="flex items-center gap-2.5 border-b-2 border-ink px-[18px] py-[13px]">
              <span className="font-display text-[17px] font-bold text-ink">Notifications</span>
              {unreadCount > 0 ? (
                <span className="bg-negative px-1.5 py-[1.5px] font-mono text-[8px] font-semibold text-paper-tint">{unreadCount} NEW</span>
              ) : null}
              <button type="button" onClick={markAllRead} className="ml-auto text-[10.5px] text-ink-muted underline underline-offset-2 hover:text-ink">
                Mark all read
              </button>
            </div>

            <div className="flex gap-3.5 border-b border-hairline px-[18px] py-[9px]">
              {TABS.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={`font-mono text-[9.5px] ${
                    tab === t ? "font-bold text-ink shadow-[inset_0_-2px_0_var(--color-ink)] pb-1.5" : "text-ink-faint"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>

            <div className="max-h-[420px] overflow-y-auto">
              {visible.length === 0 ? (
                <div className="px-[18px] py-8 text-center font-mono text-[10px] text-ink-faint">Nothing here yet.</div>
              ) : (
                visible.map((n) => {
                  const unread = isUnread(n);
                  const body = (
                    <>
                      <span className={`mt-[5px] h-[7px] w-[7px] flex-none rounded-full ${unread ? "bg-ink" : "bg-[#cfcabe]"}`} aria-hidden />
                      <span className="flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className="font-mono text-[8px] font-semibold tracking-[0.1em] text-ink-faint">{n.tag}</span>
                          <span className="ml-auto font-mono text-[8px] text-[#a8a396]">{n.when}</span>
                        </span>
                        <span className="mt-[3px] block text-[12.5px] font-semibold text-ink">{n.title}</span>
                        {n.body ? <span className="mt-[2px] block text-[11px] leading-[1.4] text-ink-muted">{n.body}</span> : null}
                      </span>
                    </>
                  );
                  const cls = `flex gap-2.5 border-b border-hairline-faint px-[18px] py-[13px] text-left ${unread ? "bg-paper-tint" : ""}`;
                  return n.href ? (
                    <Link key={n.id} href={n.href} onClick={() => { markRead(n.id); setOpen(false); }} className={cls}>
                      {body}
                    </Link>
                  ) : (
                    <button key={n.id} type="button" onClick={() => markRead(n.id)} className={`${cls} w-full`}>
                      {body}
                    </button>
                  );
                })
              )}
            </div>

            <div className="border-t border-hairline px-[18px] py-[11px] text-center">
              <Link href="/alerts" onClick={() => setOpen(false)} className="text-[11px] font-semibold text-ink underline underline-offset-[3px]">
                Notification settings &amp; all alerts →
              </Link>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
