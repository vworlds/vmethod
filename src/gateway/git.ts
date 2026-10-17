import { accessSync, constants } from "node:fs";
import type { Config } from "../config.js";
import type { Dependencies } from "./client.js";

/** Server-only git transport. No credentials or subprocess diagnostics cross the seam. */
export class GitTransport {
  constructor(
    private config: Config,
    private env: NodeJS.ProcessEnv,
    private deps: Dependencies,
    private worktree: string
  ) {}

  async run(...args: string[]): Promise<string> {
    return this.deps.exec("git", args, {
      cwd: this.worktree,
      env: this.localEnvironment(),
    });
  }

  async transfer(command: "fetch" | "push", refs: string[]): Promise<boolean> {
    const credentials = this.config.credentials as Record<string, string> | undefined;
    const token = this.env[credentials?.githubToken ?? ""];
    if (!token) {
      throw new Error("Missing configured GitHub token environment variable");
    }
    const repo = String(this.config.repo);
    const httpsEnv = this.localEnvironment();
    httpsEnv.VMETHOD_GIT_TOKEN = token;
    const helper =
      '!f() { printf "%s\\n" "username=x-access-token" "password=$VMETHOD_GIT_TOKEN"; }; f';
    if (
      await this.retry(
        [
          "-c",
          "credential.helper=",
          "-c",
          `credential.helper=${helper}`,
          command,
          ...(command === "push" ? ["--porcelain"] : ["-q"]),
          `https://github.com/${repo}.git`,
          ...refs,
        ],
        httpsEnv
      )
    ) {
      return true;
    }
    const key = this.env[credentials?.sshKey ?? ""];
    if (!key) {
      return false;
    }
    try {
      accessSync(key, constants.R_OK);
    } catch {
      return false;
    }
    this.deps.report(`HTTPS ${command} failed; trying SSH`);
    const sshEnv = this.localEnvironment();
    // GIT_SSH_COMMAND is interpreted by a shell; quote the server-owned path too.
    sshEnv.GIT_SSH_COMMAND = `ssh -i '${key.replaceAll("'", "'\\''")}' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes`;
    return this.retry(
      [
        command,
        ...(command === "push" ? ["--porcelain"] : ["-q"]),
        `git@github.com:${repo}.git`,
        ...refs,
      ],
      sshEnv
    );
  }

  private async retry(args: string[], env: NodeJS.ProcessEnv): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.deps.exec("git", args, { cwd: this.worktree, env });
        return true;
      } catch {
        // git stderr can contain credentials and remote-controlled text.
        if (attempt === 2) {
          return false;
        }
        const delay = 2000 * 2 ** attempt;
        this.deps.report(
          `retry ${attempt + 1}/2 in ${delay / 1000}s: git ${args.includes("push") ? "push" : "fetch"}`
        );
        await this.deps.sleep(delay);
      }
    }
    return false;
  }

  private localEnvironment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "HOME", "TMPDIR", "SYSTEMROOT"]) {
      if (this.env[key]) {
        env[key] = this.env[key];
      }
    }
    return {
      ...env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };
  }
}

export function taskBranch(branch: string, config: Config): void {
  validateBranch(branch);
  if (
    [
      "dev",
      "master",
      "main",
      "HEAD",
      String(config.baseBranch),
      String(config.releaseBranch),
    ].includes(branch)
  ) {
    throw new Error(`error: refusing to push ${branch}`);
  }
}

export function validateBranch(branch: string): void {
  if (
    !branch ||
    branch.length > 240 ||
    branch.startsWith("-") ||
    /\s/.test(branch) ||
    Array.from(branch).some(
      (character) =>
        "~^:?*[\\".includes(character) ||
        character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) === 127
    ) ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.includes("//") ||
    branch
      .split("/")
      .some((part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))
  ) {
    throw new Error("Invalid task branch");
  }
}
