"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Compare's header row (18a) — the one client island on the page (CONVENTIONS §2/§3: a
 * component is a client island only if it handles input). Renders up to 4 filled columns
 * (ticker + score chip + name + venue, with a "×" remove) plus one "Add a name" slot when a
 * slot remains, then rewrites `?t=` and navigates. Everything else on the page (the data rows)
 * is a plain server component reading the same `t` searchParam.
 */

export interface CompareColumn {
  venue: string;
  ticker: string;
  name: string;
  venueLabel: string;
  score: number | null;
  /** Uppercase DB vocabulary — BUY/OVERWEIGHT/HOLD/UNDERWEIGHT/SELL/null. */
  rating: string | null;
}

const MAX_SLOTS = 4;
const PAIR_RE = /^[A-Za-z]{2,5}:[A-Za-z0-9.]{1,12}$/;

function toQuery(pairs: CompareColumn[]): string {
  const t = pairs.map((p) => `${p.venue}:${p.ticker}`).join(",");
  return t ? `/compare?t=${encodeURIComponent(t)}` : "/compare";
}

const buyish = (r: string | null) => r === "BUY" || r === "OVERWEIGHT";

export function CompareHeaderRow({ columns }: { columns: CompareColumn[] }) {
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  function remove(idx: number) {
    router.push(toQuery(columns.filter((_, i) => i !== idx)));
  }

  function add(e: React.FormEvent) {
    e.preventDefault();
    const v = draft.trim().toUpperCase();
    if (!v) return;
    if (!PAIR_RE.test(v)) {
      setError("Use VENUE:TICKER, e.g. TDWL:2222");
      return;
    }
    const [venue, ticker] = v.split(":");
    if (columns.some((c) => c.venue === venue && c.ticker === ticker)) {
      setError("Already in this comparison");
      return;
    }
    setError(null);
    setDraft("");
    router.push(toQuery([...columns, { venue, ticker, name: "", venueLabel: "", score: null, rating: null }]));
  }

  const slotsLeft = MAX_SLOTS - columns.length;

  return (
    <div className="grid grid-cols-[150px_repeat(4,1fr)]">
      <div className="border-b border-hairline-faint" />
      {columns.map((c, i) => (
        <div
          key={`${c.venue}:${c.ticker}`}
          className="relative border-b border-hairline-faint border-l border-l-hairline-soft px-4 pt-4 pb-3.5"
        >
          <button
            type="button"
            onClick={() => remove(i)}
            aria-label={`Remove ${c.ticker} from comparison`}
            className="absolute top-1.5 right-1.5 font-mono text-[11px] leading-none text-ink-faint hover:text-ink"
          >
            ×
          </button>
          <div className="flex items-baseline gap-[7px] pr-4">
            <span className="font-mono text-[10px] font-semibold">{c.ticker}</span>
            {c.score != null ? (
              <span
                className={`ml-auto font-mono text-[8px] font-bold tracking-[0.02em] ${
                  buyish(c.rating) ? "bg-ink px-[6px] py-[1.5px] text-paper-tint" : "border border-ink px-[5px] py-[1px] text-ink"
                }`}
              >
                {c.score}
              </span>
            ) : null}
          </div>
          <div className="mt-[5px] truncate font-display text-[17px] font-bold text-ink">{c.name || c.ticker}</div>
          <div className="text-[11px] text-ink-muted">{c.venueLabel || c.venue}</div>
        </div>
      ))}
      {slotsLeft > 0 ? (
        <div className="border-b border-hairline-faint border-l border-dashed border-l-hairline-strong px-4 py-4">
          <form onSubmit={add} className="flex h-full flex-col items-center justify-center gap-1.5 text-center">
            <input
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                if (error) setError(null);
              }}
              placeholder="VENUE:TICKER"
              aria-label="Add a security to compare, e.g. TDWL:2222"
              className="w-full border border-hairline bg-paper px-2 py-1.5 text-center font-mono text-[10.5px] uppercase text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
            />
            <button
              type="submit"
              className="font-ui text-[11px] font-semibold text-ink-muted hover:text-ink"
            >
              + Add a name
            </button>
            {error ? <span className="font-mono text-[8.5px] text-negative">{error}</span> : null}
          </form>
        </div>
      ) : null}
      {/* Pad remaining empty slots (only reachable if MAX_SLOTS ever exceeds the visible add cell). */}
      {Array.from({ length: Math.max(0, slotsLeft - 1) }).map((_, i) => (
        <div key={`pad-${i}`} className="border-b border-hairline-faint border-l border-dashed border-l-hairline-strong" />
      ))}
    </div>
  );
}
