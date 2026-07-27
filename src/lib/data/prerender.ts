import "server-only";

/**
 * The one rule every `generateStaticParams` in this app has to follow.
 *
 * ── THE BUG THIS EXISTS TO PREVENT ─────────────────────────────────────────
 * Every prerender-head reader was written as `const { data } = await sb.from(…)`,
 * discarding `error`. That reads fine until a query fails, and then a DB fault
 * becomes indistinguishable from "there is nothing to prerender". Next 16 under
 * Cache Components rejects an empty `generateStaticParams`, so the build died
 * with `EmptyGenerateStaticParamsError` — an error that names the wrong cause,
 * usually on a route nobody had touched.
 *
 * That is not hypothetical: `main` shipped a red build for 10 commits
 * (c181a86..a5b8d6c) because `ohlcv_daily` had no index leading with
 * `trade_date`, the turnover query blew the `anon` role's **3s**
 * `statement_timeout`, and the resulting error was silently converted to `[]`.
 * Vercel was the only gate that could see it, and nobody was reading it.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 * Two halves, pulling in opposite directions on purpose:
 *
 *   1. An error is NEVER silently an empty list. It is logged with its real
 *      cause, every time. Silence is what cost the 10 commits.
 *
 *   2. A warm-cache optimization NEVER fails a deploy. Nothing about
 *      correctness depends on which N pages are prerendered — the on-demand
 *      path is the same code. Failing a deploy over it is disproportionate.
 *
 * So: try the good list; if it fails or is empty, say so loudly and take the
 * cheap one. If the cheap one also comes back empty, throw — by then something
 * is genuinely wrong and a red build is the correct outcome.
 *
 * The `anon` budget is 3s per statement (`pg_roles.rolconfig`, verified
 * 2026-07-27) and a build runs ~9 workers concurrently, so a `fallback` must be
 * a query that cannot be slow: no unindexed sort, no join, no wide column list.
 * Prefer ordering by primary key.
 */
export async function prerenderHead<T>(
  label: string,
  primary: () => Promise<T[]>,
  fallback: () => Promise<T[]>,
): Promise<T[]> {
  try {
    const rows = await primary();
    if (rows.length > 0) return rows;
    console.warn(`[prerender:${label}] primary head came back EMPTY — falling back`);
  } catch (err) {
    console.error(
      `[prerender:${label}] primary head FAILED, falling back. The prerendered pages are not ` +
        `the intended ones. Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const rows = await fallback();
  if (rows.length === 0) {
    throw new Error(
      `[prerender:${label}] fallback head is ALSO empty. generateStaticParams cannot be ` +
        `satisfied and Cache Components rejects an empty result. This is not a slow-query ` +
        `artefact — check anon RLS and that the table has rows.`,
    );
  }
  return rows;
}

/**
 * The sitemap's counterpart: a section that may be missing but must never fail
 * the build.
 *
 * ⚠️ NEVER back a `generateStaticParams` with this. It returns `[]` on failure,
 * and an empty `generateStaticParams` is a hard error under Cache Components —
 * so using it there converts a recoverable fault into a dead build, which is the
 * exact bug `prerenderHead` exists to prevent. I made that mistake on
 * `/articles/[slug]`: it passed locally and killed the Vercel production build.
 * If the caller is a `generateStaticParams`, it needs `prerenderHead` and a
 * fallback that cannot be slow.
 *
 * `sitemap.ts` is one file whose sections are independent — losing filing URLs
 * should not cost the article URLs too, and neither should cost a deploy. But a
 * failure still has to be *seen*, because an omitted section and an empty one
 * look identical in the output.
 *
 * The filings section is the one that motivates this: it sorts 14,710 rows on an
 * unindexed `filed_at` and takes ~1.7s of the `anon` role's 3s budget, so it is
 * one slow build away from silently dropping the whole section. Measured, it
 * currently succeeds — and returns exactly 1,000 rows against a `limit(10000)`,
 * because PostgREST caps responses at `db-max-rows`. See
 * DEF-SITEMAP-POSTGREST-ROW-CAP.
 */
export async function optionalList<T>(label: string, fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch (err) {
    console.error(
      `[${label}] section FAILED and is being OMITTED from the sitemap. ` +
        `Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}
