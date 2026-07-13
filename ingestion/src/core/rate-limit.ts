/**
 * Transport-agnostic rate-limiting primitives shared by HttpClient and
 * BrowserClient (§5). Kept separate from fetcher.ts so they are pure and
 * unit-testable with an injected clock, with zero network.
 *
 *  - TokenBucket: per-host ≤ N req/s smoothing.
 *  - DailyBudget: per-host hard ceiling ≤ 300 requests/day (recon exit criterion).
 *  - Semaphore: global concurrency ≤ 4.
 */

export type Clock = () => number; // epoch ms

/** Per-host token bucket. Refills at `ratePerSec` tokens/second, capped at `burst`. */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly ratePerSec: number;
  private readonly burst: number;
  private readonly clock: Clock;

  constructor(ratePerSec: number, burst: number, clock: Clock = Date.now) {
    this.ratePerSec = ratePerSec;
    this.burst = burst;
    this.tokens = burst;
    this.clock = clock;
    this.lastRefill = clock();
  }

  private refill(): void {
    const now = this.clock();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.burst, this.tokens + elapsedSec * this.ratePerSec);
    this.lastRefill = now;
  }

  /** True if a token was available and consumed right now (no waiting). */
  tryTake(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Milliseconds until the next token is available (0 if one is available now). */
  msUntilNextToken(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    const deficit = 1 - this.tokens;
    return Math.ceil((deficit / this.ratePerSec) * 1000);
  }
}

/** Per-host UTC-day request counter with a hard ceiling. */
export class DailyBudget {
  private count = 0;
  private dayKey: string;
  private readonly limit: number;
  private readonly clock: Clock;

  constructor(limit: number, clock: Clock = Date.now) {
    this.limit = limit;
    this.clock = clock;
    this.dayKey = DailyBudget.keyFor(clock());
  }

  private static keyFor(epochMs: number): string {
    return new Date(epochMs).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  }

  private roll(): void {
    const key = DailyBudget.keyFor(this.clock());
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.count = 0;
    }
  }

  remaining(): number {
    this.roll();
    return Math.max(0, this.limit - this.count);
  }

  /** Reserve one request against today's budget; false if the ceiling is hit. */
  tryConsume(): boolean {
    this.roll();
    if (this.count >= this.limit) return false;
    this.count += 1;
    return true;
  }
}

/** Async counting semaphore for global concurrency. */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.available = permits;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    // resolved with a permit already handed over by release()
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the permit straight to the next waiter (available stays consumed).
      next();
    } else {
      this.available += 1;
    }
  }
}

/**
 * Registry of per-host limiters so all requests to the same host share one
 * bucket + budget. A single global semaphore bounds total concurrency.
 */
export class HostLimiterRegistry {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly budgets = new Map<string, DailyBudget>();
  readonly globalSemaphore: Semaphore;

  constructor(
    private readonly ratePerSec: number,
    private readonly budgetPerDay: number,
    globalConcurrency: number,
    private readonly clock: Clock = Date.now,
  ) {
    this.globalSemaphore = new Semaphore(globalConcurrency);
  }

  bucket(host: string): TokenBucket {
    let b = this.buckets.get(host);
    if (!b) {
      // burst 1 → strict ≤1 req/s smoothing at the default rate.
      b = new TokenBucket(this.ratePerSec, Math.max(1, Math.ceil(this.ratePerSec)), this.clock);
      this.buckets.set(host, b);
    }
    return b;
  }

  budget(host: string): DailyBudget {
    let d = this.budgets.get(host);
    if (!d) {
      d = new DailyBudget(this.budgetPerDay, this.clock);
      this.budgets.set(host, d);
    }
    return d;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
