import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { configValue, getConfig } from "../config.js";
import {
  checkMarkdown,
  guardProtocolHeader,
  MarkdownDependencyError,
} from "../gateway/markdown.js";
import { assertLockfileInSync, lockfileCheckable, npmCiEnvironment } from "../gateway/lockfile.js";
import type { CallContext, Transport } from "../gateway/transport.js";
import { context } from "./transport.js";
import { workerWorktree } from "./worker-path.js";

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
    // Before any local scratch state or post: this verb adds `[worker] ` itself.
    guardProtocolHeader(body, "pr-comment");
    const scratch = join(root, ".tmp");
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "pr-comment-"));
    const file = join(directory, "body.md");
    try {
      writeFileSync(file, `[worker] ${body}`);
      return await transport.call("post", { ref: args[0], file }, ctx);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  if (args.length !== 1) {
    throw new Error(`usage: ${verb}.sh <pr>`);
  }
  if (verb === "read-pr") {
    const prompt = await transport.call("read", { kind: "pr", ref: args[0] }, ctx);
    if (prompt === "No accepted thread") {
      return prompt;
    }
    const reviews = await transport.call(
      "read",
      { kind: "pr", ref: args[0], option: "--reviews" },
      ctx
    );
    return `${prompt}\n\n${reviews}`;
  }
  if (verb === "start-task") {
    return startTask(transport, root, args[0], env, ctx, deps);
  }
  throw new Error("Unknown worker verb");
}

export async function startTask(
  transport: Transport,
  root: string,
  ref: string,
  env: NodeJS.ProcessEnv,
  ctx: CallContext,
  deps: WorkerDependencies
): Promise<string> {
  const config = getConfig(root, env);
  const { branch, base } = await transport.call("task", { ref, fetch: true }, ctx);
  const branches = config.branches as { mainCheckout?: string };
  const worktreeRoot = resolve(
    branches.mainCheckout ?? root,
    String(configValue(config, "branches.worktreeRoot"))
  );
  const target = workerWorktree(root, config, branch);
  if (!relative(worktreeRoot, target) || relative(worktreeRoot, target).startsWith(`..${sep}`)) {
    throw new Error("Worktree escapes branches.worktreeRoot");
  }
  const git = (cwd: string, ...args: string[]) =>
    deps.exec(
      "git",
      [...(config.workerUser && cwd === target ? ["-c", `safe.directory=${target}`] : []), ...args],
      { cwd }
    );
  mkdirSync(worktreeRoot, { recursive: true });
  let ancestor = target;
  while (!existsSync(ancestor)) {
    ancestor = dirname(ancestor);
  }
  const realRoot = realpathSync(worktreeRoot);
  const realAncestor = realpathSync(ancestor);
  if (realAncestor !== realRoot && !realAncestor.startsWith(`${realRoot}${sep}`)) {
    throw new Error("Worktree escapes branches.worktreeRoot");
  }
  if (!existsSync(target)) {
    // A failing show-ref or worktree add is never silently treated as success.
    const branches = await git(root, "for-each-ref", "--format=%(refname)", `refs/heads/${branch}`);
    await git(
      root,
      "worktree",
      "add",
      ...(branches.trim()
        ? [target, branch]
        : ["-b", branch, target, `refs/remotes/origin/${branch}`])
    );
  }
  if (realpathSync(target).startsWith(`${realpathSync(worktreeRoot)}${sep}`) === false) {
    throw new Error("Worktree escapes branches.worktreeRoot");
  }
  if (
    realpathSync((await git(target, "rev-parse", "--show-toplevel")).trim()) !==
    realpathSync(target)
  ) {
    throw new Error("error: target is not its own worktree");
  }
  const common = (await git(target, "rev-parse", "--git-common-dir")).trim();
  const directory = (await git(target, "rev-parse", "--git-dir")).trim();
  if (resolve(target, common) === resolve(target, directory)) {
    throw new Error("error: run this inside your own worktree, not the main checkout");
  }
  if ((await git(target, "rev-parse", "--abbrev-ref", "HEAD")).trim() !== branch) {
    throw new Error("error: worktree has a different task branch");
  }
  if ((await git(target, "status", "--porcelain")).trim()) {
    throw new Error("error: worktree has uncommitted changes; commit or stash them first");
  }
  await git(target, "branch", "-q", `--set-upstream-to=origin/${branch}`);
  const mine = (await git(target, "rev-list", "--count", `origin/${base}..HEAD`)).trim();
  const behind = (await git(target, "rev-list", "--count", `HEAD..origin/${base}`)).trim();
  deps.report(`branch ${branch} keeps its ${mine} commit(s); ${behind} behind origin/${base}`);
  if (config.workerUser || config.workerGroup) {
    await transport.call("workerAccess", { directory: target }, ctx);
  }
  if (lockfileCheckable(target)) {
    deps.report(`checking lockfile sync in ${target}`);
    await assertLockfileInSync(deps, target, npmCiEnvironment(env));
  }
  const stamp = join(target, "node_modules/.package-lock.sha");
  const want = createHash("sha256")
    .update(readFileSync(join(target, "package-lock.json")))
    .digest("hex");
  if (!existsSync(stamp) || readFileSync(stamp, "utf8").trim() !== want) {
    // Do not pass gateway credentials to package lifecycle scripts.
    const installEnv = npmCiEnvironment(env);
    const output = await deps.exec(
      config.workerGroup ? "sh" : "npm",
      config.workerGroup ? ["-c", "umask 002\nexec npm ci"] : ["ci"],
      {
        cwd: target,
        env: installEnv,
      }
    );
    if (output.trim()) {
      deps.report(output.trim());
    }
    mkdirSync(join(target, "node_modules"), { recursive: true });
    writeFileSync(stamp, `${want}\n`);
  } else {
    deps.report("dependencies already match package-lock.json");
  }
  if (config.workerUser || config.workerGroup) {
    await transport.call("workerAccess", { directory: target }, ctx);
  }
  return `ready. Next: scripts/agent/read-pr.sh ${ref}`;
}
