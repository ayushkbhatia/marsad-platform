/**
 * sources.seed.ts — local mirror of the ingest.sources + ingest.schedules seed.
 *
 * CONTRACT.md §1/§8 path: `ingestion/src/config/sources.seed.ts` — the ONE sources-seed
 * migration input. Modules that import the seed by the frozen contract path resolve it here.
 *
 * This is the TypeScript reference for `supabase/migrations/20260713000017_ingest_sources.sql`.
 * The migration is the source of truth applied to the live DB; this file mirrors it 1:1 for
 * local reference and for the golden test that guards the two from drifting (sources.test.ts).
 *
 * Locked constraints (CONTRACT.md §0): scrape-only + DELAYED; all 6 venues; English only;
 * config-over-code (endpoints live here, never hardcoded in adapters); snapshot-first.
 *
 * The type shapes below mirror the frozen contract in `ingestion/src/core/types.ts` (CONTRACT §2).
 * They are re-declared locally (not imported) so the config package stays self-contained and
 * usable before `src/core/types.ts` is built by the core-framework module. Names/fields MUST match
 * the contract — the frozen file is the source of truth if they ever diverge.
 */

// ---- mirrored contract types (CONTRACT.md §2) --------------------------------

export type VenueCode = 'TDWL' | 'DFM' | 'ADX' | 'QE' | 'MSX' | 'BHB';

export type DataType =
  | 'quotes'
  | 'indices'
  | 'filings_list'
  | 'filing_detail'
  | 'financials'
  | 'securities_profile'
  | 'dividends'
  | 'ipo'
  | 'calendar'
  | 'eod_bulletin'
  | 'ohlcv_backfill';

// ingest.sources.transport CHECK ∈ ('http','http_bootstrap','headless') — 0005 DDL.
export type Transport = 'http' | 'http_bootstrap' | 'headless';

export type RobotsStatus = 'allowed' | 'disallowed' | 'override';

export interface NormalizeRule {
  pattern: string;
  replacement: string;
  flags?: string;
}

export interface ActionDiscovery {
  navigateUrl: string;
  extract: 'datatable_ajax' | 'network_capture';
  responseUrlPattern?: string;
}

export interface EndpointConfig {
  method?: 'GET' | 'POST';
  urlTemplate?: string;
  headers?: Record<string, string>;
  pagination?: { param: string; start: number; pageSize?: number };
  actionDiscovery?: ActionDiscovery;
  responseKind: 'json' | 'html' | 'txt_json' | 'xlsx' | 'pdf';
}

// ---- seed row shapes ---------------------------------------------------------

/** One ingest.sources seed row. Columns map 1:1 to the 0005 DDL (defaults omitted). */
export interface SourceSeed {
  venue: VenueCode;
  dataType: DataType;
  entryUrl: string;
  endpointConfig: EndpointConfig;
  normalizeRules: NormalizeRule[];
  transport: Transport;
  robotsStatus: RobotsStatus;
  active: boolean;
  /** the paired ingest.schedules row */
  schedule: ScheduleSeed;
}

/** One ingest.schedules seed row (per source). Columns per 0005 DDL. */
export interface ScheduleSeed {
  cadenceMinutes: number;
  sessionOnly: boolean;
  offsetMinutes: number;
  active: boolean;
}

// Stagger per CONTRACT §8: TDWL+0 DFM+1 ADX+2 QE+3 MSX+4 BHB+5.
const OFFSET: Record<VenueCode, number> = {
  TDWL: 0,
  DFM: 1,
  ADX: 2,
  QE: 3,
  MSX: 4,
  BHB: 5,
};

// Cadence law (01 §4.2, CONTRACT §8): quotes 10min session-only; filings_list 5min;
// eod_bulletin coarse 60min (eod_sweep handler self-gates at close+30).
function quotesSchedule(v: VenueCode): ScheduleSeed {
  return { cadenceMinutes: 10, sessionOnly: true, offsetMinutes: OFFSET[v], active: true };
}
function filingsSchedule(v: VenueCode): ScheduleSeed {
  return { cadenceMinutes: 5, sessionOnly: false, offsetMinutes: OFFSET[v], active: true };
}
function eodSchedule(v: VenueCode): ScheduleSeed {
  return { cadenceMinutes: 60, sessionOnly: false, offsetMinutes: OFFSET[v], active: true };
}

// ---- the seed ----------------------------------------------------------------

export const SOURCE_SEED: readonly SourceSeed[] = [
  // ======================= TDWL (Saudi / Tadawul) =======================
  // Akamai-WAF'd → http_bootstrap. Full-market JSON via NJgetMainNomucMarketDetails
  // (portal action id + PUID scraped at runtime, never hardcoded). ct text/html, body JSON.
  {
    venue: 'TDWL',
    dataType: 'quotes',
    entryUrl:
      'https://www.saudiexchange.sa/wps/portal/saudiexchange/ourmarkets/main-market-watch',
    endpointConfig: {
      method: 'GET',
      responseKind: 'json',
      actionDiscovery: {
        navigateUrl:
          'https://www.saudiexchange.sa/wps/portal/saudiexchange/ourmarkets/main-market-watch',
        extract: 'datatable_ajax',
        responseUrlPattern: 'NJgetMainNomucMarketDetails',
      },
      urlTemplate:
        '{discoveredActionUrl}?sectorParameter=&tableViewParameter=1&iswatchListSelected=NO&requestLocale=en&_={epochMs}',
    },
    normalizeRules: [
      { pattern: '"transactionDate":"[^"]*"', replacement: '"transactionDate":""' },
      { pattern: '"lastUpdatetime":"[^"]*"', replacement: '"lastUpdatetime":""' },
    ],
    transport: 'http_bootstrap',
    robotsStatus: 'allowed',
    active: true,
    schedule: quotesSchedule('TDWL'),
  },
  {
    venue: 'TDWL',
    dataType: 'filings_list',
    entryUrl:
      'https://www.saudiexchange.sa/wps/portal/saudiexchange/newsandreports/issuer-news',
    endpointConfig: {
      method: 'GET',
      responseKind: 'json',
      actionDiscovery: {
        navigateUrl:
          'https://www.saudiexchange.sa/wps/portal/saudiexchange/newsandreports/issuer-news',
        extract: 'datatable_ajax',
        responseUrlPattern: 'IssuerNews|issuer-news|getNews',
      },
      pagination: { param: 'pageNumber', start: 1, pageSize: 50 },
    },
    normalizeRules: [],
    transport: 'http_bootstrap',
    robotsStatus: 'allowed',
    active: true,
    schedule: filingsSchedule('TDWL'),
  },
  {
    venue: 'TDWL',
    dataType: 'eod_bulletin',
    // TODO(vps): pin the daily market-report XLSX archive/download action on first VPS run.
    entryUrl:
      'https://www.saudiexchange.sa/wps/portal/saudiexchange/newsandreports/reports-publications/market-reports',
    endpointConfig: {
      method: 'GET',
      responseKind: 'xlsx',
      actionDiscovery: {
        navigateUrl:
          'https://www.saudiexchange.sa/wps/portal/saudiexchange/newsandreports/reports-publications/market-reports',
        extract: 'datatable_ajax',
        responseUrlPattern: 'MarketReport|daily.*\\.xlsx',
      },
    },
    normalizeRules: [],
    transport: 'http_bootstrap',
    robotsStatus: 'allowed',
    active: true,
    schedule: eodSchedule('TDWL'),
  },

  // ======================= DFM (Dubai) =======================
  // SPA-over-JSON on api2.dfm.ae. http_bootstrap (may be challenged).
  {
    venue: 'DFM',
    dataType: 'quotes',
    entryUrl: 'https://marketwatch.dfm.ae/en',
    endpointConfig: {
      method: 'GET',
      responseKind: 'json',
      // TODO(vps): pin exact api2.dfm.ae /mw/v1 market-watch route from SPA bundle.
      actionDiscovery: {
        navigateUrl: 'https://marketwatch.dfm.ae/en',
        extract: 'network_capture',
        responseUrlPattern: '^https://api2\\.dfm\\.ae/mw/v1/',
      },
    },
    normalizeRules: [],
    transport: 'http_bootstrap',
    robotsStatus: 'allowed',
    active: true,
    schedule: quotesSchedule('DFM'),
  },
  {
    venue: 'DFM',
    dataType: 'filings_list',
    entryUrl: 'https://www.dfm.ae/en/the-exchange/news-disclosures/disclosures',
    endpointConfig: {
      method: 'GET',
      responseKind: 'json',
      // TODO(vps): pin exact api2.dfm.ae /efsah/v1 disclosures route from SPA bundle.
      actionDiscovery: {
        navigateUrl: 'https://www.dfm.ae/en/the-exchange/news-disclosures/disclosures',
        extract: 'network_capture',
        responseUrlPattern: '^https://api2\\.dfm\\.ae/efsah/v1/',
      },
      pagination: { param: 'page', start: 1, pageSize: 50 },
    },
    normalizeRules: [],
    transport: 'http_bootstrap',
    robotsStatus: 'allowed',
    active: true,
    schedule: filingsSchedule('DFM'),
  },
  {
    venue: 'DFM',
    dataType: 'eod_bulletin',
    entryUrl: 'https://www.dfm.ae/en/the-exchange/market-information/market-statistics',
    endpointConfig: {
      method: 'GET',
      responseKind: 'xlsx',
      // TODO(vps): pin daily-bulletin XLSX/PDF download route on first VPS run.
      actionDiscovery: {
        navigateUrl: 'https://www.dfm.ae/en/the-exchange/market-information/market-statistics',
        extract: 'network_capture',
        responseUrlPattern: 'bulletin|daily.*\\.(xlsx|pdf)',
      },
    },
    normalizeRules: [],
    transport: 'http_bootstrap',
    robotsStatus: 'allowed',
    active: true,
    schedule: eodSchedule('DFM'),
  },

  // ======================= ADX (Abu Dhabi) =======================
  // WAF-fronted → http_bootstrap. Exact JSON-services paths DEFERRED to first VPS run.
  {
    venue: 'ADX',
    dataType: 'quotes',
    // PLACEHOLDER url — TODO(vps): discover ADX market-data JSON-services URL via
    // page.on('response') on the first VPS run; ADX serves the full board as JSON.
    entryUrl: 'https://www.adx.ae/english/pages/marketinformation/marketwatch.aspx',
    endpointConfig: {
      method: 'GET',
      responseKind: 'json',
      actionDiscovery: {
        navigateUrl: 'https://www.adx.ae/english/pages/marketinformation/marketwatch.aspx',
        extract: 'network_capture',
        responseUrlPattern: 'adx\\.ae.*(market|watch|quote|board)',
      },
    },
    normalizeRules: [],
    transport: 'http_bootstrap',
    robotsStatus: 'allowed',
    active: true,
    schedule: quotesSchedule('ADX'),
  },
  {
    venue: 'ADX',
    dataType: 'filings_list',
    entryUrl: 'https://www.adx.ae/english/pages/newsandevents/disclosures.aspx',
    endpointConfig: {
      method: 'GET',
      responseKind: 'json',
      // TODO(vps): discover ADX disclosures JSON list URL on first VPS run.
      actionDiscovery: {
        navigateUrl: 'https://www.adx.ae/english/pages/newsandevents/disclosures.aspx',
        extract: 'network_capture',
        responseUrlPattern: 'adx\\.ae.*(news|disclosure|announcement)',
      },
      pagination: { param: 'page', start: 1, pageSize: 50 },
    },
    normalizeRules: [],
    transport: 'http_bootstrap',
    robotsStatus: 'allowed',
    active: true,
    schedule: filingsSchedule('ADX'),
  },
  {
    venue: 'ADX',
    dataType: 'eod_bulletin',
    entryUrl: 'https://www.adx.ae/english/pages/marketinformation/tradingreport.aspx',
    endpointConfig: {
      method: 'GET',
      responseKind: 'xlsx',
      // TODO(vps): pin ADX daily trading report download route on first VPS run.
      actionDiscovery: {
        navigateUrl: 'https://www.adx.ae/english/pages/marketinformation/tradingreport.aspx',
        extract: 'network_capture',
        responseUrlPattern: 'adx\\.ae.*(report|daily).*\\.(xlsx|xls|pdf)',
      },
    },
    normalizeRules: [],
    transport: 'http_bootstrap',
    robotsStatus: 'allowed',
    active: true,
    schedule: eodSchedule('ADX'),
  },

  // ======================= QE (Qatar) =======================
  // Plain HTTP. CONFIRMED clean-JSON board at qse_files/MarketWatch.txt (txt_json).
  {
    venue: 'QE',
    dataType: 'quotes',
    entryUrl: 'https://www.qe.com.qa/pps/qse_files/MarketWatch.txt',
    endpointConfig: {
      method: 'GET',
      responseKind: 'txt_json',
      urlTemplate: 'https://www.qe.com.qa/pps/qse_files/MarketWatch.txt',
      headers: { Referer: 'https://www.qe.com.qa/' },
    },
    normalizeRules: [],
    transport: 'http',
    robotsStatus: 'allowed',
    active: true,
    schedule: quotesSchedule('QE'),
  },
  {
    venue: 'QE',
    dataType: 'filings_list',
    entryUrl: 'https://www.qe.com.qa/company-news',
    endpointConfig: {
      method: 'GET',
      responseKind: 'html',
      // TODO(vps): confirm announcements/data-set feed shape (/frontend-js-api/data-set).
      urlTemplate: 'https://www.qe.com.qa/company-news',
      pagination: { param: 'page', start: 1, pageSize: 50 },
    },
    normalizeRules: [],
    transport: 'http',
    robotsStatus: 'allowed',
    active: true,
    schedule: filingsSchedule('QE'),
  },
  {
    venue: 'QE',
    dataType: 'eod_bulletin',
    entryUrl: 'https://www.qe.com.qa/daily-market-report',
    endpointConfig: {
      method: 'GET',
      responseKind: 'xlsx',
      // TODO(vps): pin QE daily bulletin archive (PDF/XLS) download route.
      urlTemplate: 'https://www.qe.com.qa/daily-market-report',
    },
    normalizeRules: [],
    transport: 'http',
    robotsStatus: 'allowed',
    active: true,
    schedule: eodSchedule('QE'),
  },

  // ======================= MSX (Muscat) =======================
  // Board assembly behind an SPA with reCAPTCHA on some paths → http_bootstrap for
  // quotes. snapshot.aspx?s= is per-security and NOT captcha-gated (fallback path).
  {
    venue: 'MSX',
    dataType: 'quotes',
    entryUrl: 'https://www.msx.om/market-watch',
    endpointConfig: {
      method: 'GET',
      responseKind: 'json',
      // TODO(vps): pin MSX market-watch JSON route; reCAPTCHA on some paths.
      actionDiscovery: {
        navigateUrl: 'https://www.msx.om/market-watch',
        extract: 'network_capture',
        responseUrlPattern: 'msx\\.om.*(market|watch|board|quote)',
      },
      // Fallback: iterate snapshot.aspx?s={symbol} (html) per security.
      urlTemplate: 'https://www.msx.om/snapshot.aspx?s={symbol}',
    },
    normalizeRules: [],
    transport: 'http_bootstrap',
    robotsStatus: 'allowed',
    active: true,
    schedule: quotesSchedule('MSX'),
  },
  {
    venue: 'MSX',
    dataType: 'filings_list',
    entryUrl: 'https://www.msx.om/details.aspx?b1=News&t=News',
    endpointConfig: {
      method: 'GET',
      responseKind: 'html',
      // TODO(vps): add Disclosures/Circulars sibling routes as additional rows if
      // they carry distinct external_id namespaces.
      urlTemplate: 'https://www.msx.om/details.aspx?b1=News&t=News',
      pagination: { param: 'page', start: 1, pageSize: 50 },
    },
    normalizeRules: [],
    transport: 'http',
    robotsStatus: 'allowed',
    active: true,
    schedule: filingsSchedule('MSX'),
  },
  {
    venue: 'MSX',
    dataType: 'eod_bulletin',
    entryUrl: 'https://www.msx.om/reports.aspx?t=Daily',
    endpointConfig: {
      method: 'GET',
      responseKind: 'xlsx',
      // TODO(vps): pin MSX daily/monthly bulletin archive download route.
      urlTemplate: 'https://www.msx.om/reports.aspx?t=Daily',
    },
    normalizeRules: [],
    transport: 'http',
    robotsStatus: 'allowed',
    active: true,
    schedule: eodSchedule('MSX'),
  },

  // ======================= BHB (Bahrain) =======================
  // Plain HTTP. webapi.bahrainbourse.com JSON host. Daily-Trading-Summary.aspx = EOD gold.
  {
    venue: 'BHB',
    dataType: 'quotes',
    entryUrl: 'https://www.bahrainbourse.com/en',
    endpointConfig: {
      method: 'GET',
      responseKind: 'json',
      // TODO(vps): pin exact webapi.bahrainbourse.com/api market-watch route from SPA bundle.
      actionDiscovery: {
        navigateUrl: 'https://www.bahrainbourse.com/en',
        extract: 'network_capture',
        responseUrlPattern: '^https://webapi\\.bahrainbourse\\.com/api/',
      },
    },
    normalizeRules: [],
    transport: 'http',
    robotsStatus: 'allowed',
    active: true,
    schedule: quotesSchedule('BHB'),
  },
  {
    venue: 'BHB',
    dataType: 'filings_list',
    entryUrl: 'https://www.bahrainbourse.com/en/news-announcements',
    endpointConfig: {
      method: 'GET',
      responseKind: 'html',
      // TODO(vps): confirm BHB news/announcements list shape (HTML or webapi JSON).
      urlTemplate: 'https://www.bahrainbourse.com/en/news-announcements',
      pagination: { param: 'page', start: 1, pageSize: 50 },
    },
    normalizeRules: [],
    transport: 'http',
    robotsStatus: 'allowed',
    active: true,
    schedule: filingsSchedule('BHB'),
  },
  {
    venue: 'BHB',
    dataType: 'eod_bulletin',
    // EOD gold source.
    entryUrl:
      'https://www.bahrainbourse.com/en/Stocks/Pages/Daily-Trading-Summary.aspx',
    endpointConfig: {
      method: 'GET',
      responseKind: 'xlsx',
      // TODO(vps): pin the XLSX download link off the summary page.
      urlTemplate:
        'https://www.bahrainbourse.com/en/Stocks/Pages/Daily-Trading-Summary.aspx',
    },
    normalizeRules: [],
    transport: 'http',
    robotsStatus: 'allowed',
    active: true,
    schedule: eodSchedule('BHB'),
  },
] as const;

/** The 6 active GCC venues (BK Kuwait is inactive — no ingestion). CONTRACT §0.2. */
export const VENUES: readonly VenueCode[] = ['TDWL', 'DFM', 'ADX', 'QE', 'MSX', 'BHB'];

/** Lookup a single seed row by (venue, dataType). */
export function findSource(venue: VenueCode, dataType: DataType): SourceSeed | undefined {
  return SOURCE_SEED.find((s) => s.venue === venue && s.dataType === dataType);
}
