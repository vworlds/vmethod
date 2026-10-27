import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkMarkdown, MarkdownDependencyError } from "../gateway/markdown.js";
import type { Transport } from "../gateway/transport.js";
import { context } from "./transport.js";

export interface WorkerDependencies {
  exec: (
    file: string,
    args: readonly string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv }
  ) => Promise<string>;
  report: (message: string) => void;
}

/** Compatibility verbs use the same transport for every GitHub operation. */
export async function workerVerb(
  transport: Transport | undefined,
  root: string,
  verb: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  deps: WorkerDependencies
): Promise<string> {
  if (verb === "check-markdown") {
    if (args.length !== 1) {
      throw new Error("usage: check-markdown.sh <file>");
    }
    let body: string;
    try {
      body = readFileSync(args[0], "utf8");
    } catch {
      throw new MarkdownDependencyError(`cannot read ${args[0]}`);
    }
    await checkMarkdown(root, body, true);
    return "";
  }
  if (!transport) {
    throw new Error("Gateway required");
  }
  const ctx = context(env);
  if (verb === "push") {
    if (args.length > 2) {
      throw new Error("Usage: vmethod push [worktree branch]");
    }
    if (args.length === 1) {
      throw new Error("Usage: vmethod push [worktree branch]");
    }
    const worktree = resolve(args[0] ?? root);
    const branch =
      args[1] ??
      (
        await deps.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: worktree,
        })
      ).trim();
    return transport.call("push", { worktree, branch }, ctx);
  }
  if (verb === "pr-comment") {
    if (args.length !== 2) {
      throw new Error("usage: pr-comment.sh <pr> <file>");
    }
    const body = readFileSync(args[1], "utf8");
    // Before any local scratch state or post. `pr-comment` never duplicates the
    // header: a body whose first non-blank line opens with `[worker]` posts as
    // is, a bare body gets the header added, and `[orchestrator] …` is refused
    // — a worker never posts orchestrator protocol.
    const firstLine =
      body
        .split(/\r?\n/)
        .find((line) => line.trim() !== "")
        ?.trim() ?? "";
    if (firstLine.startsWith("[orchestrator]")) {
      throw new Error(
        `First non-blank line is the protocol header ${JSON.stringify(firstLine)}; pr-comment adds the [worker] header itself and a worker never posts [orchestrator] protocol`
      );
    }
    const scratch = join(root, ".tmp");
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "pr-comment-"));
    const file = join(directory, "body.md");
    try {
      writeFileSync(file, firstLine.startsWith("[worker]") ? body : `[worker] ${body}`);
      return await transport.call("post", { ref: args[0], file }, ctx);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  if (args.length !== 1) {
    throw new Error(`usage: ${verb}.sh <pr>`);
  }
  if (verb === "read-pr") {
    // The whole per-item thread read covers comments, reviews and review comments.
    return String(await transport.call("read", { kind: "pr", ref: args[0] }, ctx));
  }
  throw new Error("Unknown worker verb");
}
