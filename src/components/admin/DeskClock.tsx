"use client";

import { useEffect, useState } from "react";

/** "SUN 12 JUL 2026" half — date only, no comma. */
const dateFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Dubai",
  weekday: "short",
  day: "2-digit",
  month: "short",
  year: "numeric",
});

/** "09:41" half — time only. */
const timeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Dubai",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/**
 * Small ticking GST clock for the desk top bar. Client leaf — the only
 * reason this needs the client at all is `setInterval`; everything else on
 * the page stays server-rendered. Renders nothing until mounted so the
 * server/client markup never mismatches on the wall-clock value.
 *
 * Date and time are formatted separately and joined with " · " (the
 * AdminRail.dc.html handoff format, e.g. "SUN 12 JUL 2026 · 09:41 GST") —
 * `Intl.DateTimeFormat` with weekday+date+time in one call emits locale
 * commas between every segment, and stripping just the first one left a
 * stray comma before the time.
 */
export function DeskClock() {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const datePart = dateFmt.format(now).replace(/,/g, "").toUpperCase();
      const timePart = timeFmt.format(now);
      setLabel(`${datePart} · ${timePart}`);
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <span className="font-mono text-[8.5px] tracking-[0.1em] text-ink-faint">
      {label ? `${label} GST` : " "}
    </span>
  );
}
