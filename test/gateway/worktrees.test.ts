import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import type { Dependencies } from "../../src/gateway/client.js";
import { WorktreeService, type WorktreeTask } from "../../src/gateway/worktrees.js";
import { fixture, ghConfig } from "../helpers.js";

/** The worker checkout (a git repository) apart from the orchestrator's root, task trees
 * in OpenCode's own directory, and an OpenCode fake that removes them through git. */
function setup() {
  const root = fixture();
  const checkout = fixture();
  const trees = fixture();
  const git = (args: string[], cwd = checkout) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git(["init", "-b", "dev"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.invalid"]);
  writeFileSync(join(checkout, ".gitignore"), "node_modules/\n.tmp/\n");
  git(["add", ".gitignore"]);
  git(["commit", "-m", "initial"]);
  const head = git(["rev-parse", "HEAD"]);
  const reports: string[] = [];
  const commands: string[] = [];
  const unexpected: string[] = [];
  const removals: string[] = [];
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
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.host === "opencode.test" && url.pathname === "/api/location") {
        expect(url.searchParams.get("location[directory]")).toBe(checkout);
        return Response.json({ directory: checkout, project: { id: "project-id" } });
      }
      if (url.host === "opencode.test" && url.pathname === "/api/worktree") {
        expect(init?.method).toBe("DELETE");
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({ projectID: "project-id", force: true });
        removals.push(body.directory);
        commands.push(`opencode worktree remove ${body.directory}`);
        git(["worktree", "remove", "--force", body.directory]);
        return new Response(null, { status: 204 });
      }
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
    workerCheckout: checkout,
  };
  const env: NodeJS.ProcessEnv = {
    OPENCODE_BASE_URL: "http://opencode.test",
    OPENCODE_SERVER_USERNAME: "user",
    OPENCODE_SERVER_PASSWORD: "password",
  };
  const service = () =>
    new WorktreeService(root, config, env, deps, async (pr) => sessions.get(pr) ?? "stopped");
  const add = (pr: number, state = "MERGED", location = join(trees, `auto-task-${pr}`)) => {
    const branch = `task-${pr}`;
    git(["worktree", "add", "-b", branch, location, "dev"]);
    const task: WorktreeTask = { pr, branch, state, head, base: "dev" };
    return { task, path: location };
  };
  return {
    root,
    checkout,
    trees,
    git,
    head,
    deps,
    config,
    env,
    reports,
    commands,
    removals,
    sessions,
    service,
    add,
  };
}

/** A stand-in for the origin the transfer fetch targets: a clone of the worker checkout
 * that moved on and holds the merged head behind refs/pull/<pr>/head only, as GitHub
 * does after it deletes a merged branch.
 */
function standInOrigin(f: ReturnType<typeof setup>, pr: number): { remote: string; head: string } {
  const remote = fixture();
  execFileSync("git", ["clone", "-q", f.checkout, remote], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000,
  });
  writeFileSync(join(remote, "merged"), "data");
  f.git(["config", "user.name", "Test"], remote);
  f.git(["config", "user.email", "test@example.invalid"], remote);
  f.git(["add", "merged"], remote);
  f.git(["commit", "-m", "merged on GitHub"], remote);
  const head = f.git(["rev-parse", "HEAD"], remote);
  f.git(["update-ref", `refs/pull/${pr}/head`, head], remote);
  return { remote, head };
}

/** Serve the transfer's git invocation from the stand-in origin instead of GitHub,
 * recording every fetch refspec; never delegates token-bearing calls to git config.
 */
function interceptTransfer(f: ReturnType<typeof setup>, remote = "") {
  const exec = f.deps.exec;
  const refspecs: string[] = [];
  let attempts = 0;
  let fail = false;
  f.deps.exec = async (file, args, options) => {
    if (file === "git" && args[0] === "-c" && args[4] === "fetch") {
      attempts++;
      expect(args.slice(4, 7)).toEqual(["fetch", "-q", "https://github.com/example/project.git"]);
      expect(String(args)).not.toContain("fake-token");
      expect(options?.env?.VMETHOD_GIT_TOKEN).toBe("fake-token");
      refspecs.push(...args.slice(7));
      if (fail) {
        throw new Error("secret: fake-token / untrusted remote stderr");
      }
      return execFileSync("git", ["fetch", "-q", remote, ...args.slice(7)], {
        cwd: options?.cwd,
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
    return exec(file, args, options);
  };
  return {
    refspecs,
    attempts: () => attempts,
    fail: () => {
      fail = true;
    },
  };
}

const serviceTestsTimeout = 30000;

test(
  "cleanup fetches the merged head GitHub holds after the branch is deleted",
  async () => {
    const f = setup();
    f.env.GH_CONFIG_DIR = ghConfig("fake-token");
    const origin = standInOrigin(f, 1);
    const transfer = interceptTransfer(f, origin.remote);
    const tree = f.add(1);
    tree.task.head = origin.head;
    expect(await f.service().cleanup(tree.task)).toBe(true);
    expect(existsSync(tree.path)).toBe(false);
    expect(f.removals).toEqual([tree.path]);
    expect(transfer.attempts()).toBe(1);
    expect(transfer.refspecs).toEqual(["refs/pull/1/head"]);
  },
  serviceTestsTimeout
);

test(
  "an unpushed local commit is still refused after the merged head is fetched",
  async () => {
    const f = setup();
    f.env.GH_CONFIG_DIR = ghConfig("fake-token");
    const origin = standInOrigin(f, 1);
    const transfer = interceptTransfer(f, origin.remote);
    const tree = f.add(1);
    tree.task.head = origin.head;
    writeFileSync(join(tree.path, "divergent"), "data");
    f.git(["add", "divergent"], tree.path);
    f.git(["commit", "-m", "not pushed"], tree.path);
    expect(await f.service().cleanup(tree.task)).toBe(false);
    expect(existsSync(tree.path)).toBe(true);
    expect(f.reports.join("\n")).toContain(
      "unpushed work (branch head not contained in PR head or base)"
    );
    expect(transfer.attempts()).toBe(1);
    expect(transfer.refspecs).toEqual(["refs/pull/1/head"]);
    expect(f.removals).toEqual([]);
  },
  serviceTestsTimeout
);

test(
  "a failed fetch refuses with its own reason instead of the generic safety skip",
  async () => {
    const f = setup();
    f.env.GH_CONFIG_DIR = ghConfig("fake-token");
    const transfer = interceptTransfer(f);
    transfer.fail();
    f.deps.sleep = async () => undefined; // The retried fetch fails outright.
    const tree = f.add(1);
    tree.task.head = "e".repeat(40); // Missing object, so reason fetches it first.
    expect(await f.service().cleanup(tree.task)).toBe(false);
    expect(existsSync(tree.path)).toBe(true);
    expect(f.reports.join("\n")).toContain(
      `cannot fetch merged PR head ${"e".repeat(40)}: fetch failed`
    );
    expect(f.reports.join("\n")).not.toContain("safety check failed");
    expect(transfer.attempts()).toBe(3);
    expect(f.removals).toEqual([]);
  },
  serviceTestsTimeout
);

test(
  "a head still missing after the fetch keeps the generic refusal",
  async () => {
    const f = setup();
    f.env.GH_CONFIG_DIR = ghConfig("fake-token");
    const origin = standInOrigin(f, 1);
    const transfer = interceptTransfer(f, origin.remote);
    const tree = f.add(1);
    tree.task.head = "f".repeat(40); // Missing object, never assume an empty rev-list.
    expect(await f.service().cleanup(tree.task)).toBe(false);
    expect(f.reports.join("\n")).toContain("safety check failed");
    expect(existsSync(tree.path)).toBe(true);
    expect(transfer.attempts()).toBe(1);
    expect(transfer.refspecs).toEqual(["refs/pull/1/head"]);
    expect(f.removals).toEqual([]);
  },
  serviceTestsTimeout
);

test(
  "already-present merged head and base need no fetch",
  async () => {
    const f = setup();
    f.env.GH_CONFIG_DIR = ghConfig("fake-token");
    const transfer = interceptTransfer(f);
    const tree = f.add(1);
    expect(await f.service().cleanup(tree.task)).toBe(true);
    expect(transfer.attempts()).toBe(0);
  },
  serviceTestsTimeout
);

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
    const service = new WorktreeService(f.root, f.config, f.env, f.deps, async () => status, close);
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
  expect(f.removals).toEqual([tree.path]);
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
    expect(f.removals).toEqual([]);
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

test("never touches a tree not named for its branch", async () => {
  const f = setup();
  const unprefixed = f.add(2, "MERGED", join(f.trees, "task-2"));
  const lookedUp: string[] = [];
  expect(
    await f.service().list(async (branch) => {
      lookedUp.push(branch);
      return unprefixed.task;
    }, true)
  ).toBe("Total freed: 0 KiB");
  expect(lookedUp).toEqual([]);
  expect(await f.service().cleanup(unprefixed.task)).toBe(false);
  expect(f.reports.join("\n")).toContain("not a task worktree of the worker checkout");
  expect(existsSync(unprefixed.path)).toBe(true);
  expect(f.removals).toEqual([]);
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

test("a branch also checked out in another worktree is retained", async () => {
  const f = setup();
  const tree = f.add(1);
  const other = join(f.root, "orchestrator");
  f.git(["worktree", "add", "--force", other, tree.task.branch]);
  expect(await f.service().cleanup(tree.task)).toBe(false);
  // Whichever of the two trees git lists first, neither is removed.
  expect(f.reports.join("\n")).toMatch(/branch belongs to another worktree|not a task worktree/);
  expect(existsSync(tree.path)).toBe(true);
  expect(existsSync(other)).toBe(true);
}, 15000);

test.each(["job-", ""])(
  "respects a custom worktree prefix %j",
  async (prefix) => {
    const f = setup();
    const own = f.add(1, "MERGED", join(f.trees, `${prefix}task-1`));
    const other = f.add(2);
    const service = new WorktreeService(
      f.root,
      { ...f.config, branches: { worktreePrefix: prefix } },
      f.env,
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

test("the worker checkout and an unregistered repository named like a task tree are never removed", async () => {
  const f = setup();
  // The checkout's own branch is never a task tree, even with a task-like name.
  f.git(["checkout", "-q", "-b", "task-9"]);
  expect(
    await f
      .service()
      .cleanup({ pr: 9, branch: "task-9", base: "dev", head: f.head, state: "MERGED" })
  ).toBe(false);
  expect(f.reports.join("\n")).toContain("branch belongs to another worktree");
  f.git(["checkout", "-q", "dev"]);
  const path = join(f.trees, "auto-task-1");
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "task-1"], { cwd: path });
  expect(
    await f
      .service()
      .cleanup({ pr: 1, branch: "task-1", base: "dev", head: f.head, state: "MERGED" })
  ).toBe(true);
  expect(existsSync(path)).toBe(true);
  expect(f.removals).toEqual([]);
}, 15000);

test("failed commit reads and unknown session reads retain the tree", async () => {
  const f = setup();
  const tree = f.add(1);
  tree.task.head = "f".repeat(40); // Missing object, never assume an empty rev-list.
  expect(await f.service().cleanup(tree.task)).toBe(false);
  expect(f.reports.join("\n")).toContain("safety check failed");
  const service = new WorktreeService(f.root, f.config, f.env, f.deps, async () => {
    throw new Error("offline");
  });
  expect(await service.cleanup(tree.task)).toBe(false);
  expect(existsSync(tree.path)).toBe(true);
  expect(f.removals).toEqual([]);
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
    f.env,
    f.deps,
    async () => "stopped",
    close,
    capture
  );
  const fetch = f.deps.fetch;
  f.deps.fetch = async (input, init) => {
    if (init?.method === "DELETE") {
      order.push("remove");
    }
    return fetch(input, init);
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
