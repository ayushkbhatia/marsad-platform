/**
 * Per-source outbound proxy support (P1 runtime fix, GROUND-TRUTH item #4).
 *
 * Some GCC venue origins are IP-geofenced or WAF-blocked from our plain VPS egress
 * IP. We route ONLY the sources that need it — the ones whose
 * ingest.sources.endpoint_config.use_proxy is true — through a **Geonode** residential
 * proxy that exits inside the GCC region (migrated off IPRoyal 2026-07-15; IPRoyal's
 * account was exhausted). Geonode's geo/session selectors live on the USERNAME
 * (`geonode_<user>-type-residential-country-bh`), NOT the password.
 *
 * SECRET HANDLING (hard rule): the proxy URL + credentials NEVER live in code or
 * in the migration. They are read from the environment (the owner sets the real
 * value in the VPS worker.env). This module only:
 *   1. parses a proxy URL from env into a {server, username, password} triple,
 *   2. decides, per source, whether to apply it (use_proxy flag),
 * so both transport clients (undici HttpClient, Playwright BrowserClient) can
 * consume one shared, testable shape.
 *
 * Geonode URL convention: the geo-targeting (and sticky-session) selectors live on the
 * USERNAME, not the host — e.g.
 *   http://proxy.geonode.io:9000  user=geonode_<id>-type-residential-country-bh
 *   password=<uuid>   → exits a Bahrain residential IP.
 * We keep the username verbatim (including the `-type-…-country-…` suffix): Geonode's
 * gateway parses it, we do not. We support both a single packed URL
 * (GEONODE_PROXY_URL / PROXY_URL / IPROYAL_PROXY_URL legacy, with userinfo) and split
 * PROXY_SERVER/PROXY_USERNAME/PROXY_PASSWORD vars, so the owner can set whichever is cleaner.
 */

import type { SourceRecord, ProxyMode } from './types.js';

export type { ProxyMode } from './types.js';

/** Default IP policy when a source is flagged use_proxy but sets no proxy_mode. */
export const DEFAULT_PROXY_MODE: ProxyMode = 'rotate';

/** Sticky-session lifetime (integer minutes) baked into the Geonode `-lifetime-…` selector. */
export const STICKY_SESSION_LIFETIME_MIN = 10;

/** A resolved proxy in the shape both clients want. `server` is scheme+host+port
 *  only (no userinfo) — Playwright's launch proxy and undici's ProxyAgent both
 *  take credentials separately from the server URL. */
export interface ProxyConfig {
  /** e.g. 'http://geo.iproyal.com:12321' — scheme + host + port, NO credentials. */
  server: string;
  /** May be undefined for an unauthenticated proxy. */
  username?: string;
  /** Verbatim, including any IPRoyal `_country-…` geo suffix (+ a `_session-…`
   *  suffix when mode === 'sticky'). */
  password?: string;
  /** The IP policy this proxy was resolved under (rotate = fresh IP/request,
   *  sticky = same IP for a bounded burst). Advisory for the caller; the actual
   *  rotate/sticky behaviour is already encoded in `password`. */
  mode?: ProxyMode;
}

/**
 * Parse a proxy definition out of the environment. Returns undefined when no
 * proxy is configured (the common case — most venues need none). Precedence:
 *   1. IPROYAL_PROXY_URL, else PROXY_URL — a single URL, credentials optional in
 *      the userinfo component.
 *   2. PROXY_SERVER (+ optional PROXY_USERNAME / PROXY_PASSWORD) — split form.
 * Split-form vars, when present, override the packed URL's userinfo so an owner
 * can point at a URL for the host but keep the secret password in its own var.
 */
export function parseProxyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProxyConfig | undefined {
  const rawUrl = firstNonEmpty(env.GEONODE_PROXY_URL, env.PROXY_URL, env.IPROYAL_PROXY_URL);
  const rawServer = firstNonEmpty(env.PROXY_SERVER);

  let base: ProxyConfig | undefined;
  if (rawUrl) {
    base = parseProxyUrl(rawUrl);
  } else if (rawServer) {
    base = { server: normalizeServer(rawServer) };
  }
  if (!base) return undefined;

  // Split-form credential overrides (kept verbatim — do not trim the password;
  // the IPRoyal `_country-…` suffix and any trailing chars are significant).
  const userOverride = firstNonEmpty(env.PROXY_USERNAME);
  const passOverride = env.PROXY_PASSWORD;
  const username = userOverride ?? base.username;
  const password =
    passOverride !== undefined && passOverride !== '' ? passOverride : base.password;

  const out: ProxyConfig = { server: base.server };
  if (username) out.username = username;
  if (password) out.password = password;
  return out;
}

/**
 * Parse a single proxy URL (optionally carrying userinfo) into a ProxyConfig.
 * The username/password are URL-decoded so an owner may percent-encode reserved
 * characters (e.g. `%40` for '@') in the userinfo; the raw `_country-…` suffix
 * survives round-trip because '_' , '-' and ',' are unreserved / decode to self.
 */
export function parseProxyUrl(raw: string): ProxyConfig | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return undefined;
  }
  // server = scheme//host:port, credentials stripped out.
  const server = `${u.protocol}//${u.host}`;
  const out: ProxyConfig = { server };
  if (u.username) out.username = decodeURIComponent(u.username);
  if (u.password) out.password = decodeURIComponent(u.password);
  return out;
}

/** True if this source is flagged to egress through the configured proxy. */
export function sourceUsesProxy(source: Pick<SourceRecord, 'endpointConfig'>): boolean {
  const ec = source.endpointConfig as unknown as { use_proxy?: unknown } | null | undefined;
  return ec?.use_proxy === true;
}

/**
 * The IP policy for THIS source. Reads endpoint_config.proxy_mode; anything other
 * than the two valid literals (including absent, null, or a typo) falls back to
 * DEFAULT_PROXY_MODE ('rotate') — the safe default that defeats per-IP rate limits
 * and never accidentally pins a burst to one IP. Independent of use_proxy: the
 * mode only matters when a proxy is actually applied.
 */
export function sourceProxyMode(source: Pick<SourceRecord, 'endpointConfig'>): ProxyMode {
  const ec = source.endpointConfig as unknown as { proxy_mode?: unknown } | null | undefined;
  return ec?.proxy_mode === 'sticky' ? 'sticky' : DEFAULT_PROXY_MODE;
}

/**
 * Append a Geonode sticky-session selector to the proxy USERNAME so a bounded burst
 * exits the SAME residential IP. Geonode chains selectors on the username
 * (`geonode_<user>-type-residential-country-bh-session-<id>-lifetime-<min>`), NOT the
 * password (this is the key difference from the retired IPRoyal gateway, which chained
 * them on the password). The gateway parses them; we only concatenate. Lifetime is an
 * INTEGER number of minutes (Geonode rejects a `m` suffix). A session id is generated
 * per call — callers that want one IP across N requests must resolve ONCE and reuse the
 * returned config.
 *
 * IMPORTANT: Geonode serves sticky sessions on a SEPARATE gateway port from the rotating
 * port — the rotating port (…:9000) rejects a session selector with
 * "Can not use -session- on rotating ports range". So sticky mode only works when
 * PROXY_SERVER points at a Geonode STICKY port. Until one is configured, keep proxied
 * sources on proxy_mode='rotate'.
 *
 * `rotate` mode returns the proxy untouched (the base creds already rotate per request).
 * If the proxy carries no username, there is nothing to pin a session on → untouched.
 */
export function applyProxyMode(
  proxy: ProxyConfig,
  mode: ProxyMode,
  sessionId: string = randomSessionId(),
): ProxyConfig {
  if (mode !== 'sticky') return { ...proxy, mode: 'rotate' };
  if (!proxy.username) return { ...proxy, mode: 'sticky' };
  // Do not double-append if a session selector is already present (idempotent).
  const username = /-session-/.test(proxy.username)
    ? proxy.username
    : `${proxy.username}-session-${sessionId}-lifetime-${STICKY_SESSION_LIFETIME_MIN}`;
  return { ...proxy, username, mode: 'sticky' };
}

/**
 * The single decision point the worker/transport layer calls: given a source and
 * the environment, return the proxy to use for THIS source, or undefined.
 *
 *  - source not flagged (use_proxy !== true) ⇒ undefined (direct egress).
 *  - flagged but env has no proxy configured ⇒ undefined + throw is NOT done here
 *    (the caller decides whether a missing-but-required proxy is fatal); we only
 *    resolve. Use resolveProxyOrThrow when a flagged source must have a proxy.
 */
export function resolveProxyForSource(
  source: Pick<SourceRecord, 'endpointConfig'>,
  env: NodeJS.ProcessEnv = process.env,
): ProxyConfig | undefined {
  if (!sourceUsesProxy(source)) return undefined;
  const proxy = parseProxyFromEnv(env);
  if (!proxy) return undefined;
  return applyProxyMode(proxy, sourceProxyMode(source));
}

/**
 * Strict variant: a source that declares use_proxy=true but has no proxy in the
 * environment is a misconfiguration we must not silently ignore (it would leak
 * the request out of the plain VPS IP and get a 403). Throws in that case.
 */
export function resolveProxyOrThrow(
  source: Pick<SourceRecord, 'endpointConfig' | 'venue' | 'dataType'>,
  env: NodeJS.ProcessEnv = process.env,
): ProxyConfig | undefined {
  if (!sourceUsesProxy(source)) return undefined;
  const proxy = parseProxyFromEnv(env);
  if (!proxy) {
    throw new Error(
      `source ${source.venue}/${source.dataType} requires a proxy (endpoint_config.use_proxy=true) ` +
        'but no proxy is configured in the environment ' +
        '(set IPROYAL_PROXY_URL or PROXY_URL / PROXY_SERVER+PROXY_USERNAME+PROXY_PASSWORD in worker.env)',
    );
  }
  return applyProxyMode(proxy, sourceProxyMode(source));
}

/**
 * Build a full proxy URL with embedded credentials — the form undici's
 * ProxyAgent constructor accepts (`new ProxyAgent(urlWithAuth)`). Credentials are
 * percent-encoded so the IPRoyal `_country-…` password and any reserved chars
 * survive as valid URL userinfo.
 */
export function proxyToUrl(proxy: ProxyConfig): string {
  if (!proxy.username && !proxy.password) return proxy.server;
  const u = new URL(proxy.server);
  if (proxy.username) u.username = encodeURIComponent(proxy.username);
  if (proxy.password) u.password = encodeURIComponent(proxy.password);
  return u.toString();
}

/** Base64 value for a `Proxy-Authorization: Basic …` header (CONNECT fallback). */
export function proxyBasicAuth(proxy: ProxyConfig): string | undefined {
  if (!proxy.username && !proxy.password) return undefined;
  const raw = `${proxy.username ?? ''}:${proxy.password ?? ''}`;
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
}

/** A short, url-safe random id for an IPRoyal sticky-session selector. Uses the
 *  Web Crypto RNG when available, else Math.random (id is not security-sensitive —
 *  it only groups a burst of requests onto one exit IP). */
function randomSessionId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (typeof g.crypto?.randomUUID === 'function') {
    return g.crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  }
  return Math.random().toString(36).slice(2, 14);
}

function firstNonEmpty(...vals: Array<string | undefined>): string | undefined {
  for (const v of vals) {
    if (v && v.trim() !== '') return v;
  }
  return undefined;
}

/** Ensure a bare host:port gets an http:// scheme so URL parsing works downstream. */
function normalizeServer(raw: string): string {
  const t = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
  return `http://${t}`;
}
