import { existsSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Config } from "../config.js";
import type { Dependencies } from "./client.js";
import { GitTransport, validateBranch } from "./git.js";
import { object } from "./people.js";
import { WorkerWorktrees } from "./worker-launch.js";
import { workerWorktreeName } from "./worker-path.js";

/** Same-repository task metadata, authenticated by the gateway before cleanup. */
export interface WorktreeTask {
  pr: number;
  branch: string;
  base: string;
  head: string;
  state: string;
}

/** Shared, conservative cleanup for merge recovery, explicit stop and backlog pruning.
 * Task worktrees live in the worker checkout; OpenCode removes them, git there deletes
 * the branch. Unknown sessions/objects and unsafe paths retain data; ignored files
 * alone may be removed.
 */
export class WorktreeService {
  private workerTrees?: WorkerWorktrees;

  constructor(
    private root: string,
    private config: Config,
    private env: NodeJS.ProcessEnv,
    private deps: Dependencies,
    private status: (pr: number) => Promise<"live" | "stopped" | "unknown">,
    private closeSession?: (pr: number) => Promise<boolean>,
    private captureUsage?: (pr: number) => Promise<boolean>
  ) {}

  /** Read lazily: verbs that never touch worker worktrees need no worker checkout. */
  private get worker(): WorkerWorktrees {
    return (this.workerTrees ??= new WorkerWorktrees(this.root, this.config, this.env, this.deps));
  }

  /** Without a worker checkout no task worktree or task branch can exist to clean. */
  private get cloned(): boolean {
    return existsSync(join(this.worker.checkout, ".git"));
  }

  /** Task worktrees of the worker checkout: registered, on a branch, named for it. */
  async trees(): Promise<{ path: string; branch: string }[]> {
    if (!this.cloned) {
      return [];
    }
    return (await this.worker.registered()).filter((tree) => this.safePath(tree.path, tree.branch));
  }

  /** Print sizes/reasons and optionally remove eligible trees and close their
   * stopped sessions; never stop sessions implicitly. A false closure is reported
   * by the backend without failing pruning of later trees.
   */
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
    if (!(await this.eligible(task))) {
      return false;
    }
    // Store the delivery's final usage before the files disappear (#262): a
    // failed capture retains the tree for retry instead of losing grade data.
    if (this.captureUsage && !(await this.captureUsage(task.pr))) {
      return false;
    }
    if (this.closeSession) {
      await this.closeSession(task.pr);
      // Closure can take time: recheck every guard before removing files.
      if (!(await this.eligible(task))) {
        return false;
      }
    }
    if (!this.cloned) {
      return true;
    }
    const path = await this.worker.find(task.branch);
    // An absent tree may be a retry after removal but before prune/branch deletion.
    const localHead = (
      await this.git().run("for-each-ref", "--format=%(objectname)", `refs/heads/${task.branch}`)
    ).trim();
    if (!path && !localHead) {
      return true;
    }
    if (path) {
      await this.worker.remove(path);
      this.deps.report(`${path}: removed`);
    }
    await this.git().run("worktree", "prune");
    const head = (
      await this.git().run("for-each-ref", "--format=%(objectname)", `refs/heads/${task.branch}`)
    ).trim();
    if (head) {
      // Recheck the branch immediately before deletion (including crash recovery).
      if (await this.uncontained(head, task)) {
        this.deps.report(`${task.branch}: local branch retained: unpushed work`);
        return false;
      }
      // Compare-and-delete: a commit racing this safety check must retain its ref.
      await this.git().run("update-ref", "-d", `refs/heads/${task.branch}`, head);
    }
    return true;
  }

  /** Apply the same non-destructive safety guard before session closure. */
  async eligible(task: WorktreeTask): Promise<boolean> {
    validateBranch(task.branch);
    const path = this.cloned ? await this.worker.find(task.branch) : undefined;
    const reason = await this.reason(path, task);
    if (reason) {
      this.deps.report(`${path ?? task.branch}: skipped: ${reason}`);
      return false;
    }
    return true;
  }

  private git(path = this.worker.checkout): GitTransport {
    return new GitTransport(this.config, this.env, this.deps, path);
  }

  private async reason(path: string | undefined, task: WorktreeTask): Promise<string | undefined> {
    if (path !== undefined && !this.safePath(path, task.branch)) {
      return "not a task worktree of the worker checkout";
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
      if (path !== undefined && existsSync(path)) {
        const git = this.git(path);
        const common = (await git.run("rev-parse", "--git-common-dir")).trim();
        const own = (await this.git().run("rev-parse", "--git-common-dir")).trim();
        if (
          realpathSync(resolve(path, common)) !== realpathSync(resolve(this.worker.checkout, own))
        ) {
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
      }
      const head = this.cloned
        ? (
            await this.git().run(
              "for-each-ref",
              "--format=%(objectname)",
              `refs/heads/${task.branch}`
            )
          ).trim()
        : "";
      if (head && (await this.checkedOut(task.branch)).length > (path === undefined ? 0 : 1)) {
        return "branch belongs to another worktree";
      }
      if (head) {
        // #293: GitHub may hold merged-head commits the worker clone never fetched
        // (refresh-checks, an outside conflict fix or an owner push); fetch before
        // containment so cleanup needs no manual fetch into the worker checkout.
        const missing = await this.fetchMissing(task);
        if (missing) {
          return missing;
        }
        if (await this.uncontained(head, task)) {
          return "unpushed work (branch head not contained in PR head or base)";
        }
      }
    } catch {
      return "safety check failed (session, git state or commit objects unavailable); retry after inspection";
    }
    return undefined;
  }

  /** Every worktree of the worker checkout, the checkout itself included, on this branch. */
  private async checkedOut(branch: string): Promise<string[]> {
    const output = await this.git().run("worktree", "list", "--porcelain", "-z");
    return output.split("\0\0").flatMap((record) => {
      const fields = record.split("\0");
      const path = fields.find((field) => field.startsWith("worktree "))?.slice(9);
      return path && fields.includes(`branch refs/heads/${branch}`) ? [path] : [];
    });
  }

  /** A task tree is named for its branch and is neither checkout nor a symlink alias. */
  private safePath(path: string, branch: string): boolean {
    const target = resolve(path);
    if (basename(target) !== workerWorktreeName(this.config, branch)) {
      return false;
    }
    const protectedPaths = [this.worker.checkout, resolve(this.root)];
    if (protectedPaths.includes(target)) {
      return false;
    }
    if (existsSync(target)) {
      const real = realpathSync(target);
      return (
        real === target &&
        protectedPaths.every((checkout) => !existsSync(checkout) || realpathSync(checkout) !== real)
      );
    }
    return true;
  }

  private async size(path: string): Promise<number | undefined> {
    try {
      // Measurement has its own two-minute budget, independent of the CLI verb's default.
      const output = await this.deps.exec("du", ["-sk", "--", path], {
        cwd: this.worker.checkout,
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

  /** Fetch, once, the merged head and base objects the worker clone has not seen (#293):
   * the merged branch is deleted on GitHub and its squash head exists only behind
   * refs/pull/<n>/head, which no worker checkout ref ever brought in. Already-present
   * objects need no fetch; a failed fetch refuses with its own reason.
   */
  private async fetchMissing(task: WorktreeTask): Promise<string | undefined> {
    const wants: [string, string][] = [];
    if (!(await this.hasCommit(task.head))) {
      wants.push([`merged PR head ${task.head}`, `refs/pull/${task.pr}/head`]);
    }
    if (!(await this.baseRefs(task)).length) {
      wants.push([
        `base branch ${task.base}`,
        `+refs/heads/${task.base}:refs/remotes/origin/${task.base}`,
      ]);
    }
    if (!wants.length) {
      return undefined;
    }
    if (
      !(await this.git().transferOk(
        "fetch",
        wants.map(([, ref]) => ref)
      ))
    ) {
      // The head want first: with both missing it names the merged head.
      return `cannot fetch ${wants[0][0]}: fetch failed`;
    }
    return undefined;
  }

  /** Whether the checkout's object store resolves the commit; a malformed head is
   * never fetchable and stays refused by the containment check's own validation.
   */
  private async hasCommit(sha: string): Promise<boolean> {
    if (!/^[a-f\d]{40}$/i.test(sha)) {
      return false;
    }
    try {
      await this.git().run("rev-parse", "--verify", "--quiet", `${sha}^{commit}`);
      return true;
    } catch {
      return false;
    }
  }

  /** Local and origin refs of the task base; the containment check accepts either. */
  private async baseRefs(task: WorktreeTask): Promise<string[]> {
    validateBranch(task.base);
    return (
      await this.git().run(
        "for-each-ref",
        "--format=%(refname)",
        `refs/heads/${task.base}`,
        `refs/remotes/origin/${task.base}`
      )
    )
      .split("\n")
      .filter(Boolean);
  }

  /** The worker checkout's local base lags; its origin ref is refreshed by every launch. */
  private async uncontained(head: string, task: WorktreeTask): Promise<boolean> {
    if (!/^[a-f\d]{40}$/i.test(head) || !/^[a-f\d]{40}$/i.test(task.head)) {
      throw new Error("Invalid cleanup commit");
    }
    const bases = await this.baseRefs(task);
    if (!bases.length) {
      throw new Error("Base branch unavailable in the worker checkout");
    }
    return Boolean(
      (
        await this.git().run(
          "rev-list",
          "-1",
          head,
          "--not",
          ...(task.state === "MERGED" ? [task.head] : []),
          ...bases,
          "--"
        )
      ).trim()
    );
  }
}
