import type { BoardStatus, Card, MigrationResult } from "../board/types.js";
import type { OpenTaskInput, ReviewInput } from "./task-flow-types.js";
import type { SessionInput, WatchEvent } from "./events.js";
import type { LearningInput } from "./learnings.js";

export interface Operations {
  /** Resolve one accepted open task PR with this exact same-repository head branch, or null. */
  resolveTask: { input: { branch: string }; output: number | null };
  learnings: { input: LearningInput; output: string };
  learningCheck: { input: { ref: string; label?: boolean }; output: string };
  issueCreate: {
    input: { title: string; file: string; labels?: string[]; estimate?: number; status?: string };
    output: string;
  };
  issueClose: { input: { ref: string; comment?: string }; output: string };
  /** Replace a previously read issue body, refusing stale read evidence. */
  issueEdit: { input: { ref: string; file: string }; output: string };
  /** Set a blocked-by relation on a configured-repository issue; the blocker may be cross-repository. */
  issueBlock: { input: { ref: string; blocker: string }; output: string };
  /** Clear a blocked-by relation on a configured-repository issue. */
  issueUnblock: { input: { ref: string; blocker: string }; output: string };
  /** Set an existing issue card's Estimate on the shared points scale; never a PR card. */
  issueEstimate: { input: { ref: string; points: number }; output: string };
  /** Publish body-bound scope review and give the owner the issue turn. */
  scopeReview: { input: { ref: string; file: string }; output: string };
  /** Remove delegation only; no operation lets an agent grant autopilot. */
  autopilotStop: { input: { ref: string; kind: "issue" | "pr" }; output: string };
  /** Re-copy a linked issue's live owner grant onto an accepted task PR. */
  autopilotInherit: { input: { ref: string }; output: string };
  /** Null clears only Progress or Estimate; strings retain ordinary value validation. */
  boardSetIssue: { input: { ref: string; field: string; value: string | null }; output: string };
  /** Orchestrator-only management-turn housekeeping: set or clear the single management
   * assignee on a configured-repository issue or PR; worker assignees are untouched. */
  boardSetAssignees: {
    input: { ref: string; value: "owner" | "orchestrator" | null };
    output: string;
  };
  worker: { input: { args: string[] }; output: string | WorkerResult };
  suggestModel: { input: { ref: string }; output: string };
  grade: { input: { ref: string; points?: number }; output: string };
  openTask: { input: OpenTaskInput; output: string };
  reviewTask: { input: ReviewInput; output: string };
  askIssue: { input: { ref: string; file: string }; output: string };
  mergeTask: {
    input: { ref: string; mergeCommit?: boolean; carryApproval?: string };
    output: string;
  };
  /** Close an unmerged task PR without merging; card, worktree and issue follow-up belong to the watcher. */
  closeTask: { input: { ref: string; comment?: string }; output: string };
  /** Orchestrator-only bounded conflict resolution and approval-carry reconciliation. */
  resolveConflicts: { input: { ref: string; retry?: boolean }; output: string };
  /** Orchestrator-only Development links; complete promotes, unlink demotes. Flags are exclusive. */
  linkTask: { input: { ref: string; complete?: boolean; unlink?: boolean }; output: string };
  releaseHold: { input: { ref: string }; output: string };
  workerStatus: { input: { ref: string }; output: "live" | "stopped" | "unknown" };
  nextEvents: {
    /** watchStart marks a CLI invocation; replay reads history without polling or acknowledging. */
    input: SessionInput & {
      timeoutSeconds: number;
      ack?: string[];
      pollOnce?: boolean;
      watchStart?: boolean;
      guideSeen?: boolean;
      replay?: string;
    };
    /** A nonempty real delivery may carry the one-line chat-rule reminder, at most once every 2h. */
    output: { events: WatchEvent[]; notice?: string; reminder?: string };
  };
  watchMute: { input: { ref: string }; output: string };
  watchUnmute: { input: { ref: string }; output: string };
  watchMutes: { input: Record<string, never>; output: string };
  waitChecks: {
    input: { ref: string; maxMinutes?: number; graceSeconds?: number };
    output: Verdict;
  };
  checkTaskCi: { input: { ref: string }; output: Verdict };
  refreshChecks: { input: { ref: string }; output: Verdict };
  verify: { input: { refs: string[]; packages?: string[]; bench?: boolean }; output: Verdict };
  boardStatus: { input: { fix?: boolean }; output: BoardStatus };
  boardMigrate: {
    input: { dryRun?: boolean; steal?: boolean };
    output: MigrationResult;
  };
  boardItem: { input: { itemId: string }; output: Card };
  boardSet: {
    input: {
      itemId: string;
      field: "Status" | "Estimate" | "Model" | "Progress" | "Cost";
      value: string | number | null;
      progress?: string | null;
    };
    output: string;
  };
  boardArchive: { input: { itemId: string }; output: string };
  read: {
    input: {
      kind: "pr" | "issue" | "comment" | "checks" | "registry";
      ref: string;
      option?: "--files" | "--diff" | "--reviews" | "--checks" | "--new";
    };
    output: string;
  };
  /** Post exact file content; discussion_r reply URLs route to the inline thread. */
  post: { input: { ref: string; file: string; replyTo?: string }; output: string };
  push: { input: { worktree: string; branch: string; commit?: string }; output: string };
  task: {
    input: { ref: string; fetch?: boolean };
    output: { branch: string; base: string };
  };
  /** Scoped GET/query diagnostics: untrusted JSON, root-list drop count and optional nested-redaction count. */
  ghRead: { input: { source: string }; output: string };
  dropped: { input: { since?: string }; output: string };
  ownerApproved: { input: { ref: string }; output: boolean | "unknown" };
}

export interface CallContext {
  role: "orchestrator" | "worker";
  taskPr?: number;
}

export function context(env: NodeJS.ProcessEnv): CallContext {
  const role = env.VMETHOD_ROLE ?? "worker";
  if (role !== "orchestrator" && role !== "worker") {
    throw new Error("Invalid VMETHOD_ROLE");
  }
  const task = env.VMETHOD_TASK_PR;
  if (task !== undefined && (!/^[1-9]\d*$/.test(task) || !Number.isSafeInteger(Number(task)))) {
    throw new Error("Invalid VMETHOD_TASK_PR");
  }
  return { role, ...(task === undefined ? {} : { taskPr: Number(task) }) };
}

/** CLI-ready outcome: the last text line is always the verdict. */
export interface Verdict {
  text: string;
  code: 0 | 1 | 2 | 3;
}

/** CLI-ready worker listing: the text always prints; a non-zero code fails the command. */
export interface WorkerResult {
  text: string;
  code: 0 | 1;
}

export interface Transport {
  call<K extends keyof Operations>(
    operation: K,
    input: Operations[K]["input"],
    ctx: CallContext
  ): Promise<Operations[K]["output"]>;
}

export type Handlers = {
  [K in keyof Operations]: (
    input: Operations[K]["input"],
    ctx: CallContext
  ) => Promise<Operations[K]["output"]>;
};

export function inProcess(
  handlers: Handlers,
  authorize: <K extends keyof Operations>(
    operation: K,
    input: Operations[K]["input"],
    ctx: CallContext
  ) => void | Promise<void>
): Transport {
  return {
    async call<K extends keyof Operations>(
      operation: K,
      input: Operations[K]["input"],
      ctx: CallContext
    ): Promise<Operations[K]["output"]> {
      await authorize(operation, input, ctx);
      return (
        handlers[operation] as (
          input: Operations[K]["input"],
          ctx: CallContext
        ) => Promise<Operations[K]["output"]>
      )(input, ctx);
    },
  };
}
