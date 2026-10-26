import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { basename } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import type { Dependencies } from "../../src/gateway/client.js";
import { WorktreeService, type WorktreeTask } from "../../src/gateway/worktrees.js";
import { fixture } from "../helpers.js";

function setup() {
  const root = fixture();
  const git = (args: string[], cwd = root) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git(["init", "-b", "dev"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.invalid"]);
  writeFileSync(join(root, ".gitignore"), ".worktrees/\nnode_modules/\n.tmp/\n");
  git(["add", ".gitignore"]);
  git(["commit", "-m", "initial"]);
  const head = git(["rev-parse", "HEAD"]);
  const reports: string[] = [];
  const commands: string[] = [];
  const unexpected: string[] = [];
  onTestFinished(() => expect(unexpected).toEqual([]));
  const sessions = new Map<number, "live" | "stopped" | "unknown">();
  const deps: Dependencies = {
    exec: async (file, args, options) => {
      commands.push(`${file} ${args.join(" ")}`);
      if (
        file !== "du" &&
        (file !== "git" ||
          ![
            "worktree",
            "rev-parse",
            "symbolic-ref",
            "status",
            "for-each-ref",
            "rev-list",
            "branch",
            "update-ref",
          ].includes(args[0]))
      ) {
        unexpected.push(`${file} ${args.join(" ")}`);
        throw new Error(`Unexpected command: ${unexpected.at(-1)}`);
      }
      return execFileSync(file, [...args], {
        cwd: options?.cwd,
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    },
    fetch: async () => {
      unexpected.push("network");
      throw new Error("Unexpected network");
    },
    now: () => 0,
    sleep: async () => {
      unexpected.push("sleep");
      throw new Error("Unexpected sleep");
    },
    report: (message) => reports.push(message),
  };
  const config = {
    repo: "example/project",
    baseBranch: "dev",
    releaseBranch: "master",
    branches: { mainCheckout: root },
  };
  const service = () =>
    new WorktreeService(root, config, {}, deps, async (pr) => sessions.get(pr) ?? "stopped");
  const add = (
    pr: number,
    state = "MERGED",
    location = join(root, ".worktrees", `auto-task-${pr}`)
  ) => {
    const branch = `task-${pr}`;
    git(["worktree", "add", "-b", branch, location, "dev"]);
    const task: WorktreeTask = { pr, branch, state, head, base: "dev" };
    return { task, path: location };
  };
  return { root, git, head, deps, config, reports, commands, sessions, service, add };
}

test.each([false, true])(
  "failed du reports size unknown and continues every tree (prune=%s)",
  async (prune) => {
    const f = setup();
    const trees = [f.add(1), f.add(2)];
    const exec = f.deps.exec;
    const measured: string[] = [];
    f.deps.exec = async (file, args, options) => {
      if (file === "du") {
        expect(options?.timeout).toBe(120000);
        measured.push(String(args[2]));
        if (args[2] === trees[0].path) {
          throw new Error("du permission error or timeout");
        }
        return `128\t${args[2]}\n`;
      }
      return exec(file, args, options);
    };
    const output = await f
      .service()
      .list(async (branch) => trees.find((tree) => tree.task.branch === branch)?.task, prune);
    expect(measured).toEqual(trees.map((tree) => tree.path));
    expect(output).toContain(`${trees[0].path}: size unknown; ${prune ? "removed" : "removable"}`);
    expect(output).toContain(`${trees[1].path}: 128 KiB; ${prune ? "removed" : "removable"}`);
    expect(output).toContain(
      `Total ${prune ? "freed" : "removable"}: 128 KiB + 1 tree(s) with size unknown`
    );
    expect(trees.map((tree) => existsSync(tree.path))).toEqual([!prune, !prune]);
  },
  15000
);

test.each(["stopped", "live", "unknown"] as const)(
  "backlog pruning closes sessions before safe removal (%s)",
  async (status) => {
    const f = setup();
    const tree = f.add(1, "CLOSED");
    const close = vi.fn(async () => {
      expect(existsSync(tree.path)).toBe(true);
      return true;
    });
    const service = new WorktreeService(f.root, f.config, {}, f.deps, async () => status, close);
    await service.list(async () => tree.task, false);
    expect(close).not.toHaveBeenCalled();
    await service.list(async () => tree.task, true);
    expect(close.mock.calls).toEqual(status === "stopped" ? [[1]] : []);
    expect(existsSync(tree.path)).toBe(status !== "stopped");
  },
  15000
);

test("invalid du output is unknown rather than a zero measurement", async () => {
  const f = setup();
  const tree = f.add(1);
  const exec = f.deps.exec;
  f.deps.exec = async (file, args, options) =>
    file === "du" ? "invalid measurement" : exec(file, args, options);
  const output = await f.service().list(async () => tree.task, false);
  expect(output).toContain(`${tree.path}: size unknown; removable`);
  expect(output).toContain("Total removable: 0 KiB + 1 tree(s) with size unknown");
  expect(f.reports.join("\n")).toContain("size unknown (du failed or returned invalid output");
}, 15000);

test("cleanup removes ignored dependencies and local branch; a retry is harmless", async () => {
  const f = setup();
  const tree = f.add(1);
  mkdirSync(join(tree.path, "node_modules"));
  writeFileSync(join(tree.path, "node_modules", "payload"), "ignored");
  expect(await f.service().cleanup(tree.task)).toBe(true);
  expect(existsSync(tree.path)).toBe(false);
  expect(f.git(["for-each-ref", "--format=%(refname)", `refs/heads/${tree.task.branch}`])).toBe("");
  expect(await f.service().cleanup(tree.task)).toBe(true);
  expect(f.commands.filter((line) => line.includes("worktree remove"))).toHaveLength(1);
}, 15000);

test("listing and prune include only closed/merged tasks, skip live and unknown sessions, and show sizes", async () => {
  const f = setup();
  const trees = [f.add(1), f.add(2, "CLOSED"), f.add(3, "OPEN"), f.add(4), f.add(5)];
  f.sessions.set(4, "live");
  f.sessions.set(5, "unknown");
  const lookup = async (branch: string) => trees.find((tree) => tree.task.branch === branch)?.task;
  const listing = await f.service().list(lookup, false);
  expect(listing).toContain(`${trees[0].path}:`);
  expect(listing).toMatch(/Total removable: [1-9]\d* KiB/);
  expect(listing).not.toContain(trees[2].path);
  expect(listing).toContain("skipped: worker session live or unknown");
  expect(trees.every((tree) => existsSync(tree.path))).toBe(true);
  const pruned = await f.service().list(lookup, true);
  expect(pruned).toMatch(/Total freed: [1-9]\d* KiB/);
  expect(trees.map((tree) => existsSync(tree.path))).toEqual([false, false, true, true, true]);
  expect(await f.service().list(lookup, true)).toContain("Total freed: 0 KiB");
}, 15000);

test.each(["tracked", "untracked", "unpushed"])(
  "retains and reports %s work",
  async (kind) => {
    const f = setup();
    const tree = f.add(1);
    writeFileSync(join(tree.path, kind === "tracked" ? ".gitignore" : "new-file"), "new work");
    if (kind === "unpushed") {
      f.git(["add", "new-file"], tree.path);
      f.git(["commit", "-m", "not pushed"], tree.path);
    }
    expect(await f.service().cleanup(tree.task)).toBe(false);
    expect(existsSync(tree.path)).toBe(true);
    expect(f.reports.join("\n")).toContain(
      kind === "unpushed" ? "unpushed work" : "uncommitted work"
    );
    expect(f.commands.some((line) => line.includes("worktree remove"))).toBe(false);
  },
  15000
);

test("containment accepts a branch ancestor of the merged head, not a divergent commit", async () => {
  const f = setup();
  const tree = f.add(1);
  writeFileSync(join(tree.path, "pushed"), "data");
  f.git(["add", "pushed"], tree.path);
  f.git(["commit", "-m", "PR commit"], tree.path);
  tree.task.head = f.git(["rev-parse", "HEAD"], tree.path);
  expect(await f.service().cleanup(tree.task)).toBe(true);
}, 15000);

test("never touches foreign roots, unprefixed trees, symlink aliases or the main checkout", async () => {
  const f = setup();
  const outside = f.add(1, "MERGED", join(f.root, "outside", "auto-task-1"));
  const unprefixed = f.add(2, "MERGED", join(f.root, ".worktrees", "task-2"));
  symlinkSync(outside.path, join(f.root, ".worktrees", "auto-task-1"));
  const lookedUp: string[] = [];
  expect(
    await f.service().list(async (branch) => {
      lookedUp.push(branch);
      return outside.task;
    }, true)
  ).toBe("Total freed: 0 KiB");
  expect(lookedUp).toEqual([]);
  expect(await f.service().cleanup(outside.task)).toBe(false);
  expect(await f.service().cleanup(unprefixed.task)).toBe(false);
  expect(existsSync(outside.path)).toBe(true);
  expect(existsSync(unprefixed.path)).toBe(true);
}, 15000);

test("unmerged closed work must be contained in base, not just the abandoned PR head", async () => {
  const f = setup();
  const tree = f.add(1, "CLOSED");
  writeFileSync(join(tree.path, "abandoned"), "data");
  f.git(["add", "abandoned"], tree.path);
  f.git(["commit", "-m", "abandoned PR work"], tree.path);
  tree.task.head = f.git(["rev-parse", "HEAD"], tree.path);
  expect(await f.service().cleanup(tree.task)).toBe(false);
  expect(existsSync(tree.path)).toBe(true);
  expect(f.reports.join("\n")).toContain("unpushed work");
}, 15000);

test("a branch also checked out outside the project task root is retained", async () => {
  const f = setup();
  const tree = f.add(1);
  const other = join(f.root, "orchestrator");
  f.git(["worktree", "add", "--force", other, tree.task.branch]);
  expect(await f.service().cleanup(tree.task)).toBe(false);
  expect(f.reports.join("\n")).toContain("branch belongs to another worktree");
  expect(existsSync(tree.path)).toBe(true);
  expect(existsSync(other)).toBe(true);
}, 15000);

test.each(["job-", ""])(
  "respects a custom worktree root and prefix %j",
  async (prefix) => {
    const f = setup();
    const own = f.add(1, "MERGED", join(f.root, "workers", `${prefix}task-1`));
    const other = f.add(2);
    const service = new WorktreeService(
      f.root,
      {
        ...f.config,
        branches: { mainCheckout: f.root, worktreeRoot: "workers", worktreePrefix: prefix },
      },
      {},
      f.deps,
      async () => "stopped"
    );
    const output = await service.list(async (branch) => {
      expect(branch).toBe(own.task.branch);
      return own.task;
    }, true);
    expect(output).toContain(`${own.path}:`);
    expect(output).not.toContain(other.path);
    expect(existsSync(own.path)).toBe(false);
    expect(existsSync(other.path)).toBe(true);
  },
  15000
);

test("main checkout and a different repository under the configured root are never removed", async () => {
  const f = setup();
  const service = new WorktreeService(
    f.root,
    { ...f.config, branches: { mainCheckout: f.root, worktreeRoot: "..", worktreePrefix: "" } },
    {},
    f.deps,
    async () => "stopped"
  );
  expect(
    await service.cleanup({
      pr: 1,
      branch: basename(f.root),
      base: "dev",
      head: f.head,
      state: "MERGED",
    })
  ).toBe(false);
  const path = join(f.root, ".worktrees", "auto-task-1");
  mkdirSync(path, { recursive: true });
  f.git(["init", "-b", "task-1"], path);
  expect(
    await f
      .service()
      .cleanup({ pr: 1, branch: "task-1", base: "dev", head: f.head, state: "MERGED" })
  ).toBe(false);
  expect(f.reports.join("\n")).toContain("another repository");
  expect(existsSync(path)).toBe(true);
  expect(f.commands.some((line) => line.includes("worktree remove"))).toBe(false);
}, 15000);

test("failed commit reads and unknown session reads retain the tree", async () => {
  const f = setup();
  const tree = f.add(1);
  tree.task.head = "f".repeat(40); // Missing object, never assume an empty rev-list.
  expect(await f.service().cleanup(tree.task)).toBe(false);
  expect(f.reports.join("\n")).toContain("safety check failed");
  const service = new WorktreeService(f.root, f.config, {}, f.deps, async () => {
    throw new Error("offline");
  });
  expect(await service.cleanup(tree.task)).toBe(false);
  expect(existsSync(tree.path)).toBe(true);
  expect(f.commands.some((line) => line.includes("worktree remove"))).toBe(false);
}, 15000);

test("crash recovery deletes an orphan branch but preserves a concurrently advanced ref", async () => {
  const f = setup();
  const tree = f.add(1);
  f.git(["worktree", "remove", tree.path]);
  const exec = f.deps.exec;
  f.deps.exec = async (file, args, options) => {
    if (file === "git" && args[0] === "update-ref") {
      f.git(["checkout", tree.task.branch]);
      f.git(["commit", "--allow-empty", "-m", "racing commit"]);
      f.git(["checkout", "dev"]);
    }
    return exec(file, args, options);
  };
  await expect(f.service().cleanup(tree.task)).rejects.toThrow();
  expect(f.git(["rev-parse", `refs/heads/${tree.task.branch}`])).not.toBe(f.head);
  f.deps.exec = exec;
  expect(await f.service().cleanup(tree.task)).toBe(false);
  const other = f.add(2);
  f.git(["worktree", "remove", other.path]);
  expect(await f.service().cleanup(other.task)).toBe(true);
  expect(f.git(["for-each-ref", "--format=%(refname)", `refs/heads/${other.task.branch}`])).toBe(
    ""
  );
}, 15000);

test("cleanup captures delivery usage before removal and retains the tree while capture fails", async () => {
  const f = setup();
  const order: string[] = [];
  let captureSucceeds = true;
  const capture = async (pr: number) => {
    order.push(`capture#${pr}`);
    return captureSucceeds;
  };
  const close = async () => {
    order.push("close");
    return true;
  };
  const service = new WorktreeService(
    f.root,
    f.config,
    {},
    f.deps,
    async () => "stopped",
    close,
    capture
  );
  const exec = f.deps.exec;
  f.deps.exec = async (file, args, options) => {
    if (file === "git" && args[0] === "worktree" && args[1] === "remove") {
      order.push("remove");
    }
    return exec(file, args, options);
  };
  const tree = f.add(1);
  expect(await service.cleanup(tree.task)).toBe(true);
  expect(order).toEqual(["capture#1", "close", "remove"]);
  expect(existsSync(tree.path)).toBe(false);
  // A failed capture keeps the next tree and its session for retry, like safety skips.
  captureSucceeds = false;
  const retained = f.add(2);
  expect(await service.cleanup(retained.task)).toBe(false);
  expect(order).toEqual(["capture#1", "close", "remove", "capture#2"]);
  expect(existsSync(retained.path)).toBe(true);
  captureSucceeds = true;
  expect(await service.cleanup(retained.task)).toBe(true);
  expect(order.slice(-3)).toEqual(["capture#2", "close", "remove"]);
  expect(existsSync(retained.path)).toBe(false);
}, 15000);
