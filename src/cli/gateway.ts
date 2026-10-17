import type { Transport, CallContext } from "../gateway/transport.js";
import type { ReadInput } from "../gateway/server.js";

export async function gatewayVerb(
  transport: Transport,
  verb: string,
  args: string[],
  env: NodeJS.ProcessEnv = {}
): Promise<string> {
  const ctx = context(env);
  switch (verb) {
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
      const [action, ...flags] = args;
      if (
        (action !== "status" && action !== "migrate") ||
        (action === "status" && flags.length) ||
        flags.some((flag) => !["--dry-run", "--steal"].includes(flag)) ||
        new Set(flags).size !== flags.length
      ) {
        throw new Error("Usage: vmethod board status|migrate [--dry-run] [--steal]");
      }
      return JSON.stringify(
        action === "status"
          ? await transport.call("boardStatus", {}, ctx)
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
      if (args.length !== 2) {
        throw new Error("Usage: vmethod post <ref> <file>");
      }
      return transport.call("post", { ref: args[0], file: args[1] }, ctx);
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
