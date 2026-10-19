import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { check } from "../check.js";
import { configValue, getConfig } from "../config.js";
import { init } from "../init.js";
import { verbs } from "../registry.js";
import { createGateway } from "../gateway/server.js";
import { checkOnline } from "../gateway/identity.js";
import { gatewayVerb } from "./gateway.js";
import { workerVerb } from "./worker.js";
import { taskFlowVerb } from "./task-flow.js";
import { ciVerb } from "./ci.js";
import { learningsVerb } from "./learnings.js";
import { MarkdownDependencyError } from "../gateway/markdown.js";
import { execFile, execFileSync } from "node:child_process";
import { watchClient } from "./watch.js";
import { promisify } from "node:util";
import { inferWorkerEnvironment } from "../gateway/worker-context.js";
import type { Dependencies } from "../gateway/client.js";

declare const __VERSION__: string;
declare const __BOARD_VERSION__: number;

const [verb, ...args] = process.argv.slice(2);

// Resolved once per run, exactly like the stubs: VMETHOD_ROOT first, then git
// discovery. The cwd is never the root, so commands work from subdirectories.
let projectRoot: string | undefined;
function root(): string {
  if (projectRoot) {
    return projectRoot;
  }
  if (process.env.VMETHOD_ROOT) {
    return (projectRoot = resolve(process.env.VMETHOD_ROOT));
  }
  try {
    return (projectRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim());
  } catch {
    throw new Error("vmethod: git could not find a repository; set VMETHOD_ROOT");
  }
}
try {
  switch (verb) {
    case "learnings":
    case "worker":
    case "worktrees":
    case "suggest-model":
    case "grade":
    case "cost":
    case "read":
    case "watch":
    case "mute":
    case "unmute":
    case "mutes":
    case "post":
    case "gh-read":
    case "board":
    case "issue":
    case "scope-review":
    case "dropped":
    case "start-task":
    case "read-pr":
    case "pr-comment":
    case "push":
    case "open-task":
    case "review":
    case "ask":
    case "merge-task":
    case "link-task":
    case "release-hold":
    case "wait-checks":
    case "verify":
    case "refresh-checks":
    case "check-task-ci": {
      const dependencies = {
        fetch,
        exec: async (file, args, options) =>
          (
            await promisify(execFile)(file, [...args], {
              timeout: ["verify", "merge-task"].includes(verb) ? 1800000 : 30000,
              ...options,
            })
          ).stdout,
        now: Date.now,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        report: (message) => console.error(message),
      } satisfies Dependencies;
      const transport = createGateway(root(), process.env, dependencies);
      const env = await inferWorkerEnvironment(root(), process.env, transport, dependencies);
      if (verb === "learnings") {
        console.log(await learningsVerb(transport, args, env));
        break;
      }
      if (verb === "watch") {
        await watchClient(transport, args, env);
        break;
      }
      if (["wait-checks", "verify", "refresh-checks", "check-task-ci"].includes(verb)) {
        const result = await ciVerb(transport, verb, args, env);
        console.log(result.text);
        process.exitCode = result.code;
        break;
      }
      const output = ["start-task", "read-pr", "pr-comment", "push"].includes(verb)
        ? await workerVerb(transport, root(), verb, args, env, {
            exec: async (file, args, options) =>
              (
                await promisify(execFile)(file, [...args], {
                  timeout: 300000,
                  ...options,
                })
              ).stdout,
            report: (message) => console.error(message),
          })
        : ["open-task", "review", "ask", "merge-task", "link-task", "release-hold"].includes(verb)
          ? await taskFlowVerb(transport, verb, args, env)
          : await gatewayVerb(transport, verb, args, env);
      if (output) {
        console.log(output);
      }
      break;
    }
    case "check-markdown":
      await workerVerb(undefined, root(), verb, args, process.env, {
        exec: async () => {
          throw new Error("Unexpected exec");
        },
        report: (message) => console.error(message),
      });
      break;
    case "version":
      console.log(`vmethod ${__VERSION__}\nboard ${__BOARD_VERSION__}\nNode ${process.version}`);
      break;
    case "config": {
      if (args.length !== 2 || args[0] !== "get") {
        throw new Error("Usage: vmethod config get <key>");
      }
      const value = configValue(getConfig(root(), process.env), args[1]);
      console.log(typeof value === "object" ? stringify(value).trimEnd() : String(value));
      break;
    }
    case "check": {
      if (
        args.some((arg) => !["--online", "--defer-permissions"].includes(arg)) ||
        new Set(args).size !== args.length
      ) {
        throw new Error("Usage: vmethod check [--online] [--defer-permissions]");
      }
      const result = check(root(), process.env, {
        deferPermissions: args.includes("--defer-permissions"),
        version: __VERSION__,
      });
      if (args.includes("--online")) {
        const online = await checkOnline(root(), process.env, {
          fetch,
          exec: async () => {
            throw new Error("Unexpected identity-check exec");
          },
          now: Date.now,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          report: (message) => console.error(message),
        });
        result.messages.push(...online.messages);
        if (online.code && !result.code) {
          result.code = online.code;
        }
      }
      console.log(result.messages.length ? result.messages.join("\n") : "vmethod check: ok");
      process.exitCode = result.code;
      break;
    }
    case "init": {
      if (args.length && (args.length !== 1 || args[0] !== "--dry-run")) {
        throw new Error("Usage: vmethod init [--dry-run]");
      }
      const templates = resolve(dirname(fileURLToPath(import.meta.url)), "../templates");
      console.log(
        init(root(), templates, args.includes("--dry-run")).join("\n") || "Already initialized"
      );
      console.log(
        "Owner: install templates/claude-settings.json from @vworlds/vmethod as .claude/settings.json."
      );
      break;
    }
    default:
      throw new Error(`Usage: vmethod <${verbs.map((entry) => entry.name).join("|")}>`);
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = error instanceof MarkdownDependencyError ? 2 : 1;
}
