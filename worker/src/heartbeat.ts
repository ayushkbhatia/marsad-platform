import type { Sql } from "./db.js";
import { log } from "./log.js";

/**
 * Liveness heartbeats into ops.job_heartbeats (06 §6):
 *   job_heartbeats(job_name pk, expected_interval_s, last_run_at, last_ok_at,
 *                  last_error, consecutive_failures)
 * The pg_cron heartbeat_sentinel flags any row past 2x expected_interval, so a
 * dead worker becomes an ops.incidents row without any push-based alerting.
 */

export interface HeartbeatWriter {
  /** Begin the 30s upsert loop for the given job classes. */
  start(jobNames: string[]): void;
  /** Record a handler failure against a job class (sets last_error, bumps consecutive_failures). */
  recordFailure(jobName: string, error: unknown): Promise<void>;
  /** Record a successful unit of work (resets consecutive_failures, sets last_ok_at). */
  recordSuccess(jobName: string): Promise<void>;
  stop(): void;
}

export function createHeartbeatWriter(sql: Sql, intervalMs: number): HeartbeatWriter {
  let timer: NodeJS.Timeout | undefined;
  const expectedIntervalS = Math.ceil(intervalMs / 1000);

  async function beat(jobNames: string[]): Promise<void> {
    try {
      for (const jobName of jobNames) {
        await sql`
          insert into ops.job_heartbeats (job_name, expected_interval_s, last_run_at)
          values (${jobName}, ${expectedIntervalS}, now())
          on conflict (job_name) do update
            set expected_interval_s = excluded.expected_interval_s,
                last_run_at = now()
        `;
      }
    } catch (err) {
      // Heartbeat failure must never kill the worker; the sentinel catching
      // silence IS the alert path for a broken DB connection.
      log.warn("heartbeat upsert failed", { err });
    }
  }

  return {
    start(jobNames: string[]): void {
      void beat(jobNames);
      timer = setInterval(() => void beat(jobNames), intervalMs);
      timer.unref();
    },

    async recordSuccess(jobName: string): Promise<void> {
      try {
        await sql`
          insert into ops.job_heartbeats (job_name, expected_interval_s, last_run_at, last_ok_at, consecutive_failures)
          values (${jobName}, ${expectedIntervalS}, now(), now(), 0)
          on conflict (job_name) do update
            set last_run_at = now(),
                last_ok_at = now(),
                last_error = null,
                consecutive_failures = 0
        `;
      } catch (err) {
        log.warn("heartbeat success upsert failed", { jobName, err });
      }
    },

    async recordFailure(jobName: string, error: unknown): Promise<void> {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await sql`
          insert into ops.job_heartbeats (job_name, expected_interval_s, last_run_at, last_error, consecutive_failures)
          values (${jobName}, ${expectedIntervalS}, now(), ${message.slice(0, 2000)}, 1)
          on conflict (job_name) do update
            set last_run_at = now(),
                last_error = ${message.slice(0, 2000)},
                consecutive_failures = ops.job_heartbeats.consecutive_failures + 1
        `;
      } catch (err) {
        log.warn("heartbeat failure upsert failed", { jobName, err });
      }
    },

    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
