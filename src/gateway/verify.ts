import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { Config } from "../config.js";
import type { Dependencies } from "./client.js";
import { ChecksService } from "./checks.js";
import { GitTransport } from "./git.js";
import { runVerifyHook } from "./verify-hook.js";
import type { Operations, Verdict } from "./transport.js";
import { liveBaseHead } from "./base-head.js";

/** Orchestrator integration work; project recipes receive no gateway credentials. */
export class VerificationService {
  constructor(
    private root: string,
    private env: NodeJS.ProcessEnv,
    private config: Config,
    private deps: Dependencies,
    private checks: ChecksService,
    private push: (input: Operations["push"]["input"], pr: number) => Promise<string>
  ) {}

  async verify(input: Operations["verify"]["input"]): Promise<Verdict> {
    const branches = this.config.branches as
      { mainCheckout?: string; worktreeRoot?: string } | undefined;
    const parent = resolve(
      branches?.mainCheckout ?? this.root,
      branches?.worktreeRoot ?? ".worktrees"
    );
    mkdirSync(parent, { recursive: true });
    const lock = join(parent, ".vmethod-review-lock");
    try {
      mkdirSync(lock);
    } catch {
      throw new Error("verify: review worktree is locked; another verify may be running");
    }
    try {
      return await this.runVerify(input);
    } finally {
      rmdirSync(lock);
    }
  }

  async refresh(ref: string): Promise<Verdict> {
    const snapshot = await this.checks.snapshot(ref);
    if (!snapshot.green || !snapshot.stale) {
      return {
        code: 0,
        text: snapshot.green
          ? "refresh-checks: base has not moved; no push"
          : "refresh-checks: no green run; wait for or fix CI first",
      };
    }
    const git = new GitTransport(this.config, this.env, this.deps, this.root);
    if (
      !(await git.transferOk("fetch", [
        `+refs/heads/${snapshot.base}:refs/remotes/origin/${snapshot.base}`,
        `+refs/heads/${snapshot.branch}:refs/remotes/origin/${snapshot.branch}`,
      ]))
    ) {
      throw new Error("refresh-checks: fetch failed");
    }
    const head = (await git.run("rev-parse", `refs/remotes/origin/${snapshot.branch}`)).trim();
    const base = await liveBaseHead(snapshot.base, { git });
    if (head !== snapshot.head || base !== snapshot.baseSha) {
      return { code: 2, text: "refresh-checks: head or base moved; run again" };
    }
    let tree: string;
    try {
      tree = (await git.run("merge-tree", "--write-tree", head, base)).trim();
    } catch {
      return {
        code: 3,
        text: `checks: CONFLICT with ${snapshot.base}: merge origin/${snapshot.base}, push, run again`,
      };
    }
    if (!/^[a-f\d]{40}$/i.test(tree)) {
      throw new Error("refresh-checks: invalid merge tree");
    }
    const commit = (
      await git.run(
        "-c",
        "user.name=orchestrator",
        "-c",
        "user.email=orchestrator@localhost",
        "commit-tree",
        tree,
        "-p",
        head,
        "-p",
        base,
        "-m",
        `merge: bring in origin/${snapshot.base} to retest against the current base`
      )
    ).trim();
    const result = await this.push(
      { worktree: this.root, branch: snapshot.branch, commit },
      snapshot.target.number
    );
    return { code: 0, text: `refresh-checks: ${result}; CI retriggered, wait for checks` };
  }

  private async runVerify(input: Operations["verify"]["input"]): Promise<Verdict> {
    if (
      !Array.isArray(input.refs) ||
      !input.refs.length ||
      input.refs.some((ref) => typeof ref !== "string") ||
      (input.bench !== undefined && typeof input.bench !== "boolean") ||
      (input.packages !== undefined &&
        (!Array.isArray(input.packages) ||
          !input.packages.length ||
          input.packages.some((name) => typeof name !== "string" || !name || /\s/.test(name))))
    ) {
      throw new Error("Invalid verify options");
    }
    const prs = await Promise.all(input.refs.map((ref) => this.checks.pull(ref)));
    const base = prs[0].base;
    if (prs.some((pr) => pr.base !== base || pr.baseSha !== prs[0].baseSha)) {
      throw new Error("verify requires PRs sharing the same base");
    }
    const branches = this.config.branches as
      { mainCheckout?: string; worktreeRoot?: string } | undefined;
    const parent = resolve(
      branches?.mainCheckout ?? this.root,
      branches?.worktreeRoot ?? ".worktrees"
    );
    const worktree = join(parent, "orchestrator-review");
    mkdirSync(parent, { recursive: true });
    const git = new GitTransport(this.config, this.env, this.deps, this.root);
    const refs = [
      `+refs/heads/${base}:refs/remotes/origin/${base}`,
      ...prs.map((pr) => `+refs/heads/${pr.branch}:refs/remotes/origin/${pr.branch}`),
    ];
    if (!(await git.transferOk("fetch", refs))) {
      throw new Error("verify: fetch failed");
    }
    const marker = join(parent, ".vmethod-review-owner");
    const common = (
      await git.run("rev-parse", "--path-format=absolute", "--git-common-dir")
    ).trim();
    if (!existsSync(worktree)) {
      await git.run("worktree", "add", "--detach", worktree, `refs/remotes/origin/${base}`);
      writeFileSync(marker, common);
    } else if (!existsSync(marker) || readFileSync(marker, "utf8") !== common) {
      throw new Error(
        "verify: existing review worktree is not owned by vmethod; move it aside first"
      );
    }
    const review = new GitTransport(this.config, this.env, this.deps, worktree);
    // Never reset/clean the main checkout, a symlink, an attached task branch or another repo.
    if (
      realpathSync(worktree) === realpathSync(this.root) ||
      realpathSync(worktree) === resolve(common, "..") ||
      realpathSync(worktree) !== resolve(realpathSync(parent), "orchestrator-review") ||
      (await review.run("rev-parse", "--path-format=absolute", "--git-common-dir")).trim() !==
        common ||
      realpathSync((await review.run("rev-parse", "--show-toplevel")).trim()) !==
        realpathSync(worktree) ||
      (await review.run("rev-parse", "--abbrev-ref", "HEAD")).trim() !== "HEAD"
    ) {
      throw new Error("verify: unsafe review worktree");
    }
    await review.run("reset", "-q", "--hard");
    await review.run("checkout", "-q", "--detach", `refs/remotes/origin/${base}`);
    if ((await review.run("rev-parse", "HEAD")).trim() !== prs[0].baseSha) {
      throw new Error("verify: base moved; run again");
    }
    await review.run("clean", "-qxfd");
    for (const pr of prs) {
      const fetched = (await review.run("rev-parse", `refs/remotes/origin/${pr.branch}`)).trim();
      if (fetched !== pr.head) {
        throw new Error("verify: PR head moved; run again");
      }
      try {
        await review.run(
          "-c",
          "user.name=orchestrator",
          "-c",
          "user.email=orchestrator@localhost",
          "merge",
          "-q",
          "--no-edit",
          pr.head
        );
      } catch {
        await review.run("merge", "--abort");
        return {
          code: 1,
          text: `verify: PR #${pr.target.number} does not merge cleanly onto ${base} (with the PRs before it)`,
        };
      }
    }
    await review.run("clean", "-qxfd");
    const hook = join(worktree, "scripts/vmethod-hooks/verify");
    if (!existsSync(hook)) {
      throw new Error("verify: missing scripts/vmethod-hooks/verify hook");
    }
    const args = [
      ...(input.packages ? ["--packages", input.packages.join(" ")] : []),
      ...(input.bench ? ["--bench"] : []),
    ];
    const result = await runVerifyHook(worktree, this.config, this.env, this.deps, args);
    const commit = (await review.run("rev-parse", "--short", "HEAD")).trim();
    return {
      code: result.code,
      text: `${result.text}\nverify: ${result.code ? "FAILED" : "ok"} (${commit} = ${base} + PR ${prs.map((pr) => pr.target.number).join(" ")}; logs: ${result.logs})`,
    };
  }
}
