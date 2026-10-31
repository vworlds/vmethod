import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOG_LINES = 200;

/** Append timestamped watcher telemetry, keeping the same bounded/private log
 * rules for retries and pacing. Callers report an unusable log once per signature. */
export function appendWatchReport(dir: string, name: string, message: string, now: number): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  let lines: string[] = [];
  try {
    lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  if (lines.length >= LOG_LINES) {
    writeFileSync(`${path}.tmp`, `${lines.slice(-Math.floor(LOG_LINES / 2)).join("\n")}\n`, {
      mode: 0o600,
    });
    renameSync(`${path}.tmp`, path);
  }
  appendFileSync(path, `${new Date(now).toISOString()} ${message}\n`, { mode: 0o600 });
}
