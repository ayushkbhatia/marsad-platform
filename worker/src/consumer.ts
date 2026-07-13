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
    const handlerName =
      typeof msg.message?.handler === "string" ? (msg.message.handler as string) : undefined;

    const handler = handlerName ? resolveHandler(handlerName) : undefined;

    try {
      if (!handler) {
        throw new Error(
          handlerName
            ? `no handler registered for '${handlerName}'`
            : "message has no 'handler' key",
        );
      }
      const ctx: HandlerContext = {
        sql,
        log: msgLog,
        config,
        queue,
        msgId: msg.msg_id,
        readCt: msg.read_ct,
      };
      const { handler: _h, ...payload } = msg.message;
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
