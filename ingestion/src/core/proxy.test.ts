import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProxyFromEnv,
  parseProxyUrl,
  sourceUsesProxy,
  sourceProxyMode,
  applyProxyMode,
  resolveProxyForSource,
  resolveProxyOrThrow,
  proxyToUrl,
  proxyBasicAuth,
  DEFAULT_PROXY_MODE,
  STICKY_SESSION_LIFETIME_MIN,
  type ProxyConfig,
} from './proxy.js';
import type { SourceRecord } from './types.js';

// A minimal source stub — only the fields the proxy resolver reads.
function src(use_proxy: boolean | undefined, extra: Record<string, unknown> = {}): SourceRecord {
  return {
    id: 1,
    venue: 'BHB',
    dataType: 'quotes',
    entryUrl: 'https://www.bahrainbourse.com/en',
    endpointConfig: { responseKind: 'json', ...(use_proxy === undefined ? {} : { use_proxy }), ...extra } as never,
    normalizeRules: [],
    transport: 'http',
    robotsStatus: 'allowed',
    active: true,
    lastContentHash: null,
  };
}

// IPRoyal-style creds from GROUND TRUTH #4 (geo suffix on the password).
const IPROYAL_URL = 'http://ZTfyHFmrsJ9Yerwa:aR5AzVF0J4kjnpZ3_country-ae%2Csa@geo.iproyal.com:12321';

test('parseProxyUrl: splits server from userinfo, decodes the geo-suffixed password', () => {
  const p = parseProxyUrl(IPROYAL_URL);
  assert.ok(p);
  assert.equal(p.server, 'http://geo.iproyal.com:12321', 'server has NO credentials');
  assert.equal(p.username, 'ZTfyHFmrsJ9Yerwa');
  assert.equal(p.password, 'aR5AzVF0J4kjnpZ3_country-ae,sa', 'geo selector preserved on the password');
});

test('parseProxyUrl: bad input ⇒ undefined', () => {
  assert.equal(parseProxyUrl(''), undefined);
  assert.equal(parseProxyUrl('   '), undefined);
  assert.equal(parseProxyUrl('not a url'), undefined);
});

test('parseProxyFromEnv: absent ⇒ undefined (the common no-proxy case)', () => {
  assert.equal(parseProxyFromEnv({}), undefined);
});

test('parseProxyFromEnv: IPROYAL_PROXY_URL packed form', () => {
  const p = parseProxyFromEnv({ IPROYAL_PROXY_URL: IPROYAL_URL });
  assert.deepEqual(p, {
    server: 'http://geo.iproyal.com:12321',
    username: 'ZTfyHFmrsJ9Yerwa',
    password: 'aR5AzVF0J4kjnpZ3_country-ae,sa',
  });
});

test('parseProxyFromEnv: PROXY_URL is the fallback when IPROYAL_PROXY_URL is absent', () => {
  const p = parseProxyFromEnv({ PROXY_URL: IPROYAL_URL });
  assert.ok(p);
  assert.equal(p.server, 'http://geo.iproyal.com:12321');
});

test('parseProxyFromEnv: IPROYAL_PROXY_URL wins over PROXY_URL', () => {
  const p = parseProxyFromEnv({
    IPROYAL_PROXY_URL: 'http://u1:p1@a.example:1',
    PROXY_URL: 'http://u2:p2@b.example:2',
  });
  assert.equal(p?.server, 'http://a.example:1');
});

test('parseProxyFromEnv: split PROXY_SERVER/USERNAME/PASSWORD form', () => {
  const p = parseProxyFromEnv({
    PROXY_SERVER: 'geo.iproyal.com:12321', // no scheme — normalized to http://
    PROXY_USERNAME: 'ZTfyHFmrsJ9Yerwa',
    PROXY_PASSWORD: 'aR5AzVF0J4kjnpZ3_country-ae,sa',
  });
  assert.deepEqual(p, {
    server: 'http://geo.iproyal.com:12321',
    username: 'ZTfyHFmrsJ9Yerwa',
    password: 'aR5AzVF0J4kjnpZ3_country-ae,sa',
  });
});

test('parseProxyFromEnv: split-form password (raw, not URL-encoded) is kept verbatim', () => {
  // The whole point of split form: the owner can drop the raw password with its
  // literal comma without percent-encoding, and we must not mangle it.
  const p = parseProxyFromEnv({
    PROXY_URL: 'http://olduser:oldpass@geo.iproyal.com:12321',
    PROXY_PASSWORD: 'aR5AzVF0J4kjnpZ3_country-ae,sa',
    PROXY_USERNAME: 'ZTfyHFmrsJ9Yerwa',
  });
  assert.equal(p?.password, 'aR5AzVF0J4kjnpZ3_country-ae,sa', 'split password overrides URL userinfo');
  assert.equal(p?.username, 'ZTfyHFmrsJ9Yerwa');
  assert.equal(p?.server, 'http://geo.iproyal.com:12321');
});

test('parseProxyFromEnv: unauthenticated proxy (server only)', () => {
  const p = parseProxyFromEnv({ PROXY_SERVER: 'http://plain.proxy:8080' });
  assert.deepEqual(p, { server: 'http://plain.proxy:8080' });
});

test('sourceUsesProxy: true only when endpoint_config.use_proxy === true', () => {
  assert.equal(sourceUsesProxy(src(true)), true);
  assert.equal(sourceUsesProxy(src(false)), false);
  assert.equal(sourceUsesProxy(src(undefined)), false, 'absent flag ⇒ direct egress');
  // truthy-but-not-true must not enable the proxy (no accidental opt-in).
  assert.equal(sourceUsesProxy(src(undefined, { use_proxy: 'yes' })), false);
});

test('resolveProxyForSource: env present + use_proxy true ⇒ proxy', () => {
  const p = resolveProxyForSource(src(true), { IPROYAL_PROXY_URL: IPROYAL_URL });
  assert.equal(p?.server, 'http://geo.iproyal.com:12321');
});

test('resolveProxyForSource: use_proxy false ⇒ undefined even when env has a proxy', () => {
  const p = resolveProxyForSource(src(false), { IPROYAL_PROXY_URL: IPROYAL_URL });
  assert.equal(p, undefined, 'non-proxied source never egresses through the proxy');
});

test('resolveProxyForSource: use_proxy true but env absent ⇒ undefined (non-strict)', () => {
  const p = resolveProxyForSource(src(true), {});
  assert.equal(p, undefined);
});

test('resolveProxyOrThrow: flagged source with no env proxy ⇒ throws (misconfig)', () => {
  assert.throws(
    () => resolveProxyOrThrow(src(true), {}),
    /requires a proxy/,
  );
});

test('resolveProxyOrThrow: unflagged source ⇒ undefined, no throw', () => {
  assert.equal(resolveProxyOrThrow(src(false), {}), undefined);
});

test('resolveProxyOrThrow: flagged + env present ⇒ proxy', () => {
  const p = resolveProxyOrThrow(src(true), { PROXY_URL: IPROYAL_URL });
  assert.equal(p?.server, 'http://geo.iproyal.com:12321');
});

test('proxyToUrl: round-trips server + percent-encoded credentials', () => {
  const proxy: ProxyConfig = {
    server: 'http://geo.iproyal.com:12321',
    username: 'ZTfyHFmrsJ9Yerwa',
    password: 'aR5AzVF0J4kjnpZ3_country-ae,sa',
  };
  const url = proxyToUrl(proxy);
  const back = parseProxyUrl(url);
  assert.equal(back?.server, proxy.server);
  assert.equal(back?.username, proxy.username);
  assert.equal(back?.password, proxy.password, 'geo comma survives encode→decode round-trip');
});

test('proxyToUrl: no credentials ⇒ bare server', () => {
  assert.equal(proxyToUrl({ server: 'http://plain.proxy:8080' }), 'http://plain.proxy:8080');
});

test('proxyBasicAuth: builds a Basic header value; undefined when no creds', () => {
  const h = proxyBasicAuth({
    server: 'http://p:1',
    username: 'user',
    password: 'pass',
  });
  assert.equal(h, `Basic ${Buffer.from('user:pass').toString('base64')}`);
  assert.equal(proxyBasicAuth({ server: 'http://p:1' }), undefined);
});

// ---------------------------------------------------------------------------
// P1.7a — per-source rotate-vs-sticky IP policy
// ---------------------------------------------------------------------------

const IPROYAL_BASE: ProxyConfig = {
  server: 'http://geo.iproyal.com:12321',
  username: 'ZTfyHFmrsJ9Yerwa',
  password: 'aR5AzVF0J4kjnpZ3_country-ae,sa',
};

test('DEFAULT_PROXY_MODE is rotate (safe default that defeats per-IP rate limits)', () => {
  assert.equal(DEFAULT_PROXY_MODE, 'rotate');
});

test('sourceProxyMode: absent ⇒ rotate; explicit sticky ⇒ sticky; junk ⇒ rotate', () => {
  assert.equal(sourceProxyMode(src(true)), 'rotate', 'absent proxy_mode ⇒ rotate');
  assert.equal(sourceProxyMode(src(true, { proxy_mode: 'sticky' })), 'sticky');
  assert.equal(sourceProxyMode(src(true, { proxy_mode: 'rotate' })), 'rotate');
  assert.equal(sourceProxyMode(src(true, { proxy_mode: 'STICKY' })), 'rotate', 'typo ⇒ safe rotate');
  assert.equal(sourceProxyMode(src(true, { proxy_mode: null })), 'rotate');
  // Mode is independent of use_proxy — it only matters once a proxy is applied.
  assert.equal(sourceProxyMode(src(false, { proxy_mode: 'sticky' })), 'sticky');
});

test('applyProxyMode: rotate leaves the base password untouched (fresh IP/request)', () => {
  const p = applyProxyMode(IPROYAL_BASE, 'rotate');
  assert.equal(p.password, IPROYAL_BASE.password, 'no session selector appended');
  assert.equal(p.mode, 'rotate');
  assert.equal(p.server, IPROYAL_BASE.server);
  assert.equal(p.username, IPROYAL_BASE.username);
});

test('applyProxyMode: sticky appends an IPRoyal _session-…_lifetime-… selector', () => {
  const p = applyProxyMode(IPROYAL_BASE, 'sticky', 'abc123');
  assert.equal(
    p.password,
    `aR5AzVF0J4kjnpZ3_country-ae,sa_session-abc123_lifetime-${STICKY_SESSION_LIFETIME_MIN}m`,
    'session selector chained after the existing _country- selector',
  );
  assert.equal(p.mode, 'sticky');
});

test('applyProxyMode: sticky is idempotent — never double-appends a session selector', () => {
  const once = applyProxyMode(IPROYAL_BASE, 'sticky', 'abc123');
  const twice = applyProxyMode(once, 'sticky', 'zzz999');
  assert.equal(twice.password, once.password, 'second sticky pass is a no-op on the password');
});

test('applyProxyMode: sticky on an unauthenticated proxy has no password to pin ⇒ untouched', () => {
  const p = applyProxyMode({ server: 'http://plain.proxy:8080' }, 'sticky');
  assert.equal(p.password, undefined);
  assert.equal(p.mode, 'sticky');
});

test('applyProxyMode: distinct session ids ⇒ distinct pinned passwords (different IP bursts)', () => {
  const a = applyProxyMode(IPROYAL_BASE, 'sticky');
  const b = applyProxyMode(IPROYAL_BASE, 'sticky');
  assert.notEqual(a.password, b.password, 'auto-generated session ids differ');
});

test('resolveProxyForSource: YAHOO-shaped source ⇒ rotate proxy (fresh IP/request)', () => {
  // A Yahoo source as flipped by migration 0027: use_proxy=true + proxy_mode=rotate.
  const yahoo = src(true, { provider: 'yahoo', proxy_mode: 'rotate' });
  const p = resolveProxyForSource(yahoo, { IPROYAL_PROXY_URL: IPROYAL_URL });
  assert.ok(p);
  assert.equal(p.mode, 'rotate');
  assert.equal(p.server, 'http://geo.iproyal.com:12321');
  assert.equal(p.password, 'aR5AzVF0J4kjnpZ3_country-ae,sa', 'no session selector — rotates per request');
});

test('resolveProxyForSource: WAF-shaped source (sticky) ⇒ IP-pinned proxy', () => {
  const waf = src(true, { proxy_mode: 'sticky' });
  const p = resolveProxyForSource(waf, { IPROYAL_PROXY_URL: IPROYAL_URL });
  assert.ok(p);
  assert.equal(p.mode, 'sticky');
  assert.match(p.password ?? '', /_session-[^_]+_lifetime-\d+m$/, 'session selector appended for affinity');
});

test('resolveProxyForSource: unflagged source ⇒ direct (undefined), no proxy regardless of mode', () => {
  const none = src(false, { proxy_mode: 'sticky' });
  assert.equal(resolveProxyForSource(none, { IPROYAL_PROXY_URL: IPROYAL_URL }), undefined);
});

test('resolveProxyForSource: flagged, mode absent ⇒ rotate (BHB default would be sticky via its own config)', () => {
  const p = resolveProxyForSource(src(true), { IPROYAL_PROXY_URL: IPROYAL_URL });
  assert.equal(p?.mode, 'rotate', 'no proxy_mode ⇒ DEFAULT_PROXY_MODE');
});

test('resolveProxyOrThrow: carries the resolved mode through', () => {
  const rotate = resolveProxyOrThrow(src(true, { provider: 'yahoo', proxy_mode: 'rotate' }), {
    PROXY_URL: IPROYAL_URL,
  });
  assert.equal(rotate?.mode, 'rotate');
  const sticky = resolveProxyOrThrow(src(true, { proxy_mode: 'sticky' }), { PROXY_URL: IPROYAL_URL });
  assert.equal(sticky?.mode, 'sticky');
});
