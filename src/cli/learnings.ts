import { context, type Transport } from "../gateway/transport.js";
import type { LearningInput } from "../gateway/learnings.js";
import type { AnnotationInput } from "../gateway/learning-annotations.js";

/** Parse the learning CLI without performing filesystem or network operations. */
export async function learningsVerb(
  transport: Transport,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<string> {
  const [action, ...flags] = args;
  const ctx = context(env);
  if (action === "annotate" || action === "aggregate") {
    const input: AnnotationInput = { action };
    const seen = new Set<string>();
    for (let i = 0; i < flags.length; i++) {
      const flag = flags[i];
      if (seen.has(flag)) {
        throw new Error(`Duplicate flag: ${flag}`);
      }
      seen.add(flag);
      if (action === "annotate" && flag === "--force") {
        input.force = true;
        continue;
      }
      const value = flags[++i];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${flag}`);
      }
      if (flag === "--model") {
        input.model = value;
      } else if (
        action === "annotate" &&
        flag === "--pr" &&
        /^[1-9]\d*$/.test(value) &&
        Number.isSafeInteger(Number(value))
      ) {
        input.pr = Number(value);
      } else if (
        action === "annotate" &&
        flag === "--since" &&
        /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) &&
        Number.isFinite(Date.parse(value))
      ) {
        input.since = value;
      } else {
        throw new Error(`Invalid learnings argument: ${flag}`);
      }
    }
    if (input.pr && input.since) {
      throw new Error("Choose --pr or --since");
    }
    return transport.call("learnings", input, ctx);
  }
  if (action === "merge") {
    if (flags.length !== 1 || !/^[1-9]\d*$/.test(flags[0] ?? "")) {
      throw new Error("Usage: learnings merge <pr> (central repository)");
    }
    return transport.call("learnings", { action: "merge", pr: Number(flags[0]) }, ctx);
  }
  if (action === "check-pr") {
    if (
      flags.length < 1 ||
      flags.length > 2 ||
      !/^[1-9]\d*$/.test(flags[0]) ||
      (flags[1] !== undefined && flags[1] !== "--label")
    ) {
      throw new Error("Usage: learnings check-pr <pr> [--label] (CI)");
    }
    return transport.call("learningCheck", { ref: flags[0], label: flags[1] === "--label" }, ctx);
  }
  if (!["submit", "show", "report"].includes(action)) {
    throw new Error("Usage: learnings submit|show|report|annotate|aggregate|check-pr|merge");
  }
  const input: LearningInput = { action: action as "submit" | "show" | "report" };
  const seen = new Set<string>();
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (seen.has(flag) && flag !== "--include-text") {
      throw new Error(`Duplicate flag: ${flag}`);
    }
    seen.add(flag);
    if (action === "show" && index === 0 && !flag.startsWith("-")) {
      input.family = flag;
      continue;
    }
    if (action === "report" && flag === "--json") {
      input.json = true;
      continue;
    }
    const allowed =
      action === "submit"
        ? ["--notes", "--include-text"]
        : action === "report"
          ? ["--family", "--kind"]
          : [];
    const value = flags[++index];
    if (!allowed.includes(flag) || !value || value.startsWith("--")) {
      throw new Error(`Invalid learnings argument: ${flag}`);
    }
    if (flag === "--include-text") {
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error("--include-text requires a PR number");
      }
      (input.includeText ??= []).push(Number(value));
    } else if (flag === "--notes") {
      input.notes = value;
    } else if (flag === "--family") {
      input.family = value;
    } else if (flag === "--kind") {
      input.kind = value;
    }
  }
  return transport.call("learnings", input, ctx);
}
