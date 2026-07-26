import { createHash, timingSafeEqual } from "node:crypto";
import { revalidatePath, revalidateTag } from "next/cache";

/**
 * POST /api/revalidate — on-demand cache invalidation (BRIDGE-BUILD-PLAN P0.6).
 *
 * Every `use cache` fn in `src/lib/data/*` declares `cacheTag(...)`, but until this
 * route existed nothing in `src/` ever called `revalidateTag` — tags only ever aged
 * out via `cacheLife`. For a news product that means a worker-published story stays
 * invisible for the length of the cache window. This endpoint is the invalidation
 * side of that contract: the publish path (P3.7) POSTs
 * `{"tags":["content","newsroom","articles"]}` here and the next request to `/wire`
 * re-reads.
 *
 * AUTH — this route is NOT covered by `src/proxy.ts`. That proxy's matcher is
 * `["/admin/:path*"]` only, so `/api/revalidate` reaches the handler unauthenticated;
 * the shared secret below is its *only* gate. Two consequences worth keeping in mind
 * if the proxy matcher is ever widened: (a) don't assume a second layer exists, and
 * (b) if `/api/*` is later added to the matcher, this handler must keep its own check
 * anyway — the worker authenticates with a secret, not with Basic-Auth admin creds.
 *
 * Fails CLOSED, exactly like the admin proxy: an unset `REVALIDATE_SECRET` is a 503,
 * never an implicit allow. The comparison is constant-time — both sides are SHA-256'd
 * to a fixed 32 bytes first, so `timingSafeEqual` can't throw on a length mismatch and
 * the *length* of the real secret doesn't leak through an early return either. The
 * secret is never echoed, logged, or included in any response body.
 *
 * ALLOWLIST — a caller may only invalidate tags this codebase actually declares
 * (`grep -rn 'cacheTag(' src/lib/`). Arbitrary strings are rejected with a 400 that
 * names the offender. Parameterised families (`stock:123`) are admitted by a strict
 * numeric regex, not by "anything containing a colon" — the ids are all integers
 * (`securityId`, `parseHolderId`, `seriesId`).
 *
 * Next 16 note: the single-argument `revalidateTag(tag)` form is deprecated; the
 * two-argument `revalidateTag(tag, "max")` marks the entry stale with
 * stale-while-revalidate semantics. `updateTag` (immediate expiry, read-your-own-
 * writes) is Server-Action-only and cannot be called from a Route Handler.
 */

// ── Allowlists (the entire public contract of this endpoint) ──────────────────

/** Literal tags declared somewhere under `src/lib/`. Keep in sync with `cacheTag(...)`. */
const TAGS = new Set([
  "analysts",
  "articles",
  "compare",
  "content",
  "datapoints",
  "dividends",
  "earnings",
  "filings",
  "freshness",
  "fx",
  "heatmap",
  "holders",
  "indices",
  "ipo",
  "movers",
  "newsroom",
  "screener",
  "search",
  "securities",
]);

/** Parameterised tag families — `stock:{id}`, `holder:{id}`, `datapoint-series:{id}`. */
const TAG_PATTERNS: readonly RegExp[] = [
  /^stock:[1-9]\d{0,17}$/,
  /^holder:[1-9]\d{0,17}$/,
  /^datapoint-series:[1-9]\d{0,17}$/,
];

/**
 * Literal app paths only: leading slash, no traversal, no `//`, no query/hash, no
 * dynamic-segment brackets (a route pattern like `/stock/[id]` would require
 * `revalidatePath`'s second `type` argument, which this contract doesn't expose).
 */
const PATH_RE = /^\/(?:[A-Za-z0-9\-._~]+\/?)*$/;

const MAX_ITEMS = 64; // per list — a publish event touches a handful of tags, not thousands
const MAX_TAG_LEN = 256; // Next's documented cache-tag ceiling
const MAX_PATH_LEN = 1024; // Next's documented path ceiling
const MAX_BODY_BYTES = 16 * 1024;

const SECRET_HEADER = "x-revalidate-secret";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/**
 * Constant-time secret compare. Digesting both sides first pins them to 32 bytes, so
 * `timingSafeEqual` never sees unequal lengths (it throws on those) and no early
 * length check leaks how long the configured secret is.
 */
function secretMatches(presented: string, configured: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(configured, "utf8").digest();
  return timingSafeEqual(a, b);
}

function isAllowedTag(tag: string): boolean {
  if (tag.length === 0 || tag.length > MAX_TAG_LEN) return false;
  if (TAGS.has(tag)) return true;
  return TAG_PATTERNS.some((re) => re.test(tag));
}

function isAllowedPath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH_LEN) return false;
  if (path.includes("..")) return false;
  return PATH_RE.test(path);
}

/** Coerce an unknown JSON field to a bounded string[]; `null` means "malformed". */
function stringList(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null;
  if (!value.every((v): v is string => typeof v === "string")) return null;
  return value.map((v) => v.trim()).filter((v) => v !== "");
}

export async function POST(request: Request): Promise<Response> {
  const configured = process.env.REVALIDATE_SECRET;

  // Fail closed — an unconfigured secret is a misconfiguration, not an open door.
  if (!configured) {
    return json({ revalidated: false, error: "revalidation is not configured" }, 503);
  }

  const presented = request.headers.get(SECRET_HEADER);
  if (!presented || !secretMatches(presented, configured)) {
    return json({ revalidated: false, error: "unauthorized" }, 401);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return json({ revalidated: false, error: "body too large" }, 413);
  }

  let body: unknown;
  try {
    body = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch {
    return json({ revalidated: false, error: "body must be valid JSON" }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json({ revalidated: false, error: "body must be a JSON object" }, 400);
  }

  const { tags: rawTags, paths: rawPaths } = body as { tags?: unknown; paths?: unknown };

  const tags = stringList(rawTags);
  if (tags === null) {
    return json({ revalidated: false, error: `"tags" must be an array of at most ${MAX_ITEMS} strings` }, 400);
  }
  const paths = stringList(rawPaths);
  if (paths === null) {
    return json({ revalidated: false, error: `"paths" must be an array of at most ${MAX_ITEMS} strings` }, 400);
  }

  if (tags.length === 0 && paths.length === 0) {
    return json({ revalidated: false, error: 'nothing to do — supply "tags" and/or "paths"' }, 400);
  }

  // Validate everything BEFORE invalidating anything: a request is all-or-nothing,
  // so a rejected tag never leaves a half-applied invalidation behind.
  for (const tag of tags) {
    if (!isAllowedTag(tag)) {
      return json({ revalidated: false, error: `unknown cache tag: ${tag}` }, 400);
    }
  }
  for (const path of paths) {
    if (!isAllowedPath(path)) {
      return json({ revalidated: false, error: `invalid path: ${path}` }, 400);
    }
  }

  const uniqueTags = [...new Set(tags)];
  const uniquePaths = [...new Set(paths)];

  for (const tag of uniqueTags) revalidateTag(tag, "max");
  for (const path of uniquePaths) revalidatePath(path);

  return json({ revalidated: true, tags: uniqueTags, paths: uniquePaths });
}
