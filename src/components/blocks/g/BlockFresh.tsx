import type { VenueFeedState } from "@/lib/market/freshness";
import { warnConstraint } from "../constraints";
import type { BlockNodeOf, FreshPayload, FreshState } from "../types";

/*
 * BLK-FRESH · Freshness badge — G · Provenance & trust
 *
 * "EXACTLY FOUR STATES — NEVER A NUMBER WITHOUT ONE OF THESE FOUR"
 *
 * Hard rule 2, the other half of BLK-PROV.
 *
 * ── A DELIBERATE DIVERGENCE FROM THE READER APP, RECORDED HERE ──────────────
 * The card footer says "SHARED WITH THE READER APP'S FreshnessBadge", but the
 * two specifications genuinely disagree and cannot both be satisfied by one
 * component:
 *
 *   | block library (this file)     | src/components/ui/FreshnessBadge.tsx     |
 *   |-------------------------------|------------------------------------------|
 *   | 4 states                      | 6 states (adds reconnecting, halted,     |
 *   |                               | auction; has no face for CLOSED)         |
 *   | CLOSED is its own grey state  | `closed` degrades to `delayed`           |
 *   | FEED OFFLINE dot is RED       | offline dot is grey — "red never marks a |
 *   |                               | feed failure (S1 color law)"             |
 *   | mono 8.5px, label always      | mono 9.5px, label takes the dot colour   |
 *   | ink-muted                     |                                          |
 *
 * The artifact wins for blocks (docs/design/README.md: "If the JSON disagrees
 * with the HTML, the HTML wins"), so this renders the four-state badge exactly
 * as the card draws it. `fromVenueFeedState` below maps the SAME
 * `venue_feed_status.state` column onto these four, so both surfaces stay
 * driven by one source even though they draw it differently. The contradiction
 * is a design question for the desk, not something to paper over in code.
 */

interface Face {
  dot: string;
  label: (p: FreshPayload) => string;
}

const FACES: Record<FreshState, Face> = {
  live: {
    dot: "bg-positive",
    label: (p) => (p.timestamp ? `LIVE · ${p.timestamp}` : "LIVE"),
  },
  delayed: {
    dot: "bg-caution",
    label: (p) => {
      const head = p.delayMinutes == null ? "DELAYED" : `DELAYED ${p.delayMinutes} MIN`;
      return p.venue ? `${head} · ${p.venue}` : head;
    },
  },
  closed: {
    dot: "bg-ink-faint",
    label: (p) => (p.lastClose ? `CLOSED · ${p.lastClose}` : "CLOSED"),
  },
  offline: {
    dot: "bg-negative",
    label: (p) => (p.retryCount == null ? "FEED OFFLINE" : `FEED OFFLINE · RETRY ${p.retryCount}`),
  },
};

/**
 * Map the ingestion sweep's `public.venue_feed_status.state` vocabulary onto the
 * four faces this block has. `reconnecting` reads as offline (the feed is not
 * delivering); `halted`/`auction` are market states with no block face and
 * degrade to `closed` — never to `live`, which we do not claim for a venue that
 * is not printing.
 */
export function fromVenueFeedState(state: VenueFeedState | string | null | undefined): FreshState {
  switch (state) {
    case "live":
      return "live";
    case "delayed":
      return "delayed";
    case "closed":
    case "halted":
    case "auction":
      return "closed";
    case "offline":
    case "reconnecting":
      return "offline";
    default:
      // Unknown/missing degrades to delayed, never to live.
      return "delayed";
  }
}

export function BlockFresh({ node }: { node: BlockNodeOf<"BLK-FRESH"> }) {
  const p = node.payload;
  const face = FACES[p.state];
  if (!face) {
    warnConstraint("BLK-FRESH", `unknown state "${p.state}" — the block has exactly four.`);
    return null;
  }
  return (
    <span className="inline-flex w-fit items-center gap-1.5">
      <span className={`h-[6px] w-[6px] flex-none rounded-full ${face.dot}`} aria-hidden />
      <span className="font-mono text-[8.5px] tracking-[0.08em] text-ink-muted">{face.label(p)}</span>
    </span>
  );
}
