"use client";

import { useEffect, useState } from "react";

const fmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Dubai",
  weekday: "short",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/**
 * Small ticking GST clock for the desk top bar. Client leaf — the only
 * reason this needs the client at all is `setInterval`; everything else on
 * the page stays server-rendered. Renders nothing until mounted so the
 * server/client markup never mismatches on the wall-clock value.
 */
export function DeskClock() {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    const tick = () => setLabel(fmt.format(new Date()).toUpperCase().replace(",", ""));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <span className="font-mono text-[8.5px] tracking-[0.1em] text-dark-text-faint">
      {label ? `${label} GST` : " "}
    </span>
  );
}
