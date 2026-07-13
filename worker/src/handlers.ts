/**
 * Public barrel for the worker's pgmq handler layer.
 *
 * The registry primitives live in ./handlers/index.ts; the P1 ingestion
 * handlers (CONTRACT §9) live under ./handlers/. This barrel re-exports the
 * surface the entrypoint (src/index.ts) needs to boot ingestion:
 *
 *   const runtime = await createIngestionRuntime({ sql, config });
 *   const names = registerIngestionHandlers(runtime);
 *
 * plus the frozen payload/runtime types other worker code may reference.
 */
export {
  registerHandler,
  resolveHandler,
  registeredHandlers,
  type Handler,
  type HandlerContext,
  type MessagePayload,
} from './handlers/index.js';

export { registerIngestionHandlers } from './handlers/register-ingestion-handlers.js';
export { createIngestionRuntime } from './handlers/runtime-wiring.js';

export type {
  HandlerName,
  QuotePollPayload,
  EodSweepPayload,
  FilingsPollPayload,
  CrossCheckPayload,
  KeyRatiosPayload,
} from './handlers/payloads.js';

export type {
  IngestionRuntime,
  VenueCode,
  DataType,
  SourceRecord,
  RunTaskResult,
  StagedKey,
} from './handlers/ingestion-runtime.js';
