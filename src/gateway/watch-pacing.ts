import type { ResourceBudget } from "./client.js";

const FLOOR = 10_000;

/** Header-driven board-poll controller. Milliseconds for time, points for cost. */
export class WatchPacing {
  interval = FLOOR;
  private previous?: ResourceBudget;
  private pendingCost = 0;
  private pollCost = 0;
  private externalRate = 0;
  private integral = 0;

  /** Observe account-wide header depletion; never use rateLimit.remaining as budget. */
  observe(status: ResourceBudget | undefined, reserve: number, now: number): number {
    if (!status || status.reset * 1000 <= now) {
      this.previous = undefined;
      this.externalRate = 0;
      this.integral = 0;
      this.pendingCost = 0;
      return (this.interval = FLOOR);
    }
    const previous = this.previous;
    if (!previous || previous.reset !== status.reset) {
      this.externalRate = 0;
      this.integral = 0;
    } else if (status.sampledAt > previous.sampledAt) {
      const elapsed = status.sampledAt - previous.sampledAt;
      const spent = Math.max(0, previous.remaining - status.remaining);
      const external = Math.max(0, spent - this.pendingCost) / elapsed;
      // Low-pass damping prevents one burst from being treated as permanent spend.
      const weight = 1 - Math.exp(-elapsed / 60_000);
      this.externalRate += weight * (external - this.externalRate);
      const sustainable =
        Math.max(1, status.remaining - reserve) / Math.max(FLOOR, status.reset * 1000 - now);
      const error = (this.externalRate + this.pollCost / FLOOR) / sustainable - 1;
      // Bounded integral, with leak and anti-windup for recovery after a spender stops.
      this.integral = Math.max(0, Math.min(1, this.integral * (1 - weight) + error * weight));
    } else if (previous.sampledAt === status.sampledAt && previous.remaining === status.remaining) {
      // REST-only ticks must not invent fresh GraphQL observations or reset cost accounting.
      return this.bound(this.interval, status, now);
    }
    this.previous = { ...status };
    this.pendingCost = 0;
    const horizon = status.reset * 1000 - now;
    // Keep a two-poll cushion above the unchanged gateway reserve. External spend
    // is observed, not controlled: no poll policy can contain an unlimited caller.
    const available = Math.max(0, status.remaining - reserve - 1 - 2 * this.pollCost);
    const rate = available / horizon;
    const allowance = rate - this.externalRate * (1 + 0.1 * this.integral);
    const target = allowance > 0 ? this.pollCost / allowance : horizon;
    // Proportional response to projected shortfall; damp only recovery, never an
    // urgent slowdown. Once the floor is affordable, return exactly to it.
    const next = target <= FLOOR ? FLOOR : Math.max(target, this.interval * 0.8);
    return this.bound(next, status, now);
  }

  /** Include every board/overflow query, including work before a failed read. */
  recordPoll(cost: number): void {
    this.pendingCost += cost;
    if (cost > 0) {
      this.pollCost = cost;
    }
  }

  private bound(interval: number, status: ResourceBudget, now: number): number {
    const horizon = Math.max(0, status.reset * 1000 - now);
    // Less than ten seconds before reset, the reset is the upper bound.
    this.interval = Math.min(horizon, Math.max(FLOOR, Math.ceil(interval)));
    return this.interval;
  }
}
