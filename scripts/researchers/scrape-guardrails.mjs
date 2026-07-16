// scrape-guardrails.mjs — shared proxy-bandwidth guardrails for the Tadawul browser researchers.
//
// The researchers drive a full headed Chromium through the metered Geonode proxy. Two guardrails here:
//   1. RESOURCE INTERCEPTION — abort resources a DOM/data scrape never needs (images, fonts, media) plus
//      analytics/ad/tracker hosts. KEEPS document / script / stylesheet / xhr / fetch, so the SPA still
//      renders, the data XHRs still fire, and — critically on an Akamai host — the Akamai sensor JS
//      (a `script`) still loads and the challenge still clears. Images/fonts/media are behavioral, not
//      part of the TLS/JS fingerprint, so blocking them does not raise the challenge rate (validated live).
//   2. BYTE ACCOUNTING + HARD BUDGET — sum response Content-Length so every run REPORTS its proxy bytes,
//      and expose over() so a run can self-stop before a misconfiguration burns GBs. The budget is a
//      safety net (generous), not the primary control — cadence is (systemd timer, sized to the data's
//      quarterly change rate).
//
// Usage:
//   import { makeGuards } from './scrape-guardrails.mjs';
//   const guards = makeGuards({ maxBytes: Number(process.env.MAX_RUN_BYTES || 800) * 1e6 });
//   ... per browser context:  await guards.install(ctx);
//   ... in the work loop:      if (guards.over()) { /* stop this run gracefully */ }
//   ... at DONE:               log(`bytes ${guards.stats().mb}MB (blocked ${guards.stats().blocked})`);

const BLOCK_TYPES = new Set(['image', 'media', 'font']);
const BLOCK_HOSTS =
  /(google-analytics|googletagmanager|doubleclick|facebook\.net|hotjar|clarity\.ms|adservice|adsystem|scorecardresearch|quantserve|criteo|taboola|newrelic|sentry\.io|mixpanel|segment\.(io|com))/i;

export function makeGuards({ maxBytes = 0 } = {}) {
  let bytes = 0;
  let blocked = 0;
  let allowed = 0;

  async function install(ctx) {
    await ctx.route('**/*', (route) => {
      try {
        const req = route.request();
        if (BLOCK_TYPES.has(req.resourceType()) || BLOCK_HOSTS.test(req.url())) {
          blocked++;
          return route.abort();
        }
        allowed++;
        return route.continue();
      } catch {
        return route.continue();
      }
    });
    // Content-Length is a floor (chunked/compressed responses under-report) — enough for a bytes/run
    // signal and a safety budget, not billing-exact.
    ctx.on('response', (resp) => {
      try {
        const cl = Number(resp.headers()['content-length'] || 0);
        if (Number.isFinite(cl) && cl > 0) bytes += cl;
      } catch {
        /* best effort */
      }
    });
  }

  return {
    install,
    bytes: () => bytes,
    over: () => maxBytes > 0 && bytes > maxBytes,
    stats: () => ({ mb: +(bytes / 1e6).toFixed(1), blocked, allowed, maxMb: +(maxBytes / 1e6).toFixed(0) }),
  };
}
