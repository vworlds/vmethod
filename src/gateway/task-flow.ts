import type { Config } from "../config.js";
import type { Dependencies } from "./client.js";
import type { ConflictPrior, OpenTaskInput, ReviewInput } from "./task-flow-types.js";
import type { TaskHost } from "../tasks/common.js";
import { TaskOpen } from "../tasks/open.js";
import { TaskReview } from "../tasks/review.js";
import { TaskMerge } from "../tasks/merge.js";
import { TaskLink } from "../tasks/link.js";
import { ConflictCards } from "../conflicts/cards.js";
export { conformingTitle } from "../tasks/common.js";

/** Compatibility facade; workflow implementations live in tasks/ and conflicts/. */
export class TaskFlow {
  private readonly openTasks: TaskOpen;
  private readonly reviews: TaskReview;
  private readonly merges: TaskMerge;
  private readonly links: TaskLink;
  private readonly conflicts: ConflictCards;

  constructor(
    root: string,
    env: NodeJS.ProcessEnv,
    config: Config,
    deps: Dependencies,
    host: TaskHost
  ) {
    this.openTasks = new TaskOpen(root, env, config, deps, host);
    this.reviews = new TaskReview(root, env, config, deps, host);
    this.merges = new TaskMerge(root, env, config, deps, host);
    this.links = new TaskLink(root, env, config, deps, host);
    this.conflicts = new ConflictCards(root, env, config, deps, host);
  }

  /** Capture the card turn a conflict dispatch will interrupt; store it in the resolution record. */
  async cardPrior(ref: string): Promise<ConflictPrior> {
    return this.conflicts.cardPrior(ref);
  }

  /** Show the dispatched fixer: 💥 Progress and the assigned worker holding the turn. */
  async cardConflict(ref: string): Promise<void> {
    return this.conflicts.cardConflict(ref);
  }

  /** Return the card to its stored pre-dispatch state once the resolution resolves.
   * Re-reads the live card first: an owner approval found between dispatch and
   * resolution is never overwritten (the #244 case). On an Approved card the restore
   * keeps the Status, restores verifying Progress, clears the interrupted fixer turn
   * and reports the kept approval; otherwise it returns the stored prior turn. */
  async cardRestore(ref: string, prior: ConflictPrior): Promise<void | "approval-kept"> {
    return this.conflicts.cardRestore(ref, prior);
  }

  /** Open an already-pushed non-task PR; never creates task relations or a worker. */
  async openPr(input: {
    branch: string;
    title: string;
    file: string;
    draft?: boolean;
  }): Promise<string> {
    return this.openTasks.openPr(input);
  }

  /** Open an isolated draft delivery, freezing only an on-scale opening issue Estimate. */
  async open(input: OpenTaskInput): Promise<string> {
    return this.openTasks.open(input);
  }

  /** Backfill Development links; complete promotes, unlink demotes to a partial task. */
  async link(ref: string, complete = false, unlink = false): Promise<string> {
    return this.links.link(ref, complete, unlink);
  }

  async review(input: ReviewInput): Promise<string> {
    return this.reviews.review(input);
  }

  /** Ask on the issue; an Executing issue summons also pauses its linked workers. */
  async ask(ref: string, file: string): Promise<string> {
    return this.reviews.ask(ref, file);
  }

  async status(ref: string, forMerge = false): Promise<"live" | "stopped" | "unknown"> {
    return this.reviews.status(ref, forMerge);
  }

  /** Release an open held task, preserving prompt edits and refusing repeated releases. */
  async release(ref: string): Promise<string> {
    return this.reviews.release(ref);
  }

  /** Apply task identity, fork, track and hold gates before any conflict side effect. */
  async conflictTask(ref: string): Promise<void> {
    return this.conflicts.conflictTask(ref);
  }

  /**
   * Tolerant PR lifecycle read for conflict reconciliation: a merged or closed PR
   * must close its resolution record instead of failing every future reconcile.
   */
  async pullLifecycle(ref: string): Promise<"open" | "merged" | "closed"> {
    return this.conflicts.pullLifecycle(ref);
  }

  /** Escalate independent conflict-proof failures without impersonating the fixer. */
  async escalateConflict(ref: string, reason: string, files: string[]): Promise<void> {
    return this.conflicts.escalateConflict(ref, reason, files);
  }

  /** Merge a stopped/session-less task against the live base; delegated carries also require cleanBaseMerges proof. */
  async merge(
    ref: string,
    mergeCommit = false,
    carryApproval?: string,
    expectedHead?: string
  ): Promise<string> {
    return this.merges.merge(ref, mergeCommit, carryApproval, expectedHead);
  }

  /** Merge a non-task PR using current owner/delegated approval; recovery only repeats follow-up. */
  async mergePr(ref: string): Promise<string> {
    return this.merges.mergePr(ref);
  }

  /** Close an unmerged task PR without merging (#288): the delivery is abandoned.
   * The watcher moves the closed PR card to Done and reports the worktree cleanup
   * candidate; a linked issue stays open for the LAUNCH decision. Refused before
   * any write unless the PR is in the configured repository, open and a task PR. */
  async close(ref: string, comment?: string): Promise<string> {
    return this.merges.close(ref, comment);
  }
}
