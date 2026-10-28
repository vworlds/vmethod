import { afterEach, expect, test } from "vitest";
import { WatchFake } from "./watch-fake.js";

const fixtures: WatchFake[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.done();
  }
});

test("watch scheduling observes shared-account spending through real client headers and recovers", async () => {
  const f = new WatchFake();
  fixtures.push(f);
  f.config.vmethod = { repo: "off" };
  f.cards = [f.card(6)];
  const start = f.clock;
  const reset = start / 1000 + 600;
  let remaining = 460;
  let boardReads = 0;
  const boardReadTimes: number[] = [];
  const transportFailures: string[] = [];
  const fetch = f.deps.fetch;
  f.deps.fetch = async (input, init) => {
    let response: Response;
    try {
      response = await fetch(input, init);
    } catch (error) {
      transportFailures.push(String(error));
      throw error;
    }
    if (new URL(String(input)).pathname !== "/graphql") {
      return response;
    }
    const payload = JSON.parse(String(init?.body));
    if (!payload.query.includes("query WatchBoard(")) {
      return response;
    }
    remaining -= 5;
    boardReads++;
    boardReadTimes.push(f.clock);
    const body = await response.json();
    body.data.rateLimit.cost = 5;
    return Response.json(body, {
      headers: {
        "x-ratelimit-resource": "graphql",
        "x-ratelimit-remaining": String(remaining),
        "x-ratelimit-reset": String(reset),
        "x-ratelimit-limit": "5000",
      },
    });
  };
  const loop = f.loop();
  for (let elapsed = 0; elapsed < 600_000; elapsed += 10_000) {
    // An independent process spends four points between each pair of ticks,
    // stopping after 200 seconds of this ten-minute reset window. No separate
    // rate-limit endpoint is read; the scenario stays within WatchFake's bound.
    if (elapsed > 0 && elapsed <= 200_000) {
      remaining -= 4;
    }
    f.clock = start + elapsed;
    await f.once(loop);
    expect(remaining).toBeGreaterThan(100);
  }
  expect(boardReads).toBeLessThan(60);
  // Continuously changing controller values need not hold for three polls, so
  // prove actual scheduling slowdown/recovery independently of debounced reports.
  const gaps = boardReadTimes.slice(1).map((at, index) => at - boardReadTimes[index]);
  expect(gaps.some((gap) => gap > 20_000)).toBe(true);
  expect(gaps.slice(-3)).toEqual([10_000, 10_000, 10_000]);
  expect(f.pollReports.at(-1)).toContain("interval=10s");
  expect(transportFailures).toEqual([]);
  expect(f.reports).toEqual([]);
  expect(f.sleeps).toEqual([]);
});
