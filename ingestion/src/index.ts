/**
 * Package entry point for `marsad-ingestion`.
 *
 * The worker imports EXACTLY ONE symbol from here — createIngestionRuntime — via a dynamic
 * import in worker/src/handlers/runtime-wiring.ts (CONTRACT §1). The rest of the surface
 * (core framework, adapters, lake) is re-exported for direct use by CLI tools (replay) and
 * tests.
 */

export {
  createIngestionRuntime,
  type IngestionRuntime,
  type CreateIngestionRuntimeDeps,
  type RunTaskResult,
  type StagedKey,
} from './runtime.js';

export { ADAPTERS } from './adapters/index.js';
export * from './core/index.js';
