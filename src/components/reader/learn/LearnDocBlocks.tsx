import type { LearnDocBlock, LearnDocNote } from "@/lib/learn/docs";
import { SectionBar } from "@/components/ui";

/**
 * Renders a `LearnDoc`'s content blocks (20f). Slice-private — the block
 * shape is authored content, not a shared design-system primitive, so this
 * lives under `reader/learn/` rather than `components/ui/*` (CONVENTIONS §1.2).
 * Reuses `SectionBar` for the black section-heading band so a doc page reads
 * like every other data-dense reader surface.
 */
export function LearnDocBlocks({ blocks }: { blocks: LearnDocBlock[] }) {
  return (
    <div className="flex flex-col gap-7">
      {blocks.map((block, i) => (
        <LearnBlock key={i} block={block} />
      ))}
    </div>
  );
}

function LearnBlock({ block }: { block: LearnDocBlock }) {
  return (
    <div>
      {block.heading ? <SectionBar label={block.heading} className="mb-3.5" /> : null}

      {block.paragraphs?.map((p, i) => (
        <p key={i} className="mt-3 font-ui text-[13.5px] leading-[1.7] text-ink-mid first:mt-0">
          {p}
        </p>
      ))}

      {block.bullets ? (
        <ul className="mt-3 flex flex-col gap-2">
          {block.bullets.map((b, i) => (
            <li key={i} className="flex gap-2.5 font-ui text-[13.5px] leading-[1.65] text-ink-mid">
              <span className="mt-[7px] h-[5px] w-[5px] flex-none rotate-45 bg-ink-faint" aria-hidden />
              <span>{b}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {block.ordered ? (
        <ol className="mt-3 flex flex-col gap-2">
          {block.ordered.map((b, i) => (
            <li key={i} className="flex gap-2.5 font-ui text-[13.5px] leading-[1.65] text-ink-mid">
              <span className="w-4 flex-none font-mono text-[11px] text-ink-faint">{i + 1}.</span>
              <span>{b}</span>
            </li>
          ))}
        </ol>
      ) : null}

      {block.terms ? (
        <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
          {block.terms.map((t) => (
            <div key={t.term} className="border-l-2 border-hairline-strong pl-3">
              <dt className="font-ui text-[12.5px] font-semibold text-ink">{t.term}</dt>
              <dd className="mt-0.5 font-ui text-[12.5px] leading-[1.6] text-ink-muted">{t.definition}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {block.table ? (
        <div className="mt-3 overflow-x-auto border border-hairline">
          <table className="w-full min-w-[480px] border-collapse text-left">
            <thead>
              <tr className="border-b border-hairline bg-paper-tint">
                {block.table.columns.map((c) => (
                  <th
                    key={c}
                    className="px-3 py-2 font-mono text-[8.5px] font-semibold tracking-[0.1em] text-ink-faint uppercase"
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.table.rows.map((row, i) => (
                <tr key={i} className="border-b border-hairline-faint last:border-0">
                  {row.map((cell, j) => (
                    <td
                      key={j}
                      className={`px-3 py-2.5 font-ui text-[12.5px] leading-[1.55] ${
                        j === 0 ? "font-semibold text-ink" : "text-ink-mid"
                      }`}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {block.note ? <LearnNote note={block.note} /> : null}
    </div>
  );
}

function LearnNote({ note }: { note: LearnDocNote }) {
  const kicker =
    note.kind === "important" ? "Important" : note.kind === "draft" ? "Draft — not for reliance" : "Note";
  // Monochrome only — the amber `text-caution` token is reserved for data
  // freshness (CONVENTIONS §4 color law) and must never be repurposed here.
  const strong = note.kind === "important" || note.kind === "draft";
  return (
    <div className={`border px-4 py-3.5 ${strong ? "border-ink bg-paper-tint" : "border-hairline-strong"}`}>
      <span className="font-mono text-[8.5px] font-semibold tracking-[0.14em] text-ink-faint uppercase">
        {kicker}
      </span>
      <p
        className={
          strong
            ? "mt-1.5 font-display text-[14px] font-semibold leading-[1.4] text-ink"
            : "mt-1.5 font-ui text-[12.5px] leading-[1.6] text-ink-mid"
        }
      >
        {note.text}
      </p>
    </div>
  );
}
