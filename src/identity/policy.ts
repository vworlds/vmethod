import { type Config } from "../config.js";
import { inProcess, type CallContext, type Operations } from "../gateway/transport.js";
import { reference } from "../gateway/refs.js";

const policy = {
  learnings: ["worker", "orchestrator"],
  learningCheck: ["worker", "orchestrator"],
  issueCreate: ["orchestrator"],
  upstreamIssue: ["orchestrator"],
  upstreamComment: ["orchestrator"],
  issueEdit: ["orchestrator"],
  issueBlock: ["orchestrator"],
  issueUnblock: ["orchestrator"],
  issueParent: ["orchestrator"],
  issueUnparent: ["orchestrator"],
  issueEstimate: ["orchestrator"],
  scopeReview: ["orchestrator"],
  autopilotStop: ["orchestrator"],
  autopilotInherit: ["orchestrator"],
  issueClose: ["orchestrator"],
  issueReopen: ["orchestrator"],
  boardSetIssue: ["orchestrator"],
  boardSetAssignees: ["orchestrator"],
  boardAdd: ["orchestrator"],
  worker: ["orchestrator"],
  grade: ["orchestrator"],
  suggestModel: ["orchestrator"],
  limits: ["orchestrator"],
  openTask: ["orchestrator"],
  prOpen: ["orchestrator"],
  prEdit: ["orchestrator"],
  prMerge: ["orchestrator"],
  reviewTask: ["orchestrator"],
  askIssue: ["orchestrator"],
  mergeTask: ["orchestrator"],
  closeTask: ["orchestrator"],
  resolveConflicts: ["orchestrator"],
  linkTask: ["orchestrator"],
  releaseHold: ["orchestrator"],
  releaseNext: ["orchestrator"],
  workerStatus: ["orchestrator"],
  nextEvents: ["orchestrator"],
  watchMute: ["orchestrator"],
  watchUnmute: ["orchestrator"],
  watchMutes: ["orchestrator"],
  watchStop: ["orchestrator"],
  waitChecks: ["worker", "orchestrator"],
  checkTaskCi: ["orchestrator"],
  refreshChecks: ["orchestrator"],
  verify: ["orchestrator"],
  boardStatus: ["orchestrator"],
  boardInit: ["orchestrator"],
  boardMigrate: ["orchestrator"],
  boardItem: ["orchestrator"],
  boardSet: ["orchestrator"],
  boardArchive: ["orchestrator"],
  read: ["worker", "orchestrator"],
  post: ["worker", "orchestrator"],
  push: ["worker", "orchestrator"],
  resolveTask: ["worker", "orchestrator"],
  task: ["worker", "orchestrator"],
  ghRead: ["orchestrator"],
  dropped: ["orchestrator"],
  ownerApproved: ["orchestrator"],
} as const satisfies Record<keyof Operations, readonly ("worker" | "orchestrator")[]>;

/** Apply operation roles, authenticated identity and the worker's own-task boundary in order. */
export function authorizeGateway(
  config: Config,
  env: NodeJS.ProcessEnv,
  authenticate: (ctx: CallContext, operation: keyof Operations) => Promise<boolean>
): Parameters<typeof inProcess>[1] {
  return async (operation, input, ctx) => {
    if (
      (operation === "learnings" &&
        ["submit", "annotate", "aggregate", "merge"].includes(
          (input as Operations["learnings"]["input"]).action
        ) &&
        ctx?.role !== "orchestrator") ||
      (operation === "learningCheck" &&
        (input as Operations["learningCheck"]["input"]).label &&
        ctx?.role !== "orchestrator" &&
        env.GITHUB_ACTIONS !== "true")
    ) {
      throw new Error("Learning writes require orchestrator role");
    }
    if (
      !ctx ||
      !Object.hasOwn(policy, operation) ||
      !(policy[operation] as readonly string[]).includes(ctx.role)
    ) {
      throw new Error(
        "Gateway operation denied for client role; check the checkout's VMETHOD_ROLE and VMETHOD_TASK_PR in .vmethod/.env"
      );
    }
    const ciLearningIdentity = await authenticate(ctx, operation);
    if (
      operation === "learningCheck" &&
      (input as Operations["learningCheck"]["input"]).label &&
      ctx.role !== "orchestrator" &&
      !ciLearningIdentity
    ) {
      throw new Error("Learning writes require orchestrator role");
    }
    if (ctx.role === "worker" && ["post", "task", "waitChecks"].includes(operation)) {
      const target = reference((input as Operations["post"]["input"]).ref, config);
      if (
        !Number.isSafeInteger(ctx.taskPr) ||
        Number(ctx.taskPr) < 1 ||
        target.number !== ctx.taskPr ||
        target.repo.toLowerCase() !== config.repo.toLowerCase()
      ) {
        throw new Error(
          "Worker may post only to its own taskPr in the configured repository; run vmethod in your task worktree, whose .vmethod/.env sets VMETHOD_ROLE=worker and VMETHOD_TASK_PR"
        );
      }
    }
  };
}
