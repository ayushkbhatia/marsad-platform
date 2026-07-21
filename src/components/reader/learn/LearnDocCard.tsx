import Link from "next/link";
import type { LearnDoc } from "@/lib/learn/docs";

/** Hub index card (20f). Square corners, hairline border, hover promotes to ink. */
export function LearnDocCard({ doc }: { doc: LearnDoc }) {
  const isDraft = doc.status === "draft-legal";
  return (
    <Link
      href={`/learn/${doc.slug}`}
      className="group flex flex-col gap-2 border border-hairline-strong bg-paper px-5 py-4 transition-colors hover:border-ink hover:bg-paper-tint"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-display text-[15px] font-semibold leading-tight text-ink">{doc.title}</span>
        <span className="flex-none font-ui text-ink-faint transition-transform group-hover:translate-x-0.5">
          →
        </span>
      </div>
      <p className="font-ui text-[12px] leading-[1.55] text-ink-muted">{doc.dek}</p>
      {isDraft ? (
        <span className="mt-1 inline-flex w-fit items-center gap-1.5 border border-hairline-strong px-1.5 py-[3px] font-mono text-[8px] font-semibold tracking-[0.12em] text-ink-faint uppercase">
          <span className="h-[5px] w-[5px] flex-none rotate-45 bg-ink-faint" aria-hidden />
          Draft
        </span>
      ) : null}
    </Link>
  );
}
