import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import type { Config } from "../config.js";
import { GitHubHttpError, type Dependencies } from "./client.js";
import { stateRoot } from "./digest.js";
import { GitTransport } from "./git.js";
import { proveConflictMerge } from "./conflict-proof.js";
import type { CiSnapshot } from "./checks.js";
import type { Verdict } from "./transport.js";
import type { ConflictPrior } from "./task-flow-types.js";
import { cleanBaseMerges } from "./clean-base.js";
import { liveBaseHead } from "./base-head.js";

export const conflictCertification =
  "conflict-only resolution; remerge diff limited to conflicted hunks; verify and CI green";

interface Resolution {
  head: string;
  base: string;
  branch: string;
  approved: boolean;
  files: string[];
  step: 1 | 2 | 3;
  phase: "starting" | "waiting" | "resolved" | "blocked" | "merged";
  reason?: string;
  resolvedHead?: string;
  started: number;
  dispatched?: boolean;
  verifyNoticeReported?: boolean;
  /** Card turn (Status, Progress, assignees) captured before a step-2/3 dispatch. */
  prior?: ConflictPrior;
  /** Set once the stored prior card was restored after RESOLVED. */
  restored?: boolean;
}

export interface ConflictHooks {
  snapshot(pr: number): Promise<CiSnapshot>;
  approved(pr: number, head: string): Promise<boolean | "unknown">;
  update(pr: number, head: string): Promise<void>;
  wait(pr: number): Promise<Verdict>;
  fix(pr: number, base: string, files: string[]): Promise<2 | 3>;
  status(pr: number): Promise<"live" | "stopped" | "unknown">;
  stop(pr: number): Promise<void>;
  workerBlocked(pr: number, since: number): Promise<boolean>;
  directory(pr: number): Promise<string>;
  /** Claim reportNotice before emitting an absent-hook notice; false means it was already emitted. */
  verify(directory: string, head: string, reportNotice: () => boolean): Promise<boolean>;
  blocked(pr: number, reason: string, files: string[]): Promise<void>;
  merge(pr: number, reason: string, head: string): Promise<void>;
  /** Capture the card turn a step-2/3 dispatch will interrupt; stored in the record. */
  cardPrior(pr: number): Promise<ConflictPrior>;
  /** Show the dispatched fixer: 💥 Progress and the worker holding the turn. */
  cardConflict(pr: number): Promise<void>;
  /** Return the card to the stored prior once the resolution resolves. */
  cardRestore(pr: number, prior: ConflictPrior): Promise<void>;
}

/** Durable, bounded conflict workflow. Agents propose; only server-side evidence can carry approval. */
export class ConflictService {
  private readonly directory: string;
  constructor(
    private root: string,
    private config: Config,
    private env: NodeJS.ProcessEnv,
    private deps: Dependencies,
    private hooks: ConflictHooks
  ) {
    this.directory = join(
      stateRoot(env, String(config.stateName ?? String(config.repo).replace("/", "-"))),
      "conflicts"
    );
  }

  /** Start once per conflicting head, or reconcile a previously dispatched resolution.
   * Current heads are no-ops; reconciliation errors propagate without conflict escalation.
   * Auto-merge errors retain resolved state and return actionable manual-merge guidance.
   */
  async resolve(pr: number): Promise<string> {
    if (!Number.isSafeInteger(pr) || pr < 1) {
      throw new Error("Expected a positive PR number");
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const lock = join(this.directory, `${pr}.lock`);
    mkdirSync(lock);
    try {
      return await this.run(pr);
    } finally {
      rmdirSync(lock);
    }
  }

  /** Watchers reconcile pending fixes even after the conflicting head has advanced. */
  pending(pr: number): boolean {
    const record = this.read(pr);
    return !!record && ["starting", "waiting"].includes(record.phase);
  }

  /** True while a dispatched step-2/3 fixer episode owns the card. */
  fixing(pr: number): boolean {
    const record = this.read(pr);
    return !!record && record.dispatched === true && ["starting", "waiting"].includes(record.phase);
  }

  private async run(pr: number): Promise<string> {
    const snapshot = await this.hooks.snapshot(pr);
    const old = this.read(pr);
    const git = new GitTransport(this.config, this.env, this.deps, this.root);
    if (
      !(await git.transfer("fetch", [
        `+refs/heads/${snapshot.base}:refs/remotes/origin/${snapshot.base}`,
        `+refs/heads/${snapshot.branch}:refs/remotes/origin/${snapshot.branch}`,
      ]))
    ) {
      throw new Error("Conflict preview fetch failed");
    }
    if (
      (await liveBaseHead(snapshot.base, { git })) !== snapshot.baseSha ||
      (await git.run("rev-parse", `refs/remotes/origin/${snapshot.branch}`)).trim() !==
        snapshot.head
    ) {
      throw new Error("Head or base moved during conflict preview; run again");
    }
    const active = old && ["starting", "waiting"].includes(old.phase);
    if (
      !snapshot.conflict &&
      (!active || (old.head === snapshot.head && old.files.length === 0)) &&
      (await git.run("merge-base", snapshot.baseSha, snapshot.head)).trim() === snapshot.baseSha
    ) {
      if (active) {
        old.phase = "resolved";
        old.resolvedHead = snapshot.head;
        this.save(pr, old);
      }
      return `nothing to resolve for #${pr}`;
    }
    if (old && (active || old.resolvedHead === snapshot.head || old.head === snapshot.head)) {
      if (old.phase === "starting") {
        throw new Error(
          `Conflict #${pr}: previous dispatch was interrupted; inspect worker/update state`
        );
      }
      if (old.phase === "waiting") {
        return this.finish(pr, old, snapshot);
      }
      await this.restore(pr, old);
      return this.event(pr, old);
    }
    const files = (await git.mergePreview(snapshot.head, snapshot.baseSha)).conflicts;
    const record: Resolution = {
      head: snapshot.head,
      base: snapshot.baseSha,
      branch: snapshot.branch,
      approved: (await this.hooks.approved(pr, snapshot.head)) === true,
      files,
      step: files.length ? 3 : 1,
      phase: "starting",
      started: this.deps.now(),
    };
    if (files.length) {
      // Capture before any dispatch so an interrupted run never loses the turn to restore.
      record.prior = await this.hooks.cardPrior(pr);
    }
    this.save(pr, record);
    if (!files.length) {
      try {
        await this.hooks.update(pr, snapshot.head);
      } catch (error) {
        if (
          !(error instanceof GitHubHttpError) ||
          error.status !== 422 ||
          !/\bthere are no new commits on the base branch\b/i.test(error.message)
        ) {
          throw error;
        }
        record.phase = "resolved";
        record.resolvedHead = snapshot.head;
        this.save(pr, record);
        return `nothing to resolve for #${pr}`;
      }
      record.phase = "waiting";
      this.save(pr, record);
      const verdict = await this.hooks.wait(pr);
      if (verdict.code === 1 || verdict.code === 3) {
        return this.block(pr, record, verdict.code === 1 ? "CI red" : "base conflicts again");
      }
      if (verdict.code === 2) {
        return `PENDING #${pr}: waiting for CI`;
      }
      return this.finish(pr, record, await this.hooks.snapshot(pr));
    }
    record.step = await this.hooks.fix(pr, snapshot.base, files);
    try {
      await this.hooks.cardConflict(pr);
    } catch (error) {
      this.deps.report(
        `Conflict #${pr}: card could not show the fixer turn: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    record.dispatched = true;
    record.phase = "waiting";
    this.save(pr, record);
    return `PENDING #${pr}: conflict fixer dispatched (step ${record.step})`;
  }

  private async finish(pr: number, record: Resolution, snapshot: CiSnapshot): Promise<string> {
    if (this.deps.now() - record.started > 60 * 60_000) {
      return this.block(pr, record, "conflict resolution exceeded the one-hour limit");
    }
    if ((await this.hooks.status(pr)) === "live") {
      return `PENDING #${pr}: conflict fixer running`;
    }
    if (await this.hooks.workerBlocked(pr, record.started)) {
      return this.block(pr, record, "fixer reported BLOCKED or QUESTION");
    }
    if (snapshot.head === record.head) {
      if (this.deps.now() - record.started < 120_000) {
        return `PENDING #${pr}: waiting for conflict turn to start`;
      }
      if (record.step === 1) {
        return `PENDING #${pr}: waiting for updated head`;
      }
      return this.block(pr, record, "fixer stopped without a resolution");
    }
    if (
      snapshot.conflict ||
      snapshot.baseSha !== record.base ||
      snapshot.branch !== record.branch
    ) {
      return this.block(pr, record, "head/base changed or still conflicting");
    }
    const patterns =
      (this.config.conflicts as { escalatePaths?: string[] } | undefined)?.escalatePaths ?? [];
    if (record.files.some((file) => patterns.some((pattern) => matchesGlob(file, pattern)))) {
      return this.block(pr, record, "escalated path requires owner review");
    }
    const needsWorktree = record.step !== 1 || record.approved;
    const directory = needsWorktree ? await this.hooks.directory(pr) : this.root;
    const git = new GitTransport(this.config, this.env, this.deps, directory);
    if (
      !(await git.transfer("fetch", [
        `+refs/heads/${snapshot.branch}:refs/remotes/origin/${snapshot.branch}`,
      ]))
    ) {
      throw new Error("Conflict proof fetch failed");
    }
    if (needsWorktree && (await git.run("rev-parse", "HEAD")).trim() !== snapshot.head) {
      if (record.step !== 1 || (await git.run("status", "--porcelain")).trim()) {
        return this.block(pr, record, "worktree does not contain the resolved head");
      }
      await git.run("merge", "--ff-only", snapshot.head);
    }
    if (
      record.step === 1 &&
      !(await cleanBaseMerges(
        (...args) => git.run(...args),
        record.head,
        snapshot.head,
        record.base
      ))
    ) {
      return this.block(pr, record, "update-branch produced more than a clean base merge");
    }
    if (
      record.step !== 1 &&
      !(await proveConflictMerge(
        (...args) => git.run(...args),
        snapshot.head,
        record.head,
        record.base,
        record.files
      ))
    ) {
      return this.block(pr, record, "remerge diff is not limited to conflicted hunks");
    }
    if (!snapshot.green || snapshot.stale) {
      if (
        snapshot.runs.some(
          (run) =>
            run.status === "completed" &&
            !["success", "neutral", "skipped"].includes(String(run.conclusion))
        )
      ) {
        return this.block(pr, record, "CI red");
      }
      return `PENDING #${pr}: waiting for green CI on current base`;
    }
    if (
      (record.step === 3 || record.approved) &&
      !(await this.hooks.verify(directory, snapshot.head, () => {
        if (record.verifyNoticeReported) {
          return false;
        }
        record.verifyNoticeReported = true;
        this.save(pr, record);
        return true;
      }))
    ) {
      return this.block(pr, record, "merge verify hook failed");
    }
    const current = await this.hooks.snapshot(pr);
    if (
      current.head !== snapshot.head ||
      current.baseSha !== record.base ||
      !current.green ||
      current.stale
    ) {
      return this.block(pr, record, "head/base/CI changed during verification");
    }
    record.resolvedHead = snapshot.head;
    record.phase = "resolved";
    this.save(pr, record);
    if (record.approved) {
      try {
        await this.hooks.merge(pr, conflictCertification, snapshot.head);
        record.phase = "merged";
      } catch (error) {
        record.reason = `auto-merge refused (${error instanceof Error ? error.message : String(error)}); merge manually when ready`;
      }
    }
    this.save(pr, record);
    if (record.phase === "resolved") {
      await this.restore(pr, record);
    }
    return this.event(pr, record);
  }

  private async block(pr: number, record: Resolution, reason: string): Promise<string> {
    if (!record.files.length) {
      throw new Error(`Conflict resolution #${pr}: ${reason}`);
    }
    record.phase = "blocked";
    record.reason = reason;
    this.save(pr, record);
    if (record.dispatched) {
      try {
        await this.hooks.stop(pr);
      } catch {
        this.deps.report(
          `Conflict #${pr}: worker stop could not be confirmed; inspect the session before resuming`
        );
      }
    }
    await this.hooks.blocked(pr, reason, record.files);
    return this.event(pr, record);
  }

  /** Return the stored pre-dispatch card exactly once after RESOLVED; retries on reconciliation. */
  private async restore(pr: number, record: Resolution): Promise<void> {
    if (record.phase !== "resolved" || !record.prior || !record.dispatched || record.restored) {
      return;
    }
    try {
      await this.hooks.cardRestore(pr, record.prior);
    } catch (error) {
      this.deps.report(
        `Conflict #${pr}: card could not return to its previous state: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    record.restored = true;
    this.save(pr, record);
  }

  private event(pr: number, record: Resolution): string {
    if (record.phase === "blocked") {
      return `BLOCKED #${pr}: conflict escalated (${record.reason})`;
    }
    if (record.phase === "merged") {
      return `MERGED #${pr} (conflict-only, approval carried)`;
    }
    if (record.phase === "resolved") {
      if (record.reason) {
        return `RESOLVED #${pr}: ${record.reason}`;
      }
      return `RESOLVED #${pr} (step ${record.step})`;
    }
    return `PENDING #${pr}: conflict dispatch in progress; inspect gateway state before retrying`;
  }

  private read(pr: number): Resolution | undefined {
    const file = join(this.directory, `${pr}.json`);
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Resolution) : undefined;
  }

  private save(pr: number, record: Resolution): void {
    const file = join(this.directory, `${pr}.json`);
    writeFileSync(`${file}.new`, JSON.stringify(record) + "\n", { mode: 0o600 });
    renameSync(`${file}.new`, file);
  }
}
