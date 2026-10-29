import { execFileSync } from "node:child_process";
import { testConfig } from "../config.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Dependencies } from "../../src/gateway/client.js";
import { WorkerWorktrees } from "../../src/gateway/worker-launch.js";
import { fixture, ghConfig } from "../helpers.js";

/** An origin with a task branch, the orchestrator's clone and the workers' own clone. */
function setup(files: Record<string, string> = {}) {
  const run = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const origin = fixture();
  run(origin, "init", "-q", "-b", "dev");
  run(origin, "config", "user.name", "Test");
  run(origin, "config", "user.email", "test@example.invalid");
  writeFileSync(join(origin, ".gitignore"), "node_modules/\n");
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(origin, name), text);
  }
  run(origin, "add", ".");
  run(origin, "commit", "-q", "-m", "initial");
  run(origin, "branch", "7-task");
  const root = join(fixture(), "orchestrator");
  const checkout = join(fixture(), "worker");
  run(origin, "clone", "-q", origin, root);
  run(origin, "clone", "-q", origin, checkout);
  const trees = fixture();
  const calls: string[] = [];
  const deps: Dependencies = {
    exec: async (file, args, options) => {
      calls.push(`${file} ${args.join(" ")}`);
      if (file === "npm") {
        expect(options?.env).toEqual({ HUSKY: "0", PATH: "/usr/bin" });
        if (args[0] === "ci" && args.length === 1) {
          expect(options?.timeout).toBe(900000);
          mkdirSync(join(String(options?.cwd), "node_modules/.bin"), { recursive: true });
          writeFileSync(join(String(options?.cwd), "node_modules/.bin/vmethod"), "", {
            mode: 0o755,
          });
        }
        return "";
      }
      expect(file).toBe("git");
      const fetch = args.indexOf("fetch");
      // The gateway fetches over HTTPS from GitHub; the fixture fetches from origin.
      const local = fetch >= 0 ? ["fetch", "-q", origin, ...args.slice(fetch + 3)] : [...args];
      return execFileSync("git", local, {
        cwd: options?.cwd,
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      expect(url.host).toBe("opencode.test");
      calls.push(`opencode ${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname === "/api/location") {
        expect(url.searchParams.get("location[directory]")).toBe(checkout);
        return Response.json({ directory: checkout, project: { id: "project-id" } });
      }
      expect(url.pathname).toBe("/api/worktree");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        projectID: "project-id",
        from: checkout,
        name: "auto-7-task",
        branch: "7-task",
      });
      // Like OpenCode: the branch must exist and is checked out detached.
      const directory = join(trees, body.name);
      run(checkout, "worktree", "add", "-q", "--detach", directory, body.branch);
      return Response.json({ directory });
    },
    now: () => 0,
    sleep: async () => {},
    report: () => {},
  };
  const env = {
    PATH: "/usr/bin",
    GH_CONFIG_DIR: ghConfig("orchestrator-token"),
    OPENCODE_BASE_URL: "http://opencode.test",
    OPENCODE_SERVER_USERNAME: "user",
    OPENCODE_SERVER_PASSWORD: "password",
  };
  const config = testConfig({ workerCheckout: checkout });
  return {
    root,
    checkout,
    trees,
    calls,
    run,
    worktrees: () => new WorkerWorktrees(root, config, env, deps),
  };
}

test("prepare creates the task worktree in the worker checkout through OpenCode, on the branch, with the task env", async () => {
  const f = setup();
  const directory = await f.worktrees().prepare({ pr: 7, branch: "7-task", base: "dev" });
  expect(directory).toBe(join(f.trees, "auto-7-task"));
  expect(f.run(directory, "rev-parse", "--abbrev-ref", "HEAD")).toBe("7-task");
  expect(f.run(directory, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/7-task");
  expect(readFileSync(join(directory, ".vmethod/.env"), "utf8")).toBe(
    "VMETHOD_ROLE=worker\nVMETHOD_TASK_PR=7\n"
  );
  // The task env never shows up as a change, in this or any later worktree.
  expect(f.run(directory, "status", "--porcelain", "--untracked-files=all")).toBe("");
  expect(readFileSync(join(f.checkout, ".git/info/exclude"), "utf8")).toContain("/.vmethod/.env\n");
  // Nothing touched the orchestrator's checkout.
  expect(f.run(f.root, "worktree", "list", "--porcelain")).not.toContain("7-task");
  expect(f.calls.filter((call) => call.startsWith("opencode"))).toEqual([
    "opencode GET /api/location",
    "opencode POST /api/worktree",
  ]);
  // A second launch reuses the tree and creates nothing.
  f.calls.length = 0;
  expect(await f.worktrees().prepare({ pr: 7, branch: "7-task", base: "dev" })).toBe(directory);
  expect(f.calls.some((call) => call.startsWith("opencode"))).toBe(false);
  expect(
    readFileSync(join(f.checkout, ".git/info/exclude"), "utf8").split("/.vmethod/.env")
  ).toHaveLength(2);
  expect(await f.worktrees().locate("7-task")).toBe(directory);
}, 15000);

test("prepare installs once per package-lock.json and requires the vmethod bin", async () => {
  const f = setup({
    "package.json": JSON.stringify({ name: "consumer" }),
    "package-lock.json": "{}\n",
  });
  const directory = await f.worktrees().prepare({ pr: 7, branch: "7-task", base: "dev" });
  expect(f.calls.filter((call) => call.startsWith("npm"))).toEqual([
    "npm ci --dry-run --no-audit --no-fund --ignore-scripts",
    "npm ci",
  ]);
  expect(existsSync(join(directory, "node_modules/.package-lock.sha"))).toBe(true);
  f.calls.length = 0;
  await f.worktrees().prepare({ pr: 7, branch: "7-task", base: "dev" });
  expect(f.calls.filter((call) => call.startsWith("npm"))).toEqual([
    "npm ci --dry-run --no-audit --no-fund --ignore-scripts",
  ]);
}, 15000);

test("locate never creates, and a worker checkout sharing the orchestrator's .git is refused", async () => {
  const f = setup();
  await expect(f.worktrees().locate("7-task")).rejects.toThrow(
    "No worktree of the worker checkout is on 7-task"
  );
  expect(f.calls.some((call) => call.startsWith("opencode"))).toBe(false);
  const shared = new WorkerWorktrees(
    f.root,
    testConfig({ workerCheckout: join(f.root, ".worktrees/linked") }),
    {},
    {
      exec: async (file, args, options) =>
        execFileSync(file, [...args], { cwd: options?.cwd, encoding: "utf8" }),
      fetch,
      now: () => 0,
      sleep: async () => {},
      report: () => {},
    }
  );
  f.run(f.root, "worktree", "add", "-q", join(f.root, ".worktrees/linked"));
  await expect(shared.prepare({ pr: 7, branch: "7-task", base: "dev" })).rejects.toThrow(
    "workerCheckout shares the orchestrator's .git"
  );
}, 15000);
