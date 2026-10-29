import { accessSync, constants } from "node:fs";
import type { Config } from "../config.js";
import type { Dependencies } from "./client.js";
import { githubToken } from "./github-token.js";

export const gitIdentityVariables = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

/** What distinguishes a failed transfer: classified from the final attempt's subprocess output. */
type TransferOutcome = "moved" | "workflow-scope" | "auth" | "other";

export interface TransferFailure {
  ok: false;
  outcome: TransferOutcome;
  /** First line of the final attempt's failure text, with credential text removed. */
  detail: string;
}

export type TransferResult = { ok: true } | TransferFailure;

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

  /** Classified transfer: on failure, the last attempt's outcome and redacted detail line. */
  async transfer(command: "fetch" | "push", refs: string[]): Promise<TransferResult> {
    const credentials = this.config.credentials;
    const token = githubToken(this.env);
    const repo = this.config.repo ?? "undefined";
    const httpsEnv = this.localEnvironment();
    httpsEnv.VMETHOD_GIT_TOKEN = token;
    const helper =
      '!f() { printf "%s\\n" "username=x-access-token" "password=$VMETHOD_GIT_TOKEN"; }; f';
    const result = await this.retry(
      command,
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
      httpsEnv,
      token
    );
    if (result.ok) {
      return result;
    }
    const key = this.env[credentials?.sshKey ?? ""];
    if (!key) {
      return result;
    }
    try {
      accessSync(key, constants.R_OK);
    } catch {
      return result;
    }
    this.deps.report(`HTTPS ${command} failed; trying SSH`);
    const sshEnv = this.localEnvironment();
    // GIT_SSH_COMMAND is interpreted by a shell; quote the server-owned path too.
    sshEnv.GIT_SSH_COMMAND = `ssh -i '${key.replaceAll("'", "'\\''")}' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes`;
    return this.retry(
      command,
      [
        command,
        ...(command === "push" ? ["--porcelain"] : ["-q"]),
        `git@github.com:${repo}.git`,
        ...refs,
      ],
      sshEnv,
      token
    );
  }

  /** Thin boolean wrapper keeping fetch-style callers' plain success/failure semantics. */
  async transferOk(command: "fetch" | "push", refs: string[]): Promise<boolean> {
    return (await this.transfer(command, refs)).ok;
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

  private async retry(
    command: "fetch" | "push",
    args: string[],
    env: NodeJS.ProcessEnv,
    token: string
  ): Promise<TransferResult> {
    let failure = classifyFailure(new Error("git transfer failed"), token);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.deps.exec("git", args, { cwd: this.worktree, env });
        return { ok: true };
      } catch (error) {
        failure = classifyFailure(error, token);
        // git stderr is remote-controlled text and can carry credentials; it is
        // classified locally, never reported or surfaced unredacted.
        if (failure.outcome === "workflow-scope" || failure.outcome === "auth") {
          return failure;
        }
        if (attempt === 2) {
          return failure;
        }
        const delay = 2000 * 2 ** attempt;
        this.deps.report(`retry ${attempt + 1}/2 in ${delay / 1000}s: git ${command}`);
        await this.deps.sleep(delay);
      }
    }
    return failure; // the last attempt's outcome; TS keeps this after the loop.
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

/** The push verb's actionable message for a classified failure; never contains credential text. */
export function pushFailureMessage(failure: TransferFailure, repo: string): string {
  switch (failure.outcome) {
    case "moved":
      return "error: the remote branch moved: fetch and merge it (never force-push)";
    case "workflow-scope":
      return "push refused: changing .github/workflows needs a token with the workflow scope; ask the orchestrator";
    case "auth":
      return `push refused: the gh login in GH_CONFIG_DIR is not authorized for ${repo}`;
    case "other":
      return `push failed: ${failure.detail}`;
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
      config.baseBranch ?? "undefined",
      config.releaseBranch ?? "undefined",
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

/** Git's refusal markers, most specific first: a workflow-scope porcelain line may also carry reject words (#318). */
const workflowScopeRefusal = /refusing to allow\b[^\n]*\bto create or update workflow\b/;
const authenticationRefusal =
  /\bHTTP\s*40[13]\b|\breturned error:\s*40[13]\b|\bPermission denied\b|\bAuthentication failed\b|\bcould not read Username\b/;
const movedRefusal = /\[rejected\]|\bnon-fast-forward\b|\bfetch first\b|\bstale info\b/;

/** The untrusted failure output an exec error carries, whichever stream the driver filled. */
function failureOutput(error: unknown): { all: string; first: string } {
  const source = error as { message?: unknown; stderr?: unknown; stdout?: unknown };
  const parts = [source.stderr, source.stdout, source.message].filter(
    (value): value is string => typeof value === "string" && value.trim() !== ""
  );
  return {
    all: parts.join("\n"),
    first: parts[0]
      ? (parts[0].split(/\r?\n/).find((line) => line.trim()) ?? "").trim()
      : "git transfer failed",
  };
}

/** Redact the token value and any `user:pass@` in URLs from untrusted git output. */
function redactCredentials(text: string, token: string): string {
  // URL credentials first: dropping the token first would leave `user:` behind when the
  // password itself was the token.
  const withoutUrlCredentials = text.replace(
    /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/:@\s]+:[^/:@\s]+@/g,
    "$1"
  );
  return token ? withoutUrlCredentials.split(token).join("") : withoutUrlCredentials;
}

function classifyFailure(error: unknown, token: string): TransferFailure {
  const { all, first } = failureOutput(error);
  const outcome: TransferOutcome = workflowScopeRefusal.test(all)
    ? "workflow-scope"
    : authenticationRefusal.test(all)
      ? "auth"
      : movedRefusal.test(all)
        ? "moved"
        : "other";
  return { ok: false, outcome, detail: redactCredentials(first, token) };
}
