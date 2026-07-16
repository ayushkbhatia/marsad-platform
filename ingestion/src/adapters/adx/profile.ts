// ingestion/src/adapters/adx/profile.ts
//
// ADX (Abu Dhabi) native securities-profile TaskSpec — sector / isin / shares_outstanding for the ~93
// ADX names from the exchange-native company overview.json (07 §2.2 "Profile … ADX: … ADX overview.json").
// ADX has NO aggregator (not on Yahoo, Mubasher pages are shells for it) → exchange-native is the only
// path, and the cookie-seated Chromium request-context + apigateway gateway headers already exist
// (adapters/adx/quotes.ts, DEF-ADX-QUOTES). This is the profile analogue.
//
// Transport: http_bootstrap (Playwright request-context). www.adx.ae / apigateway.adx.ae are Akamai-WAF'd
// (403 to plain HTTP), so fetch() uses ctx.browser: bootstrap() seats the WAF cookies ONCE per chunk,
// then one in-context GET per injected symbol (urlTemplate.replace({symbol})) with the pinned gateway
// headers. Per-ticker isolation: one company's 404/challenge never aborts the chunk.
//
// CONFIG-DRIVEN + VPS-PINNED: the exact overview URL + JSON field paths (Next.js SSR — likely under
// pageProps/props.pageProps) are pinned in endpoint_config (urlTemplate + profileFieldMap + headers) on
// the first VPS capture; DEFAULT_ADX_PROFILE_MAP is a best-effort placeholder. Seed active=false until
// pinned + a golden fixture is captured. parse() reuses the shared PURE parseProfileDoc.

import type {
  FetchContext,
  FetchResult,
  NormalizedProfile,
  TaskSpec,
} from '../../core/types.js';
import { browserOpts } from './quotes.js';
import {
  parseProfileDoc,
  profileSymbols,
  PROFILE_PARSER_VERSION,
  type ProfileFieldMap,
} from '../profile/shared.js';

/**
 * Best-effort DEFAULT field map for the ADX company overview.json. PIN THE REAL PATHS from a live VPS
 * capture into endpoint_config.profileFieldMap (which overrides this) + add a golden fixture before
 * activation. ADX serves a Next.js SSR JSON, so the company node is typically nested (rowsPath).
 */
export const DEFAULT_ADX_PROFILE_MAP: ProfileFieldMap = {
  rowsPath: 'pageProps.overview',
  sector: 'sectorNameEn',
  industry: 'subSectorNameEn',
  isin: 'isin',
  shares: 'numberOfShares',
  symbol: 'companySymbol',
};

/**
 * fetch(): browser context. Bootstrap seats the Akamai/bpm WAF cookies ONCE, then one in-context GET per
 * injected symbol. The per-company overview URL is the pinned endpoint_config.urlTemplate with {symbol}
 * substituted; gateway headers (adx-gateway-apikey / channel-id / referer, like ADX quotes) come from
 * endpoint_config.headers. Streams via ctx.onFetched when supplied, else returns an array. Per-ticker
 * isolation: a failed company is logged + skipped, never aborts the chunk.
 */
async function fetchAdxProfiles(ctx: FetchContext): Promise<FetchResult[]> {
  const { source, browser, logger, now } = ctx;
  const cfg = source.endpointConfig;
  const tmpl = cfg.urlTemplate;
  if (!tmpl) {
    throw new Error(`ADX profile fetch: source ${source.id} missing endpoint_config.urlTemplate`);
  }
  // Seat WAF cookies once (best-effort — browser.get self-seats on a 401/403 via its one-free-retry).
  if (cfg.actionDiscovery) {
    try {
      await browser.bootstrap(cfg.actionDiscovery);
    } catch (err) {
      logger.warn('ADX profile bootstrap failed (continuing; get() self-retries)', {
        sourceId: source.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const fieldMap =
    (source.endpointConfig as unknown as { profileFieldMap?: ProfileFieldMap }).profileFieldMap ??
    DEFAULT_ADX_PROFILE_MAP;

  const one = async (ticker: string): Promise<FetchResult | null> => {
    const url = tmpl.replace(/\{symbol\}/g, encodeURIComponent(ticker));
    try {
      const resp = await browser.get(url, browserOpts(cfg.headers, 30_000));
      if (resp.status < 200 || resp.status >= 300) {
        logger.warn('ADX profile: non-2xx, skipping ticker', { ticker, status: resp.status });
        return null;
      }
      return {
        externalId: ticker,
        url: resp.url,
        contentType: resp.headers['content-type'] ?? 'application/json',
        httpStatus: resp.status,
        body: resp.body,
        fetchedAt: now(),
        meta: { dataType: 'securities_profile', venue: 'ADX', ticker, profileFieldMap: fieldMap, lang: 'en' },
      };
    } catch (err) {
      logger.warn('ADX profile: fetch failed, skipping ticker', { ticker, err: String(err).slice(0, 140) });
      return null;
    }
  };

  const targets = profileSymbols(ctx);
  if (ctx.onFetched) {
    const sink = ctx.onFetched;
    // Sequential through the single browser context (the per-host ≤1 req/s bucket paces it anyway).
    for (const ticker of targets) {
      const fr = await one(ticker);
      if (fr) await sink(fr);
    }
    return [];
  }
  const out: FetchResult[] = [];
  for (const ticker of targets) {
    const fr = await one(ticker);
    if (fr) out.push(fr);
  }
  return out;
}

export const adxProfile: TaskSpec<NormalizedProfile> = {
  dataType: 'securities_profile',
  parserVersion: PROFILE_PARSER_VERSION,
  fetch: fetchAdxProfiles,
  parse: parseProfileDoc,
};
