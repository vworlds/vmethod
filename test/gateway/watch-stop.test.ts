import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { expect, test } from "vitest";
import {
  isWatchCmdline,
  procWatchStopDeps,
  watchStop,
  watchStopTimeoutMs,
  type WatchStopDeps,
} from "../../src/gateway/watch-stop.js";
import { lockHolder, type LockHolder } from "../../src/gateway/lock-holder.js";
import { procStart } from "../../src/gateway/process-identity.js";
import { fixture } from "../helpers.js";

/** Mirror of the watcher's /proc stat format: field 22 (start ticks) injectable. */
function stat(start: number): string {
  return `1 (watch (vmethod)) S ${Array(18).fill("0").join(" ")} ${start} 0`;
}

/** Fake /proc harness: pids, their start ticks and command lines are explicit,
 * and the fake watcher releases its lock the way the exit hook would. */
class StopHarness {
  readonly dir = join(fixture(), "state");
  readonly lock: string;
  clock = Date.UTC(2026, 0, 1);
  readonly signals: number[] = [];
  readonly sleeps: number[] = [];
  /** /proc/<pid>/stat per pid; a missing entry means the pid is unallocated. */
  readonly proc = new Map<number, string>();
  readonly cmdline = new Map<number, string | null>();
  /** Signal failures: an ESRCH entry throws, like a process that died first. */
  readonly signalErrors = new Map<number, NodeJS.ErrnoException>();
  /** When this flag is on, the next simulated poll removes the lock (the exit hook). */
  release: boolean | null = null;

  constructor() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.lock = join(this.dir, "lock");
  }

  deps(): WatchStopDeps {
    return {
      now: () => this.clock,
      sleep: async (ms) => {
        this.sleeps.push(ms);
        this.clock += ms;
        if (this.release) {
          rmSync(this.lock);
          this.release = null;
        }
      },
      alive: (pid) => this.proc.has(pid),
      readProc: (pid) => this.proc.get(pid) ?? null,
      readCmdline: (pid) => (this.cmdline.has(pid) ? (this.cmdline.get(pid) ?? null) : null),
      signal: (pid) => {
        const error = this.signalErrors.get(pid);
        if (error) {
          throw error;
        }
        this.signals.push(pid);
      },
    };
  }

  hold(holder: LockHolder): void {
    writeFileSync(this.lock, `${JSON.stringify(holder)}\n`, { mode: 0o600 });
  }
}

test("no watcher running when the state directory holds no lock", async () => {
  const f = new StopHarness();
  await expect(watchStop(f.dir, false, f.deps())).resolves.toEqual({
    text: "no watcher running",
    code: 0,
  });
});

test("it stops a verified watcher and the lock clears", async () => {
  const f = new StopHarness();
  f.hold(lockHolder("watch", 4123, 0, 42));
  f.proc.set(4123, stat(42));
  f.cmdline.set(4123, "node\0/proj/dist/vmethod.mjs\0watch\0");
  f.release = true;
  await expect(watchStop(f.dir, false, f.deps())).resolves.toEqual({
    text: "watcher stopped (pid 4123)",
    code: 0,
  });
  expect(f.signals).toEqual([4123]);
  expect(existsSync(f.lock)).toBe(false);
});

test("a scoped watch command line (for example --track) is still the watcher", async () => {
  const f = new StopHarness();
  f.hold(lockHolder("watch", 4280, 0, 42));
  f.proc.set(4280, stat(42));
  f.cmdline.set(4280, "node\0/proj/dist/vmethod.mjs\0watch\0--track\0beta\0");
  f.release = true;
  await expect(watchStop(f.dir, false, f.deps())).resolves.toEqual({
    text: "watcher stopped (pid 4280)",
    code: 0,
  });
});

test("it refuses to signal a pid whose command line is not a vmethod watch", async () => {
  const f = new StopHarness();
  f.hold(lockHolder("watch", 4231, 0, 42));
  f.proc.set(4231, stat(42));
  f.cmdline.set(4231, "node\0/proj/dist/vmethod.mjs\0board\0status\0");
  await expect(watchStop(f.dir, false, f.deps())).resolves.toEqual({
    text: `refusing to signal pid 4231: its command line is not a vmethod watch for this state (node /proj/dist/vmethod.mjs board status)`,
    code: 1,
  });
  expect(f.signals).toEqual([]);
  expect(readFileSync(f.lock, "utf8")).toContain("4231");
});

test("the state directory alone does not vouch for the holder; a foreign lock record refuses", async () => {
  const f = new StopHarness();
  f.hold(lockHolder("worker", 4231, f.clock, 42));
  // The diagnostic's liveness suffix reads real /proc and is environment-fact;
  // the stop contract is the refusal with the holder described, never signalled.
  const verdict = await watchStop(f.dir, false, f.deps());
  expect(verdict.code).toBe(1);
  expect(verdict.text).toMatch(
    new RegExp(
      `^refusing to stop: held by worker \\(pid 4231\\) for 0s( \\(process not running; stale\\))?$`
    )
  );
  expect(f.signals).toEqual([]);
  expect(existsSync(f.lock)).toBe(true);
});

test("a reused pid makes the lock stale; only --force removes it", async () => {
  const f = new StopHarness();
  f.hold(lockHolder("watch", 4242, 0, 7));
  f.proc.set(4242, stat(99)); // The pid runs again with a different process identity.
  await expect(watchStop(f.dir, false, f.deps())).resolves.toEqual({
    text: "stale watcher lock (pid 4242 not running); remove with --stop --force",
    code: 1,
  });
  expect(f.signals).toEqual([]);
  expect(existsSync(f.lock)).toBe(true);
  await expect(watchStop(f.dir, true, f.deps())).resolves.toEqual({
    text: "stale watcher lock (pid 4242) removed",
    code: 0,
  });
  expect(f.signals).toEqual([]);
  expect(existsSync(f.lock)).toBe(false);
});

test("a stale lock is reported and --force removes it", async () => {
  const f = new StopHarness();
  f.hold(lockHolder("watch", 4250, 0, 42)); // No /proc entry: the pid is unallocated.
  await expect(watchStop(f.dir, false, f.deps())).resolves.toEqual({
    text: "stale watcher lock (pid 4250 not running); remove with --stop --force",
    code: 1,
  });
  expect(f.signals).toEqual([]);
  expect(existsSync(f.lock)).toBe(true);
  await expect(watchStop(f.dir, true, f.deps())).resolves.toEqual({
    text: "stale watcher lock (pid 4250) removed",
    code: 0,
  });
  expect(f.signals).toEqual([]);
  expect(existsSync(f.lock)).toBe(false);
});

test("legacy and initializing locks are refused, with and without --force", async () => {
  const f = new StopHarness();
  for (const raw of ["", "not json"]) {
    writeFileSync(f.lock, raw);
    await expect(watchStop(f.dir, false, f.deps())).resolves.toEqual({
      text: "refusing to stop: holder unknown (legacy or initializing lock; inspect before removal)",
      code: 1,
    });
    await expect(watchStop(f.dir, true, f.deps())).resolves.toEqual({
      text: "refusing to stop: holder unknown (legacy or initializing lock; inspect before removal)",
      code: 1,
    });
    expect(f.signals).toEqual([]);
  }
});

test("a verified holder that never releases keeps the lock and nothing escalates", async () => {
  const f = new StopHarness();
  f.hold(lockHolder("watch", 4260, 0, 42));
  f.proc.set(4260, stat(42));
  f.cmdline.set(4260, "node\0/proj/dist/vmethod.mjs\0watch\0");
  await expect(watchStop(f.dir, false, f.deps())).resolves.toEqual({
    text: `watcher (pid 4260) still holds ${f.dir}/lock after 30s; SIGKILL is never sent`,
    code: 1,
  });
  expect(f.signals).toEqual([4260]);
  expect(f.sleeps).toEqual(new Array(watchStopTimeoutMs / 250).fill(250));
  expect(existsSync(f.lock)).toBe(true);
});

test("a holder dying between verification and the signal is reported stale", async () => {
  const f = new StopHarness();
  f.hold(lockHolder("watch", 4270, 0, 42));
  f.proc.set(4270, stat(42));
  f.cmdline.set(4270, "node\0/proj/dist/vmethod.mjs\0watch\0");
  f.signalErrors.set(4270, { code: "ESRCH", name: "ESRCH" } as NodeJS.ErrnoException);
  await expect(watchStop(f.dir, false, f.deps())).resolves.toEqual({
    text: "stale watcher lock (pid 4270 not running); remove with --stop --force",
    code: 1,
  });
});

test("an unreadable holder command line is never signalled", async () => {
  const f = new StopHarness();
  f.hold(lockHolder("watch", 4290, 0, 42));
  f.proc.set(4290, stat(42));
  await expect(watchStop(f.dir, false, f.deps())).resolves.toEqual({
    text: "refusing to signal pid 4290: its command line is not a vmethod watch for this state (command line unreadable)",
    code: 1,
  });
  expect(f.signals).toEqual([]);
});

test("hostile holder text never reaches the verdict unquoted", async () => {
  const f = new StopHarness();
  const escape = "\u{1B}[2Kclear";
  f.hold(lockHolder("watch", 4300, 0, 42));
  f.proc.set(4300, stat(42));
  f.cmdline.set(4300, `node\0/or${escape}/dist/vmethod.mjs\0board\0`);
  const verdict = await watchStop(f.dir, false, f.deps());
  expect(verdict.text).not.toContain("\u{1B}");
  expect(verdict.text).toContain("clear");
}, 2000);

test("isWatchCmdline accepts both launcher spellings and rejects look-alikes", () => {
  const join0 = (...tokens: string[]) => `${tokens.join("\0")}\0`;
  expect(isWatchCmdline(join0("node", "/proj/dist/vmethod.mjs", "watch"))).toBe(true);
  expect(isWatchCmdline(join0("node", "/proj/node_modules/.bin/vmethod", "watch"))).toBe(true);
  expect(isWatchCmdline(join0("node", "/proj/dist/vmethod.mjs", "watch", "--only", "1,2"))).toBe(
    true
  );
  expect(isWatchCmdline(join0("node", "/proj/dist/watch-cli.mjs", "watch"))).toBe(false);
  expect(isWatchCmdline(join0("node", "/proj/dist/vmethod.mjs", "board", "status"))).toBe(false);
  expect(isWatchCmdline(join0("sh", "-c", "vmethod watch"))).toBe(false);
  expect(isWatchCmdline(join0("vmethod-watch", "watch"))).toBe(false);
  expect(isWatchCmdline("node /proj/dist/vmethod.mjs watch")).toBe(false);
  expect(isWatchCmdline("")).toBe(false);
  expect(isWatchCmdline(null)).toBe(false);
});

test("procWatchStopDeps decides from real proc files: foreign live, then stale", async () => {
  const deps = procWatchStopDeps(Date.now, async () => {});
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 2000)"], {
    stdio: "ignore",
  });
  try {
    // The holder runs with its real start identity, so only the command-line check refuses.
    let start: unknown;
    for (let i = 0; i < 50 && !child.pid; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(child.pid).toBeGreaterThan(1);
    for (let i = 0; i < 50; i++) {
      start = procStart(deps.readProc(child.pid as number));
      if (start !== null) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const dir = join(fixture(), "foreign-state");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "lock");
    const holder = lockHolder("watch", child.pid as number, Date.now(), start as number);
    writeFileSync(path, `${JSON.stringify(holder)}\n`, { mode: 0o600 });
    await expect(watchStop(dir, false, deps)).resolves.toMatchObject({
      code: 1,
      text: expect.stringContaining(`refusing to signal pid ${child.pid}`),
    });
    expect(existsSync(path)).toBe(true);
    await new Promise<unknown>((resolve) => child.once("exit", resolve));
    await expect(watchStop(dir, false, deps)).resolves.toEqual({
      text: `stale watcher lock (pid ${child.pid} not running); remove with --stop --force`,
      code: 1,
    });
    await expect(watchStop(dir, true, deps)).resolves.toEqual({
      text: `stale watcher lock (pid ${child.pid}) removed`,
      code: 0,
    });
    expect(existsSync(path)).toBe(false);
  } finally {
    child.kill();
  }
});
