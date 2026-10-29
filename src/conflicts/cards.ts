import { heading as protocolHeading } from "../core/protocol.js";
import { renderProgress } from "../core/progress.js";
import type { ConflictPrior } from "../gateway/task-flow-types.js";
import { taskHeld, taskIssueNumbers } from "../tasks/markers.js";
import { setTurn } from "../gateway/turn.js";
import { TaskCommon } from "../tasks/common.js";
import { ConflictOutcome } from "./outcomes.js";

/** Conflict-service hooks for task identity, lifecycle and interrupted card turns. */
export class ConflictCards extends TaskCommon {
  /** Capture the card turn a conflict dispatch will interrupt; store it in the resolution record. */
  async cardPrior(ref: string): Promise<ConflictPrior> {
    const item = await this.pr(ref);
    const assignees = await this.assigned(ref);
    if (this.config.board?.enabled === false) {
      return { status: null, progress: null, assignees };
    }
    const board = this.host.board();
    const card = await board.item(await board.ensure(String(item.id)));
    const text = (value: unknown): string | null =>
      typeof value === "string" && value.trim() ? value : null;
    return {
      status: text(card.values.Status),
      progress: text(card.values.Progress),
      assignees,
    };
  }

  /** Show the dispatched fixer: 💥 Progress and the assigned worker holding the turn. */
  async cardConflict(ref: string): Promise<void> {
    const item = await this.pr(ref);
    await this.card(
      item,
      undefined,
      renderProgress({ state: "conflict", round: null, red: false })
    );
    await this.turn(ref, "worker");
  }

  /** Return the card to its stored pre-dispatch state once the resolution resolves.
   * Re-reads the live card first: an owner approval found between dispatch and
   * resolution is never overwritten (the #244 case). On an Approved card the restore
   * keeps the Status, restores verifying Progress, clears the interrupted fixer turn
   * and reports the kept approval; otherwise it returns the stored prior turn. */
  async cardRestore(ref: string, prior: ConflictPrior): Promise<void | "approval-kept"> {
    const item = await this.pr(ref);
    if (this.config.board?.enabled !== false) {
      const card = await this.boardCard(item);
      if (card?.values.Status === "Approved") {
        await this.card(
          item,
          undefined,
          renderProgress({ state: "verifying", round: null, red: false })
        );
        await this.turn(ref, null);
        return "approval-kept";
      }
      if (prior.status) {
        await this.card(item, prior.status, prior.progress ?? null);
      } else {
        await this.card(item, undefined, prior.progress ?? null);
      }
    }
    const assigned = await this.assigned(ref);
    await setTurn(this.host.github, this.repo, this.number(ref), assigned, prior.assignees);
  }

  /** Apply identity, fork, track and hold gates before conflict side effects.
   * Closed/non-task PRs signal a terminal ConflictOutcome; unsafe gates still fail. */
  async conflictTask(ref: string): Promise<void> {
    const item = await this.pr(ref);
    if (item.state !== "OPEN" || taskIssueNumbers(String(item.body)) === undefined) {
      throw new ConflictOutcome("closed", "Conflict task is no longer open or a task PR");
    }
    if (taskHeld(String(item.title), String(item.body))) {
      throw new Error("Conflict resolution requires an open, non-held task PR on this track");
    }
  }

  /**
   * Tolerant PR lifecycle read for conflict reconciliation: a merged or closed PR
   * must close its resolution record instead of failing every future reconcile.
   */
  async pullLifecycle(ref: string): Promise<"open" | "merged" | "closed"> {
    const item = await this.pr(ref);
    return item.state === "MERGED" ? "merged" : item.state === "CLOSED" ? "closed" : "open";
  }

  /** Escalate independent conflict-proof failures without impersonating the fixer. */
  async escalateConflict(ref: string, reason: string, files: string[]): Promise<void> {
    const item = await this.pr(ref);
    if (item.state !== "OPEN") {
      throw new Error("Conflict task is no longer open");
    }
    // Re-read the live card before writing: an owner approval found between dispatch
    // and escalation is kept, and the note reports it instead of overwriting Approved.
    const approved =
      this.config.board?.enabled !== false &&
      (await this.boardCard(item))?.values.Status === "Approved";
    // A Status write would move an Approved card out of the owner's decision; on an
    // approved card only the blocked Progress rides the escalation write.
    await this.card(
      item,
      approved ? undefined : "Executing",
      renderProgress({ state: "blocked", round: null, red: false })
    );
    await this.turn(ref, "orchestrator");
    // Report only after the card/turn writes succeed, using the live resulting card.
    const kept =
      this.config.board?.enabled !== false &&
      (await this.boardCard(item))?.values.Status === "Approved";
    await this.post(
      ref,
      `${protocolHeading("NOTE")}: conflict escalated (${reason})\n\nConflicting files:\n${files.map((file) => `- ${JSON.stringify(file)}`).join("\n") || "- (none)"}\n\n${kept ? "Owner approval kept: the card stays Approved." : "Owner review is required; no approval carried."}`
    );
  }
}
