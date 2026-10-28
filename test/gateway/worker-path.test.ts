import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { expect, test } from "vitest";
import { githubToken } from "../../src/gateway/github-token.js";
import { taskEnvironment } from "../../src/gateway/worker-context.js";
import {
  workerCheckout,
  workerCheckoutIsSelf,
  mainCheckoutRoot,
  workerWorktreeName,
  workerWorktreePrefix,
} from "../../src/gateway/worker-path.js";
import { getConfig } from "../../src/config.js";
import { check } from "../../src/check.js";
import { parse, stringify } from "yaml";
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

test("workerCheckout resolves relative to the main checkout from a linked worktree", () => {
  const root = fixture();
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-qm",
    "initial",
  ]);
  const linked = join(root, ".worktrees/review");
  mkdirSync(join(root, ".worktrees"));
  execFileSync("git", ["-C", root, "worktree", "add", "-q", "--detach", linked, "HEAD"]);

  expect(mainCheckoutRoot(root)).toBe(root);
  expect(mainCheckoutRoot(linked)).toBe(root);
  expect(workerCheckout(root, { workerCheckout: "../worker" })).toBe(resolve(root, "../worker"));
  expect(workerCheckout(linked, { workerCheckout: "../worker" })).toBe(resolve(root, "../worker"));
});

test("check from a linked worktree accepts a worker clone beside the main checkout", () => {
  const root = validProject();
  const workerName = `${basename(root)}-worker`;
  const worker = join(root, "..", workerName);
  const linked = join(root, ".worktrees/review");
  mkdirSync(join(root, ".worktrees"));
  mkdirSync(join(worker, ".git"), { recursive: true });
  writeFileSync(
    join(root, "vmethod.yaml"),
    readFileSync(join(root, "vmethod.yaml"), "utf8").replace(
      "workerCheckout: ../example-worker",
      `workerCheckout: ../${workerName}`
    )
  );
  const modelFile = join(root, "models.yaml");
  const models = parse(readFileSync(modelFile, "utf8")) as Record<string, unknown>[];
  writeFileSync(
    modelFile,
    stringify(models.map((model) => ({ ...model, price: { input: 1, output: 2, cached: 0.1 } })))
  );
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "add", "-f", ".claude/settings.json"]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "initial",
  ]);
  execFileSync("git", ["-C", root, "worktree", "add", "-q", "--detach", linked, "HEAD"]);

  const result = check(linked, {
    VMETHOD_ROLE: "orchestrator",
    GIT_AUTHOR_NAME: "A",
    GIT_AUTHOR_EMAIL: "a@b",
    GIT_COMMITTER_NAME: "C",
    GIT_COMMITTER_EMAIL: "c@b",
  });
  rmSync(worker, { recursive: true, force: true });
  expect(result).toEqual({ code: 0, messages: [] });
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
