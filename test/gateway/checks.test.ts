import { expect, test } from "vitest";
import {
  workerFixtureServer as fixtureServer,
  fixtureServer as orchestratorFixtureServer,
  people,
  sha,
} from "./helpers.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { createGateway } from "../../src/gateway/server.js";
import { ConflictOutcome } from "../../src/conflicts/outcomes.js";

const base = "b".repeat(40);
const prefix = "/repos/example/project";
const pull = (overrides: Record<string, unknown> = {}) => ({
  path: `${prefix}/pulls/3`,
  method: "GET",
  json: {
    state: "open",
    user: { login: "worker", id: 102, type: "User" },
    head: { sha, ref: "3-task", repo: { full_name: "example/project" } },
    base: { sha: base, ref: "dev", repo: { full_name: "example/project" } },
    mergeable: true,
    ...overrides,
  },
});
const run = (overrides: Record<string, unknown> = {}) => ({
  id: 10,
  name: "ci",
  head_sha: sha,
  app: { id: 909 },
  status: "completed",
  conclusion: "success",
  ...overrides,
});
const checks = (runs = [run()]) => ({
  path: `${prefix}/commits/${sha}/check-runs?filter=all&per_page=100&page=1`,
  method: "GET",
  json: { check_runs: runs },
});
const ctx = { role: "worker", taskPr: 3 } as const;

test("a PR closed during a CI read signals a typed terminal outcome", async () => {
  const f = fixtureServer([pull({ state: "closed" })]);
  await expect(f.gateway.call("waitChecks", { ref: "3" }, ctx)).rejects.toBeInstanceOf(
    ConflictOutcome
  );
  f.done();
});
// Project commit.sha from the Get a branch response; substitute only the SHA.
// Wire shape: https://docs.github.com/en/rest/branches/branches#get-a-branch
const liveBase = (sha = base) => ({
  path: `${prefix}/branches/dev`,
  method: "GET",
  json: { commit: { sha } },
});

test("wait-checks green pins the head and emits a final-line verdict using only REST", async () => {
  const f = fixtureServer([pull(), checks(), pull()]);
  expect(await f.gateway.call("waitChecks", { ref: "3" }, ctx)).toEqual({
    code: 0,
    text: `checks: green (head ${sha})`,
  });
  f.done();
});

test("wait-checks ignores a previous head's red suite until current-head checks register", async () => {
  const previous = "c".repeat(40);
  const f = fixtureServer([
    pull(),
    checks([run({ head_sha: previous, conclusion: "failure" })]),
    pull(),
    checks(),
    pull(),
  ]);
  const verdict = await f.gateway.call("waitChecks", { ref: "3" }, ctx);
  expect(verdict).toEqual({ code: 0, text: `checks: green (head ${sha})` });
  expect(f.sleeps).toEqual([10000]);
  f.done();
});

test("registration race: no checks is pending and a later check can become green", async () => {
  const f = fixtureServer([pull(), checks([]), pull(), checks(), pull()]);
  expect((await f.gateway.call("waitChecks", { ref: "3" }, ctx)).code).toBe(0);
  expect(f.sleeps).toEqual([10000]);
  f.done();
});

test("no-check grace defaults to exactly 120 seconds, never an empty green", async () => {
  const f = fixtureServer(Array.from({ length: 13 }, () => [pull(), checks([])]).flat());
  const verdict = await f.gateway.call("waitChecks", { ref: "3" }, ctx);
  expect(verdict.code).toBe(2);
  expect(verdict.text).toContain("no checks registered");
  expect(f.sleeps).toEqual(Array(12).fill(10000));
  expect(verdict.text.split("\n").at(-1)).toMatch(/^checks: .*run again/);
  f.done();
});

test("pending jobs have a bounded wait and fake clock", async () => {
  const f = fixtureServer([
    pull(),
    checks([run({ status: "queued", conclusion: null })]),
    pull(),
    checks([run({ status: "in_progress", conclusion: null })]),
  ]);
  expect((await f.gateway.call("waitChecks", { ref: "3", maxMinutes: 1 / 6 }, ctx)).code).toBe(2);
  expect(f.sleeps).toEqual([10000]);
  f.done();
});

test.each([false, true])("head movement is retryable even when pending=%s", async (pending) => {
  const f = fixtureServer([
    pull(),
    checks([run(pending ? { status: "queued", conclusion: null } : {})]),
    pull({ head: { sha: "c".repeat(40), ref: "3-task", repo: { full_name: "example/project" } } }),
  ]);
  const result = await f.gateway.call("waitChecks", { ref: "3" }, ctx);
  expect(result.code).toBe(2);
  expect(result.text).toContain("head changed");
  f.done();
});

test("conflicting unregistered head yields exit 3, not a timeout", async () => {
  const f = fixtureServer([pull({ mergeable: false, mergeable_state: "dirty" }), checks([])]);
  expect(await f.gateway.call("waitChecks", { ref: "3" }, ctx)).toEqual({
    code: 3,
    text: "checks: CONFLICT with dev: merge origin/dev, push, run again",
  });
  f.done();
});

test("a forged successful check named ci from a foreign app never authorizes green", async () => {
  const f = fixtureServer([pull(), checks([run({ app: { id: 666 } })])]);
  expect((await f.gateway.call("waitChecks", { ref: "3", graceSeconds: 0 }, ctx)).code).toBe(2);
  f.done();
});

test("latest attempts are keyed by app AND name, a foreign forged success cannot replace red", async () => {
  const f = fixtureServer([
    pull(),
    checks([run({ conclusion: "failure" }), run({ id: 11, app: { id: 666 } })]),
    pull(),
  ]);
  const verdict = await f.gateway.call("waitChecks", { ref: "3" }, ctx);
  expect(verdict.code).toBe(1);
  expect(verdict.text).toContain("its log could not be read");
  expect(verdict.text.split("\n").at(-1)).toBe(`checks: RED: ci (head ${sha})`);
  f.done();
});

test("a successful rerun replaces an older failure from the same app", async () => {
  const f = fixtureServer([
    pull(),
    checks([run({ conclusion: "failure" }), run({ id: 11 })]),
    pull(),
  ]);
  expect((await f.gateway.call("waitChecks", { ref: "3" }, ctx)).code).toBe(0);
  f.done();
});

test("two trusted apps with the same check name retain independent verdicts", async () => {
  const f = fixtureServer([
    pull(),
    checks([run({ conclusion: "failure" }), run({ id: 11, app: { id: 910 } })]),
    pull(),
  ]);
  writeFileSync(
    join(f.root, "people.yaml"),
    stringify([
      ...people,
      {
        login: "other-ci",
        id: 105,
        type: "Bot",
        role: "system",
        appIds: [910],
        events: ["check_run"],
      },
    ])
  );
  const gateway = createGateway(f.root, f.env, f.deps);
  expect((await gateway.call("waitChecks", { ref: "3" }, ctx)).code).toBe(1);
  f.done();
});

test("unreadable PR is a retryable no-verdict, not a red code failure", async () => {
  const f = fixtureServer([{ path: `${prefix}/pulls/3`, method: "GET", status: 404 }]);
  const result = await f.gateway.call("waitChecks", { ref: "3", maxMinutes: 0 }, ctx);
  expect(result.code).toBe(2);
  expect(result.text).toContain("GitHub read failed");
  f.done();
});

test("completed first job waits for suite completion before declaring green", async () => {
  const suite = (status: string) => ({
    path: `${prefix}/check-suites/50`,
    method: "GET",
    json: {
      app: { id: 909 },
      head_sha: sha,
      status,
      conclusion: status === "completed" ? "success" : null,
    },
  });
  const runs = [run({ check_suite: { id: 50 } })];
  const f = fixtureServer([
    pull(),
    checks(runs),
    suite("in_progress"),
    pull(),
    checks(runs),
    suite("completed"),
    pull(),
  ]);
  expect((await f.gateway.call("waitChecks", { ref: "3" }, ctx)).code).toBe(0);
  expect(f.sleeps).toEqual([10000]);
  f.done();
});

test("red digest keeps errors/test totals, strips ANSI and excludes cleanup", async () => {
  const failed = run({
    conclusion: "failure",
    details_url: "https://github.com/example/project/actions/runs/20/job/30",
  });
  const lines = [
    "##[group]Run npm ci",
    "successful install",
    "##[group]Run npm test",
    " FAIL tests/world.test.ts > removes entities",
    "AssertionError: expected 2 to be 1",
    ...Array.from({ length: 70 }, (_, i) => `file.ts(${i},1): error TS2307: missing module`),
    "Tests  2 failed | 3 passed (5)",
    "##[error]Process completed with exit code 1",
    "cleanup",
  ]
    .map((line) => `2026-10-09T19:37:07.3620060Z ${line}`)
    .join("\n");
  const f = fixtureServer([
    pull(),
    checks([failed]),
    pull(),
    {
      path: `${prefix}/actions/jobs/30`,
      method: "GET",
      json: { run_id: 20, head_sha: sha, steps: [{ name: "Run tests", conclusion: "failure" }] },
    },
    {
      path: `${prefix}/actions/jobs/30/logs`,
      method: "GET",
      redirect: "manual",
      text: `\x1b[31m${lines}\x1b[0m`,
    },
  ]);
  const result = await f.gateway.call("waitChecks", { ref: "3" }, ctx);
  expect(result.code).toBe(1);
  expect(result.text).toContain("step: Run tests");
  expect(result.text).toContain("AssertionError");
  expect(result.text).toContain("Tests  2 failed");
  expect(result.text).not.toContain("\x1b");
  expect(result.text).not.toMatch(/successful install|cleanup/);
  expect(result.text.split("\n").length).toBeLessThanOrEqual(65);
  f.done();
});

test("a failed suite cannot turn green merely because GitHub names no failed job", async () => {
  const f = fixtureServer([
    pull(),
    checks([run({ check_suite: { id: 50 } })]),
    {
      path: `${prefix}/check-suites/50`,
      method: "GET",
      json: { app: { id: 909 }, head_sha: sha, status: "completed", conclusion: "failure" },
    },
    pull(),
  ]);
  const result = await f.gateway.call("waitChecks", { ref: "3" }, ctx);
  expect(result.code).toBe(1);
  expect(result.text.split("\n").at(-1)).toBe(`checks: RED: CI suite 50 (head ${sha})`);
  f.done();
});

const workflow = (baseSha = base) => ({
  path: `${prefix}/actions/runs?check_suite_id=50&per_page=100`,
  method: "GET",
  json: {
    workflow_runs: [
      {
        id: 20,
        check_suite_id: 50,
        head_sha: sha,
        conclusion: "success",
        pull_requests: [{ number: 3, base: { sha: baseSha }, head: { sha } }],
      },
    ],
  },
});

test.each([base, "c".repeat(40)])(
  "check-task-ci compares the run's base SHA (%s), not timestamps",
  async (testedBase) => {
    const f = orchestratorFixtureServer([
      pull(),
      liveBase(),
      checks([run({ check_suite: { id: 50 } })]),
      workflow(testedBase),
      pull(),
      liveBase(),
    ]);
    const result = await f.gateway.call("checkTaskCi", { ref: "3" }, { role: "orchestrator" });
    expect(result.code).toBe(testedBase === base ? 0 : 2);
    f.done();
  }
);

test("check-task-ci detects a live base move even when the PR and CI retain the old base", async () => {
  const f = orchestratorFixtureServer([
    pull(),
    liveBase("c".repeat(40)),
    checks([run({ check_suite: { id: 50 } })]),
    workflow(),
    pull(),
    liveBase("c".repeat(40)),
  ]);
  expect(await f.gateway.call("checkTaskCi", { ref: "3" }, { role: "orchestrator" })).toEqual({
    code: 2,
    text: "checks: green, but the base moved or CI base is unknown; run refresh-checks",
  });
  f.done();
});

test("check-task-ci fails closed when the live base moves while reading CI evidence", async () => {
  const f = orchestratorFixtureServer([
    pull(),
    liveBase(),
    checks([run({ check_suite: { id: 50 } })]),
    workflow(),
    pull(),
    liveBase("c".repeat(40)),
  ]);
  const result = await f.gateway.call("checkTaskCi", { ref: "3" }, { role: "orchestrator" });
  expect(result.code).toBe(2);
  expect(result.text).not.toContain("CI tested the current base");
  f.done();
});

test.each([undefined, "not-a-sha"])(
  "check-task-ci rejects an invalid live base SHA %s",
  async (sha) => {
    const f = orchestratorFixtureServer([pull(), { ...liveBase(), json: { commit: { sha } } }]);
    await expect(
      f.gateway.call("checkTaskCi", { ref: "3" }, { role: "orchestrator" })
    ).rejects.toThrow("Invalid live base SHA");
    f.done();
  }
);

test.each([
  { runs: [], code: 2 },
  { runs: [run({ status: "queued", conclusion: null })], code: 2 },
  { runs: [run({ conclusion: "failure" })], code: 1 },
])("check-task-ci gives a one-shot non-green verdict $code", async ({ runs, code }) => {
  const f = orchestratorFixtureServer([pull(), liveBase(), checks(runs), pull(), liveBase()]);
  expect((await f.gateway.call("checkTaskCi", { ref: "3" }, { role: "orchestrator" })).code).toBe(
    code
  );
  expect(f.sleeps).toEqual([]);
  f.done();
});

test("workers cannot verify, refresh or inspect tested base; wait-checks is scoped to their own PR", async () => {
  const f = fixtureServer([]);
  await expect(f.gateway.call("waitChecks", { ref: "4" }, ctx)).rejects.toThrow("own taskPr");
  await expect(f.gateway.call("verify", { refs: ["3"] }, ctx)).rejects.toThrow("denied");
  await expect(f.gateway.call("refreshChecks", { ref: "3" }, ctx)).rejects.toThrow("denied");
  await expect(f.gateway.call("checkTaskCi", { ref: "3" }, ctx)).rejects.toThrow("denied");
  f.done();
});
