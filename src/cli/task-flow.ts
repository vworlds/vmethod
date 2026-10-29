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
  if (verb === "pr") {
    if (args[0] === "merge" && args.length === 2 && /^[1-9]\d*$/.test(args[1])) {
      return transport.call("prMerge", { ref: args[1] }, ctx);
    }
    if (args[0] === "open" && (args.length === 4 || (args.length === 5 && args[4] === "--draft"))) {
      return transport.call(
        "prOpen",
        { branch: args[1], title: args[2], file: args[3], draft: args.length === 5 },
        ctx
      );
    }
    if (args[0] === "edit" && args.length === 3 && /^[1-9]\d*$/.test(args[1])) {
      return transport.call("prEdit", { ref: args[1], file: args[2] }, ctx);
    }
    throw new Error(
      "Usage: pr open <branch> <title> <body-file> [--draft] or pr edit <n> <body-file> or pr merge <n>"
    );
  }
  if (verb === "resolve-conflicts") {
    if (
      !/^[1-9]\d*$/.test(args[0] ?? "") ||
      (args.length !== 1 && !(args.length === 2 && args[1] === "--retry"))
    ) {
      throw new Error("Usage: resolve-conflicts <pr> [--retry]");
    }
    return transport.call(
      "resolveConflicts",
      { ref: args[0], ...(args.length === 2 ? { retry: true } : {}) },
      ctx
    );
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
      "--model-override": "modelOverride",
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
          'Usage: open-task <issue> [--direct title] [--unapproved reason] [--hold] [--part] [--model family] [--model-override "reason"] [--from branch] [--owner-approved]'
        );
      }
    }
    return transport.call("openTask", input, ctx);
  }
  if (verb === "review") {
    const input: ReviewInput = {
      ref: args[0],
      outcome: args[1] as ReviewInput["outcome"],
      file: "",
    };
    const usage =
      "Usage: review <pr> changes|owner|answer|ask|approve <file> [--in-reply-to url] [--owner-agreed url]";
    for (let i = 2; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--in-reply-to" || arg === "--owner-agreed") {
        const key = arg === "--in-reply-to" ? "replyTo" : "ownerAgreed";
        const value = args[++i];
        if (input[key] || !value || value.startsWith("--")) {
          throw new Error(usage);
        }
        input[key] = value;
      } else if (!input.file && !arg.startsWith("--")) {
        input.file = arg;
      } else {
        throw new Error(usage);
      }
    }
    if (!input.ref || !input.outcome || !input.file) {
      throw new Error(usage);
    }
    return transport.call("reviewTask", input, ctx);
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
  if (verb === "close-task") {
    const usage = "Usage: close-task <pr> [--comment file]";
    if (!args.length) {
      throw new Error(usage);
    }
    let comment: string | undefined;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--comment" && comment === undefined) {
        comment = args[++i];
        if (!comment || comment.startsWith("--")) {
          throw new Error(usage);
        }
      } else {
        throw new Error(usage);
      }
    }
    if (!/^[1-9]\d*$/.test(args[0])) {
      throw new Error(usage);
    }
    return transport.call(
      "closeTask",
      { ref: args[0], ...(comment !== undefined ? { comment } : {}) },
      ctx
    );
  }
  if (verb === "release-hold" && args.length === 1) {
    return transport.call("releaseHold", { ref: args[0] }, ctx);
  }
  throw new Error("Usage: release-hold <pr>");
}
