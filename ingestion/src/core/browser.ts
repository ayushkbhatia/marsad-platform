import type {
  BrowserClient,
  FetchOptions,
  RawResponse,
  EndpointConfig,
  Logger,
} from './types.js';
import { FetchError } from './types.js';
import {
  HostLimiterRegistry,
  hostOf,
  type Clock,
} from './rate-limit.js';

/**
 * BrowserClient (Playwright persistent request-context) — §3, §5, recon.
 *
 * TDWL/ADX are Akamai/Incapsula WAF'd: 403 to plain undici, 200 under a real
 * headless Chromium. Strategy (recon §"TDWL — confirmed working data path"):
 *
 *   1. bootstrap(): launch a lazy/singleton chromium, navigate the
 *      actionDiscovery.navigateUrl to seat WAF cookies (Akamai _abck/bm_sz),
 *      then discover the runtime action URL by scraping the datatable AJAX
 *      config from the DOM ('datatable_ajax') or capturing the XHR
 *      ('network_capture'). The action id/PUID is portal-generated — NEVER
 *      hardcoded; it lives only in endpoint_config's discovery shape.
 *   2. get(): issue context.request.get() through the SAME context so the
 *      TLS/JA3 fingerprint MATCHES the cookies (undici replay re-challenges).
 *   3. refreshIfChallenged(): a 401/403/challenge status re-bootstraps once.
 *   4. close(): release the singleton browser on worker drain.
 *
 * Playwright is imported LAZILY so this module (and the whole core package)
 * loads without chromium present — the 4 HTTP venues never touch it, and unit
 * tests can inject a fake driver. Same per-host ≤1 req/s + ≤300/day limiters as
 * HttpClient so the WAF venues obey the request budget too.
 */

/** The subset of Playwright we depend on — injectable for tests. */
export interface BrowserDriver {
  launch(): Promise<BrowserSession>;
}

export interface BrowserSession {
  /** Navigate a page to seat cookies; returns the loaded page handle. */
  newPageAndGoto(url: string): Promise<BrowserPage>;
  /** Issue an in-context request (context.request.get) sharing the seated cookies. */
  contextRequest(
    url: string,
    opts: { method: string; headers?: Record<string, string>; data?: string | Buffer },
  ): Promise<{ status: number; url: string; headers: Record<string, string>; body(): Promise<Buffer> }>;
  /** Serialize current cookies (for provenance/logging). */
  cookies(): Promise<string>;
  close(): Promise<void>;
}

export interface BrowserPage {
  /** Read the datatable AJAX endpoint URL out of the page DOM/JS at runtime. */
  discoverAjaxUrl(pattern?: string): Promise<string | null>;
  /** Wait for a network response whose URL matches pattern, return its URL. */
  captureResponseUrl(pattern: string, timeoutMs: number): Promise<string | null>;
  /** Idle wait so late-firing WAF sensor JS (Akamai _abck) can finish seating
   *  the cookie before we close the page and issue the in-context fetch. */
  settle(ms: number): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserClientOptions {
  driver: BrowserDriver; // required — the Playwright adapter or a test fake
  ratePerSec?: number;
  budgetPerHostPerDay?: number;
  globalConcurrency?: number;
  defaultTimeoutMs?: number;
  clock?: Clock;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
}

interface BootstrapState {
  resolvedUrl: string | null; // null for extract:'direct' — caller fetches its own urlTemplate
  cookies: string;
}

/** Idle wait after navigate in extract:'direct' so Akamai's sensor JS seats a
 *  validated _abck cookie before the in-context fetch (empirically ~4s suffices). */
const DIRECT_SETTLE_MS = 4500;

/**
 * True when an error means the Chromium session itself is gone (crashed, OOM-killed, or
 * closed out-of-band) rather than the request merely failing. Such an error surfaces
 * before any HTTP status exists, so the 401/403 refresh path can never catch it — the
 * caller must discard the singleton instead. Matches Playwright's closed-target strings.
 */
function isSessionDead(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Target (page, context or browser )?has been closed|Browser has been closed|Target closed|browser has disconnected|Protocol error.*(Target closed|Session closed)/i.test(
    msg,
  );
}

export function createBrowserClient(opts: BrowserClientOptions): BrowserClient {
  const ratePerSec = opts.ratePerSec ?? 1;
  const budget = opts.budgetPerHostPerDay ?? 300;
  const concurrency = opts.globalConcurrency ?? 4;
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? 20_000;
  const clock = opts.clock ?? Date.now;
  const logger = opts.logger;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const limiters = new HostLimiterRegistry(ratePerSec, budget, concurrency, clock);

  let session: BrowserSession | null = null; // lazy/singleton
  let lastBootstrap: BootstrapState | null = null;
  let lastDiscovery: EndpointConfig['actionDiscovery'] | null = null;

  async function ensureSession(): Promise<BrowserSession> {
    if (!session) {
      logger?.info('launching chromium (lazy singleton)');
      session = await opts.driver.launch();
    }
    return session;
  }

  /**
   * Drop the singleton so the next ensureSession() relaunches.
   *
   * Chromium can die out-of-band (crash, OOM, context closed by the host). The dead
   * handle stays non-null, so ensureSession() keeps returning it and every later call
   * re-throws the same error until the process restarts. refreshIfChallenged() only
   * resets on a 401/403 *response*, which a dead session never produces — it throws
   * before any status exists. Any path that discovers a broken session must discard it.
   */
  async function discardSession(): Promise<void> {
    if (!session) return;
    const dead = session;
    session = null;
    await dead.close().catch(() => {});
  }

  async function throttle(host: string): Promise<void> {
    const bucket = limiters.bucket(host);
    for (let i = 0; i < 10_000; i++) {
      if (bucket.tryTake()) return;
      await sleep(Math.max(1, bucket.msUntilNextToken()));
    }
    throw new FetchError('NETWORK', `rate limiter stuck for host ${host}`);
  }

  async function bootstrap(
    cfg: EndpointConfig['actionDiscovery'],
  ): Promise<{ resolvedUrl: string | null; cookies: string }> {
    if (!cfg) {
      throw new FetchError(
        'HTTP_4XX',
        'browser bootstrap requires endpoint_config.actionDiscovery',
      );
    }
    lastDiscovery = cfg;
    let sess = await ensureSession();
    const host = hostOf(cfg.navigateUrl);

    if (limiters.budget(host).remaining() <= 0) {
      throw new FetchError('HTTP_4XX', `daily request budget exhausted for host ${host}`);
    }
    await throttle(host);
    limiters.budget(host).tryConsume();

    logger?.info('bootstrap navigate (seat WAF cookies)', { navigateUrl: cfg.navigateUrl });
    // Discard-and-relaunch on ANY navigate failure: the session's health is unknowable
    // from here, and a relaunch costs ~1s against a wedge that otherwise persists until
    // the worker restarts (ADX quotes sat dead 46h this way, 2026-07-15→17).
    let page: BrowserPage;
    try {
      page = await sess.newPageAndGoto(cfg.navigateUrl);
    } catch (err) {
      logger?.warn('bootstrap navigate failed — discarding session, relaunching once', {
        navigateUrl: cfg.navigateUrl,
        err: err instanceof Error ? err.message : String(err),
      });
      await discardSession();
      sess = await ensureSession();
      try {
        page = await sess.newPageAndGoto(cfg.navigateUrl);
      } catch (retryErr) {
        // Leave no poisoned handle behind — the next poll starts from a clean launch.
        await discardSession();
        throw retryErr;
      }
    }

    let resolvedUrl: string | null = null;
    try {
      if (cfg.extract === 'direct') {
        // Seat cookies only. The page never auto-fires the data XHR (e.g. a fixed
        // apigateway URL behind an apikey header, or a feed the SPA fetches only on
        // interaction), so passive discovery would time out. The caller fetches its
        // own endpoint_config.urlTemplate in-context — the seated cookies + matching
        // TLS fingerprint carry it past the WAF.
        // Idle-wait first: Akamai's sensor JS updates _abck a beat AFTER networkidle,
        // and closing the page before it lands leaves an unvalidated cookie → the
        // in-context fetch gets a 200 Akamai soft-block HTML page instead of JSON.
        await page.settle(DIRECT_SETTLE_MS);
        resolvedUrl = null;
      } else if (cfg.extract === 'datatable_ajax') {
        resolvedUrl = await page.discoverAjaxUrl(cfg.responseUrlPattern);
      } else {
        resolvedUrl = await page.captureResponseUrl(
          cfg.responseUrlPattern ?? '.*',
          defaultTimeoutMs,
        );
      }
    } finally {
      await page.close().catch(() => {});
    }

    if (!resolvedUrl && cfg.extract !== 'direct') {
      throw new FetchError(
        'WAF_CHALLENGE',
        `action discovery (${cfg.extract}) found no URL on ${cfg.navigateUrl}`,
      );
    }

    const cookies = await sess.cookies();
    lastBootstrap = { resolvedUrl, cookies };
    logger?.info('bootstrap ok', { resolvedUrl });
    return lastBootstrap;
  }

  async function refreshIfChallenged(status: number): Promise<void> {
    if (status === 401 || status === 403) {
      logger?.warn('WAF challenge — re-bootstrapping', { status });
      // Tear down the poisoned session; next bootstrap relaunches.
      await discardSession();
      if (lastDiscovery) await bootstrap(lastDiscovery);
    }
  }

  async function doRequest(url: string, options: FetchOptions): Promise<RawResponse> {
    const host = hostOf(url);
    if (limiters.budget(host).remaining() <= 0) {
      throw new FetchError('HTTP_4XX', `daily request budget exhausted for host ${host}`);
    }

    async function once(): Promise<RawResponse> {
      await limiters.globalSemaphore.acquire();
      try {
        await throttle(host);
        if (!limiters.budget(host).tryConsume()) {
          throw new FetchError('HTTP_4XX', `daily request budget exhausted for host ${host}`);
        }
        const reqOpts: {
          method: string;
          headers?: Record<string, string>;
          data?: string | Buffer;
        } = { method: options.method ?? 'GET' };
        if (options.headers) reqOpts.headers = options.headers;
        if (options.body !== undefined) reqOpts.data = options.body;
        // Resolved per attempt, never captured: refreshIfChallenged() replaces the
        // singleton on a 401/403, and a retry holding the pre-refresh handle would
        // re-issue against the session we just tore down.
        const sess = await ensureSession();
        let res: Awaited<ReturnType<BrowserSession['contextRequest']>>;
        try {
          res = await sess.contextRequest(url, reqOpts);
        } catch (err) {
          // A dead context throws instead of returning a status, so refreshIfChallenged
          // never sees it — discard here or the handle wedges every later request.
          if (isSessionDead(err)) await discardSession();
          throw err;
        }
        const body = res.status === 304 ? Buffer.alloc(0) : await res.body();
        return {
          url: res.url,
          status: res.status,
          headers: res.headers,
          body,
          fromCache304: res.status === 304,
        };
      } finally {
        limiters.globalSemaphore.release();
      }
    }

    let res = await once();
    if (res.status === 401 || res.status === 403) {
      // One free retry after re-bootstrap (§10 WAF_CHALLENGE).
      await refreshIfChallenged(res.status);
      res = await once();
      if (res.status === 401 || res.status === 403) {
        throw new FetchError('WAF_CHALLENGE', `${res.status} WAF challenge for ${url}`, {
          status: res.status,
        });
      }
    }
    if (res.status >= 500) {
      throw new FetchError('HTTP_5XX', `${res.status} server error for ${url}`, {
        status: res.status,
      });
    }
    if (res.status >= 400 && res.status !== 304) {
      throw new FetchError('HTTP_4XX', `${res.status} client error for ${url}`, {
        status: res.status,
      });
    }
    return res;
  }

  return {
    bootstrap,
    refreshIfChallenged,
    async close(): Promise<void> {
      if (session) {
        logger?.info('closing chromium on drain');
        await session.close().catch(() => {});
        session = null;
      }
    },
    get(url, o) {
      return doRequest(url, { ...(o ?? {}), method: 'GET' });
    },
    request(url, o) {
      return doRequest(url, o);
    },
  };
}
