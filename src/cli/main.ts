import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { check, launcherReport } from "../check.js";
import { configValue, getConfig } from "../config.js";
import { init, installLauncher, launcherDir } from "../init.js";
import { verbs } from "../registry.js";
import { createGateway } from "../gateway/server.js";
import { checkOnline } from "../gateway/identity.js";
import { gatewayVerb } from "./gateway.js";
import { workerVerb } from "./worker.js";
import { taskFlowVerb } from "./task-flow.js";
import { ciVerb } from "./ci.js";
import { learningsVerb } from "./learnings.js";
import { releaseVerb } from "./release.js";
import { MarkdownDependencyError } from "../gateway/markdown.js";
import { execFile, execFileSync } from "node:child_process";
import { watchClient } from "./watch.js";
import { promisify } from "node:util";
import { taskEnvironment } from "../gateway/worker-context.js";
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
    case "release":
    case "worker":
    case "worktrees":
    case "suggest-model":
    case "limits":
    case "grade":
    case "read":
    case "watch":
    case "mute":
    case "unmute":
    case "mutes":
    case "post":
    case "gh-read":
    case "board":
    case "issue":
    case "upstream":
    case "scope-review":
    case "autopilot":
    case "dropped":
    case "read-pr":
    case "pr-comment":
    case "push":
    case "open-task":
    case "pr":
    case "review":
    case "ask":
    case "merge-task":
    case "close-task":
    case "resolve-conflicts":
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
              timeout: ["verify", "merge-task", "pr", "resolve-conflicts"].includes(verb)
                ? 1800000
                : 30000,
              ...options,
            })
          ).stdout,
        now: Date.now,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        report: (message) => console.error(message),
      } satisfies Dependencies;
      const transport = createGateway(root(), process.env, dependencies);
      const env = taskEnvironment(root(), process.env);
      if (verb === "learnings") {
        console.log(await learningsVerb(transport, args, env));
        break;
      }
      if (verb === "release") {
        console.log(await releaseVerb(transport, args, env));
        break;
      }
      if (verb === "watch") {
        // A watcher terminated through `watch --stop` exits via SIGTERM: this
        // handler lets the process run its exit hook and release the lock (#340).
        process.on("SIGTERM", () => process.exit(0));
        const stopCode = await watchClient(transport, args, env);
        if (stopCode !== undefined) {
          process.exitCode = stopCode;
        }
        break;
      }
      if (["wait-checks", "verify", "refresh-checks", "check-task-ci"].includes(verb)) {
        const result = await ciVerb(transport, verb, args, env);
        console.log(result.text);
        process.exitCode = result.code;
        break;
      }
      const output = ["read-pr", "pr-comment", "push"].includes(verb)
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
        : [
              "open-task",
              "pr",
              "review",
              "ask",
              "merge-task",
              "close-task",
              "resolve-conflicts",
              "link-task",
              "release-hold",
            ].includes(verb)
          ? await taskFlowVerb(transport, verb, args, env)
          : await gatewayVerb(transport, verb, args, env);
      if (output) {
        if (typeof output === "string") {
          console.log(output);
        } else {
          console.log(output.text);
          process.exitCode = output.code;
        }
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
      if (process.env.npm_lifecycle_event === undefined) {
        console.log(launcherReport(process.env));
      }
      process.exitCode = result.code;
      break;
    }
    case "init": {
      if (args[0] === "--launcher") {
        if (args.length > 2 || (args[1] !== undefined && args[1].startsWith("-"))) {
          throw new Error("Usage: vmethod init --launcher [dir]");
        }
        console.log(installLauncher(launcherDir(args[1])));
        break;
      }
      if (args.length && (args.length !== 1 || args[0] !== "--dry-run")) {
        throw new Error("Usage: vmethod init [--dry-run] or init --launcher [dir]");
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
  console.error(
    verb === "board" && args[0] === "migrate"
      ? JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
      : (error as Error).message
  );
  process.exitCode = error instanceof MarkdownDependencyError ? 2 : 1;
}
