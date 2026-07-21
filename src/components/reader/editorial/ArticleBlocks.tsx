import type { ArticleBlockView } from "@/lib/data/editorial";

/**
 * Article body renderer (server component). Renders exactly the blocks the
 * data layer delivered — which, for anon/free readers, is already the
 * RLS-truncated free portion (see `src/lib/data/editorial.ts` header). This
 * component never decides what's visible; it only lays out what's there.
 *
 * Only `block_kind: 'text'` has live examples today (02-data-lake.md §10 also
 * documents 'paragraph'/'heading'/'pull_quote'/'exhibit'/'data_table' and
 * BLK-* binding kinds). Those extra kinds are handled with a best-effort,
 * data-only rendering — no fabricated chart/table content — and can be
 * refined once real rows of those kinds exist.
 */
export function ArticleBlocks({ blocks }: { blocks: ArticleBlockView[] }) {
  if (blocks.length === 0) return null;

  return (
    <div className="flex flex-col gap-5">
      {blocks.map((b) => {
        const text = b.text ?? "";
        const kind = b.kind.toLowerCase();

        if (kind === "heading") {
          return (
            <h2 key={b.id} className="font-display text-heading-sm font-semibold text-ink">
              {text}
            </h2>
          );
        }

        if (kind === "pull_quote") {
          return (
            <blockquote
              key={b.id}
              className="border-l-[3px] border-ink py-1 pl-5 font-display text-[21px] leading-[1.4] italic text-ink-soft"
            >
              {text}
            </blockquote>
          );
        }

        if (kind === "exhibit" || kind === "data_table") {
          return (
            <div key={b.id} className="border border-hairline">
              <div className="border-b border-hairline-faint px-4 py-2.5 font-mono text-[10px] tracking-[0.1em] text-ink-muted uppercase">
                Exhibit
              </div>
              <div className="flex min-h-[140px] items-center justify-center px-4 py-6 text-center font-ui text-[12.5px] text-ink-faint">
                {text || "Data visualization not yet available for this exhibit."}
              </div>
            </div>
          );
        }

        if (kind.startsWith("blk-")) {
          return (
            <div key={b.id} className="border border-hairline-faint bg-paper-tint px-4 py-3">
              <span className="font-mono text-[9px] tracking-[0.12em] text-ink-faint uppercase">
                {b.kind}
              </span>
              {text ? <p className="mt-1 font-ui text-[13px] text-ink-mid">{text}</p> : null}
            </div>
          );
        }

        // 'text' / 'paragraph' / default.
        if (!text) return null;
        return (
          <p key={b.id} className="font-display text-[17px] leading-[1.72] text-ink-soft">
            {text}
          </p>
        );
      })}
    </div>
  );
}
