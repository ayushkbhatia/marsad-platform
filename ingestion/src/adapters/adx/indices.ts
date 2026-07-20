// ingestion/src/adapters/adx/indices.ts
//
// ADX (Abu Dhabi Securities Exchange) index-level TaskSpec — the FADGI headline index for the
// reader's index tape. SCAFFOLD: the deterministic backbone (projection + LIVE_LATEST refresh +
// staging fold-in) is proven and live; the one missing piece is the real per-venue index endpoint +
// field paths, which are WAF/session-gated and must be captured at market open. Everything here is
// filled in as far as possible and TYPE-CORRECT so the build stays green, but this task will NOT run
// until (1) the endpoint is pinned in endpoint_config (see the // PIN marker in fetch()), and (2) an
// ingest.sources row (venue ADX, data_type 'indices') is seeded (owner step — not seeded here).
//
// Transport: http_bootstrap (Playwright request-context), exactly like adx/quotes.ts — adx.ae is
// WAF-fronted (Akamai/bpm) and 403s plain HTTP. So fetch() uses ctx.browser and NEVER ctx.http.
//
// Config-driven parser (mirrors the quotes fieldMap discipline): parse() is PURE — JSON bytes + the
// source's index fieldMap (travels on snapshot.meta.fieldMap) → NormalizedIndexLevel. This keeps
// "ADX renamed the index field" a data fix (edit the source row) rather than a code deploy, and lets
// the parser be hardened against the real golden the moment it is captured, without touching this file.
//
// The staging fold-in is already wired: runtime.tasksForDataType folds a mounted `indices` TaskSpec
// into the quotes/indices path, mapRowsToStaging → mapIndex emits an INDEX.LEVEL staging row
// (natural_key INDEX.LEVEL:ADX:FADGI:{session}), cross-check lands the lake.object (single-source
// PENDING, refreshed in place each poll because INDEX.LEVEL is in LIVE_LATEST_TYPES), and
// lake.fn_index_level_project (migration 20260720163000) projects it to public.index_levels +
// index_levels_daily.

import type {
  FetchContext,
  FetchResult,
  NormalizedIndexLevel,
  ParseResult,
  StoredSnapshot,
  TaskSpec,
} from "../../core/types.js";
import { adxNumber, adxAsOfToUtc, getPath, browserOpts } from "./quotes.js";

/** public.indices.code for ADX's headline index (FTSE ADX General Index), venue ADX. */
export const ADX_INDEX_CODE = "FADGI";
export const ADX_INDICES_PARSER_VERSION = 1;

/**
 * Maps ADX's actual index-payload field names → NormalizedIndexLevel fields. Each value is the source
 * key (or a dotted path a.b.c) within the index node. Filled from the captured golden and stored in
 * ingest.sources.endpoint_config.fieldMap. Only `level` is required; missing optionals map to null.
 */
export interface AdxIndexFieldMap {
  level: string; // → level (required; index_levels.level / index_levels_daily.close are NOT NULL)
  change?: string;
  changePct?: string;
  dayHigh?: string;
  dayLow?: string;
  valueTraded?: string;
  asOf?: string; // index print time (ISO / epoch ms / epoch s); falls back to snapshot fetch time
  /** Dotted path to the index NODE in the response (a single object, or an array whose first row is
   *  the index). PIN this to the real path once the golden is captured. Default 'response'. */
  rowPath?: string;
  /** as_of value kind so the pure parser can normalize it. Default 'iso'. */
  asOfKind?: "iso" | "epoch_ms" | "epoch_s";
}

// PIN: placeholder field map. The real ADX index feed's node path + field names are unknown until the
// first market-open capture — every value below is a best-guess placeholder to keep the parser
// type-correct and replayable, NOT a verified mapping. Overwrite from the captured golden into
// endpoint_config.fieldMap (a data fix, no redeploy).
const DEFAULT_INDEX_FIELD_MAP: AdxIndexFieldMap = {
  rowPath: "response", // PIN: real node path (e.g. "response.index" or "response.results.0")
  level: "value", // PIN: real level field
  change: "change",
  changePct: "changePercent",
  dayHigh: "dayHigh",
  dayLow: "dayLow",
  valueTraded: "valueTraded",
  asOf: "asOf",
  asOfKind: "iso",
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests).
// ---------------------------------------------------------------------------

/**
 * Map one ADX index node via the field map → NormalizedIndexLevel. Returns null when no usable level
 * is present (the level is NOT NULL downstream, so a level-less print must not stage). asOf is left as
 * the raw feed value (possibly "") here; parseAdxIndices fills the snapshot fetch-time fallback so the
 * pure mapper stays clock-free.
 */
export function mapAdxIndex(
  node: Record<string, unknown>,
  fm: AdxIndexFieldMap,
): NormalizedIndexLevel | null {
  const level = adxNumber(getPath(node, fm.level));
  if (level === null) return null;

  return {
    indexCode: ADX_INDEX_CODE,
    level,
    change: adxNumber(getPath(node, fm.change)),
    changePct: adxNumber(getPath(node, fm.changePct)),
    dayHigh: adxNumber(getPath(node, fm.dayHigh)),
    dayLow: adxNumber(getPath(node, fm.dayLow)),
    valueTraded: adxNumber(getPath(node, fm.valueTraded)),
    asOf: adxAsOfToUtc(getPath(node, fm.asOf), fm.asOfKind ?? "iso"),
  };
}

/**
 * Pure parser. Reads the field map from snapshot.meta.fieldMap (worker copies it from the source row),
 * falling back to DEFAULT_INDEX_FIELD_MAP. Locates the index node by fm.rowPath (a single object, or
 * the first element of an array). Throws on non-JSON (hard drift → parse-harness status='error'); a
 * present-but-level-less node yields zero rows (drift_zero_rows), never a fabricated level.
 *
 * asOf fallback: the index feed may carry no per-print timestamp (like the ADX quotes board). Because
 * mapIndex derives the day-key session from asOf, an empty asOf would corrupt the natural_key — so the
 * parser fills asOf from snapshot.fetchedAt when the feed value is empty. This keeps parse() PURE (the
 * fetch time is on the STORED snapshot, not a live clock).
 */
export function parseAdxIndices(snapshot: StoredSnapshot): ParseResult<NormalizedIndexLevel> {
  const text = snapshot.body.toString("utf8");
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `ADX indices parse: snapshot ${snapshot.snapshotId} not valid JSON: ${(err as Error).message}`,
    );
  }
  const metaMap = (snapshot.meta?.fieldMap as Partial<AdxIndexFieldMap> | undefined) ?? {};
  const fm: AdxIndexFieldMap = { ...DEFAULT_INDEX_FIELD_MAP, ...metaMap };

  const located = getPath(doc, fm.rowPath ?? "response");
  const node = Array.isArray(located) ? located[0] : located;
  if (node === null || node === undefined || typeof node !== "object") {
    // No index node at the configured path ⇒ zero rows (drift), not a throw: a transient shape
    // change should not poison the poll, and the parse-harness records drift_zero_rows.
    return { rows: [], parserVersion: ADX_INDICES_PARSER_VERSION };
  }

  const row = mapAdxIndex(node as Record<string, unknown>, fm);
  if (row === null) return { rows: [], parserVersion: ADX_INDICES_PARSER_VERSION };

  // asOf fallback to the stored snapshot's fetch time (keeps the day-key session well-formed).
  const asOf = row.asOf && row.asOf !== "" ? row.asOf : snapshot.fetchedAt;
  return { rows: [{ ...row, asOf }], parserVersion: ADX_INDICES_PARSER_VERSION };
}

// ---------------------------------------------------------------------------
// fetch(): browser context, mirroring fetchAdxBoard. Seats the WAF cookies via bootstrap, then GETs
// the pinned index endpoint through the SAME cookie-seated context (matching TLS/JA3).
// ---------------------------------------------------------------------------

async function fetchAdxIndex(ctx: FetchContext): Promise<FetchResult[]> {
  const { source, browser, logger, now } = ctx;

  // SELF-GATE (scaffold): runtime.tasksForDataType folds a mounted `indices` task into the QUOTES
  // source poll too (CONTRACT §8: "indices are folded into the quotes task"). ADX has a live quotes
  // source (id 7) but no dedicated `indices` source yet, so without this guard every ADX quote poll
  // would ALSO run this task against the quotes board's config — an extra WAF board GET (against the
  // ADX host budget) that the raw_snapshots dedup mostly swallows, plus a stray drift_zero_rows parse.
  // Until the real index endpoint is pinned and a data_type='indices' source is seeded (owner step),
  // this returns [] for any non-indices source, so mounting the scaffold is a true no-op on the live
  // quotes pipeline. When the index turns out to live IN the quotes board instead of a dedicated feed,
  // drop this guard and set endpoint_config.fieldMap to read the index node from the board response.
  if (source.dataType !== "indices") return [];

  const discovery = source.endpointConfig.actionDiscovery;
  if (!discovery) {
    throw new Error(
      `ADX indices fetch: source ${source.id} missing endpoint_config.actionDiscovery — cannot seat WAF cookies`,
    );
  }
  const boot = await browser.bootstrap(discovery);

  // PIN: capture the real index endpoint + field paths at market open.
  //   • endpoint_config.urlTemplate → the ADX index-level XHR URL (may be the same apigateway host as
  //     the quotes board, or a dedicated index feed). Until pinned, fetch() falls back to the URL the
  //     bootstrap resolved (network_capture), which for indices is typically unset → the throw below.
  //   • endpoint_config.fieldMap → an AdxIndexFieldMap over the captured golden (node path + field
  //     names), copied onto FetchResult.meta so the PURE parser has it.
  const url = source.endpointConfig.urlTemplate ?? boot.resolvedUrl;
  if (!url) {
    throw new Error(
      `ADX indices fetch: source ${source.id} has no urlTemplate and bootstrap resolved no URL ` +
        `(PIN the index endpoint in endpoint_config.urlTemplate at market open)`,
    );
  }
  logger.info("ADX index: index URL", {
    sourceId: source.id,
    pinned: Boolean(source.endpointConfig.urlTemplate),
  });

  const resp = await browser.get(url, browserOpts(source.endpointConfig.headers));
  const fieldMap =
    (source.endpointConfig as unknown as { fieldMap?: AdxIndexFieldMap }).fieldMap ??
    DEFAULT_INDEX_FIELD_MAP;

  return [
    {
      url: resp.url,
      contentType: resp.headers["content-type"] ?? "application/json",
      httpStatus: resp.status,
      body: resp.body,
      fetchedAt: now(),
      meta: { lang: "en", fieldMap },
    },
  ];
}

export const adxIndices: TaskSpec<NormalizedIndexLevel> = {
  dataType: "indices",
  parserVersion: ADX_INDICES_PARSER_VERSION,
  fetch: fetchAdxIndex,
  parse: parseAdxIndices,
};
