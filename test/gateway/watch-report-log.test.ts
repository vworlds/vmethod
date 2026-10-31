import { expect, test } from "vitest";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { appendWatchReport } from "../../src/watch/report-log.js";
import { WatchFake } from "./watch-fake.js";
import { fixture } from "../helpers.js";

test("watch report logs are private, timestamped and bounded", () => {
  const dir = join(fixture(), "logs");
  const now = Date.UTC(2026, 9, 31);
  for (let i = 0; i <= 200; i++) {
    appendWatchReport(dir, "watch-pacing.log", `report ${i}`, now);
  }
  const path = join(dir, "watch-pacing.log");
  const lines = readFileSync(path, "utf8").trim().split("\n");
  expect(lines).toHaveLength(101);
  expect(lines[0]).toBe("2026-10-31T00:00:00.000Z report 100");
  expect(lines.at(-1)).toBe("2026-10-31T00:00:00.000Z report 200");
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("normal polling writes pacing only to its log; unavailable pacing log reports once without stopping polls", async () => {
  const f = new WatchFake();
  try {
    f.cards = [f.card(6, "Backlog")];
    const loop = f.loop();
    expect(await f.once(loop)).toEqual([]);
    expect(f.pollReports).toHaveLength(1);
    expect(f.reports).toEqual([]);
    loop.close();
  } finally {
    f.done();
  }
  const broken = new WatchFake();
  try {
    mkdirSync(join(broken.dir, "watch-pacing.log"), { recursive: true });
    broken.cards = [broken.card(6, "Backlog")];
    const loop = broken.loop();
    await broken.once(loop);
    broken.boardCost = 3;
    for (let i = 0; i < 3; i++) {
      broken.advance();
      await broken.once(loop);
    }
    expect(broken.reports).toHaveLength(1);
    expect(broken.reports[0]).toContain("watcher: pacing report log unavailable:");
    expect(
      broken.requests.filter((request) => request.includes("/graphql")).length
    ).toBeGreaterThan(3);
  } finally {
    broken.done();
  }
});
