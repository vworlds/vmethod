import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describeLockHolder, lockHolder } from "../gateway/lock-holder.js";
import { procStart } from "../gateway/process-identity.js";
import { object } from "../gateway/people.js";

interface ProcessDeps {
  pid: number;
  now(): number;
  readProc(pid: number): string | null;
}

const LOCK_RETRIES = 20;
const LOCK_RETRY_MS = 100;
const STALE_LOCK_MS = 3_000;

/** PID/start-time locks. Watch retains its 60-second holder-less initialization
 * window; conflict clears ownerless files and legacy directories immediately.
 * Both retain live holders, recover dead/reused PIDs, and release only their own
 * claim. Watch stop remains in watch-stop.ts (command verification, no SIGKILL). */
export class OwnedLock {
  constructor(
    private path: string,
    private deps: ProcessDeps
  ) {}

  /** Acquire a watcher lock and return its graceful-exit release callback. */
  watch(directory: string): () => void {
    const path = this.path;
    const start = procStart(this.deps.readProc(this.deps.pid));
    if (start === null) {
      throw new Error("watcher lock requires /proc/<pid>/stat (Linux)");
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const fd = openSync(path, "wx", 0o600);
        writeFileSync(
          fd,
          `${JSON.stringify(lockHolder("watch", this.deps.pid, this.deps.now(), start))}\n`,
          { mode: 0o600 }
        );
        closeSync(fd);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        let holderText: string;
        try {
          holderText = readFileSync(path, "utf8");
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === "ENOENT" && attempt < 2) {
            continue;
          }
          throw readError;
        }
        const holder = object(safeJson(holderText));
        if (count(holder.pid) === null && this.deps.now() - statSync(path).mtimeMs < 60_000) {
          throw new Error("watch: another watcher is initializing the lock; retry shortly", {
            cause: error,
          });
        }
        const holderPid = count(holder.pid);
        const holderStart = procStart(holderPid === null ? null : this.deps.readProc(holderPid));
        if (holderPid !== null && holderStart !== null && holderStart === holder.start) {
          throw new Error(`watch: another watcher (pid ${holderPid}) holds ${directory}`, {
            cause: error,
          });
        }
        if (attempt >= 2) {
          throw new Error(`watch: cannot clear the stale watcher lock in ${directory}`, {
            cause: error,
          });
        }
        if (readFileSync(path, "utf8") !== holderText) {
          continue;
        }
        unlinkSync(path);
      }
    }
    return () => {
      try {
        const holder = object(safeJson(readFileSync(path, "utf8")));
        if (count(holder.pid) === this.deps.pid && holder.start === start) {
          unlinkSync(path);
        }
      } catch {
        /* an exit handler must never throw */
      }
    };
  }

  /** Attempt a conflict claim; a live holder yields the quiet pending line. */
  conflict(pr: number, start: number): string | undefined {
    const lock = this.path;
    for (let attempt = 0; ; attempt++) {
      try {
        writeFileSync(
          lock,
          `${JSON.stringify({ pid: this.deps.pid, start, at: new Date(this.deps.now()).toISOString() })}\n`,
          { flag: "wx", mode: 0o700 }
        );
        return undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        let holderText: string;
        try {
          holderText = readFileSync(lock, "utf8");
        } catch (readError) {
          const code = (readError as NodeJS.ErrnoException).code;
          if (code === "EISDIR") {
            try {
              rmdirSync(lock);
            } catch (rmdirError) {
              if ((rmdirError as NodeJS.ErrnoException).code !== "ENOENT") {
                throw new Error(
                  `Conflict #${pr}: cannot clear the legacy conflict lock directory`,
                  {
                    cause: rmdirError,
                  }
                );
              }
            }
            continue;
          }
          if (code === "ENOENT" && attempt < 2) {
            continue;
          }
          throw readError;
        }
        const holder = lockOwner(holderText);
        const holderStart = procStart(holder.pid === null ? null : this.deps.readProc(holder.pid));
        if (holder.pid !== null && holderStart !== null && holderStart === holder.start) {
          return `PENDING #${pr}: conflict resolution in progress (pid ${holder.pid})`;
        }
        if (attempt >= 2) {
          throw new Error(`Conflict #${pr}: cannot clear the stale conflict lock`, {
            cause: error,
          });
        }
        if (readFileSync(lock, "utf8") !== holderText) {
          continue;
        }
        unlinkSync(lock);
      }
    }
  }

  /** Release a conflict claim only if its PID and start still match. */
  releaseConflict(start: number): void {
    try {
      const holder = lockOwner(readFileSync(this.path, "utf8"));
      if (holder.pid === this.deps.pid && holder.start === start) {
        unlinkSync(this.path);
      }
    } catch {
      /* releasing never masks the resolution's own outcome */
    }
  }
}

/** Legacy PID-only OwnedLock policy for the journal: format changes are out of
 * scope. Only a lock older than 3s with ESRCH is reclaimed. A reused live PID,
 * missing/malformed holder or fresh file stays locked; age alone never suffices. */
export class PidLock {
  constructor(private path: string) {}

  /** Retry brief contention, then surface the existing write-journal refusal. */
  acquire(): number {
    let lock = -1;
    let lockError: unknown;
    for (let attempt = 0; attempt <= LOCK_RETRIES; attempt += 1) {
      try {
        lock = openSync(this.path, "wx", 0o600);
        writeFileSync(lock, String(process.pid));
        lockError = undefined;
        break;
      } catch (error) {
        lockError = error;
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          break;
        }
        if (this.stale()) {
          try {
            unlinkSync(this.path);
          } catch (unlinkError) {
            if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") {
              lockError = unlinkError;
            }
          }
          continue;
        }
        if (attempt < LOCK_RETRIES) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
        }
      }
    }
    if (lockError !== undefined) {
      throw new Error(
        "GitHub write succeeded but cannot lock gateway write journal; inspect the remote state and journal lock before retrying (do not blindly repeat creates)",
        { cause: lockError }
      );
    }
    return lock;
  }

  /** Release the descriptor and file after the synchronous journal write. */
  release(fd: number): void {
    closeSync(fd);
    unlinkSync(this.path);
  }

  /** Test the legacy policy without taking or altering the lock. */
  stale(): boolean {
    try {
      if (Date.now() - statSync(this.path).mtimeMs <= STALE_LOCK_MS) {
        return false;
      }
      const pid = Number(readFileSync(this.path, "utf8"));
      if (!Number.isSafeInteger(pid) || pid < 1) {
        return false;
      }
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    } catch {
      return false;
    }
  }
}

/** Directory claims never recover automatically, even with a dead/reused PID or
 * missing holder. Worker claims name their holder (W5); learning/generation and
 * review claims deliberately remain holder-less. Callers retain refusal texts. */
export class DirLock {
  constructor(private path: string) {}

  acquire(): void {
    mkdirSync(this.path);
  }

  describe(now: number): string {
    return describeLockHolder(join(this.path, "holder.json"), now);
  }

  /** Write only for worker claims, inside the caller's release-protected block. */
  holder(operation: string, now: number): void {
    writeFileSync(
      join(this.path, "holder.json"),
      JSON.stringify(lockHolder(operation, process.pid, now)) + "\n",
      { mode: 0o600 }
    );
  }

  release(worker = false): void {
    if (worker) {
      rmSync(this.path, { recursive: true });
    } else {
      rmdirSync(this.path);
    }
  }
}

// The third kind, the board field lock, stays in board/runner.ts: its claim,
// README holder and release are ordered remote writes with recovery snapshots.
// It uses host/boot/PID/start identity, a one-minute holder-less field window,
// and explicit --steal for old/unknown holders without proof of death. Moving
// those writes into a file-lock abstraction would obscure their ordering.

function lockOwner(text: string): { pid: number | null; start: number | null } {
  try {
    const holder = JSON.parse(text) as unknown;
    const pid = Number((holder as { pid?: unknown }).pid);
    const start = Number((holder as { start?: unknown }).start);
    return {
      pid: Number.isSafeInteger(pid) && pid >= 1 ? pid : null,
      start: Number.isSafeInteger(start) && start >= 0 ? start : null,
    };
  } catch {
    return { pid: null, start: null };
  }
}

function count(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
