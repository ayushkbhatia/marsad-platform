import type { ReactNode } from "react";
import type { NewsroomBlockView, NewsroomCitationView } from "@/lib/data/newsroom";

/**
 * Renders a WIRE/ARTICLE's body blocks with `[c1]`/`[c2]`… citation markers
 * resolved to small superscript footnote refs + a "Sources" list underneath —
 * the "[c1] resolved to a small sources note" requirement (AGENTS task brief).
 *
 * Data-only: `citations` comes from `public.v_content_citations` (anon-safe
 * wrapper over `lake.citations`, see `src/lib/data/newsroom.ts` header) and is
 * simply `[]` until that migration applies — in which case every marker is
 * left as plain literal text (never broken, never fabricated). A marker token
 * with no matching citation is also left as literal text (defensive: never
 * invent a footnote for an unresolved claim key).
 */

const MARKER_RE = /\[([a-zA-Z0-9]+)\]/g;

function renderMarked(text: string, index: Map<string, number>, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let n = 0;
  MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER_RE.exec(text))) {
    const idx = index.get(m[1]);
    if (idx == null) continue;
    if (m.index > last) nodes.push(text.slice(last, m.index));
    nodes.push(
      <sup key={`${keyPrefix}-${n++}`} className="ml-px font-mono text-[9px] font-semibold text-ink-muted">
        [{idx}]
      </sup>,
    );
    last = m.index + m[0].length;
  }
  nodes.push(text.slice(last));
  return nodes;
}

export function WireCitedBody({
  blocks,
  citations,
  proseClassName = "font-display text-[15px] leading-[1.6] text-ink-soft",
}: {
  blocks: NewsroomBlockView[];
  citations: NewsroomCitationView[];
  proseClassName?: string;
}) {
  const textBlocks = blocks.filter((b) => b.text);
  if (textBlocks.length === 0) return null;

  const ordered = [...citations].sort((a, b) =>
    a.blockKey.localeCompare(b.blockKey, undefined, { numeric: true }),
  );
  const citationIndex = new Map(ordered.map((c, i) => [c.blockKey, i + 1]));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2.5">
        {textBlocks.map((b) => (
          <p key={b.id} className={proseClassName}>
            {renderMarked(b.text ?? "", citationIndex, `b${b.id}`)}
          </p>
        ))}
      </div>

      {ordered.length > 0 ? (
        <ul className="flex flex-col gap-1 border-t border-hairline-faint pt-2">
          {ordered.map((c, i) => (
            <li key={c.blockKey} className="flex gap-1.5 font-mono text-[10px] leading-[1.5] text-ink-faint">
              <span className="flex-none text-ink-muted">[{i + 1}]</span>
              <span>
                {c.claimText ? <span className="text-ink-muted">{c.claimText}</span> : null}
                {c.claimText && c.quotedValue ? " — " : null}
                {c.quotedValue ? <span className="font-semibold text-ink">{c.quotedValue}</span> : null}
                {!c.claimText && !c.quotedValue ? <span className="text-ink-faint">Verified source</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
