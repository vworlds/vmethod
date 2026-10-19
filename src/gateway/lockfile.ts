import { existsSync } from "node:fs";
import { join } from "node:path";

/** Minimal exec surface for the sync check; shared by gateway and worker-verb subprocess dependencies. */
export interface LockfileExec {
  exec: (
    file: string,
    args: readonly string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv }
  ) => Promise<string>;
}

/** The complete refusal task-flow and worker start must produce instead of a raw npm dump. */
export const lockfileOutOfSync =
  "lockfile out of sync with package.json: regenerate it on the task branch before starting";

/** npm's documented package.json/package-lock.json drift refusal (EUSAGE); other errors keep their original text. */
const syncRefusal =
  /`npm ci` can only install packages when your package\.json and package-lock\.json(?: or npm-shrinkwrap\.json)? are in sync/;
const invalidLine = /\bInvalid: \S/;

/** Verify sync without installing anything: no lifecycle scripts, no network audit, no node_modules writes. */
export const npmCiCheckArguments = [
  "ci",
  "--dry-run",
  "--no-audit",
  "--no-fund",
  "--ignore-scripts",
] as const;

/** Filtered subprocess environment for npm installs and checks: no credentials, no hooks, no global config. */
export function npmCiEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const filtered: NodeJS.ProcessEnv = { HUSKY: "0" };
  for (const key of ["PATH", "HOME", "TMPDIR", "SYSTEMROOT"]) {
    if (env[key]) {
      filtered[key] = env[key];
    }
  }
  return filtered;
}

/** The sync check applies only when both manifests exist; an absent lockfile fails later at its own install. */
export function lockfileCheckable(directory: string): boolean {
  return (
    existsSync(join(directory, "package.json")) && existsSync(join(directory, "package-lock.json"))
  );
}

function diagnostic(text: string): string | undefined {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  return (
    lines.find((line) => invalidLine.test(line)) ??
    lines.find((line) => /\bMissing: \S+ from lock file$/.test(line))
  );
}

/** Run `npm ci --dry-run`; rewrite npm's documented drift refusal as one actionable line, keep all other failures. */
export async function assertLockfileInSync(
  deps: LockfileExec,
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  try {
    await deps.exec("npm", npmCiCheckArguments, { cwd, env });
  } catch (error) {
    const source = error as { message?: unknown; stderr?: unknown; stdout?: unknown };
    const text = [source.stderr, source.stdout, source.message]
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    if (!syncRefusal.test(text)) {
      throw error;
    }
    const line = diagnostic(text);
    throw new Error(line ? `${lockfileOutOfSync}\n${line}` : lockfileOutOfSync, { cause: error });
  }
}
