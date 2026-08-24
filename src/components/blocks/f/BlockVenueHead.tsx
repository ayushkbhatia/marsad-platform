import { Val } from "../primitives";
import type { BlockNodeOf } from "../types";

/**
 * BLK-VENUEHEAD · Venue column header — F · Wire
 *
 * "A DEGRADED FEED IS NAMED IN THE HEADER, NOT HIDDEN IN A FOOTNOTE · CARRIES ITS OWN ITEM COUNT"
 *
 * The degraded flag sits in caution amber beside the index it belongs to, at the top of the
 * column, because a reader scanning a by-market board will not reach a footnote before they have
 * already believed the number. Naming it in place is the difference between a caveat and a
 * disclaimer.
 *
 * The item count is per-column and comes from the payload rather than from counting children: the
 * column may be truncated for space, and a count computed from what rendered would silently agree
 * with the truncation instead of exposing it.
 */
export function BlockVenueHead({ node }: { node: BlockNodeOf<"BLK-VENUEHEAD"> }) {
  const { title, headline, secondary = [], itemCount } = node.payload;

  return (
    <header className="my-3">
      <div className="flex items-baseline justify-between gap-3 bg-ink px-3 py-[7px]">
        <span className="font-mono text-[9px] font-semibold tracking-[0.14em] text-paper-tint uppercase">
          {title}
        </span>
        <span className="font-mono text-[8.5px] text-dark-text-faint tabular-nums">{itemCount} items</span>
      </div>

      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5 border border-hairline bg-paper-tint px-3 py-2">
        <span className="flex items-baseline gap-1.5">
          <span className="font-mono text-[10px] font-semibold tracking-[0.06em] text-ink uppercase">
            {headline?.label ?? "—"}
          </span>
          <span className="font-mono text-[12px] font-semibold text-ink tabular-nums">
            <Val v={headline?.change ?? null} />
          </span>
          {headline?.degraded ? <DegradedFlag label={headline?.label ?? "—"} /> : null}
        </span>

        {secondary.map((s, i) => (
          <span key={i} className="flex items-baseline gap-1.5">
            <span className="font-mono text-[8.5px] tracking-[0.08em] text-ink-muted uppercase">
              {s.label}
            </span>
            <span className="font-mono text-[10px] text-ink-muted tabular-nums">
              <Val v={s.change} />
            </span>
            {s.degraded ? <DegradedFlag label={s.label} /> : null}
          </span>
        ))}
      </div>
    </header>
  );
}

/** Named in place, in caution amber — never relegated to a footnote. */
function DegradedFlag({ label }: { label: string }) {
  return (
    <span
      className="px-[5px] py-[1px] font-mono text-[7.5px] font-semibold tracking-[0.1em] text-ink uppercase"
      style={{ background: "var(--color-caution)" }}
    >
      {label} delayed
    </span>
  );
}
