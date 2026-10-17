import type { BoardStatus, Card, MigrationResult } from "../board/types.js";
import type { SessionInput, WatchEvent } from "./events.js";

export interface Operations {
  nextEvents: {
    input: SessionInput & { timeoutSeconds: number; ack?: string[] };
    output: { events: WatchEvent[] };
  };
  watchMute: { input: { ref: string }; output: string };
  watchUnmute: { input: { ref: string }; output: string };
  watchMutes: { input: Record<string, never>; output: string };
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
  push: { input: { worktree: string; branch: string }; output: string };
  task: {
    input: { ref: string; fetch?: boolean };
    output: { branch: string; base: string };
  };
  waitReview: { input: { ref: string; pollSeconds: number }; output: string };
  ghRead: { input: { source: string }; output: string };
  dropped: { input: { since?: string }; output: string };
  ownerApproved: { input: { ref: string }; output: boolean | "unknown" };
}

export interface CallContext {
  role: "orchestrator" | "worker";
  taskPr?: number;
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
