import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { check } from "../check.js";
import { configValue, getConfig } from "../config.js";
import { init } from "../init.js";
import { verbs } from "../registry.js";
import { createGateway } from "../gateway/server.js";
import { gatewayVerb } from "./gateway.js";
import { workerVerb } from "./worker.js";
import { MarkdownDependencyError } from "../gateway/markdown.js";
import { execFile, execFileSync } from "node:child_process";
import { watchClient } from "./watch.js";
import { promisify } from "node:util";

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
    case "read":
    case "watch":
    case "mute":
    case "unmute":
    case "mutes":
    case "post":
    case "gh-read":
    case "board":
    case "dropped":
    case "start-task":
    case "read-pr":
    case "pr-comment":
    case "push":
    case "wait-review": {
      const transport = createGateway(root(), process.env, {
        fetch,
        exec: async (file, args, options) =>
          (
            await promisify(execFile)(file, [...args], {
              timeout: 30000,
              ...options,
            })
          ).stdout,
        now: Date.now,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        report: (message) => console.error(message),
      });
      if (verb === "watch") {
        await watchClient(transport, args, process.env);
        break;
      }
      const output = ["start-task", "read-pr", "pr-comment", "push", "wait-review"].includes(verb)
        ? await workerVerb(transport, root(), verb, args, process.env, {
            exec: async (file, args, options) =>
              (
                await promisify(execFile)(file, [...args], {
                  timeout: 300000,
                  ...options,
                })
              ).stdout,
            report: (message) => console.error(message),
          })
        : await gatewayVerb(transport, verb, args, process.env);
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
      if (args.length) {
        throw new Error("Usage: vmethod check (offline)");
      }
      const result = check(root(), process.env);
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
