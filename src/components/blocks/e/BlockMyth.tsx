import type { BlockNodeOf } from "../types";

/**
 * BLK-MYTH · Assumption vs mechanism — E · Mechanism
 *
 * "NEVER MOCK THE ASSUMPTION · STATE IT IN THE READER'S OWN WORDS, THEN CORRECT IT"
 *
 * The first clause is a house rule with a practical reason behind it: a reader who feels mocked
 * stops reading before the mechanism arrives, so the correction never lands and the block has
 * achieved nothing. Setting the assumption in serif italic — the same face the body uses — is part
 * of that: it reads as something a person would say, not as an exhibit being held up.
 *
 * Deliberately no constraint check. Whether a sentence mocks is a judgement, and a regex that
 * guessed would either miss it or flag honest paraphrase; the fit stage and the desk own this one.
 */
export function BlockMyth({ node }: { node: BlockNodeOf<"BLK-MYTH"> }) {
  const { assumption, mechanism } = node.payload;

  return (
    <div className="my-5 grid gap-3 md:grid-cols-2">
      <div className="bg-paper-tint px-3.5 py-3" style={{ borderTopWidth: "3px", borderTopStyle: "solid", borderTopColor: "var(--color-negative)" }}>
        <div className="font-mono text-[8.5px] font-semibold tracking-[0.12em] text-negative uppercase">
          The assumption
        </div>
        <p className="mt-2 font-display text-[14.5px] leading-[1.45] text-ink italic">{assumption}</p>
      </div>

      <div className="bg-paper-tint px-3.5 py-3" style={{ borderTopWidth: "3px", borderTopStyle: "solid", borderTopColor: "var(--color-positive)" }}>
        <div className="font-mono text-[8.5px] font-semibold tracking-[0.12em] text-positive uppercase">
          What actually happens
        </div>
        <p className="mt-2 font-ui text-[12px] leading-[1.55] text-ink">{mechanism}</p>
      </div>
    </div>
  );
}
