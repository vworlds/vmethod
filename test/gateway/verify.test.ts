import { runChildAsync } from "../child-process.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createGateway } from "../../src/gateway/server.js";
import { ciVerb } from "../../src/cli/ci.js";
import { actor, fixtureServer, graph, item, sha } from "./helpers.js";

const prefix = "/repos/example/project";
const base = "b".repeat(40);
const second = "c".repeat(40);
const tree = "d".repeat(40);
const commit = "e".repeat(40);
const pull = (number = 3, head = sha) => ({
  path: `${prefix}/pulls/${number}`,
  method: "GET",
  json: {
    state: "open",
    user: { login: "worker", id: 102, type: "User" },
    head: { sha: head, ref: `${number}-task`, repo: { full_name: "example/project" } },
    base: { sha: base, ref: "dev", repo: { full_name: "example/project" } },
    mergeable: true,
  },
});
const runs = {
  path: `${prefix}/commits/${sha}/check-runs?filter=all&per_page=100&page=1`,
  method: "GET",
  json: {
    check_runs: [
      {
        id: 10,
        name: "ci",
        head_sha: sha,
        app: { id: 909 },
        check_suite: { id: 50 },
        status: "completed",
        conclusion: "success",
      },
    ],
  },
};
const workflow = (stale: boolean) => ({
  path: `${prefix}/actions/runs?check_suite_id=50&per_page=100`,
  method: "GET",
  json: {
    workflow_runs: [
      {
        id: 20,
        check_suite_id: 50,
        head_sha: sha,
        conclusion: "success",
        pull_requests: [{ number: 3, base: { sha: stale ? second : base }, head: { sha } }],
      },
    ],
  },
});
const transfer = (command: string, ...refs: string[]) => [
  "-c",
  "credential.helper=",
  "-c",
  'credential.helper=!f() { printf "%s\\n" "username=x-access-token" "password=$VMETHOD_GIT_TOKEN"; }; f',
  command,
  command === "fetch" ? "-q" : "--porcelain",
  "https://github.com/example/project.git",
  ...refs,
];

interface Step {
  args: string[];
  output?: string;
  action?: () => void;
  fail?: boolean;
  cwd?: string;
}
function gitScript(f: ReturnType<typeof fixtureServer>, steps: Step[]) {
  let index = 0;
  f.deps.exec = async (file, args, options) => {
    const step = steps[index++];
    expect(file).toBe("git");
    expect(step, `unexpected git ${args.join(" ")}`).toBeDefined();
    expect([...args]).toEqual(step.args);
    if (step.cwd) {
      expect(options?.cwd).toBe(step.cwd);
    }
    step.action?.();
    if (step.fail) {
      throw new Error("fake git failure");
    }
    return step.output ?? "";
  };
  return () => expect(index).toBe(steps.length);
}

test.each([
  { homeFallback: false, hookFails: false },
  { homeFallback: true, hookFails: false },
  { homeFallback: false, hookFails: true },
])(
  "verify combines two pinned heads, cleans outputs, passes options and keeps per-user step logs ($homeFallback, $hookFails)",
  async ({ homeFallback, hookFails }) => {
    const f = fixtureServer([pull(), pull(4, second)]);
    const config = readFileSync(join(f.root, "vmethod.yaml"), "utf8").replace(
      "/replace/with/consumer/checkout",
      f.root
    );
    writeFileSync(join(f.root, "vmethod.yaml"), config);
    const review = join(f.root, ".worktrees/orchestrator-review");
    const common = join(f.root, ".git");
    const steps: Step[] = [
      {
        args: transfer(
          "fetch",
          "+refs/heads/dev:refs/remotes/origin/dev",
          "+refs/heads/3-task:refs/remotes/origin/3-task",
          "+refs/heads/4-task:refs/remotes/origin/4-task"
        ),
      },
      { args: ["rev-parse", "--path-format=absolute", "--git-common-dir"], output: common },
      {
        args: ["worktree", "add", "--detach", review, "refs/remotes/origin/dev"],
        action: () => {
          mkdirSync(join(review, "scripts/vmethod-hooks"), { recursive: true });
          for (const path of ["dist", "packages/a/dist", "node_modules"]) {
            mkdirSync(join(review, path), { recursive: true });
            writeFileSync(join(review, path, "stale"), "stale");
          }
          writeFileSync(
            join(review, "scripts/vmethod-hooks/verify"),
            `#!${process.execPath}
import fs from 'node:fs'; import assert from 'node:assert/strict'; import path from 'node:path';
const args = process.argv.slice(2); assert.equal(args[0], '--logs'); const logs = args[1];
assert.deepEqual(args.slice(2), ['--packages', 'alpha beta', '--bench']);
assert.equal(process.env.EXAMPLE_GITHUB_TOKEN, undefined); assert.equal(process.env.OPENCODE_SERVER_PASSWORD, undefined);
for(const dir of ['dist','packages/a/dist','node_modules']) assert.equal(fs.existsSync(dir), false, dir);
for(const step of ['format','lint','typecheck','test-alpha','test-beta','build','bench']) fs.writeFileSync(path.join(logs,step+'.log'), 'ok '+step);
console.log('ok fake hook'); console.error('hook stderr captured'); process.exit(${hookFails ? 7 : 0});`,
            { mode: 0o755 }
          );
        },
      },
      {
        args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        output: common,
        cwd: review,
      },
      { args: ["rev-parse", "--show-toplevel"], output: review },
      { args: ["rev-parse", "--abbrev-ref", "HEAD"], output: "HEAD" },
      { args: ["reset", "-q", "--hard"] },
      { args: ["checkout", "-q", "--detach", "refs/remotes/origin/dev"] },
      { args: ["rev-parse", "HEAD"], output: base },
      {
        args: ["clean", "-qxfd"],
        action: () => {
          for (const path of ["dist", "packages/a/dist", "node_modules"]) {
            rmSync(join(review, path), { recursive: true });
          }
        },
      },
      { args: ["rev-parse", "refs/remotes/origin/3-task"], output: sha },
      {
        args: [
          "-c",
          "user.name=orchestrator",
          "-c",
          "user.email=orchestrator@localhost",
          "merge",
          "-q",
          "--no-edit",
          sha,
        ],
      },
      { args: ["rev-parse", "refs/remotes/origin/4-task"], output: second },
      {
        args: [
          "-c",
          "user.name=orchestrator",
          "-c",
          "user.email=orchestrator@localhost",
          "merge",
          "-q",
          "--no-edit",
          second,
        ],
      },
      { args: ["clean", "-qxfd"] },
      { args: ["rev-parse", "--short", "HEAD"], output: "fffffff" },
    ];
    const doneGit = gitScript(f, steps);
    const git = f.deps.exec;
    let hooks = 0;
    f.deps.exec = async (file, args, options) => {
      if (file !== "/bin/sh") {
        return git(file, args, options);
      }
      hooks++;
      expect(args.slice(0, 4)).toEqual([
        "-c",
        'out=$1; shift; "$@" > "$out" 2>&1',
        "verify",
        args[3],
      ]);
      expect(options?.cwd).toBe(review);
      expect(options?.env?.EXAMPLE_GITHUB_TOKEN).toBeUndefined();
      return (await runChildAsync(file, [...args], { ...options, encoding: "utf8", timeout: 2000 }))
        .stdout;
    };
    const home = join(f.root, "other-user");
    const env = {
      ...f.env,
      HOME: home,
      XDG_STATE_HOME: homeFallback ? undefined : f.env.XDG_STATE_HOME,
      OPENCODE_SERVER_PASSWORD: "do-not-inherit",
    };
    const gateway = createGateway(f.root, env, f.deps);
    const result = await ciVerb(
      gateway,
      "verify",
      ["3", "--packages", "alpha beta", "4", "--bench"],
      { VMETHOD_ROLE: "orchestrator" }
    );
    expect(result.code, result.text).toBe(hookFails ? 1 : 0);
    expect(result.text).toContain("dev + PR 3 4");
    expect(result.text).toContain("hook stderr captured");
    expect(hooks).toBe(1);
    const logsParent = join(
      homeFallback ? join(home, ".local/state") : f.env.XDG_STATE_HOME,
      "vmethod/example-state/verify"
    );
    const dirs = readdirSync(logsParent);
    expect(dirs).toHaveLength(1);
    expect(readdirSync(join(logsParent, dirs[0])).sort()).toEqual([
      "bench.log",
      "build.log",
      "format.log",
      "hook.log",
      "lint.log",
      "test-alpha.log",
      "test-beta.log",
      "typecheck.log",
    ]);
    expect(existsSync(join(f.root, ".worktrees/.vmethod-review-lock"))).toBe(false);
    doneGit();
    f.done();
  }
);

test("refresh-checks leaves an already-current green branch untouched", async () => {
  const f = fixtureServer([pull(), runs, workflow(false), pull()]);
  expect(await f.gateway.call("refreshChecks", { ref: "3" }, { role: "orchestrator" })).toEqual({
    code: 0,
    text: "refresh-checks: base has not moved; no push",
  });
  f.done();
});

test("verify refuses an unowned existing review directory without resetting or cleaning it", async () => {
  const f = fixtureServer([pull()]);
  writeFileSync(
    join(f.root, "vmethod.yaml"),
    readFileSync(join(f.root, "vmethod.yaml"), "utf8").replace(
      "/replace/with/consumer/checkout",
      f.root
    )
  );
  const review = join(f.root, ".worktrees/orchestrator-review");
  mkdirSync(review, { recursive: true });
  writeFileSync(join(review, "personal-work"), "keep me");
  const done = gitScript(f, [
    {
      args: transfer(
        "fetch",
        "+refs/heads/dev:refs/remotes/origin/dev",
        "+refs/heads/3-task:refs/remotes/origin/3-task"
      ),
    },
    {
      args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      output: join(f.root, ".git"),
    },
  ]);
  const gateway = createGateway(f.root, f.env, f.deps);
  await expect(gateway.call("verify", { refs: ["3"] }, { role: "orchestrator" })).rejects.toThrow(
    "not owned"
  );
  expect(readFileSync(join(review, "personal-work"), "utf8")).toBe("keep me");
  expect(existsSync(join(f.root, ".worktrees/.vmethod-review-lock"))).toBe(false);
  done();
  f.done();
});

test("verify rejects mixed PR bases before fetching or invoking a hook", async () => {
  const other = pull(4, second);
  other.json.base.ref = "pack/x";
  const f = fixtureServer([pull(), other]);
  writeFileSync(
    join(f.root, "vmethod.yaml"),
    readFileSync(join(f.root, "vmethod.yaml"), "utf8").replace(
      "/replace/with/consumer/checkout",
      f.root
    )
  );
  const gateway = createGateway(f.root, f.env, f.deps);
  await expect(
    gateway.call("verify", { refs: ["3", "4"] }, { role: "orchestrator" })
  ).rejects.toThrow("sharing the same base");
  f.done();
});

test("verify aborts a failed test merge and never invokes the hook", async () => {
  const f = fixtureServer([pull()]);
  writeFileSync(
    join(f.root, "vmethod.yaml"),
    readFileSync(join(f.root, "vmethod.yaml"), "utf8").replace(
      "/replace/with/consumer/checkout",
      f.root
    )
  );
  const review = join(f.root, ".worktrees/orchestrator-review");
  const common = join(f.root, ".git");
  mkdirSync(review, { recursive: true });
  writeFileSync(join(f.root, ".worktrees/.vmethod-review-owner"), common);
  const done = gitScript(f, [
    {
      args: transfer(
        "fetch",
        "+refs/heads/dev:refs/remotes/origin/dev",
        "+refs/heads/3-task:refs/remotes/origin/3-task"
      ),
    },
    { args: ["rev-parse", "--path-format=absolute", "--git-common-dir"], output: common },
    { args: ["rev-parse", "--path-format=absolute", "--git-common-dir"], output: common },
    { args: ["rev-parse", "--show-toplevel"], output: review },
    { args: ["rev-parse", "--abbrev-ref", "HEAD"], output: "HEAD" },
    { args: ["reset", "-q", "--hard"] },
    { args: ["checkout", "-q", "--detach", "refs/remotes/origin/dev"] },
    { args: ["rev-parse", "HEAD"], output: base },
    { args: ["clean", "-qxfd"] },
    { args: ["rev-parse", "refs/remotes/origin/3-task"], output: sha },
    {
      args: [
        "-c",
        "user.name=orchestrator",
        "-c",
        "user.email=orchestrator@localhost",
        "merge",
        "-q",
        "--no-edit",
        sha,
      ],
      fail: true,
    },
    { args: ["merge", "--abort"] },
  ]);
  const gateway = createGateway(f.root, f.env, f.deps);
  const result = await gateway.call("verify", { refs: ["3"] }, { role: "orchestrator" });
  expect(result.code).toBe(1);
  expect(result.text).toContain("PR #3 does not merge cleanly");
  done();
  f.done();
});

test("refresh-checks creates a two-parent commit without modifying a checkout and pushes through the full gateway policy", async () => {
  const f = fixtureServer([
    pull(),
    runs,
    workflow(true),
    pull(),
    graph({
      repository: {
        pullRequest: item({
          author: actor(1),
          headRefName: "3-task",
          baseRefName: "dev",
          state: "OPEN",
          headRepository: { nameWithOwner: "example/project" },
        }),
      },
    }),
  ]);
  const done = gitScript(f, [
    {
      args: transfer(
        "fetch",
        "+refs/heads/dev:refs/remotes/origin/dev",
        "+refs/heads/3-task:refs/remotes/origin/3-task"
      ),
    },
    { args: ["rev-parse", "refs/remotes/origin/3-task"], output: sha },
    { args: ["rev-parse", "refs/remotes/origin/dev"], output: base },
    { args: ["merge-tree", "--write-tree", sha, base], output: tree },
    {
      args: [
        "-c",
        "user.name=orchestrator",
        "-c",
        "user.email=orchestrator@localhost",
        "commit-tree",
        tree,
        "-p",
        sha,
        "-p",
        base,
        "-m",
        "merge: bring in origin/dev to retest against the current base",
      ],
      output: commit,
    },
    { args: ["rev-parse", "--verify", `${commit}^{commit}`], output: commit },
    { args: transfer("fetch", "+refs/heads/dev:refs/remotes/origin/dev") },
    { args: ["rev-list", "--count", `refs/remotes/origin/dev..${commit}`], output: "2" },
    {
      args: [
        "diff",
        "--name-only",
        "--diff-filter=ACMR",
        "-z",
        `refs/remotes/origin/dev...${commit}`,
      ],
      output: "src/ci.ts\0",
    },
    { args: transfer("push", `${commit}:refs/heads/3-task`) },
    { args: ["update-ref", "refs/remotes/origin/3-task", commit] },
  ]);
  const result = await f.gateway.call("refreshChecks", { ref: "3" }, { role: "orchestrator" });
  expect(result.code).toBe(0);
  expect(result.text).toContain("pushed 3-task at eeeeeee");
  done();
  f.done();
});

test("refresh-checks conflict does not create a commit or push", async () => {
  const f = fixtureServer([pull(), runs, workflow(true), pull()]);
  const done = gitScript(f, [
    {
      args: transfer(
        "fetch",
        "+refs/heads/dev:refs/remotes/origin/dev",
        "+refs/heads/3-task:refs/remotes/origin/3-task"
      ),
    },
    { args: ["rev-parse", "refs/remotes/origin/3-task"], output: sha },
    { args: ["rev-parse", "refs/remotes/origin/dev"], output: base },
    { args: ["merge-tree", "--write-tree", sha, base], fail: true },
  ]);
  expect((await f.gateway.call("refreshChecks", { ref: "3" }, { role: "orchestrator" })).code).toBe(
    3
  );
  done();
  f.done();
});
