import { warnConstraint } from "../constraints";
import type { BlockNodeOf } from "../types";

/*
 * BLK-AGENTS · How this was built — G · Provenance & trust
 *
 * "AGENT CHIPS CARRY ◆, HUMANS DON'T · THE HUMAN IS ALWAYS LAST IN THE CHAIN"
 *
 * The block that makes agent-written journalism publishable: it says out loud
 * which machines touched the piece and which person signed it.
 */
export function BlockAgents({ node }: { node: BlockNodeOf<"BLK-AGENTS"> }) {
  const { narrative, chain, kicker = "HOW THIS WAS BUILT" } = node.payload;

  // The human is always last. Enforcing it here is cheap and the failure is
  // legible: a chain that ends in an agent is a piece nobody signed.
  const last = chain[chain.length - 1];
  if (chain.length === 0) {
    warnConstraint("BLK-AGENTS", "empty build chain — the piece claims no provenance at all.");
  } else if (!last || last.isAgent) {
    warnConstraint("BLK-AGENTS", "the chain does not end with a human — the human is always last.");
  }
  const humansBeforeEnd = chain.slice(0, -1).filter((e) => !e.isAgent);
  if (humansBeforeEnd.length > 0) {
    warnConstraint(
      "BLK-AGENTS",
      `human ${humansBeforeEnd.map((h) => h.name).join(", ")} appears before the end of the chain.`,
    );
  }

  return (
    <div className="border border-hairline bg-paper-tint px-3.5 py-3">
      <div className="font-mono text-[8px] font-semibold tracking-[0.14em] text-ink-faint">
        {kicker}
      </div>
      <p className="mt-[7px] text-[11.5px] leading-[1.6] text-ink-mid">{narrative}</p>
      <div className="mt-[9px] flex flex-wrap gap-[5px]">
        {chain.map((entry, i) => (
          <span
            key={`${entry.name}-${i}`}
            className={
              entry.isAgent
                ? "border border-hairline-strong px-1.5 py-[2px] font-mono text-[8px] text-ink-muted"
                : "border border-ink px-1.5 py-[2px] font-mono text-[8px] text-ink"
            }
          >
            {/* The ◆ is the renderer's, never the payload's — a payload that
                types its own diamond could dress an agent as a human. */}
            {entry.isAgent ? `◆ ${entry.name}` : entry.name}
          </span>
        ))}
      </div>
    </div>
  );
}
