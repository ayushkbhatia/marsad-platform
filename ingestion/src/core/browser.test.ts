import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserClient, type BrowserDriver, type BrowserSession, type BrowserPage } from './browser.js';
import { FetchError } from './types.js';

/** A scriptable fake Playwright driver — zero chromium, zero network. */
function fakeDriver(opts: {
  discoveredUrl?: string | null;
  responses: Array<{ status: number; url?: string; body?: string }>;
  onLaunch?: () => void;
  onClose?: () => void;
}): { driver: BrowserDriver; launches: () => number; navigations: () => string[] } {
  let launches = 0;
  const navigations: string[] = [];
  let call = 0;

  const driver: BrowserDriver = {
    async launch(): Promise<BrowserSession> {
      launches++;
      opts.onLaunch?.();
      const session: BrowserSession = {
        async newPageAndGoto(url: string): Promise<BrowserPage> {
          navigations.push(url);
          const page: BrowserPage = {
            async discoverAjaxUrl() {
              return opts.discoveredUrl ?? null;
            },
            async captureResponseUrl() {
              return opts.discoveredUrl ?? null;
            },
            async settle() {},
            async close() {},
          };
          return page;
        },
        async contextRequest(url) {
          const r = opts.responses[Math.min(call++, opts.responses.length - 1)]!;
          return {
            status: r.status,
            url: r.url ?? url,
            headers: { 'content-type': 'text/html' },
            body: async () => Buffer.from(r.body ?? ''),
          };
        },
        async cookies() {
          return '_abck=seated; bm_sz=seated';
        },
        async close() {
          opts.onClose?.();
        },
      };
      return session;
    },
  };
  return { driver, launches: () => launches, navigations: () => navigations };
}

const discovery = {
  navigateUrl: 'https://www.saudiexchange.sa/wps/portal/.../main-market-watch',
  extract: 'datatable_ajax' as const,
  responseUrlPattern: 'NJgetMainNomucMarketDetails',
};

test('BrowserClient: lazy singleton — no launch until bootstrap/get', async () => {
  const f = fakeDriver({ discoveredUrl: 'https://x/action', responses: [{ status: 200, body: 'ok' }] });
  const c = createBrowserClient({ driver: f.driver, sleep: async () => {}, ratePerSec: 100000 });
  assert.equal(f.launches(), 0, 'no chromium at construction');
  await c.bootstrap(discovery);
  assert.equal(f.launches(), 1, 'launched once on first bootstrap');
});

test('BrowserClient: bootstrap seats cookies + discovers runtime action URL', async () => {
  const f = fakeDriver({
    discoveredUrl: 'https://www.saudiexchange.sa/.../NJgetMainNomucMarketDetails=/?_=1',
    responses: [{ status: 200, body: '{"data":[]}' }],
  });
  const c = createBrowserClient({ driver: f.driver, sleep: async () => {}, ratePerSec: 100000 });
  const boot = await c.bootstrap(discovery);
  assert(boot.resolvedUrl !== null);
  assert.match(boot.resolvedUrl, /NJgetMainNomucMarketDetails/);
  assert.match(boot.cookies, /_abck/);
  assert.deepEqual(f.navigations(), [discovery.navigateUrl]);
});

test('BrowserClient: bootstrap with no discovered URL ⇒ WAF_CHALLENGE', async () => {
  const f = fakeDriver({ discoveredUrl: null, responses: [] });
  const c = createBrowserClient({ driver: f.driver, sleep: async () => {}, ratePerSec: 100000 });
  await assert.rejects(
    () => c.bootstrap(discovery),
    (e: unknown) => e instanceof FetchError && e.errorClass === 'WAF_CHALLENGE',
  );
});

test('BrowserClient: get through context returns body', async () => {
  const f = fakeDriver({ discoveredUrl: 'https://x/a', responses: [{ status: 200, body: '{"data":[1]}' }] });
  const c = createBrowserClient({ driver: f.driver, sleep: async () => {}, ratePerSec: 100000 });
  const res = await c.get('https://x/a');
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), '{"data":[1]}');
});

test('BrowserClient: 403 challenge ⇒ re-bootstrap + one free retry succeeds', async () => {
  let closes = 0;
  const f = fakeDriver({
    discoveredUrl: 'https://x/a',
    responses: [
      { status: 403, body: 'blocked' }, // first get is challenged
      { status: 200, body: 'recovered' }, // retry after re-bootstrap
    ],
    onClose: () => {
      closes++;
    },
  });
  const c = createBrowserClient({ driver: f.driver, sleep: async () => {}, ratePerSec: 100000 });
  await c.bootstrap(discovery); // launch #1
  const res = await c.get('https://x/a');
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), 'recovered');
  assert.ok(f.launches() >= 2, 're-bootstrapped after challenge');
  assert.ok(closes >= 1, 'poisoned session was torn down');
});

test('BrowserClient: persistent 403 after retry ⇒ WAF_CHALLENGE thrown', async () => {
  const f = fakeDriver({
    discoveredUrl: 'https://x/a',
    responses: [{ status: 403, body: 'blocked' }],
  });
  const c = createBrowserClient({ driver: f.driver, sleep: async () => {}, ratePerSec: 100000 });
  await c.bootstrap(discovery);
  await assert.rejects(
    () => c.get('https://x/a'),
    (e: unknown) => e instanceof FetchError && e.errorClass === 'WAF_CHALLENGE',
  );
});

test('BrowserClient: close() releases the singleton', async () => {
  let closes = 0;
  const f = fakeDriver({
    discoveredUrl: 'https://x/a',
    responses: [{ status: 200, body: 'ok' }],
    onClose: () => {
      closes++;
    },
  });
  const c = createBrowserClient({ driver: f.driver, sleep: async () => {}, ratePerSec: 100000 });
  await c.bootstrap(discovery);
  await c.close();
  assert.equal(closes, 1);
  // A subsequent get relaunches lazily.
  await c.get('https://x/a');
  assert.ok(f.launches() >= 2);
});
