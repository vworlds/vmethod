import { readFileSync } from "node:fs";
import { procStart } from "./process-identity.js";
import { object } from "./people.js";

/** Shared worker/watcher holder format. `start` is the Linux process identity
 * used by watcher stop/recovery; `at` is wall time for human-readable lock age. */
export interface LockHolder {
  operation: string;
  pid: number;
  at: string;
  start?: number;
}

/** Create a holder without changing lock acquisition or stale-lock policy. */
export function lockHolder(
  operation: string,
  pid: number,
  now: number,
  start = processStart(pid)
): LockHolder {
  return { operation, pid, at: new Date(now).toISOString(), ...(start === null ? {} : { start }) };
}

/** Describe a refused lock; legacy, incomplete or invalid records stay locked. */
export function describeLockHolder(file: string, now: number): string {
  let holder;
  try {
    holder = object(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return "holder unknown (legacy or initializing lock; inspect before removal)";
    }
    throw error;
  }
  const pid =
    typeof holder.pid === "number" && Number.isSafeInteger(holder.pid) && holder.pid > 0
      ? holder.pid
      : undefined;
  const at = typeof holder.at === "string" ? Date.parse(holder.at) : NaN;
  const operation =
    typeof holder.operation === "string" && /^[\w -]{1,80}$/.test(holder.operation)
      ? holder.operation
      : "unknown";
  let stale = false;
  if (pid !== undefined) {
    try {
      process.kill(pid, 0);
      const start = processStart(pid);
      stale = typeof holder.start === "number" && start !== null && start !== holder.start;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ESRCH" &&
        (error as NodeJS.ErrnoException).code !== "EPERM"
      ) {
        throw error;
      }
      stale = (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  }
  return `held by ${operation} (pid ${pid ?? "unknown"}) for ${Number.isFinite(at) ? `${Math.max(0, Math.floor((now - at) / 1000))}s` : "unknown age"}${stale ? " (process not running; stale)" : ""}`;
}

function processStart(pid: number): number | null {
  try {
    return procStart(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch (error) {
    if (["ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return null;
    }
    throw error;
  }
}
