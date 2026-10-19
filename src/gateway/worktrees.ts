import { existsSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { Config } from "../config.js";
import type { Dependencies } from "./client.js";
import { GitTransport, validateBranch } from "./git.js";
import { object } from "./people.js";
import { workerWorktreePrefix } from "./worker-path.js";

/** Same-repository task metadata, authenticated by the gateway before cleanup. */
export interface WorktreeTask {
  pr: number;
  branch: string;
  base: string;
  head: string;
  state: string;
}

/** Shared, conservative cleanup for merge recovery, explicit stop and backlog pruning.
 * Unknown sessions/objects and unsafe paths retain data; ignored files alone may be removed.
 */
export class WorktreeService {
  private main: string;
  private parent: string;
  private prefix: string;

  constructor(
    private root: string,
    private config: Config,
    private env: NodeJS.ProcessEnv,
    private deps: Dependencies,
    private status: (pr: number) => Promise<"live" | "stopped" | "unknown">
  ) {
    const branches = object(config.branches);
    this.main = resolve(String(branches.mainCheckout ?? root));
    this.parent = resolve(this.main, String(branches.worktreeRoot ?? ".worktrees"));
    this.prefix = workerWorktreePrefix(config);
  }

  /** List only registered prefixed trees inside this project's root. */
  async trees(): Promise<{ path: string; branch: string }[]> {
    return (await this.registered()).filter((tree) => this.safePath(tree.path, tree.branch));
  }

  /** Print sizes/reasons and optionally remove eligible trees; never stop sessions implicitly. */
  async list(
    taskFor: (branch: string) => Promise<WorktreeTask | undefined>,
    prune: boolean
  ): Promise<string> {
    const lines: string[] = [];
    let total = 0;
    let unknown = 0;
    for (const tree of await this.trees()) {
      const task = await taskFor(tree.branch);
      if (!task || !["MERGED", "CLOSED"].includes(task.state)) {
        continue;
      }
      const size = await this.size(tree.path);
      const measurement = size === undefined ? "size unknown" : `${size} KiB`;
      const reason = await this.reason(tree.path, task);
      if (reason) {
        lines.push(`${tree.path}: ${measurement}; skipped: ${reason}`);
      } else if (!prune || (await this.cleanup(task))) {
        if (size === undefined) {
          unknown++;
        } else {
          total += size;
        }
        lines.push(
          `${tree.path}: ${measurement}; ${prune ? "removed" : "removable"} (#${task.pr})`
        );
      } else {
        lines.push(`${tree.path}: ${measurement}; skipped after safety recheck`);
      }
    }
    lines.push(
      `Total ${prune ? "freed" : "removable"}: ${total} KiB${unknown ? ` + ${unknown} tree(s) with size unknown` : ""}`
    );
    return lines.join("\n");
  }

  /** Return false for a safety skip so merge recovery does not checkpoint unfinished cleanup. */
  async cleanup(task: WorktreeTask): Promise<boolean> {
    validateBranch(task.branch);
    const path = resolve(this.parent, `${this.prefix}${task.branch}`);
    const reason = await this.reason(path, task);
    if (reason) {
      this.deps.report(`${path}: skipped: ${reason}`);
      return false;
    }
    // An absent directory may be a retry after removal but before prune/branch deletion.
    const localHead = (
      await this.git().run("for-each-ref", "--format=%(objectname)", `refs/heads/${task.branch}`)
    ).trim();
    if (!existsSync(path) && !localHead) {
      return true;
    }
    if (existsSync(path)) {
      await this.git().run("worktree", "remove", "--force", path);
      this.deps.report(`${path}: removed`);
    }
    await this.git().run("worktree", "prune");
    const head = (
      await this.git().run("for-each-ref", "--format=%(objectname)", `refs/heads/${task.branch}`)
    ).trim();
    if (head) {
      // Recheck the branch immediately before deletion (including crash recovery).
      if (await this.uncontained(head, task)) {
        this.deps.report(`${path}: local branch retained: unpushed work`);
        return false;
      }
      // Compare-and-delete: a commit racing this safety check must retain its ref.
      await this.git().run("update-ref", "-d", `refs/heads/${task.branch}`, head);
    }
    return true;
  }

  private git(path = this.main): GitTransport {
    return new GitTransport(this.config, this.env, this.deps, path);
  }

  private async reason(path: string, task: WorktreeTask): Promise<string | undefined> {
    if (!this.safePath(path, task.branch)) {
      return "outside project worktree root/prefix or protected checkout";
    }
    if (!["MERGED", "CLOSED"].includes(task.state)) {
      return "PR is still open";
    }
    if (
      [
        "main",
        "master",
        "dev",
        "HEAD",
        String(this.config.baseBranch),
        String(this.config.releaseBranch),
        task.base,
      ].includes(task.branch) ||
      task.branch.startsWith(String(object(this.config.branches).packPrefix ?? "pack/"))
    ) {
      return "protected branch";
    }
    try {
      if ((await this.status(task.pr)) !== "stopped") {
        return "worker session live or unknown; stop it first";
      }
      if (existsSync(path)) {
        const git = this.git(path);
        const common = (await git.run("rev-parse", "--git-common-dir")).trim();
        const own = (await this.git().run("rev-parse", "--git-common-dir")).trim();
        if (realpathSync(resolve(path, common)) !== realpathSync(resolve(this.main, own))) {
          return "worktree belongs to another repository";
        }
        if (
          (await git.run("symbolic-ref", "--quiet", "HEAD")).trim() !== `refs/heads/${task.branch}`
        ) {
          return "worktree branch does not match PR";
        }
        if ((await git.run("status", "--porcelain", "--untracked-files=all")).trim()) {
          return "uncommitted work";
        }
        const registered = await this.registered();
        if (!registered.some((tree) => tree.path === path && tree.branch === task.branch)) {
          return "not a registered project worktree";
        }
      }
      const head = (
        await this.git().run("for-each-ref", "--format=%(objectname)", `refs/heads/${task.branch}`)
      ).trim();
      if (
        head &&
        (await this.registered()).some((tree) => tree.branch === task.branch && tree.path !== path)
      ) {
        return "branch belongs to another worktree";
      }
      if (head && (await this.uncontained(head, task))) {
        return "unpushed work (branch head not contained in PR head or base)";
      }
    } catch {
      return "safety check failed (session, git state or commit objects unavailable); retry after inspection";
    }
    return undefined;
  }

  private async registered(): Promise<{ path: string; branch: string }[]> {
    const output = await this.git().run("worktree", "list", "--porcelain", "-z");
    return output.split("\0\0").flatMap((record) => {
      const fields = record.split("\0");
      const path = fields.find((field) => field.startsWith("worktree "))?.slice(9);
      const branch = fields.find((field) => field.startsWith("branch refs/heads/"))?.slice(18);
      return path && branch ? [{ path, branch }] : [];
    });
  }

  private safePath(path: string, branch: string): boolean {
    const child = relative(this.parent, resolve(path));
    if (
      !child ||
      child.startsWith(`..${sep}`) ||
      child === ".." ||
      child !== `${this.prefix}${branch}`
    ) {
      return false;
    }
    if (resolve(path) === this.main || resolve(path) === resolve(this.root)) {
      return false;
    }
    if (existsSync(this.parent) && realpathSync(this.parent) !== this.parent) {
      return false;
    }
    if (existsSync(path)) {
      // Refuse symlinks and aliases even if they point back inside the root.
      return (
        realpathSync(path) === resolve(realpathSync(this.parent), child) &&
        realpathSync(path) !== realpathSync(this.main) &&
        realpathSync(path) !== realpathSync(this.root)
      );
    }
    return true;
  }

  private async size(path: string): Promise<number | undefined> {
    try {
      // Measurement has its own two-minute budget, independent of the CLI verb's default.
      const output = await this.deps.exec("du", ["-sk", "--", path], {
        cwd: this.main,
        timeout: 120000,
      });
      const match = /^(\d+)\s/.exec(output);
      if (!match || !Number.isSafeInteger(Number(match[1]))) {
        throw new Error("Invalid du measurement");
      }
      return Number(match[1]);
    } catch {
      // A measurement failure grants no deletion authority and must not hide other trees.
      this.deps.report(
        `${path}: size unknown (du failed or returned invalid output; inspect permissions or retry measurement)`
      );
      return undefined;
    }
  }

  private async uncontained(head: string, task: WorktreeTask): Promise<boolean> {
    if (!/^[a-f\d]{40}$/i.test(head) || !/^[a-f\d]{40}$/i.test(task.head)) {
      throw new Error("Invalid cleanup commit");
    }
    validateBranch(task.base);
    return Boolean(
      (
        await this.git().run(
          "rev-list",
          "-1",
          head,
          "--not",
          ...(task.state === "MERGED" ? [task.head] : []),
          `refs/heads/${task.base}`,
          "--"
        )
      ).trim()
    );
  }
}
