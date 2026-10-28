import { expect, test } from "vitest";
import { WatchPacing } from "../../src/gateway/watch-pacing.js";
import type { ResourceBudget } from "../../src/gateway/client.js";

const budget = (remaining: number, sampledAt = 0, reset = 3600): ResourceBudget => ({
  remaining,
  sampledAt,
  reset,
  limit: 5000,
});

test.each([1200_000, 3600_000])(
  "external spending until %i ms slows polling without consuming the reserve",
  (stop) => {
    const controller = new WatchPacing();
    let remaining = 2000;
    let next = 0;
    let longest = 0;
    let recovered = false;
    let polls = 0;
    const intervals: number[] = [];
    // External caller consumes 1440 points/hour. At the ten-second floor the
    // board alone would consume 1800: the combined load cannot fit 1900 usable.
    for (let now = 0; now < 3600_000; now += 1000) {
      if (now > 0 && now <= stop) {
        remaining -= 0.4;
      }
      if (now < next) {
        continue;
      }
      remaining -= 5;
      polls++;
      controller.recordPoll(5);
      const interval = controller.observe(budget(remaining, now), 100, now);
      expect(remaining).toBeGreaterThan(100);
      expect(interval).toBeGreaterThanOrEqual(Math.min(10_000, 3600_000 - now));
      expect(interval).toBeLessThanOrEqual(3600_000 - now);
      intervals.push(interval);
      longest = Math.max(longest, interval);
      if (now > stop + 300_000 && interval === 10_000) {
        recovered = true;
      }
      next = now + interval;
    }
    expect(remaining).toBeGreaterThan(100);
    expect(longest).toBeGreaterThan(20_000);
    expect(polls).toBeLessThan(360);
    if (stop < 3600_000) {
      expect(recovered).toBe(true);
      expect(intervals.at(-1)).toBeLessThanOrEqual(10_000);
    }
  }
);

test("measured cost drives proportional pacing; stale headers do not fabricate recovery", () => {
  const controller = new WatchPacing();
  controller.recordPoll(5);
  const status = budget(1000);
  const interval = controller.observe(status, 100, 0);
  expect(interval).toBeGreaterThan(20_000);
  expect(controller.observe(status, 100, 10_000)).toBe(interval);
  controller.recordPoll(1);
  expect(controller.observe(budget(999, 20_000), 100, 20_000)).toBe(10_000);
});

test("a burst is damped, and reserve, reset and missing-header boundaries stay bounded", () => {
  const controller = new WatchPacing();
  controller.recordPoll(2);
  expect(controller.observe(budget(5000), 100, 0)).toBe(10_000);
  controller.recordPoll(2);
  // A one-time burst of 20 points is not extrapolated at its raw 2 points/s.
  expect(controller.observe(budget(4978, 10_000), 100, 10_000)).toBe(10_000);
  controller.recordPoll(2);
  expect(controller.observe(budget(101, 20_000), 100, 20_000)).toBe(3580_000);
  expect(controller.observe(budget(101, 20_000), 100, 3595_000)).toBe(5000);
  expect(controller.observe(budget(5000, 3600_000, 7200), 100, 3600_000)).toBe(10_000);
  expect(controller.observe(undefined, 100, 3600_000)).toBe(10_000);
});
