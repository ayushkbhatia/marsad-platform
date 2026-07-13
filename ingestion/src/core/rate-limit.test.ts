import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TokenBucket,
  DailyBudget,
  Semaphore,
  HostLimiterRegistry,
  hostOf,
} from './rate-limit.js';

test('TokenBucket: strict ≤1 req/s smoothing with an injected clock', () => {
  let now = 1_000_000;
  const clock = () => now;
  const b = new TokenBucket(1, 1, clock); // 1 rps, burst 1

  assert.equal(b.tryTake(), true, 'first token available immediately');
  assert.equal(b.tryTake(), false, 'burst of 1 exhausted');
  assert.equal(b.msUntilNextToken(), 1000, 'must wait ~1s for the next token');

  now += 999;
  assert.equal(b.tryTake(), false, 'still short at 999ms');
  now += 1;
  assert.equal(b.tryTake(), true, 'token refilled at 1000ms');
});

test('TokenBucket: caps at burst, never over-accumulates', () => {
  let now = 0;
  const b = new TokenBucket(2, 3, () => now); // 2 rps, burst 3
  now += 100_000; // long idle
  assert.equal(b.tryTake(), true);
  assert.equal(b.tryTake(), true);
  assert.equal(b.tryTake(), true);
  assert.equal(b.tryTake(), false, 'capped at burst=3 despite long idle');
});

test('DailyBudget: hard ceiling of 300/day, rolls over at UTC midnight', () => {
  let now = Date.parse('2026-07-13T10:00:00Z');
  const d = new DailyBudget(300, () => now);
  for (let i = 0; i < 300; i++) assert.equal(d.tryConsume(), true, `req ${i}`);
  assert.equal(d.remaining(), 0);
  assert.equal(d.tryConsume(), false, '301st refused');

  now = Date.parse('2026-07-14T00:00:01Z'); // next UTC day
  assert.equal(d.remaining(), 300, 'budget resets next day');
  assert.equal(d.tryConsume(), true);
});

test('Semaphore: bounds concurrency and hands permits to waiters', async () => {
  const sem = new Semaphore(2);
  await sem.acquire();
  await sem.acquire();
  let third = false;
  const p = sem.acquire().then(() => {
    third = true;
  });
  await Promise.resolve();
  assert.equal(third, false, 'third acquire blocks while 2 held');
  sem.release();
  await p;
  assert.equal(third, true, 'released permit unblocks the waiter');
});

test('HostLimiterRegistry: separate bucket + budget per host', () => {
  const reg = new HostLimiterRegistry(1, 5, 4, () => 0);
  const a = reg.budget('a.com');
  const b = reg.budget('b.com');
  for (let i = 0; i < 5; i++) a.tryConsume();
  assert.equal(a.remaining(), 0);
  assert.equal(b.remaining(), 5, 'other host unaffected');
  assert.notEqual(reg.bucket('a.com'), reg.bucket('b.com'));
  assert.equal(reg.bucket('a.com'), reg.bucket('a.com'), 'same host → same bucket');
});

test('hostOf: extracts host, tolerates junk', () => {
  assert.equal(hostOf('https://qe.com.qa/pps/x.txt'), 'qe.com.qa');
  assert.equal(hostOf('not a url'), 'not a url');
});
