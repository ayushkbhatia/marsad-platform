import type { BrowserDriver, BrowserSession, BrowserPage } from './browser.js';

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
}

export function createPlaywrightDriver(opts: PlaywrightDriverOptions = {}): BrowserDriver {
  return {
    async launch(): Promise<BrowserSession> {
      // Lazy import — only paid when a WAF venue actually runs.
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({
        headless: true,
        args: opts.launchArgs ?? [],
      });
      const context = await browser.newContext({
        locale: opts.locale ?? 'en-US',
        ...(opts.userAgent ? { userAgent: opts.userAgent } : {}),
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
