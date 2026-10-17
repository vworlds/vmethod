import type { Transport, Verdict } from "../gateway/transport.js";
import { context } from "./gateway.js";

/** CI verbs parse options only; the gateway owns policy and execution. */
export async function ciVerb(
  transport: Transport,
  verb: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<Verdict> {
  const ctx = context(env);
  if (verb === "verify") {
    const refs: string[] = [];
    let packages: string[] | undefined;
    let bench = false;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === "--packages" && packages === undefined) {
        const value = args[++index];
        if (!value?.trim() || value.startsWith("--")) {
          throw new Error("--packages requires a space-separated workspace list");
        }
        packages = value.trim().split(/\s+/);
      } else if (arg === "--bench" && !bench) {
        bench = true;
      } else if (arg.startsWith("-")) {
        throw new Error(`Unknown or repeated verify option: ${arg}`);
      } else {
        refs.push(arg);
      }
    }
    if (!refs.length) {
      throw new Error('Usage: vmethod verify <pr>… [--packages "<ws>…"] [--bench]');
    }
    return transport.call("verify", { refs, packages, bench }, ctx);
  }
  if (verb === "wait-checks" && args.length >= 1 && args.length <= 2) {
    const maxMinutes = args[1] === undefined ? 30 : Number(args[1]);
    if (!Number.isFinite(maxMinutes) || maxMinutes < 0) {
      throw new Error("Invalid wait-checks minute limit");
    }
    return transport.call("waitChecks", { ref: args[0], maxMinutes }, ctx);
  }
  if (args.length !== 1) {
    throw new Error(`Usage: vmethod ${verb} <pr>`);
  }
  if (verb === "refresh-checks") {
    return transport.call("refreshChecks", { ref: args[0] }, ctx);
  }
  if (verb === "check-task-ci") {
    return transport.call("checkTaskCi", { ref: args[0] }, ctx);
  }
  throw new Error("Unknown CI verb");
}
