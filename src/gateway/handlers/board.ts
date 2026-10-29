import { assertEstimate } from "../../board/estimate.js";
import { object } from "../people.js";
import { workflowColumns } from "../../board/runner.js";
import type { Handler } from "./types.js";

export const boardStatus: Handler<"boardStatus"> = async function ({ fix }) {
  return fix ? this.board.fixStatus() : this.board.status();
};

export const boardInit: Handler<"boardInit"> = async function (input) {
  if (input.steal !== undefined && typeof input.steal !== "boolean") {
    throw new Error("Invalid initialization flags");
  }
  return this.board.init(input);
};

export const boardMigrate: Handler<"boardMigrate"> = async function (input) {
  if (
    (input.dryRun !== undefined && typeof input.dryRun !== "boolean") ||
    (input.steal !== undefined && typeof input.steal !== "boolean")
  ) {
    throw new Error("Invalid migration flags");
  }
  return this.board.migrate(input);
};

export const boardItem: Handler<"boardItem"> = async function ({ itemId }) {
  return this.board.item(itemId);
};

export const boardSet: Handler<"boardSet"> = async function (input) {
  return this.board.set(input);
};

/** Set an issue board field, or clear Progress/Estimate with a null value. */
export const boardSetIssue: Handler<"boardSetIssue"> = async function ({ ref, field, value }) {
  this.localNumber(ref);
  const issue = await this.flowThread(ref, "issue");
  return this.board.setIssueField(String(issue.id), field, value);
};

/** Orchestrator-only management-turn housekeeping (#257): the board service validates
 * the requested assignee against the card's Status and Progress and journals the writes. */
export const boardSetAssignees: Handler<"boardSetAssignees"> = async function ({ ref, value }) {
  const number = this.localNumber(ref);
  return this.board.setAssignees(number, value);
};

/** Orchestrator-only retry of issue create's board follow-up (#287): membership
 * through `board.ensureCard` (the issue-side relation), then one `setIssueFields` call
 * with the effective entries, inside the same journaled operation (#199). Idempotent: an
 * off-board issue gains Status (the --status value or the first workflow column)
 * plus any passed Estimate; a card already on the board keeps its Status unless
 * --status is given and only the passed fields change, so a re-run never moves
 * it back to Backlog. A foreign reference, a PR and a closed issue are refused
 * before any write. */
export const boardAdd: Handler<"boardAdd"> = async function ({ ref, estimate, status }) {
  if (estimate !== undefined) {
    assertEstimate(estimate);
  }
  if (status !== undefined && (typeof status !== "string" || !status.trim())) {
    throw new Error("Invalid issue status");
  }
  if (object(this.config.board).enabled === false) {
    throw new Error("Board is disabled; board add requires a configured board");
  }
  const number = this.localNumber(ref);
  const issue = await this.flowThread(String(number), "issue");
  if (issue.state !== "OPEN") {
    throw new Error(`Refusing board add on closed issue #${number}`);
  }
  const contentId = String(issue.id);
  const card = await this.board.issueCard(contentId);
  // The field plan mirrors issue create's follow-up: a fresh card files in the
  // first workflow column unless --status names one; an on-board card keeps its
  // Status and receives only the fields that were passed (#287).
  const entries = [
    ...(estimate !== undefined ? [{ name: "Estimate", value: String(estimate) }] : []),
    ...(!card || status !== undefined
      ? [{ name: "Status", value: status ?? workflowColumns[0] }]
      : []),
  ];
  // One operation for the board writes (#199), exactly as issue create's
  // follow-up: the membership add, then the fields in a single ordered mutation.
  this.github.writes.beginOperation("board add", [{ repo: String(this.config.repo), number }]);
  const membership = await this.board.ensureCard(contentId);
  if (entries.length) {
    await this.board.setIssueFields(contentId, entries, membership);
  }
  return card
    ? entries.length
      ? `Repaired issue #${number} board fields`
      : `Issue #${number} is already on the board`
    : `Added issue #${number} to the board`;
};

export const boardArchive: Handler<"boardArchive"> = async function ({ itemId }) {
  return this.board.archive(itemId);
};
