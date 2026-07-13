import { loadConfig } from "./config.js";
import { createDb } from "./db.js";
import { log } from "./log.js";
import { QUEUES, startQueueConsumer, type QueueConsumer } from "./consumer.js";
import { startIngestPoller, type IngestPoller } from "./ingest-poller.js";
import { createHeartbeatWriter } from "./heartbeat.js";
import { createHealthcheckPinger } from "./healthcheck.js";
import { registeredHandlers } from "./handlers/index.js";
import { createIngestionRuntime, registerIngestionHandlers } from "./handlers.js";

/**
 * marsad-worker entrypoint (06 §3): the single resident Node process on the
 * Hetzner VPS. This skeleton boots the pgmq consumers, the heartbeat writer
 * and the Healthchecks pinger; pollers (ingest.job_queue), agents, dispatch
 * and email modules attach here as they are built.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const sql = createDb(config);
  const heartbeat = createHeartbeatWriter(sql, config.heartbeatIntervalMs);
  const healthcheck = createHealthcheckPinger(
    config.healthcheckUrl,
    config.healthcheckPingIntervalMs,
  );

  log.info("marsad-worker booting", {
    workerId: config.workerId,
    queues: [...QUEUES],
    handlers: registeredHandlers(),
    node: process.version,
  });

  // Fail fast (and loudly) if the DB is unreachable or the role is wrong —
  // systemd Restart=always turns this into a retry loop with journald evidence.
  const rows = await sql<
    { current_user: string; db: string }[]
  >`select current_user, current_database() as db`;
  log.info("database connected", { role: rows[0]?.current_user, database: rows[0]?.db });

  // Build the P1 ingestion runtime (marsad-ingestion package) and register the
  // five ingestion handlers BEFORE the consumers start, so quote_poll/eod_sweep/
  // filings_poll/cross_check/key_ratios_recompute messages resolve to a handler
  // the moment they arrive (CONTRACT §9). createIngestionRuntime fails loudly
  // here if the package or its Storage/transport env is missing — systemd
  // Restart=always turns that into a visible retry loop rather than silent
  // per-message failures landing in ops.incidents.
  const runtime = await createIngestionRuntime({ sql, config });
  const ingestionHandlers = registerIngestionHandlers(runtime);
  log.info("ingestion handlers registered", { handlers: ingestionHandlers });

  const jobNames = QUEUES.map((q) => `worker:${q}`);
  heartbeat.start(["worker:alive", ...jobNames]);
  healthcheck.start();

  const consumers: QueueConsumer[] = QUEUES.map((q) =>
    startQueueConsumer(q, sql, config, heartbeat),
  );

  // Scheduler→worker bridge: claim + run due ingest.job_queue rows (the cadence
  // table ingest.enqueue_due_jobs() writes; NOT a pgmq queue — CONTRACT §9 note).
  // Runs alongside the pgmq consumers on the same DB pool. Without it, scheduled
  // scrapes pile up as status='queued' and are never claimed (72 rows observed).
  const ingestPoller: IngestPoller = startIngestPoller(sql, config);

  // --- graceful drain -------------------------------------------------------
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutdown requested; draining consumers", {
      signal,
      graceMs: config.shutdownGraceMs,
    });

    for (const c of consumers) c.stop();
    ingestPoller.stop();

    // Wait for in-flight handlers up to the grace period; anything still
    // running is safe to abandon — pgmq's visibility timeout redelivers pgmq
    // jobs, and ingest.requeue_stuck_jobs (cron queue-reaper) reclaims any
    // job_queue row abandoned in 'running', so both surfaces are at-least-once.
    const grace = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), config.shutdownGraceMs).unref(),
    );
    const drained = Promise.allSettled([
      ...consumers.map((c) => c.done),
      ingestPoller.done,
    ]).then(() => "drained" as const);
    const outcome = await Promise.race([drained, grace]);
    if (outcome === "timeout") {
      log.warn("drain grace period expired; exiting with work in flight");
    }

    heartbeat.stop();
    healthcheck.stop();
    await sql.end({ timeout: 5 });
    log.info("marsad-worker stopped");
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection", { err: reason });
  });
  process.on("uncaughtException", (err) => {
    log.error("uncaught exception; exiting for systemd restart", { err });
    void healthcheck.fail("uncaughtException").finally(() => process.exit(1));
  });
}

main().catch((err) => {
  log.error("fatal boot error", { err });
  process.exit(1);
});
