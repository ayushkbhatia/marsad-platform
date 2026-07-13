/**
 * Public barrel for ingestion/src/core — the transport-agnostic framework.
 * Adapters, worker handlers, and the lake modules import from here.
 */

export * from './types.js';
export { loadConfig, type IngestionConfig } from './config.js';
export { createDb, type Sql } from './db.js';

// Proxy (per-source outbound proxy support)
export {
  parseProxyFromEnv,
  parseProxyUrl,
  sourceUsesProxy,
  resolveProxyForSource,
  resolveProxyOrThrow,
  proxyToUrl,
  proxyBasicAuth,
  type ProxyConfig,
} from './proxy.js';

// Transport
export {
  createHttpClient,
  parseRetryAfter,
  makeProxiedTransport,
  type HttpClientOptions,
} from './fetcher.js';
export {
  createBrowserClient,
  type BrowserClientOptions,
  type BrowserDriver,
  type BrowserSession,
  type BrowserPage,
} from './browser.js';
export { createPlaywrightDriver, type PlaywrightDriverOptions } from './playwright-driver.js';
export {
  TokenBucket,
  DailyBudget,
  Semaphore,
  HostLimiterRegistry,
  hostOf,
  type Clock,
} from './rate-limit.js';

// Normalization + hashing
export {
  normalizeForHash,
  keySortJson,
  sha256Hex,
  contentHash,
} from './normalize.js';

// Snapshot store + parse ledger
export {
  createSnapshotStore,
  createParseRunRecorder,
  storageKey,
  type SnapshotStoreDeps,
  type PutSnapshotInputExt,
} from './snapshot.js';
export {
  runParse,
  openLakeParseRun,
  type ParseHarnessResult,
  type RunParseDeps,
  type LakeParseRun,
} from './parse-harness.js';

// Storage
export {
  createStorageUploader,
  type StorageUploader,
  type StorageUploaderOptions,
  type StorageTransport,
} from './storage.js';

// Registry / scheduler / heartbeat
export {
  loadSource,
  loadSourcesForVenue,
  agentAccountFor,
  resolvePrincipalId,
  isAgentRunEnabled,
} from './registry.js';
export {
  triggerEnqueueDueJobs,
  triggerSweepFeedStatus,
  venueIsOpen,
  claimNextJob,
  finishJob,
  requeueStuckJobs,
  cadenceMultiplier,
  type ClaimedJob,
  type JobOutcome,
} from './scheduler.js';
export { createHeartbeatWriter, type HeartbeatWriter } from './heartbeat.js';
