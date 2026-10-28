import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { describeLockHolder, lockHolder } from "../../src/gateway/lock-holder.js";
import { fixture } from "../helpers.js";

test("holder records retain watcher process identity and worker diagnostic fields", () => {
  expect(lockHolder("watch", 123, 0, 42)).toEqual({
    operation: "watch",
    pid: 123,
    at: new Date(0).toISOString(),
    start: 42,
  });
});

test.each([null, "{", "{}", '{"pid":0,"operation":"injected\\nline","at":"invalid"}'])(
  "incomplete and legacy holder %s is diagnostic only",
  (text) => {
    const file = join(fixture(), "holder.json");
    if (text !== null) {
      writeFileSync(file, text);
    }
    const description = describeLockHolder(file, 0);
    expect(description).toContain("unknown");
    expect(description).not.toContain("stale");
    expect(description).not.toContain("\n");
    if (text !== null) {
      expect(readFileSync(file, "utf8")).toBe(text);
    }
  }
);

test("unreadable holder errors are not disguised as contention", () => {
  const file = join(fixture(), "holder.json");
  mkdirSync(file);
  expect(() => describeLockHolder(file, 0)).toThrow();
});

test("a reused PID is stale without removing its holder", () => {
  const file = join(fixture(), "holder.json");
  const holder = lockHolder("status", process.pid, 0, -1);
  writeFileSync(file, JSON.stringify(holder));
  expect(describeLockHolder(file, 1000)).toBe(
    `held by status (pid ${process.pid}) for 1s (process not running; stale)`
  );
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(holder);
});
