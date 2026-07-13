/**
 * Frozen failure taxonomy (CONTRACT §10 / 01 §8 Loop A).
 *
 * Pure classification: given what a fetch/parse produced, decide the error class
 * and the policy (retryable / quality-error / escalate). No I/O, no Date.now().
 *
 * The taxonomy itself is defined ONCE, in core/types.ts, and is what the
 * transport layer throws (core/fetcher.ts / core/browser.ts raise the
 * `FetchError` class). This module does NOT redeclare it; it imports the shared
 * `FetchError` class + `FetchErrorClass` union and adds only the freshness-side
 * POLICY table plus a few pure constructors for the parse-side (PARSE_DRIFT) and
 * for handlers that must re-derive a class from a bare status. A caught core
 * FetchError flows straight into `FetchOutcome.error`; `policyFor(err.errorClass)`
 * decides what to do with it.
 *
 * 429 note: the transport (core/fetcher.ts) folds 429 into HTTP_5XX — it honors
 * Retry-After and retries with backoff, but the thrown `errorClass` is HTTP_5XX.
 * This module mirrors that single choice (there is no RATE_LIMITED class in the
 * frozen §10 taxonomy) so the class written to ingest.fetch_log.error can never
 * contradict what the transport believed the class was.
 */

import type { FetchErrorClass, ErrorPolicy } from './types.js';
import { FetchError } from './types.js';

/**
 * Retry / escalation policy per class. Retry schedules themselves live in
 * core/fetcher.ts (5s→25s→120s ±30% jitter, 3 attempts); this table only says
 * WHETHER a class retries and whether it is a Desk-bound quality error.
 */
const POLICIES: Record<FetchErrorClass, ErrorPolicy> = {
  NETWORK: { errorClass: 'NETWORK', retryable: true, qualityError: false, escalate: false },
  // 429 is folded into HTTP_5XX by the transport: retry with backoff, honoring
  // Retry-After (core/fetcher.ts). Not a quality error.
  HTTP_5XX: { errorClass: 'HTTP_5XX', retryable: true, qualityError: false, escalate: false },
  // Bootstrap refresh + one free immediate retry (BrowserClient); only escalates
  // if the refresh itself fails (the handler re-classifies the retry outcome).
  WAF_CHALLENGE: {
    errorClass: 'WAF_CHALLENGE',
    retryable: true,
    qualityError: false,
    escalate: false,
  },
  // "Endpoint moved" — no retry, straight to Desk, notify owner.
  HTTP_4XX: { errorClass: 'HTTP_4XX', retryable: false, qualityError: true, escalate: true },
  // "Site redesigned under us" — no retry, straight to Desk, notify owner.
  PARSE_DRIFT: { errorClass: 'PARSE_DRIFT', retryable: false, qualityError: true, escalate: true },
};

export function policyFor(cls: FetchErrorClass): ErrorPolicy {
  return POLICIES[cls];
}

/**
 * Classify an HTTP-level failure by status code into a throwable `FetchError`
 * (the SAME class the transport raises). A challenge is detected by the caller
 * (BrowserClient sees the WAF interstitial) and passed as `waf`; a bare 403 from
 * a plain HTTP client on a WAF venue is also treated as a challenge.
 *
 * This mirrors core/fetcher.ts's status→class mapping exactly, including folding
 * 429 into HTTP_5XX (retryable, Retry-After honored via `retryAfterMs`).
 *
 * @param status HTTP status of the failing response.
 * @param opts.waf  true when the transport recognised a WAF/interstitial body.
 * @param opts.retryAfterMs parsed Retry-After header (429/503), in ms, if any.
 */
export function classifyHttpFailure(
  status: number,
  opts: { waf?: boolean; retryAfterMs?: number | null; message?: string } = {},
): FetchError {
  const message = opts.message ?? `HTTP ${status}`;
  const retryAfterMs = opts.retryAfterMs ?? undefined;
  if (opts.waf || status === 401 || status === 403) {
    return new FetchError('WAF_CHALLENGE', message, { status });
  }
  if (status === 429 || status >= 500) {
    // 429 folds into HTTP_5XX to match the transport (core/fetcher.ts): retry
    // with backoff, honoring Retry-After when present.
    return new FetchError('HTTP_5XX', message, {
      status,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  if (status >= 400) {
    return new FetchError('HTTP_4XX', message, { status });
  }
  // 3xx/2xx shouldn't reach here — treat an unexpected non-2xx as 4xx (moved).
  return new FetchError('HTTP_4XX', message, { status });
}

/**
 * Classify a thrown transport error (no HTTP response arrived): timeouts,
 * connection resets, DNS failures ⇒ NETWORK. If the transport already raised a
 * `FetchError` (the common case — core/fetcher.ts classifies internally), it is
 * returned as-is. Otherwise we wrap the message as NETWORK.
 */
export function classifyThrown(err: unknown): FetchError {
  if (err instanceof FetchError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new FetchError('NETWORK', message, { cause: err });
}

/**
 * PARSE_DRIFT: fetch succeeded and the snapshot CHANGED, but the pure parser
 * emitted zero rows (or a zod validation failed). On an UNCHANGED snapshot,
 * zero rows is normal (nothing to re-emit) and is NOT drift.
 */
export function classifyParseDrift(
  changed: boolean,
  rowsEmitted: number,
  zodFailed = false,
): FetchError | null {
  if (!changed) return null;
  if (zodFailed || rowsEmitted === 0) {
    return new FetchError(
      'PARSE_DRIFT',
      zodFailed
        ? 'parser validation failed on a changed snapshot'
        : 'parser emitted zero rows on a changed snapshot',
    );
  }
  return null;
}
