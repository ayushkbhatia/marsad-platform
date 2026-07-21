import { runSearch } from "@/lib/data/search";

/**
 * GET /api/search?q=… — federated search JSON contract (04-reader-app.md §6).
 *
 * Thin wrapper around the cached `runSearch()` data-layer fn (which itself
 * calls `public.fn_search` via the anon RPC — never a direct table read).
 * CDN-cacheable per query string: `createAnonClient()` underneath emits no
 * `Set-Cookie`, so `s-maxage=300` is honored at the edge exactly like
 * `/api/screener/run`.
 *
 * RATE-LIMIT NOTE (04 §6 Revisions, "RPC surface hardened"): `fn_search` is
 * anon-EXECUTE and runs an FTS + trigram scan per call — cheap at today's
 * corpus (762 securities + ~14k filings, single-digit ms) but, like
 * `/api/screener/run`, an anon-invokable compute surface. Per-session/IP rate
 * limiting is a shared/cross-cutting concern (no rate-limit middleware exists
 * in the repo yet — `/api/screener/run` carries the same open TODO) and
 * belongs with whichever edge/middleware layer the lead adds for both routes
 * together; not added here to avoid a one-off, uncoordinated implementation.
 */

const CACHE = "public, s-maxage=300, stale-while-revalidate=600";
const MAX_Q_LEN = 200;

function json(body: unknown, cacheControl: string, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cacheControl,
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  const sp = new URL(request.url).searchParams;
  const q = (sp.get("q") ?? "").trim().slice(0, MAX_Q_LEN);

  if (!q) {
    return json({ q: "", hits: [], totalCount: 0, typeCounts: [], topSecurity: null }, "no-store");
  }

  const result = await runSearch(q);
  return json(result, CACHE);
}
