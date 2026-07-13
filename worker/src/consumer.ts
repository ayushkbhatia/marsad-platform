import type { Sql } from "./db.js";
import type { WorkerConfig } from "./config.js";
import { log as rootLog } from "./log.js";
import { resolveHandler, type HandlerContext, type MessagePayload } from "./handlers/index.js";
import type { HeartbeatWriter } from "./heartbeat.js";

/**
 * Queue canon per 06 §5 / Revisions #2 — exactly these five pgmq queues.
 * (ingest.job_queue is a separate cadence table consumed by the poller module,
 * not a pgmq queue; it is out of scope for this skeleton.)
 */
export const QUEUES = [
  "q_ingest",
  "q_pipeline",
  "q_dispatch",
  "q_email",
  "q_maintenance",
] as const;

export type QueueName = (typeof QUEUES)[number];

// Brief-locked read semantics: visibility timeout 600s, one message per read
// (03 Revisions #2 — LLM stages must be vt 600 / qty 1; the skeleton applies
// it uniformly until per-queue handlers land and tune 06 §5's smaller vts).
const VISIBILITY_TIMEOUT_S = 600;
const READ_QTY = 1;
// read_with_poll blocks server-side up to this long, so an idle consumer costs
// one cheap query per 5s per queue instead of a tight client loop.
const MAX_POLL_SECONDS = 5;
const POLL_INTERVAL_MS = 250;
// 06 §5 retry policy: after 5 delivery attempts, archive + ops.incidents row.
const MAX_READ_CT = 5;
// Backoff when the queue read itself errors (missing queue, DB blip).
const ERROR_BACKOFF_MS = 10_000;

interface PgmqMessage {
  /** bigint column; postgres.js delivers it as a string. */
  msg_id: string;
  read_ct: number;
  message: MessagePayload;
}

export interface QueueConsumer {
  /** Resolves when the loop has fully drained after stop() is called. */
  done: Promise<void>;
  stop(): void;
}

export function startQueueConsumer(
  queue: QueueName,
  sql: Sql,
  config: WorkerConfig,
  heartbeat: HeartbeatWriter,
): QueueConsumer {
  const jobName = `worker:${queue}`;
  const log = rootLog.child({ queue, workerId: config.workerId });
  let stopping = false;

  async function loop(): Promise<void> {
    log.info("consumer started", { vt: VISIBILITY_TIMEOUT_S, qty: READ_QTY });
    while (!stopping) {
      let messages: PgmqMessage[];
      try {
        messages = (await sql`
          select msg_id, read_ct, message
          from pgmq.read_with_poll(
            ${queue},
            ${VISIBILITY_TIMEOUT_S},
            ${READ_QTY},
            ${MAX_POLL_SECONDS},
            ${POLL_INTERVAL_MS}
          )
        `) as unknown as PgmqMessage[];
      } catch (err) {
        if (stopping) break;
        log.error("queue read failed", { err });
        await sleep(ERROR_BACKOFF_MS);
        continue;
      }

      for (const msg of messages) {
        // Kill-switch flags are re-checked between every message (03 Revisions):
        // real handlers consult iam.global_switches here before acting.
        await processMessage(msg);
        if (stopping) break;
      }
    }
    log.info("consumer drained");
  }

  async function processMessage(msg: PgmqMessage): Promise<void> {
    const msgLog = log.child({ msgId: msg.msg_id, readCt: msg.read_ct });
    const handlerName = resolveHandlerName(msg.message);

    const handler = handlerName ? resolveHandler(handlerName) : undefined;

    // Poison handling (P1 fix): a message with no matching registered handler —
    // whether it names an unknown handler, uses the `task` alias for a stage we
    // have not built yet (pg_cron enqueues {"task":"notify_drain"} for future
    // phases), or carries no handler/task key at all — must NOT throw. Throwing
    // leaves the message invisible and pgmq redelivers it every vt (600s) until
    // it hits MAX_READ_CT, i.e. an infinite-redelivery poison loop (180+ failures
    // observed on q_dispatch). Instead we ARCHIVE it immediately with a WARN, so
    // an unrecognized envelope is parked in the archive ledger for the Desk to
    // inspect rather than poisoning the queue. This is deliberately NOT an
    // ops.incidents error — a not-yet-built handler is expected, not a fault.
    if (!handler) {
      await ignoreErrors(msgLog, "archive unhandled message", async () => {
        await sql`select pgmq.archive(${queue}, ${msg.msg_id}::bigint)`;
      });
      msgLog.warn("archived message with no registered handler", {
        handler: handlerName,
        // A tiny, bounded fingerprint of the body so the log explains WHAT was
        // archived without dumping an arbitrarily large payload.
        envelope: describeEnvelope(msg.message),
      });
      return;
    }

    try {
      const ctx: HandlerContext = {
        sql,
        log: msgLog,
        config,
        queue,
        msgId: msg.msg_id,
        readCt: msg.read_ct,
      };
      // Strip BOTH envelope keys (`handler` canonical, `task` alias) so the
      // handler always receives a clean payload regardless of which key named it.
      const { handler: _h, task: _t, ...payload } = msg.message;
      await handler(payload, ctx);

      // Success: archive (not delete) — the archive table is the processing
      // ledger the Desk error queue reads (06 §5).
      await sql`select pgmq.archive(${queue}, ${msg.msg_id}::bigint)`;
      await heartbeat.recordSuccess(jobName);
      msgLog.info("message processed", { handler: handlerName });
    } catch (err) {
      msgLog.error("handler failed", { handler: handlerName, err });
      await heartbeat.recordFailure(jobName, err);

      if (msg.read_ct >= MAX_READ_CT) {
        // Terminal: archive and surface in the Desk needs-attention queue.
        await ignoreErrors(msgLog, "archive dead message", async () => {
          await sql`select pgmq.archive(${queue}, ${msg.msg_id}::bigint)`;
        });
        await ignoreErrors(msgLog, "write ops.incidents", async () => {
          await sql`
            insert into ops.incidents (severity, source, message)
            values (
              'error',
              ${jobName},
              ${`message ${msg.msg_id} archived after ${msg.read_ct} attempts: ${errText(err)}`.slice(0, 2000)}
            )
          `;
        });
      }
      // Otherwise: leave the message invisible; pgmq redelivers after vt expiry.
    }
  }

  const done = loop().catch((err) => {
    log.error("consumer loop crashed", { err });
    throw err;
  });

  return {
    done,
    stop(): void {
      stopping = true;
    },
  };
}

/**
 * Resolve the handler name from a message envelope. Canonical convention is a
 * `handler` key (CONTRACT §9); `task` is accepted as an ALIAS so that pg_cron
 * jobs that enqueue {"task":"…"} for not-yet-built stages are recognized (and,
 * when no handler is registered, archived rather than looped — see
 * processMessage). `handler` wins if both are present.
 */
function resolveHandlerName(message: MessagePayload | undefined): string | undefined {
  if (!message) return undefined;
  if (typeof message.handler === "string") return message.handler;
  if (typeof message.task === "string") return message.task;
  return undefined;
}

/**
 * A short, bounded description of an unrecognized envelope for the WARN log —
 * enough to see WHAT was archived without dumping an arbitrarily large body.
 */
function describeEnvelope(message: MessagePayload | undefined): string {
  if (message == null || typeof message !== "object") return String(message);
  const keys = Object.keys(message);
  return keys.length ? `keys: ${keys.slice(0, 12).join(",")}` : "empty object";
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function ignoreErrors(
  log: ReturnType<typeof rootLog.child>,
  what: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log.warn(`${what} failed`, { err });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
