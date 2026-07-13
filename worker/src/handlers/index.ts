import type { Sql } from "../db.js";
import type { Logger } from "../log.js";
import type { WorkerConfig } from "../config.js";

/** The JSON payload carried inside a pgmq message. */
export type MessagePayload = Record<string, unknown>;

export interface HandlerContext {
  sql: Sql;
  log: Logger;
  config: WorkerConfig;
  queue: string;
  /** pgmq message id (bigint — postgres.js returns it as a string). */
  msgId: string;
  /** pgmq delivery count — handlers can branch on retry attempts. */
  readCt: number;
}

export type Handler = (payload: MessagePayload, ctx: HandlerContext) => Promise<void>;

/**
 * Message envelope convention: every pgmq message body is a JSON object with a
 * `handler` key naming the registered handler; the rest of the object is the
 * handler's payload. Producers (pg_cron enqueue functions, lake triggers) must
 * follow this convention.
 */
const registry = new Map<string, Handler>();

export function registerHandler(name: string, handler: Handler): void {
  if (registry.has(name)) {
    throw new Error(`duplicate handler registration: ${name}`);
  }
  registry.set(name, handler);
}

export function resolveHandler(name: string): Handler | undefined {
  return registry.get(name);
}

export function registeredHandlers(): string[] {
  return [...registry.keys()];
}

// ---------------------------------------------------------------------------
// Demo handler. Real handlers land in worker/src/pollers, worker/src/agents,
// worker/src/dispatch, worker/src/email per 06 §3.1 and register themselves here.
// ---------------------------------------------------------------------------

registerHandler("noop", async (payload, ctx) => {
  ctx.log.info("noop handler executed", { payload });
});
