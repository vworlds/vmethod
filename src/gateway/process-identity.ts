import { readFileSync } from "node:fs";
import { hostname } from "node:os";

/** A board lock is shared across hosts: only compare /proc in the same host/boot. */
export function migrationIdentity(): string | undefined {
  const boot = read("/proc/sys/kernel/random/boot_id");
  const start = procStart(read(`/proc/${process.pid}/stat`));
  return boot && start !== null
    ? JSON.stringify({ host: hostname(), boot, pid: process.pid, start })
    : undefined;
}

/** Unknown, malformed or remote identities cannot prove a dead holder. */
export function migrationHolderDead(identity: string): boolean {
  let holder: { host?: unknown; boot?: unknown; pid?: unknown; start?: unknown };
  try {
    holder = JSON.parse(identity);
  } catch {
    return false;
  }
  if (
    !holder ||
    holder.host !== hostname() ||
    typeof holder.boot !== "string" ||
    typeof holder.pid !== "number" ||
    !Number.isSafeInteger(holder.pid) ||
    holder.pid < 1 ||
    typeof holder.start !== "number" ||
    !Number.isSafeInteger(holder.start) ||
    holder.start < 0
  ) {
    return false;
  }
  const boot = read("/proc/sys/kernel/random/boot_id");
  if (!boot) {
    return false;
  }
  if (holder.boot !== boot) {
    return true;
  }
  try {
    const start = procStart(readFileSync(`/proc/${holder.pid}/stat`, "utf8"));
    return start !== null && start !== holder.start;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** Field 22 of /proc/<pid>/stat, shared with watcher locks to detect reused PIDs. */
export function procStart(stat: string | null): number | null {
  if (stat === null) {
    return null;
  }
  const fields = stat
    .slice(stat.lastIndexOf(")") + 1)
    .trim()
    .split(/\s+/);
  const value = Number(fields[19]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}
