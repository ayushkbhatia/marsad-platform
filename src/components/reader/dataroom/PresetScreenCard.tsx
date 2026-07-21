import Link from "next/link";
import type { PresetScreen } from "@/lib/data/dataroom";

/** One curated-screen card for the `/screens` gallery — dark data-room surface. */
export function PresetScreenCard({ screen, count }: { screen: PresetScreen; count: number }) {
  return (
    <Link
      href={`/screens/${screen.id}`}
      className="flex min-h-[152px] flex-col border border-dark-hairline bg-dark-panel px-4 py-4 text-dark-text no-underline transition-colors hover:border-dark-hairline-strong hover:bg-dark-panel-alt"
    >
      <span className="font-mono text-[8px] font-semibold tracking-[0.12em] text-dark-text-faint uppercase">
        {screen.tag}
      </span>
      <span className="mt-2 font-display text-[18px] font-bold leading-tight text-dark-text">
        {screen.name}
      </span>
      <span className="mt-1.5 font-ui text-[11.5px] leading-relaxed text-dark-text-mid">
        {screen.description}
      </span>
      <div className="mt-auto flex items-baseline gap-2 pt-3">
        <span className="font-mono text-[11px] font-semibold text-dark-text">
          {count.toLocaleString("en-US")} {count === 1 ? "match" : "matches"}
        </span>
        <span className="ml-auto font-mono text-[11px] text-dark-text-faint">→</span>
      </div>
    </Link>
  );
}
