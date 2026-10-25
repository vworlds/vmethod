import { context, type Transport, type CallContext } from "../gateway/transport.js";
import type { ReadInput } from "../gateway/server.js";

export async function gatewayVerb(
  transport: Transport,
  verb: string,
  args: string[],
  env: NodeJS.ProcessEnv = {}
): Promise<string> {
  const ctx = context(env);
  switch (verb) {
    case "issue": {
      if ((args[0] === "block" || args[0] === "unblock") && args.length === 3) {
        return transport.call(
          args[0] === "block" ? "issueBlock" : "issueUnblock",
          { ref: args[1], blocker: args[2] },
          ctx
        );
      }
      if (args[0] === "edit" && args.length === 3) {
        return transport.call("issueEdit", { ref: args[1], file: args[2] }, ctx);
      }
      if (args[0] === "create" && args.length >= 3) {
        const labels: string[] = [];
        let estimate: number | undefined;
        let status: string | undefined;
        for (let i = 3; i < args.length; i += 2) {
          const flag = args[i],
            value = args[i + 1];
          if (
            !["--label", "--estimate", "--status"].includes(flag) ||
            !value ||
            value.startsWith("--")
          ) {
            throw new Error(
              "Usage: issue create <title> <body-file> [--label l] [--estimate n] [--status name]"
            );
          }
          if (flag === "--label") {
            labels.push(value);
          }
          if (flag === "--status") {
            if (status !== undefined) {
              throw new Error("Usage: --status may appear only once");
            }
            status = value;
          }
          if (flag === "--estimate") {
            if (
              estimate !== undefined ||
              !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) ||
              !Number.isFinite(Number(value))
            ) {
              throw new Error("Usage: --estimate requires a finite nonnegative number, once");
            }
            estimate = Number(value);
          }
        }
        return transport.call(
          "issueCreate",
          {
            title: args[1],
            file: args[2],
            labels,
            ...(estimate === undefined ? {} : { estimate }),
            ...(status === undefined ? {} : { status }),
          },
          ctx
        );
      }
      if (
        args[0] === "close" &&
        (args.length === 2 || (args.length === 4 && args[2] === "--comment"))
      ) {
        return transport.call("issueClose", { ref: args[1], comment: args[3] }, ctx);
      }
      if (args[0] === "estimate" && args.length === 3) {
        if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(args[2]) || !Number.isFinite(Number(args[2]))) {
          throw new Error(
            "Usage: issue estimate <n> <points>; <points> requires a finite nonnegative number"
          );
        }
        return transport.call("issueEstimate", { ref: args[1], points: Number(args[2]) }, ctx);
      }
      throw new Error(
        "Usage: issue create <title> <body-file> [--label l] [--estimate n] [--status name] | issue close <n> [--comment file] | issue edit <n> <body-file> | issue block <n> <blocker> | issue unblock <n> <blocker> | issue estimate <n> <points>"
      );
    }
    case "scope-review":
      if (args.length !== 2) {
        throw new Error("Usage: scope-review <issue> <summary-file>");
      }
      return transport.call("scopeReview", { ref: args[0], file: args[1] }, ctx);
    case "autopilot":
      if (args.length === 3 && args[0] === "stop" && ["issue", "pr"].includes(args[1])) {
        return transport.call(
          "autopilotStop",
          { ref: args[2], kind: args[1] as "issue" | "pr" },
          ctx
        );
      }
      if (args.length === 2 && args[0] === "inherit") {
        return transport.call("autopilotInherit", { ref: args[1] }, ctx);
      }
      throw new Error("Usage: autopilot stop <issue|pr> <n> | autopilot inherit <pr>");
    case "worker":
      return transport.call("worker", { args }, ctx);
    case "worktrees":
      if (args.length > 1 || (args[0] && args[0] !== "--prune")) {
        throw new Error("Usage: vmethod worktrees [--prune]");
      }
      return transport.call("worker", { args: ["worktrees", ...args] }, ctx);
    case "suggest-model":
      if (args.length !== 1) {
        throw new Error("Usage: suggest-model <issue>");
      }
      return transport.call("suggestModel", { ref: args[0] }, ctx);
    case "grade":
      if (
        args.length < 1 ||
        args.length > 2 ||
        (args[1] !== undefined && !/^(?:\d+)(?:\.\d+)?$/.test(args[1]))
      ) {
        throw new Error("Usage: grade <pr> [points]");
      }
      return transport.call(
        "grade",
        { ref: args[0], points: args[1] === undefined ? undefined : Number(args[1]) },
        ctx
      );
    case "mute":
    case "unmute":
      if (args.length !== 1) {
        throw new Error(`Usage: vmethod ${verb} <repo#number>`);
      }
      return transport.call(verb === "mute" ? "watchMute" : "watchUnmute", { ref: args[0] }, ctx);
    case "mutes":
      if (args.length) {
        throw new Error("Usage: vmethod mutes");
      }
      return transport.call("watchMutes", {}, ctx);
    default:
      return existingVerb(transport, verb, args, ctx);
  }
}

async function existingVerb(
  transport: Transport,
  verb: string,
  args: string[],
  ctx: CallContext
): Promise<string> {
  switch (verb) {
    case "board": {
      if (args[0] === "set" && args[2] === "Assignees") {
        if (args.length !== 4 || !["owner", "orchestrator", "--clear"].includes(args[3])) {
          throw new Error("Usage: board set <issue|pr> Assignees owner|orchestrator|--clear");
        }
        return transport.call(
          "boardSetAssignees",
          {
            ref: args[1],
            value: args[3] === "--clear" ? null : (args[3] as "owner" | "orchestrator"),
          },
          ctx
        );
      }
      if (args[0] === "set") {
        if (args.length !== 4) {
          throw new Error("Usage: board set <issue> <field> <value>|--clear");
        }
        return transport.call(
          "boardSetIssue",
          { ref: args[1], field: args[2], value: args[3] === "--clear" ? null : args[3] },
          ctx
        );
      }
      const [action, ...flags] = args;
      if (
        (action !== "status" && action !== "migrate") ||
        flags.some((flag) => !["--dry-run", "--steal", "--fix"].includes(flag)) ||
        (action === "status" && flags.some((flag) => flag !== "--fix")) ||
        new Set(flags).size !== flags.length
      ) {
        throw new Error("Usage: vmethod board status [--fix] | migrate [--dry-run] [--steal]");
      }
      return JSON.stringify(
        action === "status"
          ? await transport.call("boardStatus", { fix: flags.includes("--fix") }, ctx)
          : await transport.call(
              "boardMigrate",
              {
                dryRun: flags.includes("--dry-run"),
                steal: flags.includes("--steal"),
              },
              ctx
            ),
        null,
        2
      );
    }
    case "read": {
      const [kind, ref, option] = args;
      if (
        !["pr", "issue", "comment", "checks", "registry"].includes(kind) ||
        !ref ||
        args.length > 3 ||
        (option !== undefined &&
          !["--files", "--diff", "--reviews", "--checks"].includes(option)) ||
        (option !== undefined && kind !== "pr")
      ) {
        throw new Error(
          "Usage: vmethod read pr|issue|comment|checks|registry <ref> [--files|--diff|--reviews|--checks]"
        );
      }
      return transport.call("read", { kind, ref, option } as ReadInput, ctx);
    }
    case "post":
      if (args.length !== 2 && (args.length !== 4 || args[2] !== "--in-reply-to" || !args[3])) {
        throw new Error("Usage: vmethod post <ref> <file> [--in-reply-to url]");
      }
      return transport.call("post", { ref: args[0], file: args[1], replyTo: args[3] }, ctx);
    case "gh-read":
      if (args.length !== 1) {
        throw new Error("Usage: vmethod gh-read <endpoint|file.graphql>");
      }
      return transport.call("ghRead", { source: args[0] }, ctx);
    case "dropped":
      if (args.length && (args.length !== 2 || args[0] !== "--since")) {
        throw new Error("Usage: vmethod dropped [--since <date>]");
      }
      return transport.call("dropped", { since: args[1] }, ctx);
    default:
      throw new Error("Unknown gateway verb");
  }
}
