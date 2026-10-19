import { accessSync, constants } from "node:fs";
import type { Config } from "../config.js";
import type { Dependencies } from "./client.js";

export const gitIdentityVariables = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

/** Server-only git transport. No credentials or subprocess diagnostics cross the seam. */
export class GitTransport {
  constructor(
    private config: Config,
    private env: NodeJS.ProcessEnv,
    private deps: Dependencies,
    private worktree: string
  ) {}

  async run(...args: string[]): Promise<string> {
    if (args[0] === "commit-tree" && gitIdentityVariables.some((key) => !this.env[key]?.trim())) {
      throw new Error(
        "set GIT_AUTHOR_NAME/EMAIL in the orchestrator environment (and GIT_COMMITTER_NAME/EMAIL)"
      );
    }
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

  /** Preview a two-way merge without modifying a checkout; exit 1 is merge-tree's documented conflict result. */
  async mergePreview(ours: string, theirs: string): Promise<{ tree: string; conflicts: string[] }> {
    if (![ours, theirs].every((value) => /^[a-f\d]{40}$/i.test(value))) {
      throw new Error("Invalid merge preview SHA");
    }
    const output = await this.deps.exec(
      "/bin/sh",
      [
        "-c",
        'git merge-tree --write-tree --name-only -z "$1" "$2"; result=$?; if [ "$result" -eq 0 ] || [ "$result" -eq 1 ]; then exit 0; else exit "$result"; fi',
        "merge-preview",
        ours,
        theirs,
      ],
      { cwd: this.worktree, env: this.localEnvironment() }
    );
    const [tree, ...parts] = output.split("\0");
    if (!/^[a-f\d]{40}$/i.test(tree)) {
      throw new Error("Invalid merge-tree preview");
    }
    const end = parts.indexOf("");
    if (end < 0) {
      throw new Error("Missing merge-tree path terminator");
    }
    return { tree, conflicts: [...new Set(parts.slice(0, end))] };
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
    for (const key of ["PATH", "HOME", "TMPDIR", "SYSTEMROOT", ...gitIdentityVariables]) {
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
