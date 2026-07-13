import type { BrowserDriver, BrowserSession, BrowserPage } from './browser.js';
import { proxyBasicAuth, type ProxyConfig } from './proxy.js';

/**
 * Real Playwright BrowserDriver (§3). Kept in its own module and lazy-importing
 * 'playwright' so the rest of core never requires chromium at import time — the
 * 4 plain-HTTP venues run without it, and tests inject a fake driver.
 *
 * A persistent context is used so cookies seated by the bootstrap navigation
 * are shared by context.request.get() (matching TLS/JA3 fingerprint — 01 Rev #3).
 */

export interface PlaywrightDriverOptions {
  /** Extra chromium launch args (e.g. proxy). Default headless, no-sandbox off. */
  launchArgs?: string[];
  /** Locale sent on the context (recon: requestLocale=en). */
  locale?: string;
  userAgent?: string;
  navigationTimeoutMs?: number;
  /**
   * Outbound proxy for this Chromium session (resolved per-source by the worker
   * via core/proxy — never hardcoded). Playwright's native launch proxy
   * {server, username, password} is the PRIMARY path and handles authenticated
   * proxies correctly. If Chromium raises ERR_PROXY_AUTH_UNSUPPORTED (its
   * command-line proxy auth is flaky), we fall back to a native-proxy launch
   * with NO inline creds and instead inject `Proxy-Authorization` as an
   * extra HTTP header on the context (proxy-chain style, but in-process — no new
   * dependency). See the `proxy` handling below.
   */
  proxy?: ProxyConfig;
}

export function createPlaywrightDriver(opts: PlaywrightDriverOptions = {}): BrowserDriver {
  return {
    async launch(): Promise<BrowserSession> {
      // Lazy import — only paid when a WAF venue actually runs.
      const { chromium } = await import('playwright');

      // Proxy: Playwright's native {server,username,password} is the primary path.
      // We attempt it first; on the ERR_PROXY_AUTH_UNSUPPORTED class of failure we
      // relaunch with the proxy server only (no inline creds) and inject
      // Proxy-Authorization as an extra header (in-process proxy-chain style).
      let browser: import('playwright').Browser;
      let authHeaderFallback: Record<string, string> | undefined;

      const launchWithNativeAuth = async () => {
        const launchOpts: Parameters<typeof chromium.launch>[0] = {
          headless: true,
          args: opts.launchArgs ?? [],
        };
        if (opts.proxy) {
          launchOpts.proxy = {
            server: opts.proxy.server,
            ...(opts.proxy.username ? { username: opts.proxy.username } : {}),
            ...(opts.proxy.password ? { password: opts.proxy.password } : {}),
          };
        }
        return chromium.launch(launchOpts);
      };

      const launchWithHeaderAuth = async () => {
        const launchOpts: Parameters<typeof chromium.launch>[0] = {
          headless: true,
          args: opts.launchArgs ?? [],
        };
        if (opts.proxy) launchOpts.proxy = { server: opts.proxy.server };
        const b = await chromium.launch(launchOpts);
        if (opts.proxy) authHeaderFallback = proxyAuthHeader(opts.proxy);
        return b;
      };

      if (opts.proxy) {
        try {
          browser = await launchWithNativeAuth();
        } catch (err) {
          if (isProxyAuthUnsupported(err)) {
            browser = await launchWithHeaderAuth();
          } else {
            throw err;
          }
        }
      } else {
        browser = await launchWithNativeAuth();
      }

      const context = await browser.newContext({
        locale: opts.locale ?? 'en-US',
        // Default to a real desktop-Chrome UA. Headless Chromium's default UA
        // contains "HeadlessChrome", which Akamai (TDWL/ADX) fingerprints and
        // serves a 200 soft-block HTML page for — masking the JSON feed.
        userAgent:
          opts.userAgent ??
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        ...(authHeaderFallback ? { extraHTTPHeaders: authHeaderFallback } : {}),
      });
      const navTimeout = opts.navigationTimeoutMs ?? 30_000;

      const session: BrowserSession = {
        async newPageAndGoto(url: string): Promise<BrowserPage> {
          const page = await context.newPage();
          page.setDefaultNavigationTimeout(navTimeout);
          await page.goto(url, { waitUntil: 'networkidle' });
          return {
            async discoverAjaxUrl(pattern?: string): Promise<string | null> {
              // Scrape the datatable AJAX endpoint out of the page at runtime.
              // Portal datatables expose the action URL in their init config or
              // an inline <script>; we sweep the DOM/HTML for the pattern.
              const re = pattern ? new RegExp(pattern) : null;
              const html = await page.content();
              const candidates = html.match(/https?:\/\/[^\s"'<>\\]+/g) ?? [];
              for (const c of candidates) {
                if (!re || re.test(c)) {
                  if (re || /!ut\/p\/|ajax|MarketDetails|MarketWatch|api/i.test(c)) return c;
                }
              }
              return null;
            },
            async captureResponseUrl(pattern: string, timeoutMs: number): Promise<string | null> {
              const re = new RegExp(pattern);
              try {
                const resp = await page.waitForResponse((r: { url(): string }) => re.test(r.url()), {
                  timeout: timeoutMs,
                });
                return resp.url();
              } catch {
                return null;
              }
            },
            async settle(ms: number): Promise<void> {
              await page.waitForTimeout(ms);
            },
            async close(): Promise<void> {
              await page.close();
            },
          };
        },

        async contextRequest(url, reqOpts): Promise<{
          status: number;
          url: string;
          headers: Record<string, string>;
          body(): Promise<Buffer>;
        }> {
          const res = await context.request.fetch(url, {
            method: reqOpts.method,
            ...(reqOpts.headers ? { headers: reqOpts.headers } : {}),
            ...(reqOpts.data !== undefined ? { data: reqOpts.data } : {}),
          });
          return {
            status: res.status(),
            url: res.url(),
            headers: res.headers(),
            body: async () => Buffer.from(await res.body()),
          };
        },

        async cookies(): Promise<string> {
          const cs = await context.cookies();
          return cs.map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join('; ');
        },

        async close(): Promise<void> {
          await context.close().catch(() => {});
          await browser.close().catch(() => {});
        },
      };

      return session;
    },
  };
}

/**
 * True when a launch error is the Chromium authenticated-proxy failure class.
 * Chromium's command-line proxy cannot always negotiate Basic auth and surfaces
 * ERR_PROXY_AUTH_UNSUPPORTED (or an ERR_PROXY_CONNECTION_FAILED / net::ERR_… with
 * proxy-auth context). We match defensively on the message.
 */
function isProxyAuthUnsupported(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ERR_PROXY_AUTH_UNSUPPORTED|PROXY_AUTH|ERR_PROXY_CONNECTION_FAILED/i.test(msg);
}

/** Build the extraHTTPHeaders map carrying Proxy-Authorization for the fallback. */
function proxyAuthHeader(proxy: ProxyConfig): Record<string, string> | undefined {
  const basic = proxyBasicAuth(proxy);
  return basic ? { 'Proxy-Authorization': basic } : undefined;
}
