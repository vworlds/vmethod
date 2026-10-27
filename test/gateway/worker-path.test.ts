import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { expect, test } from "vitest";
import { githubToken } from "../../src/gateway/github-token.js";
import { taskEnvironment } from "../../src/gateway/worker-context.js";
import {
  workerCheckout,
  workerCheckoutIsSelf,
  workerWorktreeName,
  workerWorktreePrefix,
} from "../../src/gateway/worker-path.js";
import { getConfig } from "../../src/config.js";
import { fixture, ghConfig, validProject } from "../helpers.js";

test("workerCheckout resolves relative to the orchestrator checkout and refuses the checkout itself", () => {
  const root = fixture();
  expect(workerCheckout(root, { workerCheckout: "../worker" })).toBe(resolve(root, "../worker"));
  expect(workerCheckout(root, { workerCheckout: "/srv/worker" })).toBe("/srv/worker");
  expect(() => workerCheckout(root, {})).toThrow("Set workerCheckout in vmethod.yaml");
  expect(() => workerCheckout(root, { workerCheckout: "." })).toThrow("separate clone");
});

test("VMETHOD_WORKER_CHECKOUT overrides workerCheckout per machine", () => {
  const root = validProject();
  const config = getConfig(root, { VMETHOD_WORKER_CHECKOUT: "/srv/machine-worker" });
  expect(workerCheckout(root, config)).toBe("/srv/machine-worker");
});

test("workerCheckoutIsSelf reports a worker checkout's own config and never a missing value", () => {
  const root = fixture();
  expect(workerCheckoutIsSelf(root, { workerCheckout: `../${basename(root)}` })).toBe(true);
  expect(workerCheckoutIsSelf(root, { workerCheckout: root })).toBe(true);
  expect(workerCheckoutIsSelf(root, { workerCheckout: "../worker" })).toBe(false);
  expect(workerCheckoutIsSelf(root, {})).toBe(false);
});

test("worker worktree names carry the prefix and flatten branch slashes", () => {
  expect(workerWorktreeName({}, "12-fix")).toBe("auto-12-fix");
  expect(workerWorktreeName({ branches: { worktreePrefix: "w-" } }, "track/12-fix")).toBe(
    "w-track-12-fix"
  );
  expect(() => workerWorktreePrefix({ branches: { worktreePrefix: "a/b" } })).toThrow(
    "Invalid branches.worktreePrefix"
  );
});

test("taskEnvironment loads only the task variables and never overrides the environment", () => {
  const root = fixture();
  expect(taskEnvironment(root, { A: "1" })).toEqual({ A: "1" });
  mkdirSync(join(root, ".vmethod"));
  writeFileSync(
    join(root, ".vmethod/.env"),
    "# written by worker start\nVMETHOD_ROLE=worker\nVMETHOD_TASK_PR=42\n\n"
  );
  expect(taskEnvironment(root, {})).toEqual({ VMETHOD_ROLE: "worker", VMETHOD_TASK_PR: "42" });
  expect(taskEnvironment(root, { VMETHOD_ROLE: "orchestrator" })).toEqual({
    VMETHOD_ROLE: "orchestrator",
    VMETHOD_TASK_PR: "42",
  });
  writeFileSync(join(root, ".vmethod/.env"), "GH_TOKEN=x\n");
  expect(() => taskEnvironment(root, {})).toThrow("Invalid line in .vmethod/.env");
});

test("githubToken reads the gh login in GH_CONFIG_DIR and never GH_TOKEN", () => {
  expect(githubToken({ GH_CONFIG_DIR: ghConfig("from-config"), GH_TOKEN: "ignored" })).toBe(
    "from-config"
  );
  expect(() => githubToken({ GH_TOKEN: "ignored" })).toThrow("Missing GH_CONFIG_DIR");
  const empty = join(fixture(), "gh");
  mkdirSync(empty);
  expect(() => githubToken({ GH_CONFIG_DIR: empty })).toThrow("No gh login in GH_CONFIG_DIR");
  writeFileSync(join(empty, "hosts.yml"), "github.com:\n    user: keyring-user\n");
  // A keyring login asks gh; without gh on PATH there is no token to report.
  expect(() => githubToken({ GH_CONFIG_DIR: empty, PATH: "/nonexistent" })).toThrow(
    "No GitHub token for github.com"
  );
});
