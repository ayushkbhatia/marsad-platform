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

/**
 * Regression — ADX quotes sat dead 46h (2026-07-15 11:07 → 2026-07-17 09:5x).
 *
 * Chromium died out-of-band; `newPageAndGoto` then threw "Target page, context or
 * browser has been closed" on EVERY later bootstrap. The dead handle stayed non-null,
 * so ensureSession() kept returning it, and refreshIfChallenged() never fired because
 * a dead session throws before producing a 401/403 status. Only a worker restart cleared it.
 */
test('BrowserClient: a dead session does not wedge bootstrap forever (relaunches)', async () => {
  let launches = 0;
  let killNextNavigate = true;
  const driver: BrowserDriver = {
    async launch(): Promise<BrowserSession> {
      launches++;
      // Only the FIRST launched session is poisoned; a relaunch yields a healthy one.
      const poisoned = killNextNavigate;
      killNextNavigate = false;
      return {
        async newPageAndGoto(): Promise<BrowserPage> {
          if (poisoned) {
            throw new Error('browserContext.newPage: Target page, context or browser has been closed');
          }
          return {
            async discoverAjaxUrl() {
              return 'https://x/action';
            },
            async captureResponseUrl() {
              return 'https://x/action';
            },
            async settle() {},
            async close() {},
          };
        },
        async contextRequest(url) {
          return {
            status: 200,
            url,
            headers: {},
            body: async () => Buffer.from('ok'),
          };
        },
        async cookies() {
          return '_abck=seated';
        },
        async close() {},
      };
    },
  };

  const c = createBrowserClient({ driver, sleep: async () => {}, ratePerSec: 100000 });

  // Before the fix this threw; the dead handle was never discarded.
  const res = await c.bootstrap(discovery);
  assert.equal(res.resolvedUrl, 'https://x/action', 'recovered on the in-place relaunch');
  assert.equal(launches, 2, 'discarded the dead session and relaunched exactly once');

  // And it stays healthy — no relaunch storm on the next poll.
  await c.bootstrap(discovery);
  assert.equal(launches, 2, 'healthy session is reused, not relaunched');
});

test('BrowserClient: dead session during a request is discarded (heals next poll)', async () => {
  let launches = 0;
  let dead = true;
  const driver: BrowserDriver = {
    async launch(): Promise<BrowserSession> {
      launches++;
      const poisoned = dead;
      dead = false;
      return {
        async newPageAndGoto(): Promise<BrowserPage> {
          return {
            async discoverAjaxUrl() {
              return 'https://x/action';
            },
            async captureResponseUrl() {
              return 'https://x/action';
            },
            async settle() {},
            async close() {},
          };
        },
        async contextRequest(url) {
          if (poisoned) throw new Error('Target closed');
          return { status: 200, url, headers: {}, body: async () => Buffer.from('ok') };
        },
        async cookies() {
          return '_abck=seated';
        },
        async close() {},
      };
    },
  };

  const c = createBrowserClient({ driver, sleep: async () => {}, ratePerSec: 100000 });
  await assert.rejects(() => c.get('https://x/a'), /Target closed/, 'surfaces the failure');
  // The poisoned handle must be gone — the retry gets a fresh browser rather than the corpse.
  const res = await c.get('https://x/a');
  assert.equal(res.status, 200, 'next call self-heals');
  assert.equal(launches, 2, 'relaunched once after discarding the dead session');
});

/**
 * Concurrency regressions (2026-07-27). ONE BrowserClient is shared by the whole runtime
 * (runtime.ts:1125) while the ingest poller runs `ingestConcurrency` lanes (default 4) in
 * parallel, so several tasks reach this client at the same instant. Two lifecycle bugs
 * only appear under that overlap, and both end in the same symptom the 07-17 wedge fix
 * chased: `Target page, context or browser has been closed`.
 */

test('BrowserClient: concurrent cold starts launch ONE chromium (no leaked browsers)', async () => {
  let launches = 0;
  let closes = 0;
  const driver: BrowserDriver = {
    async launch(): Promise<BrowserSession> {
      launches++;
      // A real chromium launch takes ~1s; the yield is what opened the race window.
      await new Promise((r) => setTimeout(r, 5));
      return {
        async newPageAndGoto(): Promise<BrowserPage> {
          return {
            async discoverAjaxUrl() {
              return 'https://x/action';
            },
            async captureResponseUrl() {
              return 'https://x/action';
            },
            async settle() {},
            async close() {},
          };
        },
        async contextRequest(url) {
          return { status: 200, url, headers: {}, body: async () => Buffer.from('ok') };
        },
        async cookies() {
          return '_abck=seated';
        },
        async close() {
          closes++;
        },
      };
    },
  };

  const c = createBrowserClient({ driver, sleep: async () => {}, ratePerSec: 100000 });
  // Four lanes hit a cold client together — the shape runtime.ts produces every worker boot.
  await Promise.all([c.bootstrap(discovery), c.bootstrap(discovery), c.get('https://x/a'), c.get('https://x/b')]);

  // Before the fix: 4 launches, 3 of them unreachable and never closed — the leak that
  // walks the 2-vCPU box into the OOM → dead-session wedge.
  assert.equal(launches, 1, 'exactly one chromium for N concurrent cold callers');
  await c.close();
  assert.equal(closes, 1, 'and the one browser is the one that gets closed on drain');
});

test('BrowserClient: a late discard cannot close the session another lane just relaunched', async () => {
  let launches = 0;
  const closed: number[] = [];
  const driver: BrowserDriver = {
    async launch(): Promise<BrowserSession> {
      const id = ++launches;
      // Only session #1 is poisoned; every relaunch is healthy.
      const poisoned = id === 1;
      return {
        async newPageAndGoto(): Promise<BrowserPage> {
          return {
            async discoverAjaxUrl() {
              return 'https://x/action';
            },
            async captureResponseUrl() {
              return 'https://x/action';
            },
            async settle() {},
            async close() {},
          };
        },
        async contextRequest(url) {
          if (!poisoned) {
            return { status: 200, url, headers: {}, body: async () => Buffer.from('ok') };
          }
          // The dead browser fails every lane on it, but not at the same instant — a lane
          // already waiting on a response only learns the context is gone when its own
          // call unwinds. That skew is the whole bug.
          if (url.endsWith('/slow')) await new Promise((r) => setTimeout(r, 20));
          throw new Error('Target closed');
        },
        async cookies() {
          return '_abck=seated';
        },
        async close() {
          closed.push(id);
        },
      };
    },
  };

  const c = createBrowserClient({ driver, sleep: async () => {}, ratePerSec: 100000 });

  // Warm the client so every lane below provably shares session #1 — this test is about
  // the discard, not the launch race (covered above).
  await c.bootstrap(discovery);
  assert.equal(launches, 1);

  // Lane 1 is in flight on #1 and will not learn it is dead for another 20ms.
  const slowLane = c.get('https://x/slow');
  // Lane 2 fails on #1 immediately and discards it...
  await assert.rejects(() => c.get('https://x/fast'), /Target closed/);
  // ...so this poll relaunches — session #2, healthy, now serving the fleet.
  assert.equal((await c.get('https://x/fresh')).status, 200);
  assert.equal(launches, 2, 'one replacement launched');
  // Only NOW does lane 1's failure land, carrying a handle on the long-dead #1.
  await assert.rejects(() => slowLane, /Target closed/);

  // Before the fix that late discard closed whatever was current — the HEALTHY #2 — and
  // with work still arriving the lanes kill each other's browsers indefinitely.
  assert.deepEqual(closed, [1], 'only the dead session #1 was closed');
  assert.equal((await c.get('https://x/after')).status, 200, 'session #2 survived');
  assert.equal(launches, 2, 'no relaunch storm — one replacement, then reuse');
});
