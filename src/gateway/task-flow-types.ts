export interface OpenTaskInput {
  issue?: string;
  direct?: string;
  unapproved?: string;
  hold?: boolean;
  /** Requires issue; records a partial relation that merge follow-up must not complete. */
  part?: boolean;
  model?: string;
  modelOverride?: string;
  ownerApproved?: boolean;
  /** Merge origin/<branch> into the fresh task branch with a merge commit (never squash/rebase). */
  from?: string;
}
export interface ReviewInput {
  ref: string;
  outcome: "changes" | "owner" | "answer" | "ask" | "approve";
  file: string;
  replyTo?: string;
  /** Owner comment attested as agreement; required to release an Executing summons. */
  ownerAgreed?: string;
}

/** The card turn a conflict fixer dispatch interrupts; stored with the resolution record. */
export interface ConflictPrior {
  /** Board Status column before the dispatch, or null without a board. */
  status: string | null;
  /** Raw board Progress text before the dispatch, or null when the field is empty. */
  progress: string | null;
  /** PR assignees before the dispatch, exactly as read from the thread. */
  assignees: string[];
}
