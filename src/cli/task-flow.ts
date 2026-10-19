import type { Transport } from "../gateway/transport.js";
import type { OpenTaskInput, ReviewInput } from "../gateway/task-flow-types.js";
import { context } from "../gateway/transport.js";

export async function taskFlowVerb(
  transport: Transport,
  verb: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<string> {
  const ctx = context(env);
  if (verb === "resolve-conflicts") {
    if (args.length !== 1) {
      throw new Error("Usage: resolve-conflicts <pr>");
    }
    return transport.call("resolveConflicts", { ref: args[0] }, ctx);
  }
  if (verb === "ask") {
    if (args.length !== 2) {
      throw new Error("Usage: ask <issue> <file>");
    }
    return transport.call("askIssue", { ref: args[0], file: args[1] }, ctx);
  }
  if (verb === "open-task") {
    const input: OpenTaskInput = {};
    const values = {
      "--direct": "direct",
      "--unapproved": "unapproved",
      "--model": "model",
      "--from": "from",
    } as const;
    const flags = {
      "--hold": "hold",
      "--part": "part",
      "--owner-approved": "ownerApproved",
    } as const;
    const seen = new Set<string>();
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (seen.has(arg)) {
        throw new Error("Duplicate open-task argument");
      }
      seen.add(arg);
      if (Object.hasOwn(values, arg)) {
        const value = args[++i];
        if (!value || value.startsWith("--")) {
          throw new Error(`Missing value for ${arg}`);
        }
        input[values[arg as keyof typeof values]] = value;
      } else if (Object.hasOwn(flags, arg)) {
        input[flags[arg as keyof typeof flags]] = true;
      } else if (/^[1-9]\d*$/.test(arg) && !input.issue) {
        input.issue = arg;
      } else {
        throw new Error(
          "Usage: open-task <issue> [--direct title] [--unapproved reason] [--hold] [--part] [--model family] [--from branch] [--owner-approved]"
        );
      }
    }
    return transport.call("openTask", input, ctx);
  }
  if (verb === "review") {
    const replyFirst = args[2] === "--in-reply-to";
    if (
      ![3, 5].includes(args.length) ||
      (args.length === 5 && args[replyFirst ? 2 : 3] !== "--in-reply-to") ||
      (replyFirst && args.length !== 5)
    ) {
      throw new Error(
        "Usage: review <pr> changes|owner|answer|ask|approve <file> [--in-reply-to url]"
      );
    }
    return transport.call(
      "reviewTask",
      {
        ref: args[0],
        outcome: args[1] as ReviewInput["outcome"],
        file: args[replyFirst ? 4 : 2],
        replyTo: args[replyFirst ? 3 : 4],
      },
      ctx
    );
  }
  if (verb === "link-task") {
    if (
      !args.length ||
      args.length > 2 ||
      (args[1] && !["--complete", "--unlink"].includes(args[1]))
    ) {
      throw new Error("Usage: link-task <pr> [--complete|--unlink]");
    }
    return transport.call(
      "linkTask",
      { ref: args[0], complete: args[1] === "--complete", unlink: args[1] === "--unlink" },
      ctx
    );
  }
  if (verb === "merge-task") {
    const usage = 'Usage: merge-task <pr> [--merge-commit] [--carry-approval "reason"]';
    if (!args.length) {
      throw new Error(usage);
    }
    let mergeCommit = false;
    let carryApproval: string | undefined;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--merge-commit" && !mergeCommit) {
        mergeCommit = true;
      } else if (args[i] === "--carry-approval" && carryApproval === undefined) {
        carryApproval = args[++i];
        if (
          !carryApproval?.trim() ||
          carryApproval.startsWith("--") ||
          /[\r\n]/.test(carryApproval)
        ) {
          throw new Error(usage);
        }
      } else {
        throw new Error(usage);
      }
    }
    return transport.call(
      "mergeTask",
      { ref: args[0], mergeCommit, ...(carryApproval !== undefined ? { carryApproval } : {}) },
      ctx
    );
  }
  if (verb === "release-hold" && args.length === 1) {
    return transport.call("releaseHold", { ref: args[0] }, ctx);
  }
  throw new Error("Usage: release-hold <pr>");
}
