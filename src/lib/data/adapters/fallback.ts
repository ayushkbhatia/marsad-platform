/**
 * Adapter fallback helper — the transitional safety net for the sample→live swap.
 *
 * WHY THIS EXISTS: every reader surface is pixel-perfect against a design and
 * currently renders from `src/lib/data/sample/*`. As each one is re-pointed at a
 * real adapter, an empty producer (or a transient read failure) must never blank
 * a finished screen — that is the "silent blanking" risk in
 * `docs/BRIDGE-BUILD-PLAN.md` §6. During P1–P3 an adapter that returns nothing
 * falls back to the sample and logs loudly.
 *
 * THIS IS DELIBERATELY TEMPORARY. Owner decision **D-7(b)**: retire the fallback
 * per surface once that surface is genuinely live. Every call site carries a
 * `TODO(P8)` marker so step P8.5 can find and delete them all.
 *
 * IMPORTANT — this is not a licence to fabricate. It is only ever correct when
 * the sample is a faithful stand-in for content that genuinely exists upstream.
 * For a surface whose producer is known-empty (dividends, IPO, ownership), do
 * NOT wire an adapter with a fallback: ship the honest `EmptyState awaitingFeed`
 * instead (Law #2, and steps P2.4 / P2.5).
 */

/** Outcome of an adapter load — lets callers surface provenance if they want to. */
export type AdapterSource = "live" | "sample";

export interface AdapterResult<T> {
  data: T;
  source: AdapterSource;
  /** Set when the live read threw rather than simply returning empty. */
  error?: Error;
}

/**
 * Run a live adapter, falling back to the sample on empty-or-error.
 *
 * `load` should return `null` when the read succeeded but produced nothing
 * usable (no rows, or rows that cannot satisfy the contract). Throwing is also
 * handled — the error is logged and reported on the result, never swallowed
 * silently, because a persistently failing adapter that quietly serves sample
 * data forever is exactly the failure mode this project must avoid.
 */
export async function loadWithSampleFallback<T>(
  surface: string,
  load: () => Promise<T | null>,
  sample: T,
): Promise<AdapterResult<T>> {
  try {
    const live = await load();
    if (live) return { data: live, source: "live" };
    console.warn(`[adapter:${surface}] live read returned empty — serving sample`);
    return { data: sample, source: "sample" };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[adapter:${surface}] live read failed — serving sample`, error);
    return { data: sample, source: "sample", error };
  }
}

/** Convenience wrapper for call sites that only want the data. */
export async function withSampleFallback<T>(
  surface: string,
  load: () => Promise<T | null>,
  sample: T,
): Promise<T> {
  return (await loadWithSampleFallback(surface, load, sample)).data;
}

/**
 * Treat an empty array as "no data". Adapters frequently build a contract from
 * several reads where one list being empty means the whole surface is unusable.
 */
export function nonEmpty<T>(rows: T[] | null | undefined): T[] | null {
  return rows && rows.length > 0 ? rows : null;
}
