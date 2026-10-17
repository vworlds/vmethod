import type { BoardStatus, Card, MigrationResult } from "../board/types.js";
import type { OpenTaskInput, ReviewInput } from "./task-flow-types.js";
import type { SessionInput, WatchEvent } from "./events.js";
import type { LearningInput } from "./learnings.js";

export interface Operations {
  learnings: { input: LearningInput; output: string };
  learningCheck: { input: { ref: string; label?: boolean }; output: string };
  issueCreate: {
    input: { title: string; file: string; labels?: string[]; estimate?: number; status?: string };
    output: string;
  };
  issueClose: { input: { ref: string; comment?: string }; output: string };
  boardSetIssue: { input: { ref: string; field: string; value: string }; output: string };
  worker: { input: { args: string[] }; output: string };
  suggestModel: { input: { ref: string }; output: string };
  grade: { input: { ref: string; points?: number }; output: string };
  workerAccess: { input: { directory: string }; output: string };
  openTask: { input: OpenTaskInput; output: string };
  reviewTask: { input: ReviewInput; output: string };
  mergeTask: { input: { ref: string; mergeCommit?: boolean }; output: string };
  releaseHold: { input: { ref: string }; output: string };
  workerStatus: { input: { ref: string }; output: "live" | "stopped" | "unknown" };
  nextEvents: {
    input: SessionInput & { timeoutSeconds: number; ack?: string[]; pollOnce?: boolean };
    output: { events: WatchEvent[] };
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
  boardStatus: { input: Record<string, never>; output: BoardStatus };
  boardMigrate: {
    input: { dryRun?: boolean; steal?: boolean };
    output: MigrationResult;
  };
  boardItem: { input: { itemId: string }; output: Card };
  boardSet: {
    input: {
      itemId: string;
      field: "Status" | "Estimate" | "Model" | "Progress";
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
      option?: "--files" | "--diff" | "--reviews" | "--checks";
    };
    output: string;
  };
  post: { input: { ref: string; file: string }; output: string };
  push: { input: { worktree: string; branch: string; commit?: string }; output: string };
  task: {
    input: { ref: string; fetch?: boolean };
    output: { branch: string; base: string };
  };
  waitReview: { input: { ref: string; pollSeconds: number }; output: string };
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
  ) => void
): Transport {
  return {
    async call<K extends keyof Operations>(
      operation: K,
      input: Operations[K]["input"],
      ctx: CallContext
    ): Promise<Operations[K]["output"]> {
      authorize(operation, input, ctx);
      return (
        handlers[operation] as (
          input: Operations[K]["input"],
          ctx: CallContext
        ) => Promise<Operations[K]["output"]>
      )(input, ctx);
    },
  };
}
