import { heading as protocolHeading } from "../core/protocol.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { dirname, join, matchesGlob, resolve } from "node:path";
import { homedir } from "node:os";
import { loadYaml } from "../config.js";
import { object, type ObjectData } from "../gateway/people.js";
import { checkMarkdown, guardClosingKeywords } from "../gateway/markdown.js";
import { cleanBaseMerges } from "../evidence/clean-base.js";
import { liveBaseHead } from "../gateway/base-head.js";
import { approvalCarryFiles } from "../evidence/carry-approval.js";
import { taskIssues, taskIssueNumbers, trailingTaskMarker } from "./markers.js";
import { runVerifyHook } from "../gateway/verify-hook.js";
import { WorktreeService } from "../gateway/worktrees.js";
import { TaskCommon, sha, conformingTitle } from "./common.js";

interface Journal {
  head: string;
  base: string;
  branch: string;
  issues: number[];
  done: string[];
  checkout?: { old: string; target: string; trigger: string };
  install?: boolean;
}
/** Merge gates, resumable follow-up journal and abandoned-delivery closure. */
export class TaskMerge extends TaskCommon {
  /** Merge a stopped/session-less task against the live base; delegated carries also require cleanBaseMerges proof. */
  async merge(
    ref: string,
    mergeCommit = false,
    carryApproval?: string,
    expectedHead?: string
  ): Promise<string> {
    return this.mergeDelivery(ref, mergeCommit, carryApproval, expectedHead, false);
  }

  /** Merge a non-task PR using current owner/delegated approval; recovery only repeats follow-up. */
  async mergePr(ref: string): Promise<string> {
    return this.mergeDelivery(ref, false, undefined, undefined, true);
  }

  /** Close an unmerged task PR without merging (#288): the delivery is abandoned.
   * The watcher moves the closed PR card to Done and reports the worktree cleanup
   * candidate; a linked issue stays open for the LAUNCH decision. Refused before
   * any write unless the PR is in the configured repository, open and a task PR. */
  async close(ref: string, comment?: string): Promise<string> {
    const item = await this.pr(ref);
    if (item.state !== "OPEN") {
      throw new Error("PR is not open");
    }
    // The watcher's task-PR test: a task header or a valid structured relation.
    if (taskIssueNumbers(String(item.body)) === undefined) {
      throw new Error("Closing requires a task PR (task header or vmethod-task relation)");
    }
    const body = comment === undefined ? undefined : readFileSync(comment, "utf8");
    if (body !== undefined) {
      // Checked like `issue close`, before any effect.
      await checkMarkdown(this.root, body);
      guardClosingKeywords(body);
    }
    // Stop the recorded worker exactly like merge follow-up. #275: with no worker
    // record the PR never had a worker; the stop is skipped silently. A failed
    // or unavailable stop never blocks the close; the watcher reports the worker.
    if (!(await this.workerAbsent(ref))) {
      try {
        if (!this.deps.workers?.stop) {
          this.deps.report(`#${ref} worker stop unavailable (session unknown); continuing`);
        } else {
          const outcome = await this.deps.workers.stop(this.number(ref));
          this.deps.report(`#${ref} worker stop: ${outcome ?? "requested"}`);
          this.deps.report(`#${ref} worker status after stop: ${await this.status(ref)}`);
        }
      } catch {
        this.deps.report(`#${ref} worker stop failed; continuing`);
      }
    }
    if (body !== undefined) {
      await this.post(ref, body);
    }
    const closed = object(
      await this.host.github.rest(this.path(ref, "pulls"), "PATCH", { state: "closed" }, false)
    );
    if (closed.state !== "closed") {
      throw new Error("PR closure not confirmed");
    }
    return `Closed #${ref}\nReminder: run grade ${ref}`;
  }

  private async mergeDelivery(
    ref: string,
    mergeCommit: boolean,
    carryApproval: string | undefined,
    expectedHead: string | undefined,
    nonTask: boolean
  ): Promise<string> {
    if (typeof mergeCommit !== "boolean") {
      throw new Error("Invalid merge-commit flag");
    }
    if (
      carryApproval !== undefined &&
      (typeof carryApproval !== "string" || !carryApproval.trim() || /[\r\n]/.test(carryApproval))
    ) {
      throw new Error("Approval carry requires a nonempty single-line reason");
    }
    const item = await this.pr(ref);
    if (nonTask) {
      this.nonTaskBranch(String(item.headRefName));
      if (
        taskIssueNumbers(String(item.body)) !== undefined ||
        item.baseRefName !== this.config.baseBranch
      ) {
        throw new Error("pr merge requires a non-task PR against baseBranch");
      }
    }
    if (expectedHead !== undefined && item.headRefOid !== expectedHead) {
      throw new Error("Head moved after conflict certification; approval not carried");
    }
    if (!["OPEN", "MERGED"].includes(String(item.state))) {
      throw new Error("PR is closed without merging");
    }
    if (item.state === "OPEN" && (await this.status(ref, true)) !== "stopped") {
      throw new Error("Stop the worker before merging (live or unknown session)");
    }
    const head = sha(item.headRefOid),
      base = String(item.baseRefName),
      branch = String(item.headRefName);
    const pack = branch.startsWith(String(object(this.config.branches).packPrefix ?? "pack/"));
    if (pack && !mergeCommit && item.state === "OPEN") {
      throw new Error("Pack branches require --merge-commit");
    }
    if (!conformingTitle(String(item.title))) {
      if (item.state === "OPEN") {
        throw new Error("Squash subject must be <type>: <subject> without scope");
      }
      this.deps.report(
        "warning: already-merged PR has a non-conforming subject; continuing follow-up"
      );
    }
    const git = this.git();
    if (item.state === "OPEN") {
      if (
        object(this.config.board).enabled !== false &&
        (await this.boardCard(item))?.values.Status !== "Approved"
      ) {
        throw new Error("merge-task requires an Approved PR");
      }
      for (const number of taskIssueNumbers(String(item.body)) ?? []) {
        const issue = await this.host.thread(String(number), "issue");
        const exception = trailingTaskMarker(String(item.body))?.scopeException;
        if (
          !(typeof exception === "string" && exception.trim()) &&
          (await this.host.issueApproved(issue)) !== true
        ) {
          throw new Error(await this.host.scopeRefusal(issue));
        }
      }
      const baseSha = sha(item.baseRefOid);
      if (
        !(await git.transferOk("fetch", [
          `+refs/heads/${base}:refs/remotes/origin/${base}`,
          `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
        ]))
      ) {
        throw new Error("Fetch failed");
      }
      const liveBase = await liveBaseHead(base, { git });
      let certification: string | undefined;
      let autopilot = false;
      let autopilotHead = head;
      if (carryApproval !== undefined) {
        for (const approved of nonTask ? [] : await this.host.candidates(ref)) {
          const owner = (await this.host.approved(ref, approved)) === true;
          const delegated = !owner && (await this.host.autopilotApproved?.(ref, approved)) === true;
          if (!owner && !delegated) {
            continue;
          }
          if (
            delegated &&
            !(await cleanBaseMerges((...args) => git.run(...args), approved, head, baseSha))
          ) {
            continue;
          }
          const files = await approvalCarryFiles(
            (...args) => git.run(...args),
            approved,
            head,
            baseSha
          );
          if (files === null) {
            continue;
          }
          const escalate = object(this.config.conflicts).escalatePaths;
          if (
            Array.isArray(escalate) &&
            files.some((file) => escalate.some((pattern) => matchesGlob(file, String(pattern))))
          ) {
            throw new Error(
              "Owner approval cannot be carried across an escalated conflict path; re-ask the owner"
            );
          }
          autopilot = delegated;
          autopilotHead = approved;
          certification = `${protocolHeading("APPROVAL CARRIED")}${delegated ? " (autopilot)" : ""} from ${approved} to ${head}: ${carryApproval}\n\nI certify there is no behaviour change or algorithmic revamp.\n\nRemerge-diff files:\n${files.length ? files.map((file) => `- ${JSON.stringify(file)}`).join("\n") : "- (none)"}`;
          break;
        }
        if (!certification) {
          throw new Error(
            "Owner approval cannot be carried: an earlier approval and only base-merge commits are required; re-ask the owner"
          );
        }
      } else if ((await this.host.approved(ref)) !== true) {
        autopilot = (await this.host.autopilotApproved?.(ref, head)) === true;
        let survived = autopilot;
        for (const approved of nonTask ? [] : await this.host.candidates(ref)) {
          if (survived) {
            break;
          }
          const owner = (await this.host.approved(ref, approved)) === true;
          const delegated = !owner && (await this.host.autopilotApproved?.(ref, approved)) === true;
          if (
            (owner || delegated) &&
            (await cleanBaseMerges((...args) => git.run(...args), approved, head, baseSha))
          ) {
            survived = true;
            autopilot = delegated;
            autopilotHead = approved;
            break;
          }
        }
        if (!survived) {
          throw new Error(await this.host.approvalRefusal(ref));
        }
      }
      if (autopilot) {
        const files = (await git.run("diff", "--name-only", `${liveBase}...${head}`))
          .trim()
          .split("\n");
        if (
          base === String(this.config.releaseBranch) ||
          files.some((file) =>
            /(?:^|\/)people\.ya?ml$|(?:^|\/)CODEOWNERS$|^(?:\.claude\/|\.opencode\/|opencode\.jsonc?$|vmethod\.yaml$)/.test(
              file
            )
          )
        ) {
          throw new Error(
            "Autopilot cannot authorize releases, identity or permission changes; ask the owner"
          );
        }
      }
      await this.green(ref, head);
      if (item.mergeable !== "MERGEABLE") {
        throw new Error("PR is conflicting or mergeability is unknown");
      }
      if (object(this.config.merge).requireCurrentBase !== false) {
        try {
          await git.run("merge-base", "--is-ancestor", liveBase, head);
        } catch {
          throw new Error(`CI tested an older base; run refresh-checks ${ref}`);
        }
      } else {
        await this.verifyMerge(ref, liveBase, head);
      }
      const current = await this.pr(ref);
      if (nonTask) {
        this.nonTaskBranch(String(current.headRefName));
        if (taskIssueNumbers(String(current.body)) !== undefined) {
          throw new Error("PR became a task during merge checks; use merge-task");
        }
      }
      // Hook execution can take minutes: re-fetch rather than trusting the PR's
      // potentially stale baseRefOid to detect base movement during verification.
      if (!(await git.transferOk("fetch", [`+refs/heads/${base}:refs/remotes/origin/${base}`]))) {
        throw new Error("Fetch failed");
      }
      if (
        current.headRefOid !== head ||
        current.baseRefOid !== baseSha ||
        current.baseRefName !== base ||
        (await liveBaseHead(base, { git })) !== liveBase
      ) {
        throw new Error("Head or base moved during merge checks");
      }
      if ((await this.status(ref, true)) !== "stopped") {
        throw new Error("Worker restarted before merge");
      }
      if (nonTask && !autopilot && (await this.host.approved(ref)) !== true) {
        throw new Error(await this.host.approvalRefusal(ref));
      }
      if (item.isDraft) {
        await this.ready(item, false);
      }
      if (autopilot) {
        if (!(await this.host.autopilotApproved?.(ref, autopilotHead))) {
          throw new Error(
            autopilotHead === head
              ? "Autopilot revoked during merge checks; ask the owner at the current step"
              : "autopilot delegation is no longer current; ask the owner"
          );
        }
      }
      if (certification) {
        await this.post(ref, certification);
      }
      if (autopilot) {
        await this.post(
          ref,
          `${protocolHeading("AUTOPILOT")}\n\nMerging ${head} under autopilot, after my delivery review and the normal merge checks.`
        );
      }
      const merged = object(
        await this.host.github.rest(
          this.path(ref, "pulls") + "/merge",
          "PUT",
          {
            sha: head,
            merge_method: mergeCommit ? "merge" : "squash",
            commit_title: `${String(item.title)} (#${ref})`,
          },
          false
        )
      );
      if (merged.merged !== true) {
        throw new Error("Merge was refused; re-run to reconcile state");
      }
    }
    // The merge guard above protects an action, not recovery after a button/API merge.
    // Stop first, then inspect the remote branch before any destructive cleanup.
    // #275: with no worker record the PR never had a worker; the worker is absent,
    // not unknown, and the stop is skipped silently.
    if (!nonTask && !(await this.workerAbsent(ref))) {
      try {
        if (!this.deps.workers?.stop) {
          this.deps.report(
            `#${ref} worker stop unavailable (session unknown); continuing follow-up`
          );
        } else {
          const outcome = await this.deps.workers.stop(this.number(ref));
          this.deps.report(`#${ref} worker stop: ${outcome ?? "requested"}`);
          this.deps.report(`#${ref} worker status after stop: ${await this.status(ref)}`);
        }
      } catch {
        this.deps.report(`#${ref} worker stop failed; continuing follow-up`);
      }
    }
    const branchHead = async () => {
      const data = await this.host.github.rest(
        `/repos/${this.repo}/git/matching-refs/heads/${encodeURIComponent(branch)}`
      );
      if (!Array.isArray(data)) {
        throw new Error("Missing branch refs");
      }
      const ref = data.map(object).find((value) => value.ref === `refs/heads/${branch}`);
      return ref ? sha(object(ref.object).sha) : undefined;
    };
    const preserveBranch = async () => {
      const current = await branchHead();
      if (!current || current === head) {
        return { exists: Boolean(current), preserve: false };
      }
      const commits: string[] = [];
      for (let page = 1; ; page++) {
        const comparison = object(
          await this.host.github.rest(
            `/repos/${this.repo}/compare/${head}...${current}?per_page=100&page=${page}`
          )
        );
        if (!Array.isArray(comparison.commits)) {
          throw new Error("Missing post-merge commit comparison; branch retained");
        }
        commits.push(...comparison.commits.map((commit) => sha(object(commit).sha)));
        if (comparison.commits.length < 100) {
          break;
        }
      }
      // Even divergent/force-pushed history must never be deleted.
      this.deps.report(
        `post-merge commits on ${branch}: ${[...new Set([...commits, current])].join(" ")}`
      );
      return { exists: true, preserve: true };
    };
    let keepBranch = nonTask ? false : (await preserveBranch()).preserve;
    const file = this.stateFile(ref);
    const journal: Journal = existsSync(file)
      ? (JSON.parse(readFileSync(file, "utf8")) as Journal)
      : { head, base, branch, issues: nonTask ? [] : this.issues(item), done: [] };
    if (journal.head !== head || journal.base !== base || journal.branch !== branch) {
      throw new Error("Merge journal does not match PR");
    }
    // Older completed journals may have missed the issue entirely. Reconcile newly
    // discoverable relations without replaying already-checkpointed issue writes.
    if (!nonTask && existsSync(file)) {
      const issues = this.issues(item);
      if (JSON.stringify(journal.issues) !== JSON.stringify(issues)) {
        journal.issues = issues;
        journal.done = journal.done.filter((name) => name !== "estimates");
      }
    }
    this.save(file, journal);
    // One operation for the merge follow-up's issue and PR card writes (#199): the
    // watcher stays quiet while closures, board moves and turn clears land.
    this.host.github.writes.beginOperation(nonTask ? "pr-merge" : "merge-task", [
      { repo: this.repo, number: this.number(ref) },
      ...journal.issues.map((number) => ({ repo: this.repo, number })),
    ]);
    const step = async (name: string, action: () => Promise<void | boolean>) => {
      if (!journal.done.includes(name)) {
        if ((await action()) === false) {
          return;
        }
        journal.done.push(name);
        this.save(file, journal);
      }
    };
    if (base === this.mainBase) {
      for (const number of journal.issues) {
        await step(`issue-${number}`, async () => {
          const issue = await this.host.thread(String(number), "issue");
          if (issue.state === "OPEN") {
            await this.host.github.rest(this.path(String(number)), "PATCH", {
              state: "closed",
              state_reason: "completed",
            });
          }
          await this.card(issue, "Done", null);
          await this.turn(String(number), null);
        });
      }
      await step("estimates", async () => {
        const revise = new Set<number>();
        for (const number of journal.issues) {
          for (let page = 1; ; page++) {
            const data = await this.host.github.rest(
              `${this.path(String(number))}/dependencies/blocking?per_page=100&page=${page}`
            );
            if (!Array.isArray(data)) {
              throw new Error("Missing blocking issues");
            }
            for (const value of data) {
              const issue = object(value);
              if (
                issue.state === "open" &&
                issue.repository_url === `https://api.github.com/repos/${this.repo}` &&
                Number.isSafeInteger(issue.number)
              ) {
                revise.add(Number(issue.number));
              }
            }
            if (data.length < 100) {
              break;
            }
          }
        }
        if (revise.size) {
          this.deps.report(
            `revise estimates: ${[...revise]
              .sort((a, b) => a - b)
              .map((n) => `#${n}`)
              .join(" ")}`
          );
        }
      });
    }
    await step("pr-card", async () => {
      await this.card(item, "Done", null);
      await this.turn(ref, null);
    });
    await step("done-cap", async () => {
      if (object(this.config.board).enabled !== false) {
        await this.host.board().capDone();
      }
    });
    if (!pack && !nonTask) {
      await step("branch", async () => {
        // Recheck immediately before delete too: a late push must be preserved.
        const latest = await preserveBranch();
        keepBranch = latest.preserve || keepBranch;
        if (!keepBranch && latest.exists) {
          await this.host.github.rest(
            `/repos/${this.repo}/git/refs/heads/${encodeURIComponent(branch)}`,
            "DELETE"
          );
        }
      });
    }
    if (base === this.mainBase) {
      await step("checkout", async () => {
        const main = resolve(String(object(this.config.branches).mainCheckout ?? this.root));
        const local = this.git(main);
        if (
          (await local.run("rev-parse", "--abbrev-ref", "HEAD")).trim() !== base ||
          (await local.run("status", "--porcelain", "--untracked-files=no")).trim()
        ) {
          throw new Error(
            "Main checkout must be clean and on baseBranch; retry follow-up after fixing it"
          );
        }
        if (!journal.checkout) {
          if (
            !(await local.transferOk("fetch", [`+refs/heads/${base}:refs/remotes/origin/${base}`]))
          ) {
            throw new Error("Fetch failed");
          }
          journal.checkout = {
            old: sha((await local.run("rev-parse", "HEAD")).trim()),
            target: sha((await local.run("rev-parse", `refs/remotes/origin/${base}`)).trim()),
            trigger: String(object(this.config.postMerge).trigger ?? "package-lock.json"),
          };
          this.save(file, journal);
        }
        await local.run("merge", "--ff-only", journal.checkout.target);
        const changed = await local.run(
          "diff",
          "--name-only",
          journal.checkout.old,
          journal.checkout.target,
          "--",
          journal.checkout.trigger
        );
        journal.install = Boolean(changed.trim());
      });
    }
    if (!pack && !nonTask) {
      const worktrees = new WorktreeService(
        this.root,
        this.config,
        this.env,
        this.deps,
        // Merge recovery: an absent worker record is stopped, not unknown (#275).
        (pr) => this.status(String(pr), true),
        undefined,
        this.deps.workers?.captureUsage
      );
      const task = { pr: this.number(ref), branch, base, head, state: "MERGED" };
      await step("session", async () => {
        if (!(await worktrees.eligible(task))) {
          return false;
        }
        if (await this.workerAbsent(ref)) {
          // #275: a PR that never had a worker has no session to close or hide.
          return true;
        }
        if (!this.deps.workers?.close) {
          this.deps.report(`#${ref} session not closed: backend unavailable`);
          return false;
        }
        try {
          return await this.deps.workers.close(this.number(ref));
        } catch (error) {
          this.deps.report(`#${ref} session not closed: ${(error as Error).message}`);
          return false;
        }
      });
      await step("worktree", async () => worktrees.cleanup(task));
    }
    // All state/board/reporting is complete before the package may replace itself.
    await step("follow-up", async () => {
      this.deps.report(`#${ref} merged; follow-up complete`);
    });
    const output = `Merged #${ref}`;
    if (journal.install) {
      const install = String(object(this.config.postMerge).install ?? "npm ci");
      const installEnv: NodeJS.ProcessEnv = { HUSKY: "0" };
      for (const key of ["PATH", "HOME", "TMPDIR", "SYSTEMROOT"]) {
        if (this.env[key]) {
          installEnv[key] = this.env[key];
        }
      }
      // Intentionally nothing follows this await: old-version code never loads new code.
      await this.deps.exec("sh", ["-c", install], {
        cwd: resolve(String(object(this.config.branches).mainCheckout ?? this.root)),
        env: installEnv,
      });
    }
    return output;
  }

  private async green(ref: string, head: string): Promise<void> {
    const accepted: ObjectData[] = [];
    for (let page = 1; ; page++) {
      const data = object(
        await this.host.github.rest(
          `/repos/${this.repo}/commits/${head}/check-runs?per_page=100&page=${page}`
        )
      );
      if (!Array.isArray(data.check_runs)) {
        throw new Error("Missing CI checks");
      }
      for (const value of data.check_runs) {
        const run = object(value);
        if (
          this.host.people.some(
            (p) =>
              p.role === "system" &&
              p.events?.includes("check_run") &&
              p.appIds?.includes(Number(object(run.app).id))
          )
        ) {
          accepted.push(run);
        }
      }
      if (data.check_runs.length < 100) {
        break;
      }
    }
    const latest = new Map<string, ObjectData>();
    for (const run of accepted) {
      const key = `${String(object(run.app).id)}:${String(run.name)}`;
      if (!latest.has(key) || Number(run.id) > Number(latest.get(key)!.id)) {
        latest.set(key, run);
      }
    }
    const runs = [...latest.values()];
    const required = object(this.config.checks).ci;
    if (
      !runs.length ||
      runs.some(
        (run) =>
          run.head_sha !== head ||
          run.status !== "completed" ||
          !["success", "neutral", "skipped"].includes(String(run.conclusion))
      ) ||
      (Array.isArray(required) &&
        required.some(
          (name) => !runs.some((run) => run.name === name && run.conclusion === "success")
        ))
    ) {
      throw new Error(`CI is not green on current head of #${ref}`);
    }
  }

  /** The issue relation merge follow-up completes; the report names the fallback. */
  private issues(item: ObjectData): number[] {
    return taskIssues(item, this.repo, (line) => this.deps.report(line));
  }

  private get mainBase(): string {
    return String(object(loadYaml(this.root, "vmethod")).baseBranch);
  }

  private save(file: string, journal: Journal): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(journal), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  private stateFile(ref: string): string {
    const name = String(this.config.stateName ?? this.repo.replace("/", "-"));
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || [".", ".."].includes(name)) {
      throw new Error("Invalid stateName");
    }
    return join(
      this.env.XDG_STATE_HOME ?? join(this.env.HOME ?? homedir(), ".local/state"),
      "vmethod",
      name,
      `merge-${this.number(ref)}.json`
    );
  }

  private async verifyMerge(ref: string, base: string, head: string): Promise<void> {
    const parent = join(this.root, ".tmp");
    mkdirSync(parent, { recursive: true });
    const temporary = mkdtempSync(join(parent, "merge-verify-"));
    const worktree = join(temporary, "worktree");
    const git = this.git();
    let added = false;
    try {
      await git.run("worktree", "add", "--detach", worktree, base);
      added = true;
      try {
        await this.git(worktree).run(
          "-c",
          "user.name=orchestrator",
          "-c",
          "user.email=orchestrator@localhost",
          "merge",
          "-q",
          "--no-edit",
          head
        );
      } catch {
        throw new Error(`PR #${ref} does not merge cleanly onto the live base`);
      }
      if (!existsSync(join(worktree, "scripts/vmethod-hooks/verify"))) {
        throw new Error(
          `requireCurrentBase is false but no verify hook is configured; run refresh-checks ${ref}`
        );
      }
      const result = await runVerifyHook(worktree, this.config, this.env, this.deps, [
        "--scope",
        "merge",
      ]);
      if (result.code) {
        throw new Error(
          `Merge verification failed: scripts/vmethod-hooks/verify\n${result.text}\nlogs: ${result.logs}`
        );
      }
      this.deps.report(`Merge verification passed\n${result.text}\nlogs: ${result.logs}`);
    } finally {
      if (added) {
        await git.run("worktree", "remove", "--force", worktree);
      }
      rmdirSync(temporary);
    }
  }

  /** #275: true only when the backend positively reports no worker session record. A failed
   * probe keeps the recorded, cautious path: an unfalsifiable worker is never treated as absent. */
  private async workerAbsent(ref: string): Promise<boolean> {
    try {
      return (await this.deps.workers?.recorded?.(this.number(ref))) === false;
    } catch {
      return false;
    }
  }
}
