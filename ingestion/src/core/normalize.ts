import { createHash } from 'node:crypto';
import type { NormalizeRule } from './types.js';

/**
 * Content normalization + hashing (§4 step 1). PURE — no I/O, deterministic.
 *
 * Purpose: strip volatile bytes (server timestamps, CSRF/viewstate, request
 * ids, epoch cache-busters) BEFORE hashing so that content-equal fetches
 * dedupe. For JSON bodies we key-sort first (so key ordering never defeats the
 * hash), then apply NormalizeRules in order, then sha256.
 *
 * NOTE: normalization is for HASHING ONLY. The verbatim bytes are always what
 * gets stored (snapshot-first / immutable). Parsers see the raw body.
 */

/** Deterministically stringify JSON with keys sorted at every level. */
export function keySortJson(input: unknown): string {
  return JSON.stringify(sortValue(input));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortValue(obj[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Produce the normalized bytes for hashing. If the body parses as JSON it is
 * key-sorted first. Then each NormalizeRule regex is applied in order. Rules
 * with an invalid regex are skipped defensively (a bad rule must not crash a
 * fetch — it just weakens dedup, surfaced via the returned appliedRules count).
 */
export function normalizeForHash(
  body: Buffer,
  rules: NormalizeRule[],
  contentType?: string,
): { normalized: Buffer; appliedRules: number } {
  let text: string;
  const looksJson =
    (contentType && /json/i.test(contentType)) || isProbablyJson(body);

  if (looksJson) {
    try {
      text = keySortJson(JSON.parse(body.toString('utf8')));
    } catch {
      text = body.toString('utf8'); // not valid JSON after all — treat as text
    }
  } else {
    text = body.toString('utf8');
  }

  let applied = 0;
  for (const rule of rules) {
    try {
      const re = new RegExp(rule.pattern, rule.flags ?? 'g');
      text = text.replace(re, rule.replacement);
      applied++;
    } catch {
      // skip malformed rule; do not throw
    }
  }

  return { normalized: Buffer.from(text, 'utf8'), appliedRules: applied };
}

/** Hex sha256 of the normalized body. */
export function sha256Hex(normalized: Buffer): string {
  return createHash('sha256').update(normalized).digest('hex');
}

/** Convenience: normalize + hash in one call. */
export function contentHash(
  body: Buffer,
  rules: NormalizeRule[],
  contentType?: string,
): { sha256: string; normalized: Buffer } {
  const { normalized } = normalizeForHash(body, rules, contentType);
  return { sha256: sha256Hex(normalized), normalized };
}

function isProbablyJson(body: Buffer): boolean {
  // Cheap sniff on the first non-whitespace byte.
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue;
    return c === 0x7b || c === 0x5b; // '{' or '['
  }
  return false;
}
