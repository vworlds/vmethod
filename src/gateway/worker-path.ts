import { resolve } from "node:path";
import type { Config } from "../config.js";

/**
 * The workers' own clone of the repository: `workerCheckout` in vmethod.yaml,
 * overridden per machine by `VMETHOD_WORKER_CHECKOUT`, relative to the
 * orchestrator's checkout. This is the only place it is read. Worker sessions run
 * in worktrees of it, so they never share the orchestrator's checkout or `.git`.
 */
export function workerCheckout(root: string, config: Config): string {
  const value = config.workerCheckout;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      "Set workerCheckout in vmethod.yaml (or VMETHOD_WORKER_CHECKOUT) to the workers' own clone of the repository"
    );
  }
  const checkout = resolve(root, value);
  if (checkout === resolve(root)) {
    throw new Error("workerCheckout must be a separate clone, not the orchestrator's checkout");
  }
  return checkout;
}

/** Whether the configured worker checkout resolves into the given checkout itself.
 * A worker checkout's own copy of the repository config names the workers' clone
 * relative to the orchestrator's checkout, so it resolves to itself there; a
 * missing value never is.
 */
export function workerCheckoutIsSelf(root: string, config: Config): boolean {
  const value = config.workerCheckout;
  return typeof value === "string" && !!value.trim() && resolve(root, value) === resolve(root);
}

/** The worktree name a task branch gets in the worker checkout. */
export function workerWorktreeName(config: Config, branch: string): string {
  return `${workerWorktreePrefix(config)}${branch.replaceAll("/", "-")}`;
}

/** Return the literal worktree prefix shared by worktree names and legacy key decoding. */
export function workerWorktreePrefix(config: Config): string {
  const prefix = (config.branches as { worktreePrefix?: unknown } | undefined)?.worktreePrefix;
  if (prefix === undefined) {
    return "auto-";
  }
  if (typeof prefix !== "string" || /[/\\\r\n]/.test(prefix)) {
    throw new Error("Invalid branches.worktreePrefix");
  }
  return prefix;
}
