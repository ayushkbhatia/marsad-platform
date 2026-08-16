import { BlockList } from "@/components/blocks/registry";
import { resolveNode, type BoundObject } from "@/lib/blocks/bindings";
import type { AnyBlockNode } from "@/components/blocks";

export interface DeskBlock {
  seq: number;
  kind: string;
  body: { text?: string } | Record<string, unknown>;
  gated: boolean;
  bound_object_id?: string | null;
}

/**
 * The piece as the desk must see it — exhibits included.
 *
 * ── WHAT THIS REPLACES ────────────────────────────────────────────────────────
 *     detail.blocks.map((b) => b.body?.text ?? "").join("\n\n")
 *
 * A design block's `body` IS its payload: a BLK-STATSTRIP holds `cells`, a BLK-BIGNUM holds
 * `value` and `caption`. None carries a `text` field, so every composed exhibit collapsed to an
 * empty string. On item 3 that was six of eleven blocks — the approver saw prose with silent
 * gaps where the evidence was, and was asked to approve it.
 *
 * The bindings resolve from `bound_values`, which the desk RPC supplies. The reader's
 * v_content_bound_objects cannot serve this: it is scoped to LIVE content on purpose, and a
 * piece at approval is not live. Showing a uuid instead of the figure would leave the desk
 * unable to check the one thing it is there to check.
 *
 * An unbuilt code renders as MissingBlock rather than being hidden. The desk should see that a
 * block exists and cannot be drawn — a hidden exhibit reads as no exhibit.
 */
export function DeskBody({ blocks, boundValues }: {
  blocks: DeskBlock[];
  boundValues: Record<string, BoundObject>;
}) {
  if (blocks.length === 0) {
    return <p className="font-ui text-[15px] text-ink-faint">(no body blocks)</p>;
  }

  const byId = new Map(Object.entries(boundValues ?? {}));
  const out: React.ReactNode[] = [];
  let run: AnyBlockNode[] = [];

  const flush = (key: string) => {
    if (run.length === 0) return;
    out.push(<BlockList key={`blk-${key}`} nodes={run} />);
    run = [];
  };

  for (const b of blocks) {
    const code = b.kind.trim().toUpperCase();
    if (/^BLK-[A-Z]+$/.test(code)) {
      run.push({
        _key: String(b.seq),
        code,
        payload: resolveNode(b.body, byId),
        boundObjectId: b.bound_object_id ?? null,
      } as AnyBlockNode);
      continue;
    }
    flush(String(b.seq));
    const text = (b.body as { text?: string })?.text ?? "";
    if (!text.trim()) continue;
    out.push(
      <p key={`p-${b.seq}`} className="whitespace-pre-wrap font-ui text-[15px] leading-relaxed text-ink">
        {text}
      </p>,
    );
  }
  flush("tail");

  return <div className="space-y-4">{out}</div>;
}
