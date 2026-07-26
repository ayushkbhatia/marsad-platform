import Link from "next/link";
import type { LedgerLead } from "@/lib/contracts/ledger";

/**
 * Ledger front page (1b) lead-story block — the broadsheet hero: a 480px
 * photo plate + caption beside the kicker / headline / dek / editorial "take"
 * pull-quote / byline stack, closed by a 1px ink rule.
 *
 * Design-shaped: takes a `LedgerLead` view-model (see
 * `src/lib/data/sample/ledger.ts`), not a DB row. The eventual newsroom
 * adapter maps a published WIRE onto this shape.
 */
export function LedgerLeadStory({ lead }: { lead: LedgerLead }) {
  return (
    <div className="grid grid-cols-1 gap-7 border-b border-ink pb-6 md:grid-cols-[480px_1fr]">
      {/* Photo column — hatched placeholder plate + credit line. */}
      <div>
        <div
          className="grid h-[312px] place-items-center border border-hairline"
          style={{
            backgroundImage:
              "repeating-linear-gradient(45deg,#f1eee6 0 12px,#e9e5da 12px 24px)",
          }}
        >
          <span className="px-4 text-center font-mono text-[10px] tracking-[0.12em] text-ink-faint uppercase">
            {lead.photoLabel}
          </span>
        </div>
        <div className="mt-2 font-mono text-[10px] text-ink-faint">{lead.photoCaption}</div>
      </div>

      {/* Text column. */}
      <div className="flex flex-col gap-[13px]">
        <div className="font-ui text-[11px] font-bold tracking-[0.2em] text-ink uppercase">
          {lead.kicker}
        </div>

        <Link
          href={lead.href}
          className="text-balance font-display text-[41px] leading-[1.1] font-bold tracking-[-0.015em] text-ink hover:underline underline-offset-4"
        >
          {lead.headline}
        </Link>

        <p className="font-display text-[17px] leading-[1.5] text-ink-mid">{lead.dek}</p>

        <p className="border-l-2 border-ink pl-3.5 font-display text-[14.5px] italic leading-[1.55] text-ink-muted">
          {lead.take}
        </p>

        <div className="flex items-baseline gap-2.5 font-mono text-[10px] tracking-[0.08em] text-ink-faint uppercase">
          <span className="font-semibold text-ink">{lead.byline}</span>
          <span>· {lead.time}</span>
          <Link
            href={lead.href}
            className="ml-auto tracking-[0.04em] text-ink underline underline-offset-[3px] hover:text-ink-muted"
          >
            {lead.readLabel}
          </Link>
        </div>
      </div>
    </div>
  );
}
