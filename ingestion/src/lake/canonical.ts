import { createHash } from 'node:crypto';

/**
 * Deterministic JSON canonicalization + sha256, used to derive the staging
 * `content_hash` idempotency key (CONTRACT §6.5). PURE — no I/O, no clock.
 *
 * Object keys are sorted recursively so semantically-equal payloads hash equal
 * regardless of key order (a re-parse of the same snapshot must dedupe). Arrays
 * keep order (order is meaning). `undefined` object properties are dropped
 * (JSON has no undefined); numbers/strings/bools/null serialize as JSON.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** sha256 hex of the canonical JSON of `payload`. */
export function contentHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}
