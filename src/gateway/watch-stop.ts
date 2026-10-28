import { readFileSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { object } from "./people.js";
import { describeLockHolder, type LockHolder } from "./lock-holder.js";
import { procStart } from "./process-identity.js";
import { sanitizePreview } from "./events.js";

/** A graceful stop waits up to this long for the lock to clear; SIGKILL is never sent. */
export const watchStopTimeoutMs = 30_000;
const watchStopSleepMs = 250;
const watchStopAttempts = 4;

export interface WatchStopDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Only a verified kill(2) ESRCH failure may report a pid gone; injectable for tests. */
  alive: (pid: number) => boolean;
  /** Contents of /proc/<pid>/stat, or null when unreadable; injectable for tests. */
  readProc: (pid: number) => string | null;
  /** Contents of /proc/<pid>/cmdline, or null when unreadable; injectable for tests. */
  readCmdline: (pid: number) => string | null;
  /** Deliver SIGTERM to a pid; injectable for tests. */
  signal: (pid: number) => void;
}

/** CLI-ready outcome: the last text line is always the report. */
export interface WatchStopVerdict {
  text: string;
  code: 0 | 1;
}

/** /proc-based defaults for a stop command; the watcher lock reader uses the same files. */
export function procWatchStopDeps(
  now: () => number,
  sleep: (ms: number) => Promise<void>
): WatchStopDeps {
  return {
    now,
    sleep,
    alive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (
          Boolean(readOrNull(`/proc/${pid}/stat`)) ||
          (error as NodeJS.ErrnoException).code !== "ESRCH"
        );
      }
    },
    readProc: (pid) => readOrNull(`/proc/${pid}/stat`),
    readCmdline: (pid) => readOrNull(`/proc/${pid}/cmdline`),
    signal: (pid) => process.kill(pid, "SIGTERM"),
  };
}

/** Stop this checkout's running watcher: identify the lock holder, refuse anything
 * that is not a vmethod watch holding this state's lock, signal SIGTERM and wait
 * for the lock to clear. A stale lock (the recorded process is gone) is removable
 * only with the force flag; a legacy, initializing or foreign lock is always refused.
 */
export async function watchStop(
  dir: string,
  force: boolean,
  deps: WatchStopDeps
): Promise<WatchStopVerdict> {
  const path = join(dir, "lock");
  for (let attempt = 0; ; attempt++) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { text: "no watcher running", code: 0 };
      }
      throw error;
    }
    const holder = parseHolder(raw);
    if (!holder) {
      return { text: `refusing to stop: ${describeLockHolder(path, deps.now())}`, code: 1 };
    }
    if (holderProcessState(holder, deps) !== "running") {
      if (!force) {
        return staleRefusal(holder.pid);
      }
      // The stale-clear pattern of the watcher's own lock acquisition: re-read
      // before unlinking, so a contender replacing the stale file redecides.
      let current: string;
      try {
        current = readFileSync(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { text: `stale watcher lock (pid ${holder.pid}) removed`, code: 0 };
        }
        throw error;
      }
      if (attempt >= watchStopAttempts) {
        return {
          text: `watcher lock in ${dir} changed repeatedly while stopping; inspect it before removal`,
          code: 1,
        };
      }
      if (current !== raw) {
        continue; // Another writer replaced the lock: reconsider its holder from scratch.
      }
      unlinkSync(path);
      return { text: `stale watcher lock (pid ${holder.pid}) removed`, code: 0 };
    }
    const cmdline = deps.readCmdline(holder.pid);
    if (!isWatchCmdline(cmdline)) {
      return {
        text: `refusing to signal pid ${holder.pid}: its command line is not a vmethod watch for this state (${describeCmdline(cmdline)})`,
        code: 1,
      };
    }
    try {
      deps.signal(holder.pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
      return staleRefusal(holder.pid);
    }
    const deadline = deps.now() + watchStopTimeoutMs;
    while (deps.now() < deadline) {
      await deps.sleep(Math.min(watchStopSleepMs, deadline - deps.now()));
      if (lockCleared(path)) {
        return { text: `watcher stopped (pid ${holder.pid})`, code: 0 };
      }
    }
    return {
      text: `watcher (pid ${holder.pid}) still holds ${dir}/lock after ${watchStopTimeoutMs / 1000}s; SIGKILL is never sent`,
      code: 1,
    };
  }
}

/** Whether the holder command line is the `vmethod watch` CLI itself, in either
 * the launcher's `node <checkout>/dist/vmethod.mjs watch` spelling or a
 * consumer's `node <checkout>/node_modules/.bin/vmethod watch` spelling.
 */
export function isWatchCmdline(cmdline: string | null): boolean {
  if (cmdline === null) {
    return false;
  }
  const argv = cmdline.split("\0").filter((token) => token.length > 0);
  return argv.some(
    (token, index) =>
      ["vmethod", "vmethod.mjs"].includes(basename(token)) && argv[index + 1] === "watch"
  );
}

/** A complete watch holder record, or undefined when the lock is legacy,
 * initializing or written by another operation; stop never trusts such a lock.
 */
function parseHolder(raw: string): LockHolder | undefined {
  let holder;
  try {
    holder = object(JSON.parse(raw));
  } catch {
    return undefined;
  }
  const pid =
    typeof holder.pid === "number" && Number.isSafeInteger(holder.pid) && holder.pid > 0
      ? holder.pid
      : undefined;
  const start =
    typeof holder.start === "number" && Number.isSafeInteger(holder.start) && holder.start >= 0
      ? holder.start
      : undefined;
  if (pid === undefined || holder.operation !== "watch") {
    return undefined;
  }
  return {
    operation: holder.operation,
    pid,
    at: typeof holder.at === "string" ? holder.at : "",
    ...(start === undefined ? {} : { start }),
  };
}

/** The holder's process identity: gone means the pid is unallocated; reused
 * means the pid runs with a different start than the recorded one. Both make
 * the lock stale; only a live holder with the recorded start can be signalled.
 */
/** The holder's process identity: gone means the pid is unallocated; reused
 * means the pid runs with a different start than the recorded one. Both make
 * the lock stale; only a live holder with the recorded start can be signalled.
 */
function holderProcessState(
  holder: LockHolder,
  deps: WatchStopDeps
): "running" | "gone" | "reused" {
  if (!deps.alive(holder.pid)) {
    return "gone";
  }
  const start = procStart(deps.readProc(holder.pid));
  return holder.start !== undefined && start !== null && start !== holder.start
    ? "reused"
    : "running";
}

function lockCleared(path: string): boolean {
  try {
    readFileSync(path, "utf8");
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (["ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return null;
    }
    throw error;
  }
}

function staleRefusal(pid: number): WatchStopVerdict {
  return {
    text: `stale watcher lock (pid ${pid} not running); remove with --stop --force`,
    code: 1,
  };
}

/** One terminal-safe summary line of the holder's command line for refusal diagnostics. */
function describeCmdline(cmdline: string | null): string {
  return cmdline === null
    ? "command line unreadable"
    : sanitizePreview(cmdline.split("\0").join(" "));
}
