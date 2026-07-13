import { log } from "./log.js";

/**
 * Healthchecks.io dead-man switch (06 §6: worker-alive check, pinged every
 * 5 min; missed ping emails the owner). Entirely optional — no HEALTHCHECK_URL
 * means no pings, which is the local-dev default.
 */
export interface HealthcheckPinger {
  start(): void;
  /** Signal an explicit failure (Healthchecks /fail endpoint) — e.g. on fatal crash. */
  fail(reason: string): Promise<void>;
  stop(): void;
}

export function createHealthcheckPinger(
  url: string | undefined,
  intervalMs: number,
): HealthcheckPinger {
  let timer: NodeJS.Timeout | undefined;

  async function ping(suffix = ""): Promise<void> {
    if (!url) return;
    try {
      const res = await fetch(url + suffix, { method: "GET", signal: AbortSignal.timeout(10_000) });
      if (!res.ok) log.warn("healthcheck ping non-2xx", { status: res.status });
    } catch (err) {
      log.warn("healthcheck ping failed", { err });
    }
  }

  return {
    start(): void {
      if (!url) {
        log.info("HEALTHCHECK_URL not set; healthcheck pings disabled");
        return;
      }
      void ping();
      timer = setInterval(() => void ping(), intervalMs);
      timer.unref();
    },
    async fail(reason: string): Promise<void> {
      log.error("signalling healthcheck failure", { reason });
      await ping("/fail");
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
