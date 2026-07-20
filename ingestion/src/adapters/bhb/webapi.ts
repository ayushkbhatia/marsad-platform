// Shared BHB webapi auth — the dynamic APIKey Bearer used by BOTH quotes and filings.
//
// The BHB webapi (webapi.bahrainbourse.com) requires `Authorization: Bearer <APIKey>` where APIKey is
// a PUBLIC client token embedded in the homepage JS (`APIKey = '<64hex>'`) that ROTATES several
// times/day. Pinning it in endpoint_config is a time-bomb (BHB 401s on rotation), so we scrape it fresh
// from the homepage, cache it in-process across polls (shared by every BHB webapi source — one token
// serves quotes AND filings), and re-scrape ONCE on an auth failure. Both the homepage scrape and the
// webapi return 200 DIRECT from the VPS (the historical Cloudflare/geo block is gone) — no proxy.

import type { FetchContext, RawResponse } from '../../core/types.js';
import { FetchError } from '../../core/types.js';

let cachedApiKey: string | null = null;

/** Test-only: reset the in-process APIKey cache so fetch tests are order-independent. */
export function __resetBhbApiKeyCache(): void {
  cachedApiKey = null;
}

export const BHB_TOKEN_PAGE = 'https://www.bahrainbourse.com/en';
const API_KEY_RE = /APIKey['"]?\s*[:=]\s*['"]([a-fA-F0-9]{32,})['"]/;
export const BHB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export interface BhbWebapiConfig {
  urlTemplate?: string;
  tokenPageUrl?: string;
  headers?: Record<string, string>;
}

/** Scrape the current APIKey from the BHB homepage (plain HTTP). null on any failure / no key. */
export async function scrapeApiKey(ctx: FetchContext, cfg: BhbWebapiConfig): Promise<string | null> {
  const pageUrl = cfg.tokenPageUrl ?? BHB_TOKEN_PAGE;
  try {
    const res = await ctx.http.get(pageUrl, { headers: { 'user-agent': BHB_UA } });
    if (res.status < 200 || res.status >= 300) return null;
    return API_KEY_RE.exec(res.body.toString('utf8'))?.[1] ?? null;
  } catch (err) {
    ctx.logger?.warn('bhb webapi: APIKey scrape failed', { err: String(err).slice(0, 140) });
    return null;
  }
}

/** webapi GET headers: source headers with any Authorization/User-Agent stripped, then a LOWERCASE
 *  authorization Bearer (live token) + lowercase user-agent. Lowercase keys override the fetcher's
 *  defaults instead of duplicating them (a dup header trips BHB's Cloudflare 400). */
export function webapiHeaders(cfg: BhbWebapiConfig, token: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg.headers ?? {})) {
    if (/^(authorization|user-agent)$/i.test(k)) continue; // set canonically below
    out[k.toLowerCase()] = v;
  }
  out['user-agent'] = cfg.headers?.['user-agent'] ?? cfg.headers?.['User-Agent'] ?? BHB_UA;
  out['authorization'] = `Bearer ${token}`;
  if (!out['accept']) out['accept'] = 'application/json';
  return out;
}

const AUTH_FAILURE_STATUSES = new Set([400, 401, 403]);

/**
 * GET a BHB webapi URL with the dynamic Bearer: reuse the cached APIKey (else scrape one), and on an
 * auth failure (401/403, or the Cloudflare 400) re-scrape ONCE and retry with the fresh key. Caches
 * the working key in-process. Throws HTTP_4XX only when no key can be obtained at all, or the retry
 * also fails.
 *
 * ctx.http.get THROWS FetchError('HTTP_4XX', …, {status}) on any >=400 response — it never returns a
 * RawResponse for one — so the retry-on-401 branch must catch that throw, not branch on `res.status`
 * (a prior version did the latter, which made the retry dead code: the first call always threw before
 * any status check could run, so a rotated APIKey wedged every BHB webapi call — quotes AND filings —
 * for good until the whole worker process restarted and re-scraped cold. Root-caused 2026-07-20).
 */
export async function bhbWebapiGet(
  ctx: FetchContext,
  url: string,
  cfg: BhbWebapiConfig,
): Promise<RawResponse> {
  let token = cachedApiKey ?? (await scrapeApiKey(ctx, cfg));
  if (!token) {
    throw new FetchError(
      'HTTP_4XX',
      'bhb webapi: could not obtain an APIKey from the BHB homepage (scrape found no `APIKey = …`)',
    );
  }
  try {
    const res = await ctx.http.get(url, { headers: webapiHeaders(cfg, token) });
    cachedApiKey = token; // remember the working key
    return res;
  } catch (err) {
    if (!(err instanceof FetchError) || !AUTH_FAILURE_STATUSES.has(err.status ?? 0)) throw err;
    const fresh = await scrapeApiKey(ctx, cfg);
    if (!fresh || fresh === token) throw err; // no better key available — surface the original failure
    const res = await ctx.http.get(url, { headers: webapiHeaders(cfg, fresh) }); // let a second failure throw
    cachedApiKey = fresh;
    return res;
  }
}
