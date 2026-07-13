import type { Sql } from './db.js';
import type { Logger } from './types.js';

/**
 * ops.job_heartbeats writer (§5, §9) — same semantics as worker/src/heartbeat.ts
 * but scoped to per-job upserts a handler calls at run boundaries (rather than a
 * background loop). ops.heartbeat_sentinel() raises ops.incidents if a job goes
 * silent > 2× its expected interval.
 *
 * Columns (0005): job_heartbeats(job_name pk, expected_interval_s, last_run_at,
 * last_ok_at, last_error, consecutive_failures).
 */

export interface HeartbeatWriter {
  ran(jobName: string, expectedIntervalS: number): Promise<void>;
  ok(jobName: string, expectedIntervalS: number): Promise<void>;
  failed(jobName: string, expectedIntervalS: number, error: unknown): Promise<void>;
}

export function createHeartbeatWriter(sql: Sql, logger?: Logger): HeartbeatWriter {
  return {
    async ran(jobName, expectedIntervalS): Promise<void> {
      try {
        await sql`
          insert into ops.job_heartbeats (job_name, expected_interval_s, last_run_at)
          values (${jobName}, ${expectedIntervalS}, now())
          on conflict (job_name) do update
            set expected_interval_s = excluded.expected_interval_s,
                last_run_at = now()
        `;
      } catch (err) {
        logger?.warn('heartbeat ran upsert failed', { jobName, err });
      }
    },

    async ok(jobName, expectedIntervalS): Promise<void> {
      try {
        await sql`
          insert into ops.job_heartbeats
            (job_name, expected_interval_s, last_run_at, last_ok_at, consecutive_failures)
          values (${jobName}, ${expectedIntervalS}, now(), now(), 0)
          on conflict (job_name) do update
            set last_run_at = now(),
                last_ok_at = now(),
                last_error = null,
                consecutive_failures = 0
        `;
      } catch (err) {
        logger?.warn('heartbeat ok upsert failed', { jobName, err });
      }
    },

    async failed(jobName, expectedIntervalS, error): Promise<void> {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
      try {
        await sql`
          insert into ops.job_heartbeats
            (job_name, expected_interval_s, last_run_at, last_error, consecutive_failures)
          values (${jobName}, ${expectedIntervalS}, now(), ${message}, 1)
          on conflict (job_name) do update
            set last_run_at = now(),
                last_error = ${message},
                consecutive_failures = ops.job_heartbeats.consecutive_failures + 1
        `;
      } catch (err) {
        logger?.warn('heartbeat failed upsert failed', { jobName, err });
      }
    },
  };
}
