import { GitTransport, pushFailureMessage, taskBranch, validateBranch } from "../git.js";
import { realpathSync } from "node:fs";
import { matchesGlob, resolve } from "node:path";
import type { Handler } from "./types.js";

export const push: Handler<"push"> = async function (
  { worktree, branch, commit: selected, task: target },
  ctx
) {
  if (target !== undefined && selected !== undefined) {
    throw new Error("An explicit task push must use the worktree HEAD");
  }
  if (
    target !== undefined &&
    (ctx.role !== "orchestrator" || !Number.isSafeInteger(target) || target < 1)
  ) {
    throw new Error("Only orchestrators may push an explicit task PR (positive integer required)");
  }
  if (selected !== undefined && (ctx.role !== "orchestrator" || !/^[a-f\d]{40}$/i.test(selected))) {
    throw new Error("Only orchestrators may push a frozen commit");
  }
  if (branch !== undefined) {
    taskBranch(branch, this.config);
  }
  const taskPr = target ?? ctx.taskPr;
  if (!Number.isSafeInteger(taskPr) || Number(taskPr) < 1) {
    throw new Error("Push requires its own taskPr");
  }
  const task = await this.checkedTask(String(taskPr), target !== undefined);
  if (target !== undefined) {
    branch ??= task.branch;
    if (branch !== task.branch) {
      throw new Error("Push branch must match its task PR branch");
    }
  }
  if (branch === undefined) {
    throw new Error("Push requires a branch");
  }
  if (selected && task.branch !== branch) {
    throw new Error("Frozen push must match its task PR branch");
  }
  if (ctx.role === "worker") {
    if (task.branch !== branch) {
      throw new Error("Worker may push only its own task branch");
    }
  }
  if (target === undefined && realpathSync(worktree) !== realpathSync(this.root)) {
    throw new Error("Push worktree must be the gateway checkout");
  }
  const git = new GitTransport(this.config, this.env, this.deps, resolve(worktree));
  const commit = (
    await git.run(
      "rev-parse",
      "--verify",
      selected
        ? `${selected}^{commit}`
        : target !== undefined
          ? "HEAD^{commit}"
          : `refs/heads/${branch}^{commit}`
    )
  ).trim();
  if (!/^[a-f\d]{40}$/i.test(commit)) {
    throw new Error("Invalid local commit");
  }
  if (target !== undefined) {
    const head = String(task.item.headRefOid ?? "");
    if (!/^[a-f\d]{40}$/i.test(head)) {
      throw new Error("Invalid task PR head");
    }
    const fetched = await git.transfer("fetch", [
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
    if (!fetched.ok) {
      throw new Error(pushFailureMessage(fetched, this.config.repo));
    }
    const remote = (
      await git.run("rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`)
    ).trim();
    if (
      remote !== head ||
      (await git.run("rev-list", "--count", `${commit}..${head}`)).trim() !== "0"
    ) {
      throw new Error(
        pushFailureMessage({ ok: false, outcome: "moved", detail: "" }, this.config.repo)
      );
    }
  }
  const base = task.base;
  // Validate config refs before allowing them into fetch refspecs.
  validateBranch(base);
  if (!(await git.transferOk("fetch", [`+refs/heads/${base}:refs/remotes/origin/${base}`]))) {
    throw new Error("error: fetch failed");
  }
  const count = (
    await git.run("rev-list", "--count", `refs/remotes/origin/${base}..${commit}`)
  ).trim();
  if (!/^\d+$/.test(count) || Number(count) === 0) {
    throw new Error(`error: ${branch} has no commits on top of origin/${base}`);
  }
  const files = await git.run(
    "diff",
    "--name-only",
    "--diff-filter=ACMR",
    "-z",
    `refs/remotes/origin/${base}...${commit}`
  );
  const configured = this.config.push?.denyPatterns;
  const patterns = configured ?? [
    ".tmp/",
    "dist/",
    "coverage/",
    "*.log",
    "test-results/",
    "playwright-report/",
    "test-reports/",
  ];
  const changelog = (this.config.changelog?.directory ?? "changes/unreleased").replace(/\/$/, "");
  const denied = files.split("\0").filter(
    (file) =>
      file &&
      (configured !== undefined ||
        !(
          /(^|\/)(?:fixtures|__fixtures__|snapshots|__snapshots__)(\/|$)/.test(file) ||
          /(^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(
            file
          ) ||
          file.startsWith(`${changelog}/`)
        )) &&
      patterns.some((pattern) => {
        const glob = pattern.endsWith("/") ? `${pattern}**` : pattern;
        return matchesGlob(file, glob) || matchesGlob(file, `**/${glob}`);
      })
  );
  if (denied.length) {
    throw new Error(`error: refusing to push generated artefacts:\n${denied.join("\n")}`);
  }
  const result = await git.transfer("push", [`${commit}:refs/heads/${branch}`]);
  if (!result.ok) {
    throw new Error(pushFailureMessage(result, this.config.repo));
  }
  if (ctx.role === "orchestrator") {
    this.github.writes.recordPush(this.config.repo, Number(taskPr), commit);
  }
  await git.run("update-ref", `refs/remotes/origin/${branch}`, commit);
  return `pushed ${branch} at ${commit.slice(0, 7)}`;
};
