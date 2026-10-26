import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { workerVerb } from "../../src/cli/worker.js";
import { createGateway } from "../../src/gateway/server.js";
import type { Dependencies } from "../../src/gateway/client.js";
import {
  actor,
  fixtureServer as orchestratorFixture,
  graph,
  hostile,
  item,
  people,
  sha,
  workerFixtureServer as fixtureServer,
} from "./helpers.js";
import type { Person } from "../../src/gateway/people.js";

/** A peer project's orchestrator, pinned in people.yaml plus its GraphQL actor shape. */
const vecsmaster: Person = {
  login: "vecsmaster",
  id: 900,
  type: "User",
  role: "orchestrator",
  repos: ["example/other"],
};
const vecsmasterActor = { login: "vecsmaster", databaseId: 900, __typename: "User" };

const ctx = { role: "worker", taskPr: 3 } as const;
const task = (overrides = {}) =>
  graph({
    repository: {
      pullRequest: item({
        headRefName: "7-task",
        baseRefName: "pack/x",
        headRepository: { nameWithOwner: "example/project" },
        state: "OPEN",
        ...overrides,
      }),
    },
  });
type GitStep = {
  args: string[];
  output?: string;
  fail?: boolean;
  inspect?: (env: NodeJS.ProcessEnv) => void;
};
function gitFake(deps: Dependencies, root: string, steps: GitStep[]) {
  let index = 0;
  deps.exec = async (file, args, options) => {
    const step = steps[index++];
    expect(step, `Unexpected exec ${file} ${args.join(" ")}`).toBeDefined();
    expect(file).toBe("git");
    expect(args).toEqual(step.args);
    expect(options?.cwd).toBe(root);
    expect(options?.env?.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    step.inspect?.(options?.env ?? {});
    if (step.fail) {
      throw new Error("secret: fake-token / untrusted remote stderr");
    }
    return step.output ?? "";
  };
  return () => expect(index).toBe(steps.length);
}
const helper =
  '!f() { printf "%s\\n" "username=x-access-token" "password=$VMETHOD_GIT_TOKEN"; }; f';
const https = (command: "fetch" | "push", ref: string) => [
  "-c",
  "credential.helper=",
  "-c",
  `credential.helper=${helper}`,
  command,
  command === "push" ? "--porcelain" : "-q",
  "https://github.com/example/project.git",
  ref,
];
const resolveCommit = {
  args: ["rev-parse", "--verify", "refs/heads/7-task^{commit}"],
  output: `${sha}\n`,
};
const fetchBase = {
  args: https("fetch", "+refs/heads/pack/x:refs/remotes/origin/pack/x"),
};
const count = (output = "1") => ({
  args: ["rev-list", "--count", `refs/remotes/origin/pack/x..${sha}`],
  output,
});
const diff = (output = "") => ({
  args: ["diff", "--name-only", "--diff-filter=ACMR", "-z", `refs/remotes/origin/pack/x...${sha}`],
  output,
});

test("push freezes a local ref, uses the actual pack base, and never passes a secret in argv", async () => {
  const f = fixtureServer([task()]);
  const done = gitFake(f.deps, f.root, [
    resolveCommit,
    fetchBase,
    count(),
    diff(
      "package-lock.json\0test/fixtures/debug.log\0test/fixtures/dist/file.js\0test/__snapshots__/debug.log\0changes/unreleased/test.log\0"
    ),
    {
      args: https("push", `${sha}:refs/heads/7-task`),
      inspect(env) {
        expect(env.VMETHOD_GIT_TOKEN).toBe("fake-token");
      },
    },
    { args: ["update-ref", "refs/remotes/origin/7-task", sha] },
  ]);
  expect(await f.gateway.call("push", { worktree: f.root, branch: "7-task" }, ctx)).toBe(
    `pushed 7-task at ${sha.slice(0, 7)}`
  );
  done();
  f.done();
});

test("push refuses protected and hostile refs before GitHub or git", async () => {
  const f = fixtureServer([]);
  for (const branch of [
    "dev",
    "master",
    "main",
    "HEAD",
    "-x",
    "../x",
    "a:b",
    "x\nrefs/heads/dev",
    "x.lock",
    "a//b",
  ]) {
    await expect(f.gateway.call("push", { worktree: f.root, branch }, ctx)).rejects.toThrow();
  }
  await expect(
    f.gateway.call("push", { worktree: f.root, branch: "7-task" }, { role: "worker" })
  ).rejects.toThrow("taskPr");
  f.done();
});

test("push rejects other task branches, forks, closed tasks and unaccepted authors", async () => {
  for (const overrides of [
    { headRefName: "8-other" },
    { headRepository: { nameWithOwner: "attacker/fork" } },
    { state: "CLOSED" },
    { author: { ...actor(1), databaseId: 900 } },
  ]) {
    const f = fixtureServer([task(overrides)]);
    await expect(
      f.gateway.call("push", { worktree: f.root, branch: "7-task" }, ctx)
    ).rejects.toThrow();
    f.done();
  }
});

test("push zero-commit guard compares against pack/x, never origin/dev", async () => {
  const f = fixtureServer([task()]);
  const done = gitFake(f.deps, f.root, [resolveCommit, fetchBase, count("0")]);
  await expect(f.gateway.call("push", { worktree: f.root, branch: "7-task" }, ctx)).rejects.toThrow(
    "7-task has no commits on top of origin/pack/x"
  );
  done();
  f.done();
});

test("push names each changed generated artefact, not unchanged files or allowed fixture data", async () => {
  const f = fixtureServer([task()]);
  const done = gitFake(f.deps, f.root, [
    resolveCommit,
    fetchBase,
    count(),
    diff(
      ".tmp/a\0dist/index.js\0coverage/a\0test-results/report.xml\0playwright-report/a\0nested/debug.log\0package-lock.json\0test/fixtures/valid.md\0test/__snapshots__/a.snap\0changes/unreleased/23.md\0"
    ),
  ]);
  await expect(f.gateway.call("push", { worktree: f.root, branch: "7-task" }, ctx)).rejects.toThrow(
    "generated artefacts:\n.tmp/a\ndist/index.js\ncoverage/a\ntest-results/report.xml\nplaywright-report/a\nnested/debug.log"
  );
  done();
  f.done();
});

test("push.denyPatterns replaces defaults and applies directory and basename globs", async () => {
  const f = fixtureServer([task()]);
  writeFileSync(
    join(f.root, "vmethod.yaml"),
    readFileSync(join(f.root, "vmethod.yaml"), "utf8").replace(
      "push: {}",
      "push:\n  denyPatterns: ['private/', '*.secret']"
    )
  );
  const gateway = createGateway(f.root, f.env, f.deps);
  const done = gitFake(f.deps, f.root, [
    resolveCommit,
    fetchBase,
    count(),
    diff("dist/index.js\0private/data\0nested/a.secret\0"),
  ]);
  await expect(gateway.call("push", { worktree: f.root, branch: "7-task" }, ctx)).rejects.toThrow(
    "generated artefacts:\nprivate/data\nnested/a.secret"
  );
  done();
  f.done();
});

test("push retries HTTPS then SSH with environment-only keys and updates tracking only on success", async () => {
  const f = fixtureServer([task()]);
  const key = join(f.root, "key with ' quotes");
  writeFileSync(key, "fake key");
  const env = { ...f.env, EXAMPLE_SSH_KEY: key };
  const gateway = createGateway(f.root, env, f.deps);
  const push = https("push", `${sha}:refs/heads/7-task`);
  const done = gitFake(f.deps, f.root, [
    resolveCommit,
    fetchBase,
    count(),
    diff(),
    ...Array.from({ length: 3 }, () => ({ args: push, fail: true })),
    {
      args: [
        "push",
        "--porcelain",
        "git@github.com:example/project.git",
        `${sha}:refs/heads/7-task`,
      ],
      inspect(env) {
        expect(env.GIT_SSH_COMMAND).toContain("'\\''");
        expect(env.VMETHOD_GIT_TOKEN).toBeUndefined();
      },
    },
    { args: ["update-ref", "refs/remotes/origin/7-task", sha] },
  ]);
  expect(await gateway.call("push", { worktree: f.root, branch: "7-task" }, ctx)).toContain(
    "pushed"
  );
  expect(f.sleeps).toEqual([2000, 4000]);
  expect(f.reports).toContain("HTTPS push failed; trying SSH");
  expect(f.reports.join("\n")).not.toContain("fake-token");
  done();
  f.done();
});

test("push fetch failure and moved remote fail without force-push or tracking updates", async () => {
  for (const failFetch of [true, false]) {
    const f = fixtureServer([task()]);
    const failed = failFetch ? fetchBase : { args: https("push", `${sha}:refs/heads/7-task`) };
    const steps = [
      resolveCommit,
      ...(failFetch ? [] : [fetchBase, count(), diff()]),
      ...Array.from({ length: 3 }, () => ({ ...failed, fail: true })),
    ];
    const done = gitFake(f.deps, f.root, steps);
    await expect(
      f.gateway.call("push", { worktree: f.root, branch: "7-task" }, ctx)
    ).rejects.toThrow(
      failFetch ? "fetch failed" : "remote branch moved: fetch and merge it (never force-push)"
    );
    done();
    f.done();
  }
});

const comments = (nodes: unknown[]) =>
  graph({
    node: item({ comments: { nodes, pageInfo: { hasNextPage: false } } }),
  });
const meta = (node: ReturnType<typeof item>) => {
  const metadata = { ...node };
  delete metadata.body;
  delete metadata.createdAt;
  return metadata;
};

test("removed wait-review worker verb cannot poll GitHub", async () => {
  const f = fixtureServer([]);
  await expect(
    workerVerb(f.gateway, f.root, "wait-review", ["3"], { VMETHOD_TASK_PR: "3" }, f.deps)
  ).rejects.toThrow("Unknown worker verb");
  f.done();
});

test("pr-comment checks Markdown before every post, guards closers, keeps a leading [worker] header as is, refuses an [orchestrator] header and adds no footer", async () => {
  const body = "ACK `$(touch OWNED)`\n\n```sh\nrm -rf / # data only\n```\n";
  const f = fixtureServer([
    graph({ repository: { issueOrPullRequest: item() } }),
    {
      path: "/repos/example/project/issues/3/comments",
      body: { body: `[worker] ${body}` },
    },
    graph({ repository: { issueOrPullRequest: item() } }),
    {
      path: "/repos/example/project/issues/3/comments",
      body: { body: "[worker] ACK already prefixed\n" },
    },
    graph({ repository: { issueOrPullRequest: item() } }),
    {
      path: "/repos/example/project/issues/3/comments",
      body: { body: "\n\n[worker] ACK after leading blanks\n" },
    },
  ]);
  const deps = { exec: f.deps.exec, report: f.deps.report };
  const file = join(f.root, "body.md");
  for (const bad of [
    hostile,
    "ACK\n```mermaid\ninvalid\n",
    "ACK\n~~~\nunclosed",
    "Fixes #4",
    "Part of #5",
  ]) {
    writeFileSync(file, bad);
    await expect(
      workerVerb(f.gateway, f.root, "pr-comment", ["3", file], { VMETHOD_TASK_PR: "3" }, deps)
    ).rejects.toThrow();
  }
  writeFileSync(file, body);
  expect(
    await workerVerb(f.gateway, f.root, "pr-comment", ["3", file], { VMETHOD_TASK_PR: "3" }, deps)
  ).toContain("Posted");
  writeFileSync(file, "[worker] ACK already prefixed\n");
  await workerVerb(f.gateway, f.root, "pr-comment", ["3", file], { VMETHOD_TASK_PR: "3" }, deps);
  writeFileSync(file, "\n\n[worker] ACK after leading blanks\n");
  await workerVerb(f.gateway, f.root, "pr-comment", ["3", file], { VMETHOD_TASK_PR: "3" }, deps);
  writeFileSync(file, "[orchestrator] ANSWER for the worker\n");
  await expect(
    workerVerb(f.gateway, f.root, "pr-comment", ["3", file], { VMETHOD_TASK_PR: "3" }, deps)
  ).rejects.toThrow(
    /First non-blank line is the protocol header "\[orchestrator\] ANSWER for the worker"; pr-comment adds the \[worker\] header itself and a worker never posts \[orchestrator\] protocol/
  );
  writeFileSync(file, "\n\n[orchestrator] ANSWER for the worker\n");
  await expect(
    workerVerb(f.gateway, f.root, "pr-comment", ["3", file], { VMETHOD_TASK_PR: "3" }, deps)
  ).rejects.toThrow("a worker never posts [orchestrator] protocol");
  expect(existsSync(join(f.root, "OWNED"))).toBe(false);
  f.done();
});

test("read-pr delivers the prompt, comments and reviews through filtered labelled reads", async () => {
  const review = item({
    id: "review",
    author: actor(2),
    body: "[orchestrator] REVIEW",
  });
  const f = fixtureServer([
    task(),
    graph({ node: item({ title: "Task", body: "Prompt" }) }),
    comments([]),
    task(),
    graph({
      node: item({
        reviews: { nodes: [meta(review)], pageInfo: { hasNextPage: false } },
      }),
    }),
    graph({ node: review }),
  ]);
  const output = await workerVerb(
    f.gateway,
    f.root,
    "read-pr",
    ["3"],
    {},
    { exec: f.deps.exec, report: f.deps.report }
  );
  expect(output).toContain("Prompt");
  expect(output).toContain("from worker (worker)");
  expect(output).toContain("from peer (orchestrator)");
  expect(output).toContain("[orchestrator] REVIEW");
  f.done();
});

test("read-pr labels a peer project's orchestrator comment as a collaborator, never an amendment", async () => {
  const answer = item({
    id: "peer-answer",
    author: vecsmasterActor,
    body: "[orchestrator] ANSWER\n\nPeer answer.",
  });
  const f = orchestratorFixture(
    [
      task(),
      graph({ node: item({ title: "Task", body: "Prompt" }) }),
      comments([meta(answer)]),
      graph({ node: answer }),
      task(),
      graph({ node: item({ reviews: { nodes: [], pageInfo: { hasNextPage: false } } }) }),
    ],
    actor(2),
    [...people, vecsmaster]
  );
  const output = await workerVerb(
    f.gateway,
    f.root,
    "read-pr",
    ["3"],
    {},
    { exec: f.deps.exec, report: f.deps.report }
  );
  expect(output).toContain("from vecsmaster (collaborator)");
  expect(output).not.toContain("from vecsmaster (orchestrator)");
  f.done();
});
