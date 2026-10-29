import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { DirLock, OwnedLock, PidLock } from "../../src/journal/locks.js";
import { lockHolder } from "../../src/gateway/lock-holder.js";
import { migrationIdentity } from "../../src/gateway/process-identity.js";
import { readState, writeState } from "../../src/board/readme.js";
import { FakeBoard } from "../board/fake.js";
import { fixture } from "../helpers.js";

afterEach(() => vi.restoreAllMocks());

const proc = (start: number) => `123 (command with spaces) S ${"0 ".repeat(18)}${start}`;

function owned() {
  const directory = fixture();
  const path = join(directory, "lock");
  const now = Math.ceil(Date.now() / 1000) * 1000;
  const deps = {
    pid: 123,
    now: () => now,
    readProc: (pid: number) => (pid === 123 ? proc(42) : null),
  };
  return { directory, path, deps, lock: new OwnedLock(path, deps) };
}

test.each(["live", "dead", "reused", "missing", "empty", "malformed"])(
  "watch owned lock: %s holder",
  (kind) => {
    const f = owned();
    const text =
      kind === "empty"
        ? ""
        : kind === "malformed"
          ? "{"
          : JSON.stringify({
              pid: kind === "dead" ? 456 : 123,
              start: kind === "reused" ? 41 : 42,
            });
    if (kind !== "missing") {
      writeFileSync(f.path, text);
    }
    if (kind === "live" || kind === "empty" || kind === "malformed") {
      expect(() => f.lock.watch(f.directory)).toThrow(
        kind === "live"
          ? `watch: another watcher (pid 123) holds ${f.directory}`
          : "watch: another watcher is initializing the lock; retry shortly"
      );
      expect(readFileSync(f.path, "utf8")).toBe(text);
    } else {
      const release = f.lock.watch(f.directory);
      expect(readFileSync(f.path, "utf8")).toBe(
        `${JSON.stringify(lockHolder("watch", 123, f.deps.now(), 42))}\n`
      );
      expect(statSync(f.path).mode & 0o777).toBe(0o600);
      release();
      expect(existsSync(f.path)).toBe(false);
    }
  }
);

test.each([59_999, 60_000])("watch holder-less initialization boundary %sms", (age) => {
  const f = owned();
  writeFileSync(f.path, "{}");
  const time = new Date(f.deps.now() - age);
  utimesSync(f.path, time, time);
  if (age < 60_000) {
    expect(() => f.lock.watch(f.directory)).toThrow("initializing the lock");
  } else {
    f.lock.watch(f.directory)();
    expect(existsSync(f.path)).toBe(false);
  }
});

test.each(["live", "dead", "reused", "missing", "empty", "malformed", "legacy directory"])(
  "conflict owned lock: %s holder",
  (kind) => {
    const f = owned();
    const text =
      kind === "empty"
        ? ""
        : kind === "malformed"
          ? "{"
          : JSON.stringify({
              pid: kind === "dead" ? 456 : 123,
              start: kind === "reused" ? 41 : 42,
            });
    if (kind === "legacy directory") {
      mkdirSync(f.path);
    } else if (kind !== "missing") {
      writeFileSync(f.path, text);
    }
    if (kind === "live") {
      expect(f.lock.conflict(400, 42)).toBe(
        "PENDING #400: conflict resolution in progress (pid 123)"
      );
      expect(readFileSync(f.path, "utf8")).toBe(text);
    } else {
      expect(f.lock.conflict(400, 42)).toBeUndefined();
      expect(readFileSync(f.path, "utf8")).toBe(
        `${JSON.stringify({ pid: 123, start: 42, at: new Date(f.deps.now()).toISOString() })}\n`
      );
      expect(statSync(f.path).mode & 0o777).toBe(0o700);
      f.lock.releaseConflict(42);
      expect(existsSync(f.path)).toBe(false);
    }
  }
);

test.each(["watch", "conflict"])("%s release preserves a replacement holder", (kind) => {
  const f = owned();
  let release: () => void;
  if (kind === "watch") {
    release = f.lock.watch(f.directory);
  } else {
    expect(f.lock.conflict(400, 42)).toBeUndefined();
    release = () => f.lock.releaseConflict(42);
  }
  const replacement = JSON.stringify({ pid: 123, start: 43 });
  writeFileSync(f.path, replacement);
  release();
  expect(readFileSync(f.path, "utf8")).toBe(replacement);
});

test("watch refuses when its own process start cannot be read", () => {
  const f = owned();
  expect(() =>
    new OwnedLock(f.path, { ...f.deps, readProc: () => null }).watch(f.directory)
  ).toThrow("watcher lock requires /proc/<pid>/stat (Linux)");
  expect(existsSync(f.path)).toBe(false);
});

test.each(["live", "dead", "reused", "missing", "malformed", "fresh", "EPERM"])(
  "legacy journal PID policy: %s holder",
  (kind) => {
    const path = join(fixture(), "writes.jsonl.lock");
    // Whole-second anchor keeps the exact 3000ms boundary independent of the
    // filesystem's floating-point timestamp conversion.
    const now = Math.ceil(Date.now() / 1000) * 1000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      if (kind === "dead" || kind === "fresh" || kind === "EPERM") {
        throw Object.assign(new Error("process probe"), {
          code: kind === "EPERM" ? "EPERM" : "ESRCH",
        });
      }
      return true;
    });
    if (kind !== "missing") {
      writeFileSync(path, kind === "malformed" ? "{}" : "123");
      const time = new Date(now - (kind === "fresh" ? 3_000 : 3_001));
      utimesSync(path, time, time);
    }
    // PID-only data cannot distinguish a live holder from a reused live PID.
    expect(new PidLock(path).stale()).toBe(kind === "dead");
    expect(existsSync(path)).toBe(kind !== "missing");
    if (["missing", "malformed", "fresh"].includes(kind)) {
      expect(kill).not.toHaveBeenCalled();
    }
  }
);

test("journal acquire/release retains PID-only content and file mode", () => {
  const path = join(fixture(), "writes.jsonl.lock");
  const lock = new PidLock(path);
  const fd = lock.acquire();
  expect(readFileSync(path, "utf8")).toBe(String(process.pid));
  expect(statSync(path).mode & 0o777).toBe(0o600);
  lock.release(fd);
  expect(existsSync(path)).toBe(false);
});

test.each(["live", "dead", "reused", "missing"])(
  "directory claim never recovers %s holder",
  (kind) => {
    const path = join(fixture(), "400.lock");
    const lock = new DirLock(path);
    lock.acquire();
    if (kind !== "missing") {
      const holder = lockHolder("status", process.pid, 0, kind === "reused" ? -1 : undefined);
      if (kind === "dead") {
        holder.pid = 2147483647;
      }
      writeFileSync(join(path, "holder.json"), JSON.stringify(holder));
    }
    const before = kind === "missing" ? null : readFileSync(join(path, "holder.json"), "utf8");
    expect(() => lock.acquire()).toThrow(expect.objectContaining({ code: "EEXIST" }));
    const description = lock.describe(1000);
    if (kind === "missing") {
      expect(description).toContain("holder unknown");
    } else {
      expect(description.includes("stale")).toBe(kind !== "live");
      expect(readFileSync(join(path, "holder.json"), "utf8")).toBe(before);
    }
    expect(existsSync(path)).toBe(true);
    lock.release(true);
  }
);

test("holder-less directory release and worker holder creation retain their formats", () => {
  const path = join(fixture(), "lock");
  const lock = new DirLock(path);
  lock.acquire();
  lock.release();
  expect(existsSync(path)).toBe(false);
  lock.acquire();
  lock.holder("status", 0);
  expect(readFileSync(join(path, "holder.json"), "utf8")).toBe(
    `${JSON.stringify(lockHolder("status", process.pid, 0))}\n`
  );
  lock.release(true);
  expect(existsSync(path)).toBe(false);
});

test.each(["live", "dead", "reused", "remote", "previous boot", "missing"])(
  "board field lock retains its %s holder policy",
  async (kind) => {
    const board = new FakeBoard();
    board.stamp(0);
    board.fields.push({
      id: "lock",
      name: "vmethod-migration-lock",
      createdAt: board.clock,
      type: "text",
      options: [],
    });
    const holder = JSON.parse(migrationIdentity()!);
    if (kind === "dead") {
      holder.pid = 2147483647;
    }
    if (kind === "reused") {
      holder.start += 1;
    }
    if (kind === "remote") {
      holder.host += "-remote";
    }
    if (kind === "previous boot") {
      holder.boot += "-previous";
    }
    if (kind !== "missing") {
      const state = readState(board.readme);
      state.lock = `old migrator since ${new Date(board.clock).toISOString()} identity ${JSON.stringify(holder)}`;
      board.readme = writeState(board.readme, state);
    }
    try {
      if (["dead", "reused", "previous boot"].includes(kind)) {
        await board.service().migrate({});
        expect(readState(board.readme).version).toBe(1);
        expect(readState(board.readme).lock).toBeUndefined();
        expect(board.fields.some((field) => field.name === "vmethod-migration-lock")).toBe(false);
      } else {
        await expect(board.service().migrate({ steal: true })).rejects.toThrow(
          kind === "missing"
            ? "Migration lock being acquired"
            : "Migration lock held; stale locks require --steal"
        );
        expect(board.fields.some((field) => field.id === "lock")).toBe(true);
      }
    } finally {
      board.done();
    }
  }
);

test.each([59_999, 60_000])("board holder-less field age boundary %sms", async (age) => {
  const board = new FakeBoard();
  board.stamp(0);
  board.fields.push({
    id: "lock",
    name: "vmethod-migration-lock",
    createdAt: board.clock - age,
    type: "text",
    options: [],
  });
  try {
    if (age < 60_000) {
      await expect(board.service().migrate({ steal: true })).rejects.toThrow(
        "Migration lock being acquired"
      );
    } else {
      await expect(board.service().migrate({})).rejects.toThrow(
        "LOCK ORPHANED (no holder); use --steal"
      );
      await board.service().migrate({ steal: true });
      expect(readState(board.readme).lock).toBeUndefined();
      expect(board.fields.some((field) => field.name === "vmethod-migration-lock")).toBe(false);
    }
  } finally {
    board.done();
  }
});
