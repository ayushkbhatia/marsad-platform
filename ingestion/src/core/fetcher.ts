import { gunzipSync, inflateSync, inflateRawSync, brotliDecompressSync } from 'node:zlib';
import type { HttpClient, FetchOptions, RawResponse, Logger } from './types.js';
import { FetchError } from './types.js';
import {
  HostLimiterRegistry,
  hostOf,
  type Clock,
} from './rate-limit.js';
import { proxyToUrl, type ProxyConfig } from './proxy.js';

/**
 * HttpClient (undici) — §3 / §5.
 *
 *  - Per-host token bucket ≤ ratePerSec (default 1 req/s) + global concurrency
 *    ceiling (default 4), backed by HostLimiterRegistry.
 *  - Per-host hard daily budget ≤ 300 requests/host (recon exit criterion) —
 *    a WAF_CHALLENGE-class refusal (as HTTP_4XX) is thrown BEFORE the network
 *    call when the budget is exhausted so we never blow the ceiling.
 *  - Retry/backoff on NETWORK + HTTP_5XX (4 attempts ⇒ 3 sleeps, 5s→25s→120s ±30% jitter).
 *  - 429 honors Retry-After (§10).
 *  - Conditional GET (If-None-Match / If-Modified-Since) → 304 fast path.
 *
 * The scheduler/worker picks this client when SourceRecord.transport === 'http'.
 */

export interface HttpClientOptions {
  ratePerSec?: number; // default 1
  budgetPerHostPerDay?: number; // default 300
  globalConcurrency?: number; // default 4
  defaultTimeoutMs?: number; // default 20_000
  maxRetries?: number; // default 4 (total attempts ⇒ 3 sleeps: 5s→25s→120s, §10)
  userAgent?: string;
  clock?: Clock;
  logger?: Logger;
  /** Injectable low-level transport for tests. Defaults to undici.request. */
  transport?: LowLevelTransport;
  /** Injectable sleep for tests (default real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Outbound proxy for THIS client. When set, the default undici transport
   * routes every request through a ProxyAgent dispatcher (credentials embedded,
   * incl. the IPRoyal `_country-…` geo password and, for proxy.mode==='sticky',
   * the `_session-…` selector). Resolved per-source by the worker via
   * core/proxy.resolveProxyForSource — never hardcoded. The rotate-vs-sticky IP
   * policy is already encoded in proxy.password; proxy.mode is advisory (logged).
   * For a 'rotate' source, every request through this ProxyAgent still gets a
   * fresh exit IP because the base creds carry no session selector. Ignored when a
   * custom `transport` is injected (tests).
   */
  proxy?: ProxyConfig;
}

/** The minimal shape we need from undici — injectable for tests. */
export interface LowLevelTransport {
  (
    url: string,
    opts: {
      method: string;
      headers: Record<string, string>;
      body?: string | Buffer;
      signal?: AbortSignal;
    },
  ): Promise<LowLevelResponse>;
}

export interface LowLevelResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: { arrayBuffer(): Promise<ArrayBuffer> };
  /** Final URL after redirects, if the transport exposes it. */
  url?: string;
}

const DEFAULT_UA =
  'MarsadIngestBot/1.0 (+https://marsad.example; delayed market data; contact ops@marsad)';

// Backoff schedule base (ms) for HTTP_5XX / NETWORK — §10: 5s → 25s → 120s.
const BACKOFF_BASE_MS = [5_000, 25_000, 120_000];
const JITTER = 0.3;

export function createHttpClient(opts: HttpClientOptions = {}): HttpClient {
  const ratePerSec = opts.ratePerSec ?? 1;
  const budget = opts.budgetPerHostPerDay ?? 300;
  const concurrency = opts.globalConcurrency ?? 4;
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? 20_000;
  const maxRetries = opts.maxRetries ?? 4;
  const ua = opts.userAgent ?? DEFAULT_UA;
  const clock = opts.clock ?? Date.now;
  const logger = opts.logger;
  // A configured proxy is applied only to the REAL undici transport. If a caller
  // injects a custom transport (tests), it owns its own routing.
  const transport: LowLevelTransport =
    opts.transport ?? (opts.proxy ? makeProxiedTransport(opts.proxy) : defaultTransport);
  const sleep = opts.sleep ?? realSleep;
  if (opts.proxy && !opts.transport) {
    logger?.info('http client egressing through proxy', {
      server: opts.proxy.server,
      // rotate = fresh exit IP/request (defeats per-IP 429); sticky = IP-pinned burst.
      mode: opts.proxy.mode ?? 'rotate',
    });
  }

  const limiters = new HostLimiterRegistry(ratePerSec, budget, concurrency, clock);

  async function throttle(host: string): Promise<void> {
    const bucket = limiters.bucket(host);
    // Wait out the token bucket (per-host ≤ ratePerSec).
    // Loop because msUntilNextToken is advisory; recheck after sleeping.
    // Guard against pathological spins.
    for (let i = 0; i < 10_000; i++) {
      if (bucket.tryTake()) return;
      const waitMs = Math.max(1, bucket.msUntilNextToken());
      await sleep(waitMs);
    }
    throw new FetchError('NETWORK', `rate limiter stuck for host ${host}`);
  }

  async function doRequest(url: string, options: FetchOptions): Promise<RawResponse> {
    const host = hostOf(url);

    // Hard daily budget check — refuse BEFORE the network call.
    if (limiters.budget(host).remaining() <= 0) {
      throw new FetchError(
        'HTTP_4XX',
        `daily request budget exhausted for host ${host} (${budget}/day)`,
      );
    }

    const headers: Record<string, string> = {
      'user-agent': ua,
      'accept-encoding': 'gzip, deflate',
      ...(options.headers ?? {}),
    };
    if (options.conditional?.etag) headers['if-none-match'] = options.conditional.etag;
    if (options.conditional?.lastModified) {
      headers['if-modified-since'] = options.conditional.lastModified;
    }

    const method = options.method ?? 'GET';
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;

    let lastErr: FetchError | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // Concurrency + rate limiting + budget consume happen per network attempt.
      await limiters.globalSemaphore.acquire();
      try {
        await throttle(host);

        if (!limiters.budget(host).tryConsume()) {
          throw new FetchError(
            'HTTP_4XX',
            `daily request budget exhausted for host ${host} (${budget}/day)`,
          );
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let res: LowLevelResponse;
        try {
          const reqInit: {
            method: string;
            headers: Record<string, string>;
            signal: AbortSignal;
            body?: string | Buffer;
          } = { method, headers, signal: controller.signal };
          if (options.body !== undefined) reqInit.body = options.body;
          res = await transport(url, reqInit);
        } catch (err) {
          throw classifyNetworkError(err);
        } finally {
          clearTimeout(timer);
        }

        const status = res.statusCode;

        if (status === 304) {
          return {
            url: res.url ?? url,
            status,
            headers: flattenHeaders(res.headers),
            body: Buffer.alloc(0),
            fromCache304: true,
          };
        }

        if (status === 429) {
          const retryAfterMs = parseRetryAfter(res.headers['retry-after']);
          lastErr = new FetchError('HTTP_5XX', `429 Too Many Requests for ${url}`, {
            status,
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          });
          logger?.warn('http 429 rate-limited', { url, attempt, retryAfterMs });
          await backoffOrThrow(lastErr, attempt);
          continue;
        }

        if (status >= 500) {
          lastErr = new FetchError('HTTP_5XX', `${status} server error for ${url}`, { status });
          logger?.warn('http 5xx', { url, status, attempt });
          await backoffOrThrow(lastErr, attempt);
          continue;
        }

        if (status >= 400) {
          // 4xx (except 429) — endpoint moved/blocked; no retry (§10).
          throw new FetchError('HTTP_4XX', `${status} client error for ${url}`, { status });
        }

        const raw = Buffer.from(await res.body.arrayBuffer());
        const respHeaders = flattenHeaders(res.headers);
        // undici.request does NOT auto-decompress. We advertise `accept-encoding:
        // gzip, deflate`, so an origin that honours it (Yahoo does; most venue APIs
        // ignore it and send identity) returns COMPRESSED bytes. Decode here — the
        // single choke point both transports flow through — so the snapshot store and
        // every parser see plaintext. Without this, gzip bytes get JSON.parse'd to
        // zero rows silently (the OHLCV-backfill 0-bars bug). Drop the now-stale
        // content-encoding header so nothing downstream thinks the body is still coded.
        const body = decodeContentEncoding(raw, respHeaders['content-encoding'], logger);
        delete respHeaders['content-encoding'];
        return {
          url: res.url ?? url,
          status,
          headers: respHeaders,
          body,
          fromCache304: false,
        };
      } catch (err) {
        if (err instanceof FetchError && (err.errorClass === 'NETWORK' || err.errorClass === 'HTTP_5XX')) {
          lastErr = err;
          logger?.warn('fetch attempt failed', { url, attempt, errorClass: err.errorClass });
          await backoffOrThrow(err, attempt);
          continue;
        }
        throw err; // HTTP_4XX and anything else: no retry
      } finally {
        limiters.globalSemaphore.release();
      }
    }

    throw lastErr ?? new FetchError('NETWORK', `exhausted ${maxRetries} attempts for ${url}`);
  }

  async function backoffOrThrow(err: FetchError, attempt: number): Promise<void> {
    if (attempt >= maxRetries) throw err;
    const base =
      err.retryAfterMs ?? BACKOFF_BASE_MS[Math.min(attempt - 1, BACKOFF_BASE_MS.length - 1)]!;
    const jittered = base * (1 + (Math.random() * 2 - 1) * JITTER);
    await sleep(Math.max(0, Math.round(jittered)));
  }

  return {
    get(url, o) {
      return doRequest(url, { ...(o ?? {}), method: 'GET' });
    },
    request(url, o) {
      return doRequest(url, o);
    },
  };
}

// Shared undici Agent for the direct (non-proxy) transport. undici's DEFAULT
// connect timeout is 10s — too tight for some GCC origins that are slow to
// complete the TLS handshake from the VPS (QE's MarketWatch.txt takes ~15s),
// which ConnectTimeoutError'd before the request's own AbortController(timeoutMs)
// could bound it, so those fetches never landed. Raise the connect ceiling to 30s;
// per-request duration is still bounded by the AbortController the caller wires in.
let sharedDirectAgentPromise: Promise<unknown> | null = null;
async function sharedDirectAgent(): Promise<unknown> {
  if (!sharedDirectAgentPromise) {
    sharedDirectAgentPromise = (async () => {
      const { Agent } = await import('undici');
      return new Agent({ connect: { timeout: 30_000 } });
    })();
  }
  return sharedDirectAgentPromise;
}

// undici is imported LAZILY (only when the real transport actually runs) so the
// module loads for unit tests that inject a fake transport, without the dep.
const defaultTransport: LowLevelTransport = async (url, opts) => {
  const { request: undiciRequest } = await import('undici');
  const dispatcher = await sharedDirectAgent();
  const reqOpts = {
    method: opts.method as never,
    headers: opts.headers,
    dispatcher,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
    maxRedirections: 5,
  };
  const res = await undiciRequest(url, reqOpts as Parameters<typeof undiciRequest>[1]);
  return {
    statusCode: res.statusCode,
    headers: res.headers as Record<string, string | string[] | undefined>,
    body: { arrayBuffer: () => res.body.arrayBuffer() },
  };
};

/**
 * A LowLevelTransport that routes every request through an undici ProxyAgent.
 *
 * IP-ROTATION SEMANTICS (verified live against IPRoyal, P1.7a): the residential
 * gateway rotates the exit IP per NEW upstream TCP tunnel, NOT per HTTP request
 * over a reused keep-alive tunnel. So the dispatcher lifecycle is mode-dependent:
 *
 *   - 'rotate' (default): a FRESH ProxyAgent (connections:1, pipelining:0) is
 *     created and CONNECT-tunnelled per request, then closed. Each request opens a
 *     new tunnel ⇒ a fresh exit IP ⇒ the per-IP rate counter never accumulates ⇒
 *     defeats Yahoo's 429. The HttpClient's ≥1 req/s per-host bucket already spaces
 *     these so we never burst the proxy into a 407 (proven live).
 *   - 'sticky': ONE shared keep-alive ProxyAgent is created lazily and reused, so a
 *     bounded burst exits the SAME IP (cookie/IP-affinity flows, e.g. BHB WAF). The
 *     `_session-…` selector on the password (added by core/proxy.applyProxyMode)
 *     additionally pins the IP at the gateway across tunnels within the lifetime.
 *
 * Credentials (incl. the IPRoyal `_country-…` / `_session-…` password) are embedded
 * in the ProxyAgent URI. undici tunnels HTTPS origins via CONNECT and injects
 * Proxy-Authorization itself, so we do NOT hit the ERR_PROXY_AUTH_UNSUPPORTED class
 * of failure that Chromium does (that fallback lives in the BrowserClient path).
 */
export function makeProxiedTransport(proxy: ProxyConfig): LowLevelTransport {
  const proxyUri = proxyToUrl(proxy);
  // Absent mode ⇒ rotate (matches core/proxy.DEFAULT_PROXY_MODE).
  const sticky = proxy.mode === 'sticky';

  // Sticky: one shared keep-alive dispatcher (same exit IP for the burst).
  let sharedDispatcherPromise: Promise<unknown> | null = null;
  async function sharedDispatcher(): Promise<unknown> {
    if (!sharedDispatcherPromise) {
      sharedDispatcherPromise = (async () => {
        const { ProxyAgent } = await import('undici');
        return new ProxyAgent(proxyUri);
      })();
    }
    return sharedDispatcherPromise;
  }

  // Rotate: a fresh single-connection dispatcher per request (new tunnel ⇒ new IP).
  async function freshDispatcher(): Promise<{ dispatcher: unknown; close(): Promise<void> }> {
    const { ProxyAgent } = await import('undici');
    const agent = new ProxyAgent({ uri: proxyUri, connections: 1, pipelining: 0 });
    return {
      dispatcher: agent,
      close: () => (agent as { close(): Promise<void> }).close(),
    };
  }

  return async (url, opts) => {
    const { request: undiciRequest } = await import('undici');
    const chosen = sticky ? null : await freshDispatcher();
    const dispatcher = sticky ? await sharedDispatcher() : chosen!.dispatcher;
    const reqOpts = {
      method: opts.method as never,
      headers: opts.headers,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      dispatcher,
      maxRedirections: 5,
    };
    try {
      const res = await undiciRequest(url, reqOpts as Parameters<typeof undiciRequest>[1]);
      // Read the body BEFORE closing the fresh dispatcher, so the stream is fully
      // drained while its tunnel is still open (rotate mode closes the agent after).
      const ab: ArrayBuffer = await res.body.arrayBuffer();
      return {
        statusCode: res.statusCode,
        headers: res.headers as Record<string, string | string[] | undefined>,
        body: { arrayBuffer: async () => ab },
        ...(typeof (res as { url?: string }).url === 'string'
          ? { url: (res as { url?: string }).url }
          : {}),
      };
    } finally {
      if (chosen) await chosen.close().catch(() => {});
    }
  };
}

function classifyNetworkError(err: unknown): FetchError {
  if (err instanceof FetchError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';
  if (name === 'AbortError' || /abort|timeout/i.test(msg)) {
    return new FetchError('NETWORK', `request timed out: ${msg}`, { cause: err });
  }
  return new FetchError('NETWORK', `network error: ${msg}`, { cause: err });
}

function flattenHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

/**
 * Decode an HTTP response body per its Content-Encoding. undici.request does not
 * auto-decompress, and we advertise `accept-encoding: gzip, deflate`, so a compliant
 * origin (Yahoo) returns compressed bytes. Handles gzip / deflate (zlib-wrapped and
 * raw) / br; identity, absent, or unknown encodings pass through unchanged. If the
 * declared codec fails to decode (corrupt / mislabeled), the RAW bytes are returned so
 * the parser can still try rather than the request hard-failing. Exported for testing.
 */
export function decodeContentEncoding(
  body: Buffer,
  contentEncoding: string | undefined,
  logger?: Logger,
): Buffer {
  if (!contentEncoding || body.length === 0) return body;
  // Content-Encoding may list several codecs; the LAST one is outermost (applied last).
  const enc = contentEncoding
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .pop();
  if (!enc || enc === 'identity') return body;
  try {
    switch (enc) {
      case 'gzip':
      case 'x-gzip':
        return gunzipSync(body);
      case 'deflate':
        // Prefer zlib-wrapped deflate; fall back to raw deflate (some servers omit the header).
        try {
          return inflateSync(body);
        } catch {
          return inflateRawSync(body);
        }
      case 'br':
        return brotliDecompressSync(body);
      default:
        logger?.warn('unknown content-encoding, passing body through undecoded', { contentEncoding });
        return body;
    }
  } catch (err) {
    logger?.warn('content-encoding decode failed, using raw body', {
      contentEncoding,
      err: String(err).slice(0, 120),
    });
    return body;
  }
}

/** Retry-After may be seconds (int) or an HTTP-date. Returns ms or undefined. */
export function parseRetryAfter(raw: string | string[] | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  const asInt = Number.parseInt(value, 10);
  if (Number.isFinite(asInt) && String(asInt) === value.trim()) {
    return Math.max(0, asInt * 1000);
  }
  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) {
    return Math.max(0, asDate - Date.now());
  }
  return undefined;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
