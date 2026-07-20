import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, deflateSync, deflateRawSync, brotliCompressSync } from 'node:zlib';
import {
  createHttpClient,
  decodeContentEncoding,
  parseRetryAfter,
  makeCurlTransport,
  type CurlExec,
  type LowLevelTransport,
  type LowLevelResponse,
} from './fetcher.js';
import { FetchError } from './types.js';

function jsonResponse(status: number, body: string, headers: Record<string, string> = {}): LowLevelResponse {
  return {
    statusCode: status,
    headers,
    body: { arrayBuffer: async () => new TextEncoder().encode(body).buffer },
  };
}

function fakeTransport(script: LowLevelResponse[] | ((call: number, url: string) => LowLevelResponse)) {
  let call = 0;
  const calls: string[] = [];
  const t: LowLevelTransport = async (url) => {
    calls.push(url);
    const idx = call++;
    const res = Array.isArray(script) ? script[Math.min(idx, script.length - 1)]! : script(idx, url);
    return res;
  };
  return { t, calls: () => calls };
}

const noSleep = async () => {};
// Unit tests exercise retry/budget/conditional logic, not the ≤1 req/s smoother
// (that has its own coverage in rate-limit.test.ts). A high rate keeps the token
// bucket out of the way so back-to-back fake requests don't stall under noSleep.
const FAST = { ratePerSec: 100_000 };

test('HttpClient: happy path returns body + flattened headers', async () => {
  const { t } = fakeTransport([jsonResponse(200, '{"ok":true}', { 'Content-Type': 'application/json' })]);
  const c = createHttpClient({ transport: t, sleep: noSleep, ...FAST });
  const res = await c.get('https://qe.com.qa/x.txt');
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), '{"ok":true}');
  assert.equal(res.headers['content-type'], 'application/json');
  assert.equal(res.fromCache304, false);
});

test('HttpClient: 304 returns empty body + fromCache304', async () => {
  const { t } = fakeTransport([jsonResponse(304, '', { etag: 'W/"a"' })]);
  const c = createHttpClient({ transport: t, sleep: noSleep, ...FAST });
  const res = await c.get('https://x.test/', { conditional: { etag: 'W/"a"' } });
  assert.equal(res.status, 304);
  assert.equal(res.fromCache304, true);
  assert.equal(res.body.length, 0);
});

test('HttpClient: retries 5xx then succeeds (3 attempts)', async () => {
  const { t, calls } = fakeTransport([
    jsonResponse(503, 'busy'),
    jsonResponse(500, 'busy'),
    jsonResponse(200, 'done'),
  ]);
  const c = createHttpClient({ transport: t, sleep: noSleep, maxRetries: 3, ...FAST });
  const res = await c.get('https://x.test/');
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), 'done');
  assert.equal(calls().length, 3);
});

test('HttpClient: 5xx exhausts retries → FetchError HTTP_5XX', async () => {
  const { t, calls } = fakeTransport([jsonResponse(500, 'x')]);
  const c = createHttpClient({ transport: t, sleep: noSleep, maxRetries: 3, ...FAST });
  await assert.rejects(
    () => c.get('https://x.test/'),
    (e: unknown) => e instanceof FetchError && e.errorClass === 'HTTP_5XX',
  );
  assert.equal(calls().length, 3, 'exactly maxRetries attempts');
});

test('HttpClient: 4xx does NOT retry (endpoint moved)', async () => {
  const { t, calls } = fakeTransport([jsonResponse(404, 'gone')]);
  const c = createHttpClient({ transport: t, sleep: noSleep, ...FAST });
  await assert.rejects(
    () => c.get('https://x.test/'),
    (e: unknown) => e instanceof FetchError && e.errorClass === 'HTTP_4XX' && e.status === 404,
  );
  assert.equal(calls().length, 1, 'no retry on 4xx');
});

test('HttpClient: 429 honors Retry-After then succeeds', async () => {
  const { t, calls } = fakeTransport([
    jsonResponse(429, '', { 'retry-after': '2' }),
    jsonResponse(200, 'ok'),
  ]);
  const sleeps: number[] = [];
  const c = createHttpClient({
    transport: t,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    maxRetries: 3,
    ...FAST,
  });
  const res = await c.get('https://x.test/');
  assert.equal(res.status, 200);
  assert.equal(calls().length, 2);
  // Retry-After=2s ⇒ backoff base 2000ms ±30% jitter (§10) ⇒ ~1400–2600ms.
  assert.ok(
    sleeps.some((s) => s >= 1400),
    `slept ~2s per Retry-After (got ${JSON.stringify(sleeps)})`,
  );
});

test('HttpClient: network error retried then classified NETWORK', async () => {
  let n = 0;
  const t: LowLevelTransport = async () => {
    n++;
    throw new Error('ECONNRESET');
  };
  const c = createHttpClient({ transport: t, sleep: noSleep, maxRetries: 2, ...FAST });
  await assert.rejects(
    () => c.get('https://x.test/'),
    (e: unknown) => e instanceof FetchError && e.errorClass === 'NETWORK',
  );
  assert.equal(n, 2);
});

test('HttpClient: per-host daily budget hard ceiling refuses over-limit', async () => {
  const { t } = fakeTransport([jsonResponse(200, 'ok')]);
  const c = createHttpClient({ transport: t, sleep: noSleep, budgetPerHostPerDay: 2, ...FAST });
  await c.get('https://cap.test/1');
  await c.get('https://cap.test/2');
  await assert.rejects(
    () => c.get('https://cap.test/3'),
    (e: unknown) => e instanceof FetchError && e.errorClass === 'HTTP_4XX' && /budget/.test(e.message),
  );
});

test('parseRetryAfter: seconds and HTTP-date forms', () => {
  assert.equal(parseRetryAfter('5'), 5000);
  assert.equal(parseRetryAfter(undefined), undefined);
  const future = new Date(Date.now() + 10_000).toUTCString();
  const ms = parseRetryAfter(future);
  assert.ok(ms !== undefined && ms > 5000 && ms <= 11000);
});

// ── content-encoding decode (the OHLCV-backfill 0-bars root cause) ────────────────────────────────
// undici.request does not auto-decompress; we advertise accept-encoding: gzip, so a compliant origin
// (Yahoo) returns compressed bytes. Without decode the raw parser JSON.parse's gzip → zero rows.

test('decodeContentEncoding: gzip → plaintext', () => {
  const plain = '{"chart":{"result":[{"meta":{"symbol":"2222.SR"}}]}}';
  const out = decodeContentEncoding(gzipSync(Buffer.from(plain)), 'gzip');
  assert.equal(out.toString('utf8'), plain);
});

test('decodeContentEncoding: deflate (zlib-wrapped) and raw deflate both decode', () => {
  const plain = 'hello deflate';
  assert.equal(decodeContentEncoding(deflateSync(Buffer.from(plain)), 'deflate').toString(), plain);
  assert.equal(decodeContentEncoding(deflateRawSync(Buffer.from(plain)), 'deflate').toString(), plain);
});

test('decodeContentEncoding: br → plaintext', () => {
  const plain = 'hello brotli';
  assert.equal(decodeContentEncoding(brotliCompressSync(Buffer.from(plain)), 'br').toString(), plain);
});

test('decodeContentEncoding: identity / absent / unknown pass through untouched', () => {
  const raw = Buffer.from('{"a":1}');
  assert.equal(decodeContentEncoding(raw, undefined), raw);
  assert.equal(decodeContentEncoding(raw, 'identity'), raw);
  assert.equal(decodeContentEncoding(raw, 'weird-codec'), raw);
});

test('decodeContentEncoding: multi-codec list uses the outermost (last) codec', () => {
  const plain = 'stacked';
  // Sent as "identity, gzip" ⇒ gzip is outermost.
  const out = decodeContentEncoding(gzipSync(Buffer.from(plain)), 'identity, gzip');
  assert.equal(out.toString(), plain);
});

test('decodeContentEncoding: corrupt/mislabeled body returns RAW, never throws', () => {
  const notGzip = Buffer.from('plain text, definitely not gzip');
  assert.equal(decodeContentEncoding(notGzip, 'gzip'), notGzip);
});

test('HttpClient: a gzip-encoded response is decoded before it reaches the caller', async () => {
  const plain = '{"chart":{"result":[{"meta":{"symbol":"2222.SR"},"timestamp":[1]}]}}';
  const gz = gzipSync(Buffer.from(plain));
  const t: LowLevelTransport = async () => ({
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    body: { arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength) },
  });
  const c = createHttpClient({ transport: t, sleep: noSleep, ...FAST });
  const res = await c.get('https://query1.finance.yahoo.com/v8/finance/chart/2222.SR');
  assert.equal(res.body.toString('utf8'), plain, 'body handed to the parser is plaintext, not gzip');
  assert.equal(res.headers['content-encoding'], undefined, 'stale content-encoding header dropped');
  // Proves the real bug is gone: JSON.parse now succeeds on the returned body.
  assert.equal(JSON.parse(res.body.toString('utf8')).chart.result[0].meta.symbol, '2222.SR');
});

// ── curl transport (QE-quotes fix) ─────────────────────────────────────────────
// Mimics real curl: emit the body to stdout, then append the -w trailer (curl substitutes the
// %{...} placeholders after the transfer). Reading the marker from the -w arg keeps the fake
// decoupled from the transport's internal marker constant.
function fakeCurl(
  body: string,
  status: number,
  contentType: string,
  capture?: { args?: string[] },
): CurlExec {
  return async (args) => {
    if (capture) capture.args = args;
    const w = args[args.indexOf('-w') + 1] ?? '';
    const trailer = w.replace('%{http_code}', String(status)).replace('%{content_type}', contentType);
    return Buffer.from(body + trailer, 'utf8');
  };
}

test('curl transport: recovers status, content-type, and body from curl output', async () => {
  const t = makeCurlTransport({ exec: fakeCurl('{"rows":[]}', 200, 'application/json') });
  const res = await t('https://qe/board', { method: 'POST', headers: {} });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json');
  assert.equal(Buffer.from(await res.body.arrayBuffer()).toString('utf8'), '{"rows":[]}');
});

test('curl transport: builds args (method, headers, body, --compressed; skips accept-encoding)', async () => {
  const cap: { args?: string[] } = {};
  const t = makeCurlTransport({ exec: fakeCurl('ok', 200, 'text/plain', cap) });
  await t('https://qe/board', {
    method: 'POST',
    headers: { 'user-agent': 'UA', 'accept-encoding': 'gzip, deflate', 'x-test': '1' },
    body: 'f=MarketWatch',
  });
  const a = cap.args!;
  assert.ok(a.includes('--compressed'), 'curl decodes compression itself');
  assert.equal(a[a.indexOf('-X') + 1], 'POST');
  assert.ok(a.includes('user-agent: UA') && a.includes('x-test: 1'), 'headers forwarded');
  assert.ok(!a.some((x) => x.toLowerCase().startsWith('accept-encoding:')), 'accept-encoding dropped');
  assert.ok(a.includes('--data-binary') && a.includes('f=MarketWatch'), 'POST body sent');
  assert.equal(a[a.length - 1], 'https://qe/board', 'url passed after -- terminator');
});

test('curl transport: no trailer (connection reset mid-transfer) throws NETWORK', async () => {
  const t = makeCurlTransport({ exec: async () => Buffer.from('partial body, curl died', 'utf8') });
  await assert.rejects(
    () => t('https://qe/board', { method: 'GET', headers: {} }),
    (e: unknown) => e instanceof FetchError && e.errorClass === 'NETWORK',
  );
});

test('curl transport: end-to-end through createHttpClient hands the parser plaintext', async () => {
  const c = createHttpClient({
    transport: makeCurlTransport({ exec: fakeCurl('{"ok":true}', 200, 'application/json') }),
    sleep: noSleep,
    ...FAST,
  });
  const res = await c.request('https://qe/board', { method: 'POST', body: 'f=MarketWatch' });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body.toString('utf8')).ok, true);
});
