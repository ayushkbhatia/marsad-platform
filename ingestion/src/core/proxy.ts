/**
 * Per-source outbound proxy support (P1 runtime fix, GROUND-TRUTH item #4).
 *
 * Some GCC venue origins are IP-geofenced or Akamai-blocked from our plain VPS
 * egress IP (recon: bahrainbourse.com official returns 403 direct, 301 through a
 * GCC-exit residential proxy). We route ONLY the sources that need it — the ones
 * whose ingest.sources.endpoint_config.use_proxy is true — through an IPRoyal
 * residential proxy that exits inside the GCC region.
 *
 * SECRET HANDLING (hard rule): the proxy URL + credentials NEVER live in code or
 * in the migration. They are read from the environment (the owner sets the real
 * value in the VPS worker.env). This module only:
 *   1. parses a proxy URL from env into a {server, username, password} triple,
 *   2. decides, per source, whether to apply it (use_proxy flag),
 * so both transport clients (undici HttpClient, Playwright BrowserClient) can
 * consume one shared, testable shape.
 *
 * IPRoyal URL convention (recon item #4): the geo-targeting selector lives on the
 * PASSWORD, not on the host — e.g.
 *   http://geo.iproyal.com:12321  user=ZTfyHFmrsJ9Yerwa
 *   password=aR5AzVF0J4kjnpZ3_country-ae,sa   → exits Riyadh/Dubai.
 * We keep the password verbatim (including the `_country-…` suffix): IPRoyal's
 * gateway parses it, we do not. We support both a single packed URL
 * (IPROYAL_PROXY_URL / PROXY_URL with userinfo) and split PROXY_SERVER/
 * PROXY_USERNAME/PROXY_PASSWORD vars, so the owner can set whichever is cleaner.
 */

import type { SourceRecord } from './types.js';

/** A resolved proxy in the shape both clients want. `server` is scheme+host+port
 *  only (no userinfo) — Playwright's launch proxy and undici's ProxyAgent both
 *  take credentials separately from the server URL. */
export interface ProxyConfig {
  /** e.g. 'http://geo.iproyal.com:12321' — scheme + host + port, NO credentials. */
  server: string;
  /** May be undefined for an unauthenticated proxy. */
  username?: string;
  /** Verbatim, including any IPRoyal `_country-…` geo suffix. */
  password?: string;
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
  const rawUrl = firstNonEmpty(env.IPROYAL_PROXY_URL, env.PROXY_URL);
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
  return parseProxyFromEnv(env);
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
  return proxy;
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
