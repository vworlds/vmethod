import { type ObjectData } from "./people.js";

/**
 * The verifiable owner gate for `gate: owner` model families (#218). The
 * orchestrator's `--owner-approved` flag is honored only when the pinned owner
 * has approved in the task discussion: an issue or task PR comment whose first
 * line is exactly `APPROVE MODEL <family>`, posted after the issue body's last
 * edit (#218), or the issue's or task PR's board card Model value set by the
 * owner themselves (#242). A body edit reopens the comment scope, so an older
 * line must not authorize a fresh launch; every other identity (worker, peer
 * orchestrator, forged author) is refused at the fetch layer, which sends only
 * verified-owner comments here, and a card value counts only through its
 * recorded creator.
 */

/** Effective comment time: the last edit counts as the authorship moment. */
function effectiveAt(comment: ObjectData): number {
  return Date.parse(String(comment.lastEditedAt ?? comment.createdAt ?? ""));
}

export function isModelApproved(
  comments: ObjectData[],
  family: string,
  /** Issue body's last edit; a direct task without an issue is unbounded. */
  since?: number
): boolean {
  for (const comment of comments) {
    const at = effectiveAt(comment);
    if (!Number.isFinite(at)) {
      continue;
    }
    if (since !== undefined && at <= since) {
      continue;
    }
    const firstLine = String(comment.body ?? "")
      .split(/\r?\n/, 1)[0]
      .trim();
    if (firstLine === `APPROVE MODEL ${family}`) {
      return true;
    }
  }
  return false;
}

/** The refusal names both ways the owner can approve (#242): setting the Model
 * themselves, or the verifiable `APPROVE MODEL` line. */
export function modelGateError(family: string): Error {
  return new Error(
    `${family} is owner-gated: ask the owner to set the issue or task PR card's Model to ${family}, or ask the owner for an \`APPROVE MODEL ${family}\` comment on the issue or task PR, posted after the issue body's latest edit`
  );
}
