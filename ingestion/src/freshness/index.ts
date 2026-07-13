/**
 * Freshness failure-signal layer (01-ingestion.md §8, §10).
 *
 * Public surface of the code half of the two-loop freshness design:
 *   - types.ts          — FeedState, taxonomy, signal/derivation shapes.
 *   - taxonomy.ts       — pure error classification + retry/escalate policy.
 *   - state-machine.ts  — pure TS mirror of ingest.sweep_feed_status().
 *   - fetch-log.ts      — Loop A writer: ingest.fetch_log + ingest.sources.
 *   - halt-auction.ts   — ticker-level halt/auction/stale facts from board data.
 *
 * The SQL sweep (20260713000005_prices.sql) remains the single runtime writer
 * of public.venue_feed_status; nothing here writes that table.
 */

export * from './types.js';
export * from './taxonomy.js';
export * from './state-machine.js';
export * from './fetch-log.js';
export * from './halt-auction.js';
