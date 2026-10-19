import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Config } from "../config.js";
import type { Dependencies } from "./client.js";
import { untrusted } from "./people.js";
import { GitTransport } from "./git.js";

/** Verify a clean, pinned conflict resolution; an absent hook skips local verification only.
 * The conflict workflow must independently require green CI. Ordinary merge verification is unchanged.
 */
export async function verifyConflictHead(
  worktree: string,
  head: string,
  config: Config,
  environment: NodeJS.ProcessEnv,
  deps: Dependencies
): Promise<boolean> {
  const git = new GitTransport(config, environment, deps, worktree);
  if ((await git.run("status", "--porcelain")).trim()) {
    return false;
  }
  let verified = true;
  if (existsSync(join(worktree, "scripts/vmethod-hooks/verify"))) {
    verified =
      (await runVerifyHook(worktree, config, environment, deps, ["--scope", "merge"])).code === 0;
  } else {
    deps.report(
      "conflict resolution: no verify hook; local verify skipped, green CI still required"
    );
  }
  return (
    verified &&
    !(await git.run("status", "--porcelain")).trim() &&
    (await git.run("rev-parse", "HEAD")).trim() === head
  );
}

/** Run the project's installation/check hook without gateway credentials; retain its logs. */
export async function runVerifyHook(
  worktree: string,
  config: Config,
  environment: NodeJS.ProcessEnv,
  deps: Dependencies,
  options: string[] = []
): Promise<{ code: 0 | 1; text: string; logs: string }> {
  const state = environment.XDG_STATE_HOME || join(environment.HOME || homedir(), ".local/state");
  const parent = resolve(
    state,
    "vmethod",
    String(config.stateName ?? String(config.repo).replace("/", "-")),
    "verify"
  );
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const logs = mkdtempSync(join(parent, `${deps.now()}-`));
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "SYSTEMROOT"]) {
    if (environment[key]) {
      env[key] = environment[key];
    }
  }
  const output = join(logs, "hook.log");
  let code: 0 | 1 = 0;
  try {
    await deps.exec(
      "/bin/sh",
      [
        "-c",
        'out=$1; shift; "$@" > "$out" 2>&1',
        "verify",
        output,
        join(worktree, "scripts/vmethod-hooks/verify"),
        "--logs",
        logs,
        ...options,
      ],
      { cwd: worktree, env }
    );
  } catch {
    code = 1;
  }
  return { code, text: untrusted(readFileSync(output, "utf8")), logs };
}
