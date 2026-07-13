// Shared test support for the TDWL + ADX adapter golden tests. Pure helpers only — builds
// StoredSnapshot inputs for the pure parsers and a scripted BrowserClient double for fetch() tests.

import type {
  BrowserClient,
  DataType,
  FetchContext,
  FetchOptions,
  Logger,
  RawResponse,
  SourceRecord,
  StoredSnapshot,
  VenueCode,
} from "../../../core/types.js";
import { FetchError } from "../../../core/types.js";

export function makeSnapshot(opts: {
  venue: VenueCode;
  dataType: DataType;
  body: Buffer | string;
  contentType?: string;
  externalId?: string | null;
  meta?: Record<string, unknown>;
  snapshotId?: number;
  sourceId?: number;
}): StoredSnapshot {
  return {
    snapshotId: opts.snapshotId ?? 1,
    sourceId: opts.sourceId ?? 1,
    venue: opts.venue,
    dataType: opts.dataType,
    contentType: opts.contentType ?? "text/html",
    externalId: opts.externalId ?? null,
    body: typeof opts.body === "string" ? Buffer.from(opts.body, "utf8") : opts.body,
    fetchedAt: "2026-07-13T12:00:00.000Z",
    meta: opts.meta ?? {},
  };
}

export const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

/** A scripted BrowserClient: bootstrap() returns the given resolvedUrl; get()/request() pop the
 *  next queued RawResponse. refreshIfChallenged() is a no-op that records it was called. */
export class FakeBrowserClient implements BrowserClient {
  public bootstrapCalls = 0;
  public refreshCalls = 0;
  public gets: string[] = [];
  private responses: RawResponse[];
  private resolvedUrl: string;

  constructor(resolvedUrl: string, responses: RawResponse[]) {
    this.resolvedUrl = resolvedUrl;
    this.responses = responses;
  }

  async bootstrap(): Promise<{ resolvedUrl: string; cookies: string }> {
    this.bootstrapCalls += 1;
    return { resolvedUrl: this.resolvedUrl, cookies: "_abck=seated" };
  }
  async refreshIfChallenged(): Promise<void> {
    this.refreshCalls += 1;
  }
  async get(url: string, _opts?: FetchOptions): Promise<RawResponse> {
    this.gets.push(url);
    const next = this.responses.shift();
    if (!next) throw new Error("FakeBrowserClient: no scripted response left");
    // Model the REAL BrowserClient.get contract: it internally retries a WAF challenge once and
    // THROWS a typed FetchError on a persistent 401/403/4xx/5xx — callers never see those statuses.
    if (next.status === 401 || next.status === 403) {
      throw new FetchError("WAF_CHALLENGE", `${next.status} WAF challenge for ${url}`, {
        status: next.status,
      });
    }
    if (next.status >= 500) {
      throw new FetchError("HTTP_5XX", `${next.status} server error for ${url}`, { status: next.status });
    }
    if (next.status >= 400 && next.status !== 304) {
      throw new FetchError("HTTP_4XX", `${next.status} client error for ${url}`, { status: next.status });
    }
    return next;
  }
  async request(url: string, opts: FetchOptions): Promise<RawResponse> {
    return this.get(url, opts);
  }
  async close(): Promise<void> {
    /* no-op for the test double */
  }
}

export function rawResponse(opts: {
  url: string;
  status?: number;
  contentType?: string;
  body: Buffer | string;
}): RawResponse {
  return {
    url: opts.url,
    status: opts.status ?? 200,
    headers: { "content-type": opts.contentType ?? "text/html" },
    body: typeof opts.body === "string" ? Buffer.from(opts.body, "utf8") : opts.body,
    fromCache304: false,
  };
}

export function makeSource(opts: Partial<SourceRecord> & { id: number; venue: VenueCode; dataType: DataType }): SourceRecord {
  return {
    id: opts.id,
    venue: opts.venue,
    dataType: opts.dataType,
    entryUrl: opts.entryUrl ?? "https://example.test/entry",
    endpointConfig: opts.endpointConfig ?? { responseKind: "json" },
    normalizeRules: opts.normalizeRules ?? [],
    transport: opts.transport ?? "http_bootstrap",
    robotsStatus: opts.robotsStatus ?? "override",
    active: opts.active ?? true,
    lastContentHash: opts.lastContentHash ?? null,
  };
}

export function makeCtx(opts: { source: SourceRecord; browser: BrowserClient; now?: string }): FetchContext {
  const nowIso = opts.now ?? "2026-07-13T12:00:00.000Z";
  return {
    source: opts.source,
    // http must satisfy the interface but WAF venues never use it; a throwing stub proves that.
    http: {
      async get(): Promise<RawResponse> {
        throw new Error("WAF venue must not use ctx.http");
      },
      async request(): Promise<RawResponse> {
        throw new Error("WAF venue must not use ctx.http");
      },
    },
    browser: opts.browser,
    logger: silentLogger,
    now: () => nowIso,
  };
}
