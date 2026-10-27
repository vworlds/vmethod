import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parse } from "graphql";
import { stringify } from "yaml";
import { TaskFlow, conformingTitle } from "../../src/gateway/task-flow.js";
import { GitHubClient, type Dependencies } from "../../src/gateway/client.js";
import { getConfig } from "../../src/config.js";
import { object, type ObjectData, type Person } from "../../src/gateway/people.js";
import type { Card } from "../../src/board/types.js";
import { validProject, ghConfig } from "../helpers.js";
import { actor, people, sha } from "./helpers.js";
import legacyBodies from "../fixtures/github/legacy-task-bodies.json" with { type: "json" };
import closingReferences from "../fixtures/github/task-closing-references.json" with { type: "json" };
import developmentLinks from "../fixtures/github/task-development-links.json" with { type: "json" };
import { BoardService } from "../../src/gateway/board.js";
import { WatchFake } from "./watch-fake.js";
import { writeState } from "../../src/board/readme.js";
import { taskFlowVerb } from "../../src/cli/task-flow.js";
import type { Operations, Transport } from "../../src/gateway/transport.js";
import { WorkerService } from "../../src/gateway/workers.js";
import { bodyHash, scopeApproved } from "../../src/gateway/scope.js";
import { taskModelOverride } from "../../src/gateway/task-flow-types.js";
import { PeopleFilter } from "../../src/gateway/people.js";
import { Digest } from "../../src/gateway/digest.js";
import { scopeIssue, scopeComment, scopeMove } from "./scope-fixture.js";
import packageInfo from "../../package.json" with { type: "json" };
import { ConflictService, type ConflictHooks } from "../../src/gateway/conflicts.js";
import { proc } from "./watch-fake.js";

const holdBanner = "> ⛔ ON HOLD. Wait for [orchestrator] GO.";

test("autopilot delivery review advances Owner review to Approved with per-step comments", async () => {
  const f = fixture();
  f.set({ boardValues: { Status: "Executing", Progress: "🤖👍" } });
  f.host.autopilot = async () => ({
    active: true,
    grant: "owner-grant",
    at: () => true,
    unauthorized: false,
  });
  const file = join(f.root, "review.md");
  writeFileSync(file, "Reviewed implementation and tests.\n");
  await f.flow().review({ ref: "27", outcome: "owner", file });
  expect(f.touched).toContainEqual(
    expect.objectContaining({ field: "Status", value: "Owner review" })
  );
  expect(f.touched).toContainEqual(expect.objectContaining({ field: "Status", value: "Approved" }));
  const comments = f.writes
    .filter((write) => write.path.endsWith("/comments"))
    .map((write) => String(write.body.body));
  expect(comments.some((body) => body.includes("Executing → Owner review under autopilot"))).toBe(
    true
  );
  expect(
    comments.some(
      (body) =>
        body.includes(`Current head: ${sha}`) &&
        body.includes("Owner review → Approved under autopilot")
    )
  ).toBe(true);
  f.done();
});

test("removal during autopilot review leaves the current Owner review step with the owner", async () => {
  const f = fixture();
  f.set({ boardValues: { Status: "Executing", Progress: "🤖👍" } });
  let calls = 0;
  f.host.autopilot = async () => ({ active: ++calls === 1, at: () => false, unauthorized: false });
  const file = join(f.root, "review.md");
  writeFileSync(file, "Reviewed.\n");
  await f.flow().review({ ref: "27", outcome: "owner", file });
  expect(f.touched).toContainEqual(
    expect.objectContaining({ field: "Status", value: "Owner review" })
  );
  expect(f.touched.some((write) => write.value === "Approved")).toBe(false);
  f.done();
});

test("open-task invokes owner-authorized label inheritance after creating the task", async () => {
  const f = fixture();
  const copies: unknown[] = [];
  f.host.copyAutopilot = async (issue, pr) => {
    copies.push({ issue: issue.id, pr: pr.id, number: pr.number });
  };
  await f.flow().open({ issue: "8", model: "sol" });
  expect(copies).toEqual([{ issue: "issue", pr: "pr", number: 27 }]);
  f.done();
});

test("autopilot never bypasses the expensive-model gate", async () => {
  const f = fixture();
  f.host.autopilot = async () => ({ active: true, at: () => true, unauthorized: false });
  f.set({ modelApproval: false });
  await expect(f.flow().open({ issue: "8", model: "astra", ownerApproved: true })).rejects.toThrow(
    "owner-gated"
  );
  expect(f.writes).toEqual([]);
  f.done();
});

test.each([
  "people.yaml",
  ".claude/settings.json",
  "vmethod.yaml",
  ".opencode/permissions.json",
  ".github/CODEOWNERS",
])("autopilot cannot authorize owner-reserved file %s", async (path) => {
  const f = fixture();
  f.set({ approved: false });
  f.host.autopilotApproved = async () => true;
  const original = f.deps.exec;
  f.deps.exec = async (file, args, options) =>
    args[0] === "diff" && args[1] === "--name-only" ? path : original(file, args, options);
  await expect(f.flow().merge("27")).rejects.toThrow(
    "cannot authorize releases, identity or permission changes"
  );
  expect(f.writes.some((write) => write.path.endsWith("/merge"))).toBe(false);
  f.done();
});

test.each([false, true])(
  "autopilot merge requires fresh delegation and exact-head review (revoked=%s)",
  async (revoked) => {
    const f = fixture();
    f.set({ approved: false });
    let calls = 0;
    f.host.autopilotApproved = async (ref, head) => {
      expect({ ref, head }).toEqual({ ref: "27", head: sha });
      return !revoked || ++calls === 1;
    };
    if (revoked) {
      await expect(f.flow().merge("27")).rejects.toThrow("revoked during merge checks");
      expect(f.writes.some((write) => write.path.endsWith("/merge"))).toBe(false);
    } else {
      await f.flow().merge("27");
      expect(f.writes.some((write) => write.path.endsWith("/merge"))).toBe(true);
      expect(
        f.writes.some((write) => String(write.body.body).includes(`Merging ${sha} under autopilot`))
      ).toBe(true);
    }
    f.done();
  }
);

test("Executing issue summons pauses linked workers and requires agreement from that issue", async () => {
  const f = fixture();
  const original = f.deps.fetch;
  f.deps.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/repos/example/project/pulls") {
      return Response.json([{ number: 27, body: '<!-- vmethod-task {"issues":[8]} -->' }]);
    }
    return original(input, init);
  };
  const clears: number[] = [],
    stops: number[] = [];
  f.deps.workers!.clearWake = async (pr) => {
    clears.push(pr);
  };
  f.deps.workers!.status = async () => "live";
  f.deps.workers!.stop = async (pr) => {
    stops.push(pr);
  };
  const file = join(f.root, "question.md");
  writeFileSync(file, "Decision?\n");
  await f.flow().ask("8", file);
  expect(clears).toEqual([27]);
  expect(stops).toEqual([27]);
  expect(f.touched).toContainEqual(
    expect.objectContaining({ id: "issue", field: "Status", value: "Executing", progress: "👤❓" })
  );
  // The board/comment fakes expose the writes on the next read, just as the live API does.
  f.cards[0].values.Progress = "👤❓";
  f.comments.push(scopeComment({ body: "[orchestrator] OWNER QUESTION\n\nDecision?" }));
  f.set({ boardValues: { Status: "Executing", Progress: "🤖❓" } });
  f.host.ownerAgreement = async (ref, _url, _since, _text, kind) => {
    expect({ ref, kind }).toEqual({ ref: "8", kind: "issue" });
    return true;
  };
  writeFileSync(file, "> Yes, proceed.\n");
  await f.flow().review({
    ref: "27",
    outcome: "answer",
    file,
    ownerAgreed: "https://github.com/example/project/issues/8#issuecomment-123",
  });
  expect(f.resumes).toHaveLength(1);
  expect(f.touched).toContainEqual(
    expect.objectContaining({ id: "issue", field: "Status", value: "Executing", progress: null })
  );
  f.done();
});

test.each(["answer", "changes", "owner", "approve"] as const)(
  "Executing summons refuses %s without agreement before side effects",
  async (outcome) => {
    const f = fixture();
    f.set({ boardValues: { Status: "Executing", Progress: "👤❓" }, assignees: ["owner"] });
    f.comments.push(scopeComment({ body: "[orchestrator] OWNER QUESTION\n\nDecision?" }));
    const file = join(f.root, ".tmp", "answer.md");
    mkdirSync(join(f.root, ".tmp"), { recursive: true });
    writeFileSync(file, "> Yes, proceed.\n");
    await expect(f.flow().review({ ref: "27", outcome, file })).rejects.toThrow(
      "summons is paused"
    );
    expect(f.writes).toEqual([]);
    expect(f.touched).toEqual([]);
    expect(f.resumes).toEqual([]);
    f.done();
  }
);

test.each([false, true])(
  "Executing summons wakes only after verified agreement (valid=%s)",
  async (valid) => {
    const f = fixture();
    f.set({ boardValues: { Status: "Executing", Progress: "👤❓" }, assignees: ["owner"] });
    const summons = scopeComment({ body: "[orchestrator] OWNER QUESTION\n\nDecision?" });
    f.comments.push(summons);
    const url = "https://github.com/example/project/pull/27#issuecomment-123";
    const file = join(f.root, ".tmp", "answer.md");
    mkdirSync(join(f.root, ".tmp"), { recursive: true });
    writeFileSync(file, "> Yes, proceed.\n");
    f.host.ownerAgreement = async (ref, target, since, text) => {
      expect({ ref, target, since, text }).toEqual({
        ref: "27",
        target: url,
        since: Date.parse(String(summons.createdAt)),
        text: "> Yes, proceed.\n",
      });
      return valid;
    };
    const result = f.flow().review({ ref: "27", outcome: "answer", file, ownerAgreed: url });
    if (valid) {
      await expect(result).resolves.toContain("ANSWER");
      expect(f.touched).toContainEqual(
        expect.objectContaining({ id: "pr", field: "Status", value: "Executing", progress: "🤖🔨" })
      );
      expect(f.resumes).toHaveLength(1);
    } else {
      await expect(result).rejects.toThrow("summons is paused");
      expect(f.writes).toEqual([]);
      expect(f.resumes).toEqual([]);
    }
    f.done();
  }
);

test.each(["Scoping", "Spec review", "Approved", "Done"])(
  "open-task refuses a %s issue even with historical scope approval",
  async (status) => {
    const f = fixture();
    f.cards[0].values.Status = status;
    await expect(f.flow().open({ issue: "8", model: "sol" })).rejects.toThrow(
      "requires an Executing issue"
    );
    expect(f.writes).toEqual([]);
    f.done();
  }
);

test.each(["Executing", "Owner review", "Done"])(
  "merge-task refuses a %s PR even with valid owner evidence",
  async (status) => {
    const f = fixture();
    f.set({ boardValues: { Status: status } });
    await expect(f.flow().merge("27")).rejects.toThrow("requires an Approved PR");
    expect(f.writes).toEqual([]);
    f.done();
  }
);

/** What the scripted host reports for a reply target's REST comment id. */
type ReplyTarget = { author: Person; issue: number; firstLine: string };

const baseSha = "b".repeat(40),
  mergedSha = "c".repeat(40);

test.each([
  { scenario: "conclusions", proceed: false },
  { scenario: "reviewed", proceed: true },
  { scenario: "changed", proceed: false },
  { scenario: "trivial", proceed: true },
  { scenario: "orchestrator question", proceed: true },
  { scenario: "quoted hash", proceed: true },
  { scenario: "one comment", proceed: false },
  { scenario: "fast", proceed: true },
  { scenario: "fast unset", proceed: false },
  { scenario: "part", proceed: true },
  { scenario: "part changed", proceed: false },
])("open-task scope acceptance: $scenario", async ({ scenario, proceed }) => {
  const f = fixture();
  const filter = new PeopleFilter(people, "example", new Digest(f.env, "scope", f.deps.now));
  const issue = scopeIssue({
    body: scenario.includes("changed") ? "Changed body" : "Final scope",
    labels: { nodes: [{ name: "bug" }] },
  });
  const comments =
    scenario === "trivial"
      ? []
      : [
          scopeComment({
            author: ["conclusions", "one comment"].includes(scenario) ? actor() : actor(2),
            body: ["conclusions", "one comment"].includes(scenario)
              ? "Discussion"
              : scenario === "orchestrator question"
                ? "[orchestrator] OWNER QUESTION\n\nMove this to Approved to start."
                : `[orchestrator] SCOPE REVIEW\n\nbody sha256: ${scenario === "quoted hash" ? `\`${bodyHash("Final scope")}\`` : bodyHash("Final scope")}`,
          }),
        ];
  if (scenario === "fast") {
    f.config.scope = { fastPath: ["bug"] };
  }
  const timeline = scenario.startsWith("fast") ? [] : [scopeMove()];
  f.host.issueApproved = async () => scopeApproved(issue, comments, timeline, f.config, filter);
  if (proceed) {
    await expect(
      f.flow().open({ issue: "8", model: "sol", part: scenario.startsWith("part") })
    ).resolves.toContain("27");
    expect(f.writes.some((write) => write.path.endsWith("/pulls"))).toBe(true);
  } else {
    await expect(
      f.flow().open({ issue: "8", model: "sol", part: scenario.startsWith("part") })
    ).rejects.toThrow("scope not approved: post SCOPE REVIEW first");
    expect(f.writes).toEqual([]);
  }
  f.done();
});

test.each([
  {
    case: "contradicting model",
    input: { issue: "8", model: "sol" },
    error:
      'issue #8 has Model glm on its card; use it (omit --model) or override with --model-override "<reason>"',
  },
  {
    case: "empty override reason",
    input: { issue: "8", model: "sol", modelOverride: "  " },
    error: "Invalid task text argument",
  },
  {
    case: "multiline override reason",
    input: { issue: "8", model: "sol", modelOverride: "first\nsecond" },
    error: "--model-override requires --model and a single-line reason",
  },
  {
    case: "override without model",
    input: { issue: "8", modelOverride: "tier" },
    error: "--model-override requires --model and a single-line reason",
  },
])(
  "open-task refuses a contradicting model without a written reason: $case",
  async ({ input, error }) => {
    const f = fixture();
    f.cards[0].values.Model = "glm";
    await expect(f.flow().open(input)).rejects.toThrow(error);
    expect(f.writes).toEqual([]);
    f.done();
  }
);

test("open-task override posts the issue note and records the marker override", async () => {
  const f = fixture();
  f.cards[0].values.Model = "glm";
  await expect(
    f.flow().open({ issue: "8", model: "sol", modelOverride: "needs expensive tier" })
  ).resolves.toContain("27");
  const note = f.writes.find((write) => write.path === "/repos/example/project/issues/8/comments");
  expect(note?.body.body).toBe(
    "[orchestrator] NOTE: model override: using sol instead of the card's glm — needs expensive tier"
  );
  const created = f.writes.find((write) => write.path === "/repos/example/project/pulls");
  expect(String(created?.body.body)).toContain(
    '"modelOverride":{"from":"glm","to":"sol","reason":"needs expensive tier"}'
  );
  f.done();
});

test.each([
  { case: "matching --model", card: "glm", input: { issue: "8", model: "glm" }, family: "glm" },
  { case: "absent --model", card: "glm", input: { issue: "8" }, family: "glm" },
  { case: "no card Model", card: undefined, input: { issue: "8", model: "sol" }, family: "sol" },
])("open-task without an override proceeds unchanged: $case", async ({ card, input, family }) => {
  const f = fixture();
  if (card) {
    f.cards[0].values.Model = card;
  }
  await expect(f.flow().open(input)).resolves.toContain("27");
  const created = f.writes.find((write) => write.path === "/repos/example/project/pulls");
  expect(String(created?.body.body)).not.toContain("modelOverride");
  expect(
    f.writes.filter((write) => write.path === "/repos/example/project/issues/8/comments")
  ).toEqual([]);
  expect(f.touched).toContainEqual(
    expect.objectContaining({ id: "pr", field: "Model", value: family })
  );
  f.done();
});

test("taskModelOverride reads only the structured marker and refuses malformed overrides", () => {
  expect(taskModelOverride('<!-- vmethod-task {"issues":[8]} -->')).toBeUndefined();
  expect(
    taskModelOverride(
      '<!-- vmethod-task {"issues":[8],"modelOverride":{"from":"glm","to":"sol","reason":"tier"}} -->'
    )
  ).toEqual({ from: "glm", to: "sol", reason: "tier" });
  for (const body of [
    '<!-- vmethod-task {"issues":[8],"modelOverride":{}} -->',
    '<!-- vmethod-task {"issues":[8],"modelOverride":null} -->',
    '<!-- vmethod-task {"issues":[8],"modelOverride":"wrong"} -->',
    '<!-- vmethod-task {"issues":[8],"modelOverride":{"from":"glm","to":"sol","reason":"  "}} -->',
    '<!-- vmethod-task {"issues":[8],"modelOverride":{"from":"glm","to":"sol"}} -->',
  ]) {
    expect(() => taskModelOverride(body)).toThrow("Invalid task model override");
  }
});

test.each([false, true])("merge-task rechecks scope for part PRs (changed=%s)", async (changed) => {
  const f = fixture();
  f.set({ body: '<!-- vmethod-task {"issues":[8],"part":true} -->' });
  f.host.issueApproved = async () => !changed;
  if (changed) {
    await expect(f.flow().merge("27")).rejects.toThrow("scope not approved");
    expect(f.writes).toEqual([]);
  } else {
    await expect(f.flow().merge("27")).resolves.toContain("Merged");
  }
  f.done();
});

test.each(
  [
    "open-task",
    "review changes",
    "review owner",
    "review answer",
    "review ask",
    "review approve",
    "merge-task",
  ].flatMap((verb) =>
    [
      "self",
      "owner",
      ...(["review owner", "merge-task"].includes(verb) ? ["sibling"] : []),
    ].flatMap((identity) => [
      { verb, identity, carryApproval: false },
      ...(verb === "merge-task" && identity === "self"
        ? [{ verb, identity, carryApproval: true }]
        : []),
    ])
  )
)(
  "$verb through real board/client writes then watch --once (identity=$identity, carry=$carryApproval)",
  async ({ verb, identity, carryApproval }) => {
    const f = fixture();
    const w = new WatchFake();
    let sibling: WatchFake | undefined;
    try {
      w.enableWrites = true;
      // Exactly one bound orchestrator per repository: "me" acts here, "peer" is foreign.
      w.watchPeople = w.watchPeople
        .map((person) =>
          person.login === "peer" ? { ...person, repos: ["example/other"] } : person
        )
        .concat([
          { login: "me", id: 999, type: "User", role: "orchestrator", repos: ["example/project"] },
        ]);
      f.host.people = w.watchPeople;
      w.root = f.root;
      w.config = { ...f.config, board: w.config.board, vmethod: { repo: "off" } };
      w.env = { ...w.env, ...f.env };
      w.dir = join(f.env.XDG_STATE_HOME, "vmethod", String(f.config.stateName));
      if (identity === "owner") {
        w.writeActor = { login: "owner", id: 101, type: "User" };
        f.config.stateName = "owner-session";
      }
      if (identity === "sibling") {
        f.config.stateName = "sibling-session";
      }
      f.config.board = w.config.board;
      w.readme = writeState("", { version: 2, minCompatible: 1, aliases: {} }, true);
      const status = w.fields.find((field) => field.name === "Status")!;
      status.options = [
        "Backlog",
        "Scoping",
        "Spec review",
        "Executing",
        "Owner review",
        "Approved",
        "Done",
      ].map((name, index) => ({ id: `option-${index}`, name, color: "GRAY", description: "" }));
      w.fields.push({
        id: "model",
        name: "Model",
        dataType: "SINGLE_SELECT",
        createdAt: "2026-10-16T11:12:25Z",
        options: [{ id: "model-sol", name: "sol", color: "GRAY", description: "" }],
      });
      w.cards = [w.card(8, "Executing")];
      object(w.cards[0].content).id = "issue";
      object(w.cards[0].content).assignees = { nodes: [] };
      w.issues = [{ number: 8, labels: [] }];
      if (verb !== "open-task") {
        const pr = w.card(27, verb === "merge-task" ? "Approved" : "Executing", "PullRequest");
        object(pr.content).id = "pr";
        w.cards.push(pr);
        w.pulls = [
          {
            number: 27,
            body: '<!-- vmethod-task {"issues":[8]} -->',
            head: { ref: "8-task", sha },
            base: { ref: "dev" },
            created_at: w.iso(),
            user: { login: "worker", id: 102, type: "User" },
          },
        ];
        w.issues.push({ number: 27, pull_request: {}, labels: [] });
      }
      w.checks = [
        {
          id: 1,
          name: "check",
          app: { id: 909 },
          status: "completed",
          conclusion: "success",
          head_sha: sha,
        },
      ];
      const originalFetch = f.deps.fetch;
      f.deps.fetch = (input, init) => {
        const path = new URL(String(input)).pathname;
        return /\/git\/(matching-refs|refs)\/|\/dependencies\/blocking$/.test(path) ||
          String(init?.body).includes("TaskClosingLink")
          ? originalFetch(input, init)
          : w.deps.fetch(input, init);
      };
      f.deps.now = w.deps.now;
      if (carryApproval) {
        const old = "d".repeat(40);
        f.host.approved = async (_ref, historical) => historical === old;
        f.host.candidates = async () => [old];
        const exec = f.deps.exec;
        f.deps.exec = async (file, args, options) => {
          if (
            file === "git" &&
            args.join(" ") === `rev-list --parents ${old}..${sha} --not ${baseSha}`
          ) {
            return `${sha} ${old} ${baseSha}`;
          }
          if (
            file === "git" &&
            args.join(" ") === `show --remerge-diff --format= --name-only -z ${sha}`
          ) {
            return "conflict.ts\0";
          }
          return exec(file, args, options);
        };
      }
      const github = new GitHubClient(f.config, f.env, f.deps);
      f.host.github = github;
      const board = new BoardService(f.config, github, f.deps);
      f.host.board = () => board;
      const transport: Transport = {
        call: async (operation, input) => {
          if (operation === "openTask") {
            return (await f.flow().open(input as Operations["openTask"]["input"])) as never;
          }
          if (operation === "reviewTask") {
            return (await f.flow().review(input as Operations["reviewTask"]["input"])) as never;
          }
          if (operation === "mergeTask") {
            const merge = input as Operations["mergeTask"]["input"];
            return (await f
              .flow()
              .merge(merge.ref, merge.mergeCommit, merge.carryApproval)) as never;
          }
          throw new Error(`Unexpected matrix operation ${operation}`);
        },
      };
      const commandEnv = { VMETHOD_ROLE: "orchestrator" };
      const loop = w.loop();
      const once = () => w.once(loop);
      expect(await once()).toEqual([]);
      if (identity === "sibling") {
        sibling = new WatchFake();
        sibling.enableWrites = true;
        sibling.watchPeople = w.watchPeople;
        sibling.root = w.root;
        sibling.env = w.env;
        sibling.config = { ...w.config, stateName: "sibling-session" };
        sibling.dir = join(f.env.XDG_STATE_HOME, "vmethod", "sibling-session");
        sibling.cards = structuredClone(w.cards);
        sibling.pulls = w.pulls;
        sibling.issues = w.issues;
        sibling.clock = w.clock;
        expect(await sibling.once(sibling.loop())).toEqual([]);
      }
      w.advance();
      w.clock += 668;
      if (["review changes", "review answer", "review approve"].includes(verb)) {
        for (const card of w.cards) {
          if (object(card.content).__typename !== "PullRequest") {
            continue;
          }
          card.progress = { text: "👤🔍" };
          object(card.content).assignees = { nodes: [{ login: "owner" }] };
        }
        object(w.cards.find((card) => object(card.content).number === 27)!.status).name =
          "Owner review";
      }
      if (verb === "open-task") {
        await taskFlowVerb(transport, verb, ["8", "--model", "sol"], commandEnv);
      } else if (verb === "merge-task") {
        await taskFlowVerb(
          transport,
          verb,
          ["27", ...(carryApproval ? ["--carry-approval", "Conflict resolution only"] : [])],
          commandEnv
        );
        w.closingPrs[8] = [[{ state: "MERGED" }]];
      } else {
        const file = join(f.root, ".tmp", "review.md");
        mkdirSync(join(f.root, ".tmp"), { recursive: true });
        writeFileSync(file, "Review body\n");
        const ownerReply = verb === "review owner" && identity === "self";
        if (ownerReply) {
          const pr = w.cards.find((card) => object(card.content).number === 27)!;
          pr.status = { ...object(pr.status), name: "Owner review" };
          pr.progress = { text: "👤🔍" };
          object(pr.content).assignees = { nodes: [{ login: "owner" }] };
          const question = w.comment("Can you explain the change?", 0);
          question.issue_url = "https://api.github.com/repos/example/project/issues/27";
          question.html_url = "https://github.com/example/project/pull/27#issuecomment-1";
          await once();
          expect(object(pr.progress).text).toBe("🧭🔍");
          expect(object(object(pr.content).assignees).nodes).toEqual([{ login: "me" }]);
          w.advance();
        }
        await taskFlowVerb(
          transport,
          "review",
          [
            "27",
            verb.split(" ")[1],
            file,
            ...(ownerReply
              ? ["--in-reply-to", "https://github.com/example/project/pull/27#issuecomment-1"]
              : []),
          ],
          commandEnv
        );
        if (ownerReply) {
          expect(w.comments["example/project"].at(-1)?.body).toContain(
            "in reply to https://github.com/example/project/pull/27#issuecomment-1"
          );
        }
      }
      let events = await once();
      if (verb === "merge-task" && identity === "sibling") {
        expect(events.some((event) => event.kind === "button-merge")).toBe(false);
        w.advance(10 * 60_000);
        events = await once();
      }
      if (verb.startsWith("review ")) {
        const ownerTurn = ["review owner", "review ask"].includes(verb);
        const prCard = w.cards.find((card) => object(card.content).number === 27)!;
        const issueCard = w.cards.find((card) => object(card.content).number === 8)!;
        expect(object(object(prCard.content).assignees).nodes).toEqual(
          ownerTurn ? [{ login: "owner" }] : verb === "review approve" ? [{ login: "me" }] : []
        );
        expect(object(object(issueCard.content).assignees).nodes).toEqual([]);
        expect(object(issueCard.progress).text).toBeNull();
        expect(object(prCard.progress).text ?? "").toBe(
          verb === "review changes"
            ? "🤖🔨 🔁1️⃣"
            : verb === "review answer"
              ? "🤖🔨"
              : verb === "review owner"
                ? "👤🔍"
                : verb === "review ask"
                  ? "👤❓"
                  : "🧭🔍"
        );
      }
      if (identity !== "self" && verb !== "open-task") {
        expect(events.map((event) => event.kind)).toContain(
          verb === "open-task" ? "owner-done" : verb === "merge-task" ? "button-merge" : "comment"
        );
      } else {
        expect(events).toEqual([]);
      }
      if (verb === "merge-task") {
        expect(events.filter((event) => event.kind === "closed")).toEqual([]);
      }
      if (sibling) {
        expect(events.some((event) => event.line.includes("this account, another session"))).toBe(
          true
        );
        if (verb === "review owner") {
          expect(events.some((event) => event.kind === "board")).toBe(true);
          expect(
            events
              .filter((event) => event.kind === "board")
              .every((event) => !event.line.includes(" by "))
          ).toBe(true);
        }
        sibling.cards = w.cards;
        sibling.comments = w.comments;
        sibling.pulls = w.pulls;
        sibling.gone = w.gone;
        sibling.assignmentEvents = w.assignmentEvents;
        sibling.closingPrs = w.closingPrs;
        sibling.clock = w.clock;
        expect(await sibling.once(sibling.loops[0])).toEqual([]);
        expect(sibling.reports).toEqual([]);
      }
      expect(w.reports).toEqual([]);
      expect(
        readFileSync(
          join(f.env.XDG_STATE_HOME, "vmethod", String(f.config.stateName), "writes.jsonl"),
          "utf8"
        )
      ).toContain('"kind":');
      if (verb === "review owner") {
        const entries = readFileSync(
          join(f.env.XDG_STATE_HOME, "vmethod", String(f.config.stateName), "writes.jsonl"),
          "utf8"
        )
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(entries.find((entry) => entry.kind === "comment")).toMatchObject({
          commentId: w.comments["example/project"].at(-1)!.id,
          nodeId: w.comments["example/project"].at(-1)!.node_id,
        });
        expect(
          entries.find((entry) => entry.kind === "markPullRequestReadyForReview")
        ).toMatchObject({ nodeId: "pr" });
        expect(
          entries
            .filter((entry) => entry.kind === "board")
            .every((entry) => entry.itemId && entry.nodeId)
        ).toBe(true);
        expect(entries.some((entry) => entry.kind === "assigned")).toBe(true);
      }
      f.done();
    } finally {
      sibling?.done();
      w.done();
    }
  },
  15000
);
function fixture() {
  const root = validProject();
  const configPath = join(root, "vmethod.yaml");
  writeFileSync(
    configPath,
    readFileSync(configPath, "utf8").replace("/replace/with/consumer/checkout", root)
  );
  const config = getConfig(root, {});
  const events: string[] = [];
  const resumes: { pr: number; prompt: string }[] = [];
  const writes: { path: string; body: ObjectData }[] = [];
  let approved: boolean | "unknown" = true,
    issueApproved: boolean | "unknown" = true,
    modelApproval = true;
  let worker: "live" | "stopped" | "unknown" = "stopped";
  let fail = "",
    liveBase = baseSha,
    currentHead = sha,
    title = "feat: task";
  let prState = "OPEN",
    actualBase = "dev",
    branch = "8-task";
  let mergeable = "MERGEABLE",
    conflictPending = false;
  let body = '<!-- vmethod-task {"issues":[8]} -->';
  let issueNumber = 8;
  let isDraft = true;
  let references: ObjectData = structuredClone(
    developmentLinks.before.data.repository.pullRequest.closingIssuesReferences
  );
  let checks = [
    {
      id: 1,
      name: "check",
      app: { id: 909 },
      status: "completed",
      conclusion: "success",
      head_sha: sha,
    },
  ];
  let dirty = false,
    changed = true,
    issueClosed = false,
    branchExists = true,
    checkoutHead = sha;
  let assignees: string[] = [];
  let boardValues: Record<string, string | number | null> = { Status: "Approved" };
  const comments: ObjectData[] = [];
  let replyTarget: ReplyTarget | undefined;
  const cards: Card[] = [
    {
      id: "issue-card",
      contentId: "issue",
      number: 8,
      repo: "example/project",
      kind: "Issue",
      assignees: [],
      values: { Estimate: 13, Status: "Executing" },
    },
  ];
  const touched: { id: string; field: string; value: unknown; progress?: unknown }[] = [];
  const unexpected: string[] = [];
  const deps: Dependencies = {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://api.github.com");
      const method = init?.method ?? "GET",
        path = url.pathname + url.search;
      const payload = init?.body ? object(JSON.parse(String(init.body))) : {};
      events.push(`${method} ${path}`);
      writes.push({ path, body: payload });
      if (fail && path.includes(fail)) {
        throw new Error("injected failure");
      }
      let data: unknown;
      if (method === "POST" && path === "/graphql") {
        parse(String(payload.query));
        const query = String(payload.query);
        const mutation = query.includes("markPullRequestReadyForReview")
          ? "markPullRequestReadyForReview"
          : query.includes("convertPullRequestToDraft")
            ? "convertPullRequestToDraft"
            : query.includes("addCloseIssueReferences")
              ? "addCloseIssueReferences"
              : query.includes("removeCloseIssueReferences")
                ? "removeCloseIssueReferences"
                : undefined;
        if (
          mutation === "markPullRequestReadyForReview" ||
          mutation === "convertPullRequestToDraft"
        ) {
          isDraft = mutation === "convertPullRequestToDraft";
          events.push(`draft ${isDraft}`);
          data = { data: {} };
        } else if (mutation) {
          expect(payload.variables).toEqual({ issueId: "issue", pullRequestIds: ["pr"] });
          references = structuredClone(
            (mutation === "addCloseIssueReferences"
              ? developmentLinks.afterAdd
              : developmentLinks.afterRemove
            ).data.repository.pullRequest.closingIssuesReferences
          );
          references.nodes = (references.nodes as ObjectData[]).map((node) => ({
            ...node,
            number: issueNumber,
            repository: { nameWithOwner: "example/project" },
          }));
          data = structuredClone(
            mutation === "addCloseIssueReferences" ? developmentLinks.add : developmentLinks.remove
          );
        } else {
          data = { data: {} };
        }
      } else if (method === "GET" && path.includes("/check-runs?")) {
        data = { check_runs: checks };
      } else if (method === "PUT" && path === "/repos/example/project/pulls/27/merge") {
        expect(payload.sha).toBe(sha);
        prState = "MERGED";
        data = { merged: true };
      } else if (method === "POST" && path === "/repos/example/project/pulls") {
        expect(typeof payload.body).toBe("string");
        body = String(payload.body);
        data = { number: 27, node_id: "pr" };
      } else if (method === "PATCH" && path === "/repos/example/project/pulls/27") {
        expect(["string", "undefined"]).toContain(typeof payload.body);
        if (typeof payload.body === "string") {
          body = String(payload.body);
        }
        if (typeof payload.title === "string") {
          title = payload.title;
        }
        if (payload.state === "closed") {
          prState = "CLOSED";
        }
        data = { number: 27, node_id: "pr", ...(payload.state ? { state: payload.state } : {}) };
      } else if (
        method === "POST" &&
        /^\/repos\/example\/project\/issues\/(8|27)\/comments$/.test(path)
      ) {
        data = {};
      } else if (method === "POST" && path === "/repos/example/project/issues/27/labels") {
        data = {};
      } else if (
        method === "GET" &&
        [issueNumber, 27].some((n) => path === `/repos/example/project/issues/${n}`)
      ) {
        data = { assignees: assignees.map((login) => ({ login })) };
      } else if (
        method === "POST" &&
        /^\/repos\/example\/project\/issues\/(8|27)\/assignees$/.test(path)
      ) {
        data = {};
      } else if (
        method === "DELETE" &&
        /^\/repos\/example\/project\/issues\/(8|27)\/assignees$/.test(path)
      ) {
        data = {};
      } else if (method === "PATCH" && path === `/repos/example/project/issues/${issueNumber}`) {
        issueClosed = true;
        data = {};
      } else if (
        method === "GET" &&
        path ===
          `/repos/example/project/issues/${issueNumber}/dependencies/blocking?per_page=100&page=1`
      ) {
        data = [
          {
            number: 9,
            state: "open",
            repository_url: "https://api.github.com/repos/example/project",
          },
          {
            number: 44,
            state: "open",
            repository_url: "https://api.github.com/repos/example/foreign",
          },
        ];
      } else if (
        method === "GET" &&
        path.startsWith("/repos/example/project/git/matching-refs/heads/")
      ) {
        data = branchExists ? [{ ref: `refs/heads/${branch}`, object: { sha: currentHead } }] : [];
      } else if (method === "DELETE" && path.startsWith("/repos/example/project/git/refs/heads/")) {
        branchExists = false;
        data = {};
      } else {
        unexpected.push(`${method} ${path}`);
        throw new Error(`Unexpected request ${method} ${path}`);
      }
      return new Response(JSON.stringify(data), { status: 200 });
    },
    exec: async (file, args, options) => {
      const command = `${file} ${args.join(" ")}`;
      events.push(command);
      if (file === "sh" && args[0] === "-c" && args[1] === "npm ci") {
        expect(options?.env).not.toHaveProperty("EXAMPLE_GITHUB_TOKEN");
        expect(options?.env?.HUSKY).toBe("0");
        if (fail === "install") {
          throw new Error("install failed");
        }
        return "";
      }
      if (file !== "git") {
        unexpected.push(command);
        throw new Error(`Unexpected ${command}`);
      }
      if (args.includes("fetch") || args.includes("push")) {
        return "";
      }
      if (args[0] === "commit-tree") {
        return sha;
      }
      if (
        (args[0] === "for-each-ref" &&
          args[1] === "--format=%(objectname)" &&
          args[2]?.startsWith("refs/heads/")) ||
        (args[0] === "worktree" && args[1] === "prune")
      ) {
        return "";
      }
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        if (fail === "base") {
          throw new Error("base moved");
        }
        return "";
      }
      if (args.join(" ") === "rev-parse --abbrev-ref HEAD") {
        return "dev";
      }
      if (args.join(" ") === "status --porcelain --untracked-files=no") {
        return dirty ? " M package-lock.json" : "";
      }
      if (args.join(" ") === "rev-parse HEAD") {
        return checkoutHead;
      }
      if (args.join(" ") === `rev-parse refs/remotes/origin/${actualBase}`) {
        return prState === "OPEN" ? liveBase : mergedSha;
      }
      if (args[0] === "merge" && args[1] === "--ff-only") {
        checkoutHead = String(args[2]);
        return "";
      }
      if (args[0] === "diff" && args[1] === "--name-only") {
        return changed ? "package-lock.json" : "";
      }
      unexpected.push(command);
      throw new Error(`Unexpected ${command}`);
    },
    now: () => 0,
    sleep: async () => {
      throw new Error("Unexpected retry/sleep");
    },
    report: (message) => {
      events.push(`report ${message}`);
    },
    workers: {
      status: async () => {
        events.push("worker-status");
        return worker;
      },
      resume: async (pr, prompt) => {
        events.push("worker-resume");
        resumes.push({ pr, prompt });
      },
    },
  };
  const env = {
    GH_CONFIG_DIR: ghConfig("secret"),
    XDG_STATE_HOME: join(root, "state"),
    GIT_AUTHOR_NAME: "A",
    GIT_AUTHOR_EMAIL: "a@b",
    GIT_COMMITTER_NAME: "C",
    GIT_COMMITTER_EMAIL: "c@b",
  };
  const host: ConstructorParameters<typeof TaskFlow>[4] = {
    people,
    github: new GitHubClient({ ...config, gateway: { maxRetries: 0 } }, env, deps),
    board: () => ({
      ensure: async (id) => {
        events.push(`board-add ${id}`);
        return id;
      },
      item: async (id) => {
        events.push(`board-item ${id}`);
        return {
          id,
          repo: "example/project",
          kind: "PullRequest",
          assignees,
          values: { ...boardValues },
        };
      },
      set: async (input) => {
        if (fail === "board" && input.value === "Done") {
          throw new Error("board failed");
        }
        touched.push({ id: input.itemId, ...input });
        events.push(`board ${input.itemId} ${input.field} ${String(input.value)}`);
        return "ok";
      },
      capDone: async () => {
        events.push("done-cap");
      },
      snapshot: async () => ({ id: "board", readme: "", fields: [] }),
      cards: async () => [
        ...cards,
        {
          id: "pr",
          contentId: "pr",
          repo: "example/project",
          kind: "PullRequest",
          assignees,
          values: { ...boardValues },
        },
      ],
    }),
    thread: async (ref, kind) => {
      events.push(`read ${kind} ${ref}`);
      if (kind === "issue" && ref === String(issueNumber)) {
        return {
          id: "issue",
          title,
          body,
          state: issueClosed ? "CLOSED" : "OPEN",
          labels: { nodes: [] },
        };
      }
      if (kind !== "pr" || ref !== "27") {
        throw new Error(`Unexpected thread ${kind} ${ref}`);
      }
      return {
        id: "pr",
        headRefOid: currentHead,
        baseRefOid: baseSha,
        headRefName: branch,
        baseRefName: actualBase,
        title,
        body,
        state: prState,
        closingIssuesReferences: references,
        mergeable,
        isDraft,
        headRepository: { nameWithOwner: "example/project" },
        labels: { nodes: [] },
      };
    },
    comments: async () => comments,
    replyTarget: async (id) => {
      events.push(`reply-target ${id}`);
      return replyTarget;
    },
    approved: async () => approved,
    candidates: async () => [],
    issueApproved: async () => issueApproved,
    modelApproval: async (issue, family) => {
      events.push(`model-approval ${issue} ${family}`);
      return modelApproval;
    },
    conflictPending: async () => conflictPending,
  };
  return {
    root,
    config,
    events,
    resumes,
    writes,
    touched,
    host,
    deps,
    env,
    comments,
    cards,
    flow: () => new TaskFlow(root, env, config, deps, host),
    set: (values: {
      approved?: boolean | "unknown";
      issueApproved?: boolean;
      modelApproval?: boolean;
      worker?: typeof worker;
      fail?: string;
      head?: string;
      liveBase?: string;
      title?: string;
      state?: string;
      base?: string;
      branch?: string;
      body?: string;
      dirty?: boolean;
      changed?: boolean;
      issueNumber?: number;
      issueClosed?: boolean;
      references?: ObjectData;
      isDraft?: boolean;
      assignees?: string[];
      boardValues?: Record<string, string | number | null>;
      replyTarget?: ReplyTarget;
      mergeable?: string;
      conflictPending?: boolean;
    }) => {
      approved = values.approved ?? approved;
      issueApproved = values.issueApproved ?? issueApproved;
      modelApproval = values.modelApproval ?? modelApproval;
      worker = values.worker ?? worker;
      fail = values.fail ?? fail;
      currentHead = values.head ?? currentHead;
      liveBase = values.liveBase ?? liveBase;
      title = values.title ?? title;
      prState = values.state ?? prState;
      actualBase = values.base ?? actualBase;
      branch = values.branch ?? branch;
      body = values.body ?? body;
      dirty = values.dirty ?? dirty;
      changed = values.changed ?? changed;
      issueNumber = values.issueNumber ?? issueNumber;
      issueClosed = values.issueClosed ?? issueClosed;
      references = values.references ?? references;
      isDraft = values.isDraft ?? isDraft;
      assignees = values.assignees ?? assignees;
      boardValues = values.boardValues ?? boardValues;
      replyTarget = values.replyTarget ?? replyTarget;
      mergeable = values.mergeable ?? mergeable;
      conflictPending = values.conflictPending ?? conflictPending;
    },
    red: () => {
      checks = checks.map((c) => ({ ...c, conclusion: "failure" }));
    },
    greenHead: (head: string) => {
      checks = checks.map((check) => ({ ...check, head_sha: head }));
    },
    done: () => expect(unexpected).toEqual([]),
  };
}

test.each([
  { outcome: "changes", draft: true },
  { outcome: "owner", draft: false },
  { outcome: "answer", draft: true },
  { outcome: "ask", draft: true },
  { outcome: "approve", draft: false },
] as const)(
  "review %s sets draft state and keeps the owner's turn only on the PR",
  async ({ outcome, draft }) => {
    const f = fixture();
    f.set({ isDraft: !draft });
    const file = join(f.root, "review.md");
    writeFileSync(file, "Please decide.\n");
    await f.flow().review({ ref: "27", outcome, file });
    expect(f.events).toContain(`draft ${draft}`);
    if (outcome === "owner" || outcome === "ask") {
      expect(f.touched).toContainEqual(
        expect.objectContaining({
          id: "issue",
          field: "Status",
          value: "Executing",
          progress: null,
        })
      );
      expect(f.touched).toContainEqual(
        expect.objectContaining({ id: "pr", progress: outcome === "ask" ? "👤❓" : "👤🔍" })
      );
      expect(f.writes).not.toContainEqual({
        path: "/repos/example/project/issues/8/assignees",
        body: { assignees: ["owner"] },
      });
    }
    if (outcome === "ask") {
      expect(f.writes.find((write) => write.path.endsWith("/comments"))?.body.body).toMatch(
        /^\[orchestrator\] OWNER QUESTION/
      );
    }
    f.done();
  }
);

test.each(["owner", "approve"] as const)(
  "review %s on a PR conflicting with its base is refused before any write",
  async (outcome) => {
    const f = fixture();
    f.set({ mergeable: "CONFLICTING" });
    const file = join(f.root, "review.md");
    writeFileSync(file, "Handover.\n");
    await expect(f.flow().review({ ref: "27", outcome, file })).rejects.toThrow(
      "#27 conflicts with dev; resolve before handing over"
    );
    expect(f.touched).toEqual([]);
    expect(f.events).not.toContain("draft false");
    expect(f.events).not.toContain("worker-resume");
    expect(
      f.writes.filter(
        (write) =>
          write.path.endsWith("/comments") ||
          write.path.endsWith("/merge") ||
          write.path.endsWith("/assignees") ||
          write.path.endsWith("/labels")
      )
    ).toEqual([]);
    f.done();
  }
);

test("review owner over an active conflict record is refused before any write", async () => {
  const f = fixture();
  // The PR itself is mergeable again; the record still owns the card.
  f.set({ conflictPending: true });
  const file = join(f.root, "review.md");
  writeFileSync(file, "Handover.\n");
  await expect(f.flow().review({ ref: "27", outcome: "owner", file })).rejects.toThrow(
    "#27 has an active conflict record; resolve before handing over"
  );
  expect(f.touched).toEqual([]);
  expect(
    f.writes.filter(
      (write) =>
        write.path.endsWith("/comments") ||
        write.path.endsWith("/merge") ||
        write.path.endsWith("/assignees")
    )
  ).toEqual([]);
  f.done();
});

test("review owner is allowed after a starting record closes on a moved healthy head", async () => {
  const f = fixture();
  const directory = join(
    String(f.env.XDG_STATE_HOME),
    "vmethod",
    String(f.config.stateName),
    "conflicts"
  );
  mkdirSync(directory, { recursive: true });
  const record = join(directory, "27.json");
  writeFileSync(
    record,
    JSON.stringify({ phase: "starting", head: "a".repeat(40), files: ["x.ts"] })
  );
  const base = "b".repeat(40);
  const hooks = new Proxy(
    {
      lifecycle: async () => "open",
      snapshot: async () => ({
        head: sha,
        base: "dev",
        baseSha: base,
        branch: "task",
        conflict: false,
        green: true,
        stale: false,
        runs: [],
      }),
      status: async () => "stopped",
    },
    {
      get(target, key) {
        if (!(key in target)) {
          throw new Error(`Unexpected conflict hook ${String(key)}`);
        }
        return Reflect.get(target, key);
      },
    }
  ) as unknown as ConflictHooks;
  const conflicts = new ConflictService(
    f.root,
    f.config,
    f.env,
    {
      ...f.deps,
      pid: process.pid,
      readProc: () => proc(42),
      exec: async (file, args) => {
        if (file === "/bin/sh") {
          expect(args.slice(-3)).toEqual(["merge-preview", sha, base]);
          return `${"c".repeat(40)}\0\0`;
        }
        expect(file).toBe("git");
        if (args.includes("fetch")) {
          return "";
        }
        if (args.join(" ") === "rev-parse refs/remotes/origin/dev") {
          return base;
        }
        if (args.join(" ") === "rev-parse refs/remotes/origin/task") {
          return sha;
        }
        throw new Error(`Unexpected conflict git ${args.join(" ")}`);
      },
    },
    hooks
  );
  f.host.conflictPending = async () => conflicts.pending(27);
  const file = join(f.root, "review.md");
  writeFileSync(file, "Handover.\n");
  await expect(f.flow().review({ ref: "27", outcome: "owner", file })).rejects.toThrow(
    "active conflict record"
  );
  expect(await conflicts.resolve(27)).toBe("conflict on #27 resolved outside the fixer");
  expect(existsSync(record)).toBe(false);
  await f.flow().review({ ref: "27", outcome: "owner", file });
  expect(f.writes.find((write) => write.path.endsWith("/comments"))?.body.body).toMatch(
    /^\[orchestrator\] OWNER REVIEW/
  );
  f.done();
});

test("conflicting PR reviews other than owner handovers and approvals stay allowed", async () => {
  const f = fixture();
  f.set({ mergeable: "CONFLICTING", isDraft: true });
  const file = join(f.root, "review.md");
  writeFileSync(file, "Please merge origin/dev first.\n");
  await f.flow().review({ ref: "27", outcome: "changes", file });
  expect(f.writes.find((write) => write.path.endsWith("/comments"))?.body.body).toMatch(
    /^\[orchestrator\] REVIEW round 1/
  );
  f.done();
});

test("card conflict on an owner-approved card keeps Approved", async () => {
  const f = fixture();
  f.set({ boardValues: { Status: "Approved", Progress: "🧭🔍" }, assignees: ["owner"] });
  await f.flow().cardConflict("27");
  expect(f.touched).toEqual([expect.objectContaining({ field: "Progress", value: "💥" })]);
  f.done();
});

test.each([
  [
    "changes",
    "[orchestrator] REVIEW round 1 is on your PR; read it with vmethod read pr 27 --new and act.",
  ],
  ["answer", "[orchestrator] ANSWER is on your PR; read it with vmethod read pr 27 --new and act."],
] as const)("review %s resumes the worker", async (outcome, prompt) => {
  const f = fixture();
  const file = join(f.root, "review.md");
  writeFileSync(file, "Please address this.\n");
  await f.flow().review({ ref: "27", outcome, file });
  expect(f.resumes).toEqual([{ pr: 27, prompt }]);
  f.done();
});

test("review changes hands the turn back before the board move so no poll reports in flight", async () => {
  const f = fixture();
  f.set({ assignees: ["worker", "peer"] });
  const file = join(f.root, "review.md");
  writeFileSync(file, "Please address this.\n");
  await f.flow().review({ ref: "27", outcome: "changes", file });
  expect(f.events.indexOf("DELETE /repos/example/project/issues/27/assignees")).toBeLessThan(
    f.events.indexOf("board pr Status Executing")
  );
  f.done();
});

const REPLY_REFUSAL =
  "answer replies to a worker QUESTION, BLOCKED, DESIGN or HANDOFF; to reply to the owner use review <pr> ask --in-reply-to <url>";

test.each([
  {
    case: "an unknown comment",
    target: undefined,
    hash: "issuecomment-5",
  },
  {
    case: "an owner comment",
    target: { author: { ...people[0] }, issue: 27, firstLine: "What does done mean here?" },
    hash: "issuecomment-5",
  },
  {
    case: "a collaborator comment",
    target: {
      author: { ...people[2], role: "collaborator" },
      issue: 27,
      firstLine: "[worker] QUESTION\n\nWhat now?",
    },
    hash: "issuecomment-5",
  },
  {
    case: "a non-protocol worker comment",
    target: {
      author: { ...people[1] },
      issue: 27,
      firstLine: "[worker] READY FOR REVIEW (round 1)",
    },
    hash: "issuecomment-5",
  },
  {
    case: "a worker reply on another card",
    target: { author: { ...people[1] }, issue: 8, firstLine: "[worker] BLOCKED\n\nWaiting" },
    hash: "issuecomment-5",
  },
  {
    case: "a review-thread target",
    target: { author: { ...people[1] }, issue: 27, firstLine: "[worker] QUESTION\n\nWhat now?" },
    hash: "discussion_r9",
  },
] as const)(
  "review answer --in-reply-to refuses $case before posting anything",
  async ({ target, hash }) => {
    const f = fixture();
    f.set({ replyTarget: target });
    const file = join(f.root, "answer.md");
    writeFileSync(file, "The decision.\n");
    await expect(
      f.flow().review({
        ref: "27",
        outcome: "answer",
        file,
        replyTo: `https://github.com/example/project/pull/27#${hash}`,
      })
    ).rejects.toThrow(REPLY_REFUSAL);
    expect(
      f.writes.some((write) => write.path === "/repos/example/project/issues/27/comments")
    ).toBe(false);
    expect(f.touched).toEqual([]);
    expect(f.resumes).toEqual([]);
    if (hash.startsWith("issuecomment-")) {
      expect(f.events).toContain("reply-target 5");
    } else {
      expect(f.events.some((event) => event.startsWith("reply-target"))).toBe(false);
    }
    f.done();
  }
);

test.each(["QUESTION", "BLOCKED", "DESIGN", "HANDOFF"] as const)(
  "review answer --in-reply-to a worker %s posts, wakes and replies as before",
  async (tag) => {
    const f = fixture();
    f.set({
      replyTarget: {
        author: { ...people[1] },
        issue: 27,
        firstLine: `[worker] ${tag}\n\nWhat should I do?`,
      },
    });
    const file = join(f.root, "answer.md");
    writeFileSync(file, "Round one first.\n");
    expect(
      await f.flow().review({
        ref: "27",
        outcome: "answer",
        file,
        replyTo: "https://github.com/example/project/pull/27#issuecomment-7",
      })
    ).toBe("Posted ANSWER on #27");
    expect(f.events).toContain("reply-target 7");
    expect(
      f.writes.find((write) => write.path === "/repos/example/project/issues/27/comments")
    ).toEqual({
      path: "/repos/example/project/issues/27/comments",
      body: {
        body: "[orchestrator] ANSWER\n\nin reply to https://github.com/example/project/pull/27#issuecomment-7\n\nRound one first.\n",
      },
    });
    expect(f.resumes).toEqual([
      {
        pr: 27,
        prompt:
          "[orchestrator] ANSWER is on your PR; read it with vmethod read pr 27 --new and act.",
      },
    ]);
    f.done();
  }
);

test.each(["changes", "owner", "answer", "ask", "approve"] as const)(
  "review %s refuses a body file that opens with a protocol header before writing",
  async (outcome) => {
    const f = fixture();
    const file = join(f.root, "handback.md");
    writeFileSync(file, "[orchestrator] ANSWER (round 1 evidence, no action needed.)\n");
    await expect(f.flow().review({ ref: "27", outcome, file })).rejects.toThrow(
      'First non-blank line is the protocol header "[orchestrator] ANSWER (round 1 evidence, no action needed.)"; review adds the header itself'
    );
    expect(f.writes).toEqual([]);
    expect(f.touched).toEqual([]);
    expect(f.resumes).toEqual([]);
    f.done();
  }
);

test("review answer accepts a body file that only mentions a protocol header later", async () => {
  const f = fixture();
  const file = join(f.root, "answer.md");
  const handback = "The [orchestrator] ANSWER from round 1 stands; continue with the evidence.\n";
  writeFileSync(file, handback);
  await f.flow().review({ ref: "27", outcome: "answer", file });
  expect(
    f.writes.find((write) => write.path === "/repos/example/project/issues/27/comments")
  ).toEqual({
    path: "/repos/example/project/issues/27/comments",
    body: { body: `[orchestrator] ANSWER\n\n${handback}` },
  });
  f.done();
});

test.each(["issuecomment-5", "discussion_r4363811103"])(
  "review ask --in-reply-to %s keeps its protocol in conversation and hands the owner the turn",
  async (anchor) => {
    const f = fixture();
    const file = join(f.root, "question.md");
    writeFileSync(file, "Which behavior should win?\n");
    await f.flow().review({
      ref: "27",
      outcome: "ask",
      file,
      replyTo: `https://github.com/example/project/pull/27#${anchor}`,
    });
    expect(
      f.writes.find((write) => write.path === "/repos/example/project/issues/27/comments")
    ).toEqual({
      path: "/repos/example/project/issues/27/comments",
      body: {
        body: `[orchestrator] OWNER QUESTION\n\nin reply to https://github.com/example/project/pull/27#${anchor}\n\nWhich behavior should win?\n`,
      },
    });
    expect(f.touched).toContainEqual(expect.objectContaining({ id: "pr", progress: "👤❓" }));
    expect(f.writes).toContainEqual({
      path: "/repos/example/project/issues/27/assignees",
      body: { assignees: ["owner"] },
    });
    expect(f.writes).not.toContainEqual({
      path: "/repos/example/project/issues/8/assignees",
      body: { assignees: ["owner"] },
    });
    expect(f.resumes).toEqual([]);
    expect(f.events.some((event) => event.startsWith("reply-target"))).toBe(false);
    f.done();
  }
);

test.each(["changes", "answer"] as const)(
  "review %s works without worker control",
  async (outcome) => {
    const f = fixture();
    f.deps.workers = undefined;
    const file = join(f.root, "review.md");
    writeFileSync(file, "Please address this.\n");
    await f.flow().review({ ref: "27", outcome, file });
    expect(f.resumes).toEqual([]);
    f.done();
  }
);

test.each(["changes", "answer"] as const)(
  "review %s reports no session after posting",
  async (outcome) => {
    const f = fixture();
    f.deps.workers!.resume = async () => "no worker session for #27; nothing sent";
    const file = join(f.root, "review.md");
    writeFileSync(file, "Please address this.\n");
    expect(await f.flow().review({ ref: "27", outcome, file })).toContain(
      "no worker session for #27; nothing sent"
    );
    expect(f.writes).toContainEqual({
      path: "/repos/example/project/issues/27/comments",
      body: { body: expect.stringContaining("Please address this.") },
    });
    f.done();
  }
);

test("review reports queued delivery and uses the next review round", async () => {
  const f = fixture();
  f.comments.push({ body: "[orchestrator] REVIEW round 3" });
  f.deps.workers!.resume = async (pr, prompt) => {
    expect(pr).toBe(27);
    expect(prompt).toBe(
      "[orchestrator] REVIEW round 4 is on your PR; read it with vmethod read pr 27 --new and act."
    );
    return "queued for #27";
  };
  const file = join(f.root, "review.md");
  writeFileSync(file, "Please address this.\n");
  expect(await f.flow().review({ ref: "27", outcome: "changes", file })).toBe(
    "Posted REVIEW round 4 on #27\nqueued for #27"
  );
  f.done();
});

test.each([false, true])("release without session/control still posts GO (%s)", async (control) => {
  const f = fixture();
  f.set({ body: `${holdBanner}\n\n<!-- vmethod-task {"issues":[8]} -->` });
  if (control) {
    f.deps.workers!.resume = async () => "no worker session for #27; nothing sent";
  } else {
    f.deps.workers = undefined;
  }
  const output = await f.flow().release("27");
  expect(output).toBe(
    "Released #27" + (control ? "\nno worker session for #27; nothing sent" : "")
  );
  expect(f.writes.some((w) => String(w.body.body).startsWith("[orchestrator] GO"))).toBe(true);
  f.done();
});

test("release clears the turn before the board move (issue 199 order)", async () => {
  const f = fixture();
  f.set({ body: `${holdBanner}\n\n<!-- vmethod-task {"issues":[8]} -->`, assignees: ["owner"] });
  await f.flow().release("27");
  expect(f.events.indexOf("DELETE /repos/example/project/issues/27/assignees")).toBeLessThan(
    f.events.indexOf("board pr Status Executing")
  );
  f.done();
});

test.each([false, true])(
  "issue ask refuses a live task (%s) and otherwise tracks the owner",
  async (live) => {
    const f = fixture();
    if (live) {
      f.cards[0].values.Status = "Scoping";
    }
    const original = f.deps.fetch;
    f.deps.fetch = async (input, init) =>
      new URL(String(input)).pathname === "/repos/example/project/pulls"
        ? Response.json(live ? [{ body: '<!-- vmethod-task {"issues":[8]} -->' }] : [])
        : original(input, init);
    const file = join(f.root, "question.md");
    writeFileSync(file, "A decision?\n");
    if (live) {
      await expect(f.flow().ask("8", file)).rejects.toThrow("use review <pr> ask");
      expect(f.touched).toEqual([]);
    } else {
      await f.flow().ask("8", file);
      expect(f.touched).toContainEqual(
        expect.objectContaining({
          id: "issue",
          field: "Status",
          value: "Executing",
          progress: "👤❓",
        })
      );
      expect(f.writes).toContainEqual({
        path: "/repos/example/project/issues/8/assignees",
        body: { assignees: ["owner"] },
      });
      expect(f.events.indexOf("POST /repos/example/project/issues/8/assignees")).toBeLessThan(
        f.events.indexOf("board issue Status Executing")
      );
      expect(f.writes.find((write) => write.path.endsWith("/comments"))?.body.body).toMatch(
        /^\[orchestrator\] OWNER QUESTION/
      );
    }
    f.done();
  }
);

test("issue ask refuses a protocol-header file before pausing workers or writing", async () => {
  const f = fixture();
  const original = f.deps.fetch;
  f.deps.fetch = async (input, init) =>
    new URL(String(input)).pathname === "/repos/example/project/pulls"
      ? Response.json([])
      : original(input, init);
  const stopped: number[] = [];
  f.deps.workers!.stop = async (pr) => {
    stopped.push(pr);
  };
  const file = join(f.root, "question.md");
  writeFileSync(file, "[worker] QUESTION\n\nWhich behavior should win?\n");
  await expect(f.flow().ask("8", file)).rejects.toThrow(
    'First non-blank line is the protocol header "[worker] QUESTION"; ask adds the header itself'
  );
  expect(stopped).toEqual([]);
  expect(f.writes).toEqual([]);
  expect(f.touched).toEqual([]);
  f.done();
});

test.each([
  ["bug: merge-task markers", "fix: merge-task markers"],
  ["fix: existing type", "fix: existing type"],
  ["a prose title", "feat: a prose title"],
])("open-task generates %s as %s", async (title, expected) => {
  const f = fixture();
  f.set({ title });
  await f.flow().open({ issue: "8" });
  expect(f.writes.find((w) => w.path.endsWith("/pulls"))!.body.title).toBe(expected);
  f.done();
});

test.each([{ issue: "8" }, { direct: "fix: direct task" }])(
  "open-task renders only the task, markers and opening version: %j",
  async (input) => {
    const f = fixture();
    const spec =
      "Exact spec: <version> <approval basis> $&\n\n## Acceptance\n\n- Keep this text.\n";
    f.set({ body: spec });
    await f.flow().open(input);
    const body = String(
      f.writes.find((write) => write.path === "/repos/example/project/pulls")?.body.body
    );
    expect(body).toContain(`## Task specification\n\n${input.issue ? spec : input.direct}\n`);
    expect(body).toContain(
      input.issue ? '<!-- vmethod-task {"issues":[8]} -->' : '<!-- vmethod-task {"issues":[]} -->'
    );
    expect(body).toContain(`vmethod ${packageInfo.version}\n`);
    if (input.issue) {
      expect(body).toContain("<!-- points_open: 13 -->");
      expect(body).toContain(
        "https://github.com/example/project/issues/8; approved specification."
      );
    }
    for (const removed of [
      "## Commands",
      "VMETHOD_ROLE",
      "Worker model",
      "You are a worker",
      "## Build",
      "## Behavior and checks",
      "## Done when",
      "## Already on the branch",
      "READY FOR REVIEW",
    ]) {
      expect(body).not.toContain(removed);
    }
    expect(f.writes.some((write) => write.path === "/repos/example/project/pulls/27")).toBe(false);
    f.done();
  }
);

test("open-task --part records matching structured relations without closing syntax", async () => {
  const f = fixture();
  await f.flow().open({ issue: "8", part: true });
  const body = String(f.writes.find((w) => w.path.endsWith("/pulls"))!.body.body);
  expect(body).toContain("# Task: feat: task (part of issue #8)");
  expect(body).toContain('<!-- vmethod-task {"issues":[8],"part":true} -->');
  expect(body).not.toMatch(/(?:closes|fixes|resolves)\s+#8/i);
  expect(body).not.toMatch(/^Part of #8$/m);
  f.done();
});

test("two partial deliveries and one completing delivery mutate only the completing PR without reference prose", async () => {
  for (const part of [true, true, false]) {
    const f = fixture();
    await f.flow().open({ issue: "8", part });
    for (const write of f.writes.filter((w) => typeof w.body.body === "string")) {
      const body = String(write.body.body);
      expect(body).not.toMatch(/(?:closes|part of)\s+#8/i);
    }
    expect(
      f.writes.filter((w) => String(w.body.query).includes("addCloseIssueReferences"))
    ).toHaveLength(part ? 0 : 1);
    f.done();
  }
});

test("direct tasks never derive generated closing links from title or specification text", async () => {
  const f = fixture();
  await f.flow().open({ direct: "feat: title mentions (issue #99)" });
  for (const write of f.writes.filter((w) => typeof w.body.body === "string")) {
    expect(String(write.body.body)).not.toMatch(/^(?:Closes|Part of) #/m);
  }
  expect(f.writes.filter((w) => String(w.body.query).includes("CloseIssueReferences"))).toEqual([]);
  f.done();
});

test("link-task promotes a header-only task without introducing reference prose", async () => {
  const f = fixture();
  f.set({
    body: "# Task: feat: task (part of issue #8)\n\nYou are a worker.\nPrompt unchanged.",
  });
  await f.flow().link("27", true);
  await f.flow().link("27", true);
  const writes = f.writes.filter((w) => w.path.endsWith("/pulls/27"));
  expect(writes).toHaveLength(1);
  const body = String(writes[0].body.body);
  expect(body).toContain("# Task: feat: task (issue #8)");
  expect(body).not.toMatch(/(?:closes|part of)\s+#8/i);
  expect(body).not.toContain("Part of #8");
  expect(body).toContain("You are a worker.\nPrompt unchanged.");
  f.done();
});

test("plan changes preserve marker examples inside the worker prompt", async () => {
  const f = fixture();
  const prompt = 'You are a worker.\nExample: <!-- vmethod-task {"issues":[999],"part":true} -->\n';
  f.set({
    body: `# Task: feat: task (part of issue #8)\n\n${prompt}\n<!-- vmethod-task {"issues":[8],"part":true} -->`,
  });
  await f.flow().link("27", true);
  const body = String(f.writes.find((w) => w.path.endsWith("/pulls/27"))!.body.body);
  expect(body).toContain(prompt);
  expect(body).toMatch(/<!-- vmethod-task {"issues":\[8\],"part":false} -->$/);
  f.done();
});

test.each([
  '# Task: feat: task (issue #8)\n\nYou are a worker.\nKeep this prompt.\n<!-- vmethod-task {"issues":[8]} -->',
  '# Task: feat: task (part of issue #8)\n\nYou are a worker.\nKeep this prompt.\n<!-- vmethod-task {"issues":[8],"part":true} -->',
  '<!-- vmethod-task {"issues":[8]} -->',
  '<!-- vmethod-task {"issues":[8],"part":true} -->',
  '<!-- vmethod-task {"issues":[]} -->',
])("link-task backfills structured relations idempotently: %s", async (body) => {
  const f = fixture();
  f.set({ body });
  await f.flow().link("27");
  await f.flow().link("27");
  expect(f.writes.filter((w) => w.path.endsWith("/pulls/27"))).toEqual([]);
  const part = body.includes('"part":true');
  expect(
    f.writes.filter((w) => String(w.body.query).includes("addCloseIssueReferences"))
  ).toHaveLength(part || body.includes('"issues":[]') ? 0 : 1);
  f.done();
});

test.each([true, false])(
  "link-task --complete promotes partial header and marker (header=%s)",
  async (header) => {
    const f = fixture();
    f.set({
      body: `${header ? "# Task: feat: task (part of issue #8)\n\n" : ""}<!-- vmethod-task {"issues":[8],"part":true} -->`,
    });
    await f.flow().link("27");
    await f.flow().link("27", true);
    await f.flow().link("27", true);
    const writes = f.writes.filter((w) => w.path.endsWith("/pulls/27"));
    expect(writes).toHaveLength(1);
    const body = String(writes[0].body.body);
    expect(body).not.toMatch(/(?:closes|part of)\s+#8/i);
    expect(body).not.toContain("Part of #8");
    expect(body).not.toContain("part of issue");
    expect(body).toContain('"part":false');
    await f.flow().merge("27");
    expect(f.touched).toContainEqual(expect.objectContaining({ id: "issue", value: "Done" }));
    f.done();
  }
);

test.each(["MERGED", "CLOSED"])("link-task refuses %s PRs before writes", async (state) => {
  const f = fixture();
  f.set({ state });
  await expect(f.flow().link("27")).rejects.toThrow("not open");
  expect(f.writes).toEqual([]);
  f.done();
});

test.each([true, false])(
  "link-task --unlink removes a manual link and demotes the structured plan (header=%s)",
  async (header) => {
    const f = fixture();
    f.set({
      body: `${header ? "# Task: feat: task (issue #8)\n\n" : ""}<!-- vmethod-task {"issues":[8]} -->`,
    });
    await f.flow().link("27");
    await f.flow().link("27", false, true);
    await f.flow().link("27", false, true);
    await f.flow().link("27");
    expect(
      f.writes.filter((w) => String(w.body.query).includes("addCloseIssueReferences"))
    ).toHaveLength(1);
    expect(
      f.writes.filter((w) => String(w.body.query).includes("removeCloseIssueReferences"))
    ).toHaveLength(1);
    const writes = f.writes.filter((w) => w.path.endsWith("/pulls/27"));
    expect(writes).toHaveLength(1);
    const body = String(writes[0].body.body);
    expect(body).toContain('"part":true');
    if (header) {
      expect(body).toContain("(part of issue #8)");
    }
    expect(body).not.toMatch(/(?:closes|part of)\s+#8/i);
    await f.flow().merge("27");
    expect(f.writes.some((w) => w.body.state === "closed")).toBe(false);
    expect(f.touched.some((w) => w.id === "issue")).toBe(false);
    f.done();
  }
);

test("link-task refuses conflicting flags before reading or writing", async () => {
  const f = fixture();
  await expect(f.flow().link("27", true, true)).rejects.toThrow("conflicting");
  expect(f.events).toEqual([]);
  f.done();
});

test("unlinking a direct task without an issue is a no-op", async () => {
  const f = fixture();
  f.set({ body: '<!-- vmethod-task {"issues":[]} -->' });
  await f.flow().link("27", false, true);
  expect(f.writes).toEqual([]);
  f.done();
});

test.each([
  { nodes: [], pageInfo: { hasNextPage: true } },
  {},
  { nodes: [{ number: 8 }], pageInfo: { hasNextPage: false } },
])("link-task refuses incomplete or malformed connection data: %j", async (references) => {
  const f = fixture();
  f.set({ references });
  await expect(f.flow().link("27")).rejects.toThrow();
  expect(f.writes).toEqual([]);
  f.done();
});

test("a failed Development mutation preserves the plan and can be retried", async () => {
  const f = fixture();
  f.set({
    body: '# Task: feat: task (part of issue #8)\n<!-- vmethod-task {"issues":[8],"part":true} -->',
    fail: "/graphql",
  });
  await expect(f.flow().link("27", true)).rejects.toThrow();
  expect(f.writes.filter((w) => w.path.endsWith("/pulls/27"))).toEqual([]);
  f.set({ fail: "" });
  await f.flow().link("27", true);
  expect(f.writes.filter((w) => w.path.endsWith("/pulls/27"))).toHaveLength(1);
  f.done();
});

test("unlink reports an automatic reference that the manual-removal mutation cannot remove", async () => {
  const f = fixture();
  const references = {
    nodes: [{ number: 8, repository: { nameWithOwner: "example/project" } }],
    pageInfo: { hasNextPage: false },
  };
  f.set({ references });
  const thread = f.host.thread;
  f.host.thread = async (ref, kind) => ({
    ...(await thread(ref, kind)),
    ...(kind === "pr" ? { closingIssuesReferences: references } : {}),
  });
  await expect(f.flow().link("27", false, true)).rejects.toThrow("manual links only");
  expect(f.writes.filter((w) => w.path.endsWith("/pulls/27"))).toEqual([]);
  f.done();
});

test("open-task reports a created PR's linking failure and names the recovery command", async () => {
  const f = fixture();
  f.set({ fail: "/graphql" });
  await expect(f.flow().open({ issue: "8" })).rejects.toThrow(
    "Development linking failed; retry link-task 27"
  );
  expect(f.writes.filter((w) => w.path.endsWith("/pulls"))).toHaveLength(1);
  expect(f.touched).toEqual([]);
  f.done();
});

test.each([
  "Legacy prose",
  '<!-- vmethod-task {"issues":[0]} -->',
  '<!-- vmethod-task {"issues":[8],"part":"yes"} -->',
])("link-task refuses missing/invalid structured relations: %s", async (body) => {
  const f = fixture();
  f.set({ body });
  await expect(f.flow().link("27")).rejects.toThrow();
  expect(f.writes).toEqual([]);
  f.done();
});

test("merge follow-up journals idempotent worktree and session cleanup steps", async () => {
  const f = fixture();
  let closed = 0;
  f.deps.workers!.close = async (pr) => {
    expect(pr).toBe(27);
    const journal = JSON.parse(
      readFileSync(
        join(f.env.XDG_STATE_HOME, "vmethod", String(f.config.stateName), "merge-27.json"),
        "utf8"
      )
    );
    expect(journal.done).not.toContain("worktree");
    closed++;
    return true;
  };
  await f.flow().merge("27");
  await f.flow().merge("27");
  const journal = JSON.parse(
    readFileSync(
      join(f.env.XDG_STATE_HOME, "vmethod", String(f.config.stateName), "merge-27.json"),
      "utf8"
    )
  );
  expect(journal.done.filter((step: string) => step === "worktree")).toEqual(["worktree"]);
  expect(journal.done.filter((step: string) => step === "session")).toEqual(["session"]);
  expect(closed).toBe(1);
  f.done();
});

test("merge session failure is nonfatal and retried without replaying completed steps", async () => {
  const f = fixture();
  let attempts = 0;
  f.deps.workers!.close = async () => {
    if (++attempts === 1) {
      throw new Error("PATCH unavailable");
    }
    return true;
  };
  expect(await f.flow().merge("27")).toContain("Merged");
  expect(f.events).toContain("report #27 session not closed: PATCH unavailable");
  expect(await f.flow().merge("27")).toContain("Merged");
  expect(await f.flow().merge("27")).toContain("Merged");
  expect(attempts).toBe(2);
  f.done();
});

test("close-task stops a live worker, posts its comment and closes the task PR unmerged", async () => {
  const f = fixture();
  f.set({ worker: "live", boardValues: { Status: "Executing", Progress: "🤖🔨" } });
  const stops: number[] = [];
  f.deps.workers!.recorded = async (pr) => pr === 27;
  f.deps.workers!.stop = async (pr) => {
    stops.push(pr);
    f.set({ worker: "stopped" });
    return "requested";
  };
  const file = join(f.root, "close.md");
  writeFileSync(file, "Delivery abandoned: the spike does not scale.\n");
  expect(await f.flow().close("27", file)).toBe("Closed #27\nReminder: run grade 27");
  expect(stops).toEqual([27]);
  expect(f.events).toContain("report #27 worker stop: requested");
  expect(f.events).toContain("report #27 worker status after stop: stopped");
  // Spec order: stop the worker, post the comment, close the PR.
  expect(f.events.indexOf("report #27 worker stop: requested")).toBeLessThan(
    f.events.indexOf("POST /repos/example/project/issues/27/comments")
  );
  expect(f.events.indexOf("POST /repos/example/project/issues/27/comments")).toBeLessThan(
    f.events.indexOf("PATCH /repos/example/project/pulls/27")
  );
  expect(
    f.writes.some(
      (write) => write.path === "/repos/example/project/pulls/27" && write.body.state === "closed"
    )
  ).toBe(true);
  expect(
    f.writes.filter((write) => write.path !== "/graphql" && !write.path.endsWith("/comments"))
  ).toHaveLength(1); // the close PATCH is the only non-comment write
  // The watcher owns the card; the linked issue stays open and untouched.
  expect(f.touched).toEqual([]);
  expect(f.writes.filter((write) => write.path.includes("/issues/8"))).toEqual([]);
  f.done();
});

test.each([
  '<!-- vmethod-task {"issues":[]} -->',
  "# Task: feat: task (issue #8)\n\nSpecification.\n",
])("close-task accepts a direct or header task PR and leaves its issue alone: %j", async (body) => {
  const f = fixture();
  f.set({ body });
  f.deps.workers!.recorded = async () => false;
  f.deps.workers!.stop = async () => {
    throw new Error("Unexpected stop for a PR without a worker record");
  };
  expect(await f.flow().close("27")).toBe("Closed #27\nReminder: run grade 27");
  expect(f.events).not.toContain("worker-status");
  expect(f.touched).toEqual([]);
  expect(f.writes.filter((write) => write.path.includes("/issues/8"))).toEqual([]);
  f.done();
});

test("close-task continues after a failed worker stop", async () => {
  const f = fixture();
  f.set({ worker: "live" });
  f.deps.workers!.recorded = async () => true;
  f.deps.workers!.stop = async () => {
    throw new Error("PATCH unavailable");
  };
  expect(await f.flow().close("27")).toBe("Closed #27\nReminder: run grade 27");
  expect(f.events).toContain("report #27 worker stop failed; continuing");
  expect(f.writes.some((write) => write.path === "/repos/example/project/pulls/27")).toBe(true);
  f.done();
});

test("close-task continues when the worker backend has no stop control", async () => {
  // The fixture's fake backend defines status and resume only: no stop, no record probe.
  const f = fixture();
  f.set({ worker: "unknown" });
  expect(await f.flow().close("27")).toBe("Closed #27\nReminder: run grade 27");
  expect(f.events).toContain("report #27 worker stop unavailable (session unknown); continuing");
  expect(f.writes.some((write) => write.path === "/repos/example/project/pulls/27")).toBe(true);
  f.done();
});

test("close-task refuses foreign, non-task and closed PRs before any write", async () => {
  const f = fixture();
  f.deps.workers!.stop = async () => {
    throw new Error("Unexpected stop on refusal");
  };
  await expect(f.flow().close("example/other#27")).rejects.toThrow("Expected own-repository");
  f.set({ body: "A plain change\n" });
  await expect(f.flow().close("27")).rejects.toThrow("Closing requires a task PR");
  f.set({ state: "CLOSED", body: '<!-- vmethod-task {"issues":[8]} -->' });
  await expect(f.flow().close("27")).rejects.toThrow("PR is not open");
  f.set({ state: "MERGED" });
  await expect(f.flow().close("27")).rejects.toThrow("PR is not open");
  // The comment check runs before any effect: never refuse after stopping.
  f.set({ state: "OPEN" });
  const bad = join(f.root, "bad.md");
  writeFileSync(bad, "Fixes #8\n");
  await expect(f.flow().close("27", bad)).rejects.toThrow("forbidden closing");
  await expect(f.flow().close("27", join(f.root, "missing.md"))).rejects.toThrow("ENOENT");
  expect(f.events).not.toContain("worker-status");
  expect(f.touched).toEqual([]);
  expect(f.writes.filter((write) => write.path !== "/graphql")).toEqual([]);
  f.done();
});

/** A git fixture repository, its separate worker clone holding the PR's task worktree,
 * and fakes passing worktree git through and removing trees the way OpenCode does. */
function workerTaskTree(f: ReturnType<typeof fixture>, onRemove: () => void = () => {}) {
  const run = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const git = (...args: string[]) => run(f.root, ...args);
  git("init", "-b", "dev");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  writeFileSync(join(f.root, ".gitignore"), "node_modules/\n.tmp/\n.worktrees/\n");
  git("add", ".gitignore");
  git("commit", "-m", "initial");
  f.set({ state: "MERGED", head: git("rev-parse", "HEAD"), changed: false });
  const clone = `${f.root}-worker`;
  run(f.root, "clone", "-q", f.root, clone);
  f.config.workerCheckout = clone;
  const path = join(`${f.root}-trees`, "auto-8-task");
  run(clone, "worktree", "add", "-b", "8-task", path);
  mkdirSync(join(path, "node_modules"));
  writeFileSync(join(path, "node_modules/payload"), "ignored");
  Object.assign(f.env, {
    OPENCODE_BASE_URL: "http://opencode.test",
    OPENCODE_SERVER_USERNAME: "user",
    OPENCODE_SERVER_PASSWORD: "password",
  });
  const fetch = f.deps.fetch;
  f.deps.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.host !== "opencode.test") {
      return fetch(input, init);
    }
    if (url.pathname === "/api/location") {
      expect(url.searchParams.get("location[directory]")).toBe(clone);
      return Response.json({ directory: clone, project: { id: "project-id" } });
    }
    if (url.pathname === "/api/worktree" && init?.method === "DELETE") {
      expect(JSON.parse(String(init.body))).toEqual({
        projectID: "project-id",
        directory: path,
        force: true,
      });
      onRemove();
      run(clone, "worktree", "remove", "--force", path);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected opencode ${init?.method} ${url.pathname}`);
  };
  const exec = f.deps.exec;
  f.deps.exec = async (file, args, options) => {
    if (
      file === "git" &&
      (["worktree", "for-each-ref", "symbolic-ref", "rev-list", "branch", "update-ref"].includes(
        args[0]
      ) ||
        args.join(" ") === "rev-parse --git-common-dir" ||
        args.join(" ") === "status --porcelain --untracked-files=all")
    ) {
      return execFileSync(file, [...args], {
        cwd: options?.cwd,
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
    return exec(file, args, options);
  };
  return {
    path,
    branch: () => run(clone, "for-each-ref", "--format=%(refname)", "refs/heads/8-task"),
  };
}

test("merge follow-up captures worker usage before removing the worktree, and retry is a no-op", async () => {
  const f = fixture();
  const order: string[] = [];
  const { path } = workerTaskTree(f, () => {
    expect(order).toEqual(["capture"]);
    order.push("remove");
  });
  f.deps.workers!.captureUsage = async (pr) => {
    expect(pr).toBe(27);
    const journal = JSON.parse(
      readFileSync(
        join(f.env.XDG_STATE_HOME, "vmethod", String(f.config.stateName), "merge-27.json"),
        "utf8"
      )
    );
    expect(journal.done).not.toContain("worktree");
    order.push("capture");
    return true;
  };
  await f.flow().merge("27");
  await f.flow().merge("27");
  expect(order).toEqual(["capture", "remove"]);
  expect(existsSync(path)).toBe(false);
  f.done();
});

test("merge follow-up retains the worktree while usage capture fails, then removes it", async () => {
  const f = fixture();
  let removals = 0;
  const { path } = workerTaskTree(f, () => removals++);
  let capture = false;
  f.deps.workers!.captureUsage = async () => capture;
  expect(await f.flow().merge("27")).toContain("Merged");
  expect(removals).toBe(0);
  expect(existsSync(path)).toBe(true);
  const journal = JSON.parse(
    readFileSync(
      join(f.env.XDG_STATE_HOME, "vmethod", String(f.config.stateName), "merge-27.json"),
      "utf8"
    )
  );
  expect(journal.done).not.toContain("worktree");
  capture = true;
  expect(await f.flow().merge("27")).toContain("Merged");
  expect(removals).toBe(1);
  expect(existsSync(path)).toBe(false);
  f.done();
});

test.each(["live", "unknown"] as const)(
  "merge recovery never closes a %s session",
  async (worker) => {
    const f = fixture();
    f.set({ state: "MERGED", worker });
    let closed = 0;
    f.deps.workers!.close = async () => {
      closed++;
      return true;
    };
    expect(await f.flow().merge("27")).toContain("Merged");
    expect(closed).toBe(0);
    const journal = JSON.parse(
      readFileSync(
        join(f.env.XDG_STATE_HOME, "vmethod", String(f.config.stateName), "merge-27.json"),
        "utf8"
      )
    );
    expect(journal.done).not.toContain("session");
    f.done();
  }
);

test("merged follow-up stops before removing the real task directory and branch, and retry is a no-op", async () => {
  const f = fixture();
  let stops = 0,
    removals = 0;
  const tree = workerTaskTree(f, () => {
    expect(stops).toBeGreaterThan(0);
    removals++;
  });
  f.deps.workers!.stop = async () => {
    stops++;
  };
  await f.flow().merge("27");
  expect(existsSync(tree.path)).toBe(false);
  expect(tree.branch()).toBe("");
  await f.flow().merge("27");
  expect(removals).toBe(1);
  f.done();
}, 15000);

test("a merged PR without a worker record skips the stop silently and removes its worktree", async () => {
  const f = fixture();
  const tree = workerTaskTree(f);
  f.deps.workers!.recorded = async () => false;
  let stops = 0,
    closes = 0;
  f.deps.workers!.stop = async () => {
    stops++;
    throw new Error("Stop must not be attempted without a worker record");
  };
  f.deps.workers!.close = async () => {
    closes++;
    return true;
  };
  await f.flow().merge("27");
  expect(stops).toBe(0);
  expect(closes).toBe(0);
  expect(existsSync(tree.path)).toBe(false);
  expect(tree.branch()).toBe("");
  expect(f.events.some((event) => event.includes("worker stop"))).toBe(false);
  expect(f.events.some((event) => event.includes("session not closed"))).toBe(false);
  expect(f.events.some((event) => event.includes("skipped:"))).toBe(false);
  const journal = JSON.parse(
    readFileSync(
      join(f.env.XDG_STATE_HOME, "vmethod", String(f.config.stateName), "merge-27.json"),
      "utf8"
    )
  );
  expect(journal.done).toContain("session");
  expect(journal.done).toContain("worktree");
  f.done();
}, 15000);

test("open-task --from merges the source branch with a merge commit that keeps its commits and authors", async () => {
  const f = fixture();
  // The orchestrator session exports GIT_AUTHOR_*/GIT_COMMITTER_*; strip them so
  // commit authors come only from the test's own repo-local identity.
  const cleanEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: f.root,
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanEnv,
    }).trim();
  git("init", "-b", "dev");
  git("config", "user.name", "Committer");
  git("config", "user.email", "committer@example.invalid");
  writeFileSync(join(f.root, ".gitignore"), ".tmp/\n");
  git("add", ".gitignore");
  git("commit", "-m", "initial");
  git("checkout", "-b", "owner-side");
  writeFileSync(join(f.root, "notes.md"), "owner notes\n");
  git("add", "notes.md");
  git("commit", "-m", "owner first", "--author", "Owner <owner@example.invalid>");
  writeFileSync(join(f.root, "spec.md"), "owner spec\n");
  git("add", "spec.md");
  git("commit", "-m", "owner second", "--author", "Owner <owner@example.invalid>");
  const ownerSha = git("rev-parse", "owner-side");
  git("checkout", "dev");
  writeFileSync(join(f.root, "dev.md"), "dev work\n");
  git("add", "dev.md");
  git("commit", "-m", "dev work");
  git("update-ref", "refs/remotes/origin/dev", git("rev-parse", "dev"));
  git("update-ref", "refs/remotes/origin/owner-side", ownerSha);
  const pushes: string[] = [];
  const exec = f.deps.exec;
  f.deps.exec = async (file, args, options) => {
    if (file === "git" && args.includes("push")) {
      pushes.push(String(args.at(-1)));
      return "";
    }
    if (file === "git" && args.includes("fetch")) {
      return "";
    }
    if (file === "git" || file === "/bin/sh") {
      return (
        await promisify(execFile)(file, [...args], {
          cwd: options?.cwd,
          env: options?.env,
          timeout: 10000,
        })
      ).stdout;
    }
    return exec(file, args, options);
  };
  await expect(f.flow().open({ issue: "8", from: "owner-side" })).resolves.toContain("27");
  expect(pushes).toHaveLength(1);
  expect(pushes[0]).toMatch(/^[a-f\d]{40}:refs\/heads\/8-task$/);
  const head = pushes[0].split(":")[0];
  expect(head).not.toBe(ownerSha);
  const merge = git("cat-file", "-p", head);
  expect(merge).toContain("Merge branch 'owner-side' into 8-task");
  expect(merge).toContain(`parent ${ownerSha}`);
  expect(git("rev-parse", `${head}^2`)).toBe(ownerSha);
  expect(git("log", "-1", "--format=%s", `${head}^1`)).toBe("chore: open task 8");
  expect(git("rev-parse", `${head}^1^1`)).toBe(git("rev-parse", "refs/remotes/origin/dev"));
  expect(git("ls-tree", "--name-only", head).split("\n").sort()).toEqual([
    ".gitignore",
    "dev.md",
    "notes.md",
    "spec.md",
  ]);
  expect(git("log", "--format=%an", ownerSha)).toBe("Owner\nOwner\nCommitter");
  const created = f.writes.find((write) => write.path === "/repos/example/project/pulls");
  expect(created?.body.body).toContain("Started from owner-side.");
  f.done();
}, 30000);

test("open-task --from refuses a conflicting source branch, names the files and pushes nothing", async () => {
  const f = fixture();
  const cleanEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: f.root,
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanEnv,
    }).trim();
  git("init", "-b", "dev");
  git("config", "user.name", "Committer");
  git("config", "user.email", "committer@example.invalid");
  writeFileSync(join(f.root, "shared.md"), "v0\n");
  git("add", "shared.md");
  git("commit", "-m", "initial");
  git("checkout", "-b", "owner-side");
  writeFileSync(join(f.root, "shared.md"), "owner\n");
  git("commit", "-am", "owner edit", "--author", "Owner <owner@example.invalid>");
  const ownerSha = git("rev-parse", "owner-side");
  git("checkout", "dev");
  writeFileSync(join(f.root, "shared.md"), "base\n");
  git("commit", "-am", "base edit");
  git("update-ref", "refs/remotes/origin/dev", git("rev-parse", "dev"));
  git("update-ref", "refs/remotes/origin/owner-side", ownerSha);
  const pushes: string[] = [];
  const exec = f.deps.exec;
  f.deps.exec = async (file, args, options) => {
    if (file === "git" && (args.includes("push") || args.includes("fetch"))) {
      if (args.includes("push")) {
        pushes.push(String(args.at(-1)));
      }
      return "";
    }
    if (file === "git" || file === "/bin/sh") {
      return (
        await promisify(execFile)(file, [...args], {
          cwd: options?.cwd,
          env: options?.env,
          timeout: 10000,
        })
      ).stdout;
    }
    return exec(file, args, options);
  };
  await expect(f.flow().open({ issue: "8", from: "owner-side" })).rejects.toThrow(
    /open-task --from: merging origin\/owner-side into 8-task conflicts; conflicting files: shared\.md/
  );
  expect(pushes).toEqual([]);
  expect(f.writes.filter((write) => write.path === "/repos/example/project/pulls")).toEqual([]);
  f.done();
}, 30000);

test("merge follow-up completes a GitHub-auto-closed issue without closing or commenting again", async () => {
  const f = fixture();
  f.set({ issueClosed: true });
  await f.flow().merge("27");
  await f.flow().merge("27");
  expect(f.writes.filter((w) => w.body.state === "closed" || w.path.endsWith("/comments"))).toEqual(
    []
  );
  expect(
    f.touched.filter((w) => w.id === "issue" && w.field === "Status" && w.value === "Done")
  ).toHaveLength(1);
  f.done();
});

test.each(["Closes #8", "Part of #8", "Fixes #8"])(
  "open-task still guards source prose: %s",
  async (body) => {
    const f = fixture();
    f.set({ body });
    await expect(f.flow().open({ issue: "8" })).rejects.toThrow();
    expect(f.writes).toEqual([]);
    f.done();
  }
);

test("orchestrator reviews cannot use task-body keyword exceptions", async () => {
  const f = fixture();
  const file = join(f.root, "review.md");
  writeFileSync(file, "Closes #8");
  await expect(f.flow().review({ ref: "27", outcome: "answer", file })).rejects.toThrow();
  expect(f.writes).toEqual([]);
  f.done();
});

test.each(["dev", "master", "main", "HEAD"])(
  "open-task --from refuses the base, release or default branch: %s",
  async (from) => {
    const f = fixture();
    await expect(f.flow().open({ issue: "8", from })).rejects.toThrow(
      "open-task --from refuses the base, release or default branch"
    );
    expect(f.writes).toEqual([]);
    f.done();
  }
);

test("open-task --from refuses a branch name that git cannot hold", async () => {
  const f = fixture();
  await expect(f.flow().open({ issue: "8", from: "release..1" })).rejects.toThrow(
    "open-task --from: invalid branch name"
  );
  expect(f.writes).toEqual([]);
  f.done();
});

test("open-task --from names the missing source branch without creating anything", async () => {
  const f = fixture();
  const exec = f.deps.exec;
  let attempts = 0;
  f.deps.sleep = async () => {};
  f.deps.exec = async (file, args, options) => {
    if (file === "git" && args.includes("fetch")) {
      if (args.includes("+refs/heads/owner-side:refs/remotes/origin/owner-side")) {
        attempts++;
        throw new Error("fatal: Remote branch owner-side not found in upstream origin");
      }
      return "";
    }
    return exec(file, args, options);
  };
  await expect(f.flow().open({ issue: "8", from: "owner-side" })).rejects.toThrow(
    "open-task --from: no branch owner-side in example/project"
  );
  expect(attempts).toBe(3);
  expect(f.writes).toEqual([]);
  f.done();
});

test("open-task --from merges the source branch, checks the lockfile and pushes the merge commit", async () => {
  const f = fixture();
  const fromSha = "d".repeat(40);
  const tree = "e".repeat(40);
  const packageJson = '{"name":"example","version":"1.0.0"}';
  const packageLock = '{"lockfileVersion":3,"packages":{}}';
  const npm: { args: string[]; cwd: string; env: NodeJS.ProcessEnv | undefined }[] = [];
  let scratch = "";
  const exec = f.deps.exec;
  f.deps.exec = async (file, args, options) => {
    if (file === "git" && args[0] === "rev-parse") {
      expect(args[1]).toBe("refs/remotes/origin/owner-side");
      return fromSha;
    }
    if (file === "/bin/sh") {
      expect(args[0]).toBe("-c");
      expect(args[3]).toBe(sha);
      expect(args[4]).toBe(fromSha);
      return `${tree}\0`;
    }
    if (file === "git" && args[0] === "ls-tree") {
      expect(args[1]).toBe(tree);
      expect(args.slice(2)).toEqual(["--", "package.json", "package-lock.json"]);
      return [
        `100644 blob ${"f".repeat(40)}\tpackage.json`,
        `100644 blob ${"1".repeat(40)}\tpackage-lock.json`,
        "",
      ].join("\n");
    }
    if (file === "git" && args[0] === "cat-file") {
      expect(args[1]).toBe("blob");
      return args[2] === "f".repeat(40) ? packageJson : packageLock;
    }
    if (file === "npm") {
      npm.push({ args: [...args], cwd: String(options?.cwd), env: { ...options?.env } });
      scratch = String(options?.cwd);
      return "";
    }
    return exec(file, args, options);
  };
  await expect(f.flow().open({ issue: "8", from: "owner-side" })).resolves.toContain("27");
  expect(npm).toHaveLength(1);
  expect(npm[0].args).toEqual(["ci", "--dry-run", "--no-audit", "--no-fund", "--ignore-scripts"]);
  expect(npm[0].env).not.toHaveProperty("EXAMPLE_GITHUB_TOKEN");
  expect(npm[0].env?.HUSKY).toBe("0");
  expect(scratch.startsWith(f.root)).toBe(false);
  expect(existsSync(scratch)).toBe(false);
  expect(f.events.some((event) => event.includes(`${sha}:refs/heads/8-task`))).toBe(true);
  const created = f.writes.find((write) => write.path === "/repos/example/project/pulls");
  expect(created?.body.body).toContain("Started from owner-side.");
  expect(created?.body.body).toContain('<!-- vmethod-task {"issues":[8],"from":"owner-side"} -->');
  f.done();
});

test("open-task --from refuses an out-of-sync lockfile before pushing the task branch", async () => {
  const f = fixture();
  const fromSha = "d".repeat(40);
  const tree = "e".repeat(40);
  const exec = f.deps.exec;
  f.deps.exec = async (file, args, options) => {
    if (file === "git" && args[0] === "rev-parse") {
      expect(args[1]).toBe("refs/remotes/origin/owner-side");
      return fromSha;
    }
    if (file === "/bin/sh") {
      expect(args[0]).toBe("-c");
      expect(args[3]).toBe(sha);
      expect(args[4]).toBe(fromSha);
      return `${tree}\0`;
    }
    if (file === "git" && args[0] === "ls-tree") {
      expect(args[1]).toBe(tree);
      expect(args.slice(2)).toEqual(["--", "package.json", "package-lock.json"]);
      return [
        `100644 blob ${"f".repeat(40)}\tpackage.json`,
        `100644 blob ${"1".repeat(40)}\tpackage-lock.json`,
        "",
      ].join("\n");
    }
    if (file === "git" && args[0] === "cat-file") {
      expect(args[1]).toBe("blob");
      return '{"name":"example","version":"1.0.0"}';
    }
    if (file === "npm") {
      const error = new Error("Command failed: npm ci") as Error & { stderr?: string };
      error.stderr = [
        "npm error code EUSAGE",
        "npm error",
        "npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with `npm install` before continuing.",
        "npm error",
        "npm error Invalid: lock file's yaml@2.9.1 does not satisfy yaml@2.9.0",
        "npm error Missing: yaml@2.9.1 from lock file",
      ].join("\n");
      throw error;
    }
    return exec(file, args, options);
  };
  await expect(f.flow().open({ issue: "8", from: "owner-side" })).rejects.toThrow(
    "lockfile out of sync with package.json: regenerate it on the task branch before starting\nnpm error Invalid: lock file's yaml@2.9.1 does not satisfy yaml@2.9.0"
  );
  expect(f.writes).toEqual([]);
  expect(f.events.filter((event) => event.includes("push --porcelain"))).toEqual([]);
  f.done();
});

test("open-task --from skips the lockfile check when the merged tree installs no manifests", async () => {
  const f = fixture();
  const fromSha = "d".repeat(40);
  const tree = "e".repeat(40);
  const exec = f.deps.exec;
  f.deps.exec = async (file, args, options) => {
    if (file === "git" && args[0] === "rev-parse") {
      expect(args[1]).toBe("refs/remotes/origin/owner-side");
      return fromSha;
    }
    if (file === "/bin/sh") {
      expect(args[0]).toBe("-c");
      expect(args[3]).toBe(sha);
      expect(args[4]).toBe(fromSha);
      return `${tree}\0`;
    }
    if (file === "git" && args[0] === "ls-tree") {
      expect(args[1]).toBe(tree);
      expect(args.slice(2)).toEqual(["--", "package.json", "package-lock.json"]);
      return "";
    }
    if (file === "npm") {
      throw new Error("Unexpected lockfile check without manifests");
    }
    return exec(file, args, options);
  };
  await expect(f.flow().open({ issue: "8", from: "owner-side" })).resolves.toContain("27");
  f.done();
});

test("merged task with only its task header closes its issue and completes the issue card", async () => {
  const f = fixture();
  f.set({ state: "MERGED", body: "# Task: feat: task (issue #8)" });
  await f.flow().merge("27");
  expect(f.writes).toContainEqual(
    expect.objectContaining({
      path: "/repos/example/project/issues/8",
      body: { state: "closed", state_reason: "completed" },
    })
  );
  expect(f.touched).toContainEqual(
    expect.objectContaining({ id: "issue", field: "Status", value: "Done" })
  );
  expect(
    JSON.parse(
      readFileSync(
        join(f.env.XDG_STATE_HOME, "vmethod", String(f.config.stateName), "merge-27.json"),
        "utf8"
      )
    ).done
  ).toContain("follow-up");
  f.done();
});

test("merge follow-up writes watcher completion before dependency reinstall, never on partial failure", async () => {
  const f = fixture();
  const marker = join(f.env.XDG_STATE_HOME, "vmethod", String(f.config.stateName), "merge-27.json");
  f.set({ state: "MERGED", fail: "board" });
  await expect(f.flow().merge("27")).rejects.toThrow("board failed");
  expect(JSON.parse(readFileSync(marker, "utf8")).done).not.toContain("follow-up");
  f.set({ fail: "" });
  const exec = f.deps.exec;
  f.deps.exec = async (file, args, options) => {
    if (file === "sh") {
      expect(JSON.parse(readFileSync(marker, "utf8")).done).toContain("follow-up");
    }
    return exec(file, args, options);
  };
  await f.flow().merge("27");
  expect(JSON.parse(readFileSync(marker, "utf8")).done).toContain("follow-up");
  f.done();
});

test("an old empty completed journal discovers its task header issue on retry", async () => {
  const f = fixture();
  f.set({ state: "MERGED", body: "# Task: feat: task (issue #8)" });
  const dir = join(f.env.XDG_STATE_HOME, "vmethod", String(f.config.stateName));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "merge-27.json"),
    JSON.stringify({
      head: sha,
      base: "dev",
      branch: "8-task",
      issues: [],
      done: ["estimates", "follow-up"],
    })
  );
  await f.flow().merge("27");
  expect(f.writes.some((w) => w.body.state === "closed")).toBe(true);
  expect(f.touched).toContainEqual(
    expect.objectContaining({ id: "issue", field: "Status", value: "Done" })
  );
  f.done();
});

test("track follow-up keeps durable merge completion without a watcher marker", async () => {
  const f = fixture();
  f.config.track = "engine";
  f.set({ state: "MERGED", base: "track/engine" });
  const thread = f.host.thread;
  f.host.thread = async (ref, kind) => ({
    ...(await thread(ref, kind)),
    labels: { nodes: [{ name: "track:engine" }] },
  });
  await f.flow().merge("27");
  expect(
    JSON.parse(
      readFileSync(
        join(f.env.XDG_STATE_HOME, "vmethod", String(f.config.stateName), "merge-27.json"),
        "utf8"
      )
    ).done
  ).toContain("follow-up");
  expect(
    existsSync(
      join(f.env.XDG_STATE_HOME, "vmethod", `${String(f.config.stateName)}-engine`, "merged-27")
    )
  ).toBe(false);
  expect(f.writes.some((w) => w.body.state === "closed")).toBe(false);
  f.done();
});

test.each([
  '# Task: feat: task (part of issue #8)\n<!-- vmethod-task {"issues":[8],"part":true} -->',
  "# Task: feat: task (part of issue #8)",
])("partial task never completes its issue: %s", async (body) => {
  const f = fixture();
  f.set({ state: "MERGED", body });
  await f.flow().merge("27");
  expect(f.writes.some((w) => w.body.state === "closed")).toBe(false);
  expect(f.touched.some((w) => w.id === "issue")).toBe(false);
  f.done();
});

test("a PR-numbered branch without a relation reports no linked issue", async () => {
  const f = fixture();
  f.set({ state: "MERGED", branch: "345-tracks", body: "Legacy task prompt" });
  await f.flow().merge("27");
  expect(f.writes.some((w) => w.body.state === "closed")).toBe(false);
  expect(f.touched.some((w) => w.id === "issue")).toBe(false);
  expect(f.events).toContain("report no linked issue");
  f.done();
});

test.each(legacyBodies)(
  "recorded legacy body on $headRefName links only its issue",
  async (recording) => {
    const f = fixture();
    f.set({
      state: "MERGED",
      branch: recording.headRefName,
      body: recording.body,
      issueNumber: recording.issue,
    });
    await f.flow().merge("27");
    expect(f.events).toContain(`read issue ${recording.issue}`);
    expect(f.writes.filter((w) => w.body.state === "closed")).toEqual([
      {
        path: `/repos/example/project/issues/${recording.issue}`,
        body: { state: "closed", state_reason: "completed" },
      },
    ]);
    f.done();
  }
);

test.each(["Agent task for #344", "> **Agent task for #344.**", "> **Closes #344.**"])(
  "legacy header %s overrides branch numbering",
  async (body) => {
    const f = fixture();
    f.set({ state: "MERGED", branch: "345-tracks", body, issueNumber: 344 });
    await f.flow().merge("27");
    expect(f.events).toContain("read issue 344");
    f.done();
  }
);

test.each(["Part of #344.", "> **Part of #344.**"])(
  "partial legacy header %s suppresses closing references",
  async (body) => {
    const f = fixture();
    f.set({
      state: "MERGED",
      body: `${body}\nCloses #8`,
      references: {
        nodes: [{ number: 8, repository: { nameWithOwner: "example/project" } }],
        pageInfo: { hasNextPage: false },
      },
    });
    await f.flow().merge("27");
    expect(f.writes.some((w) => w.body.state === "closed")).toBe(false);
    f.done();
  }
);

test("same-repository closing references take precedence over legacy headers", async () => {
  const f = fixture();
  f.set({
    state: "MERGED",
    branch: "345-tracks",
    body: "Agent task for #344",
    references: {
      nodes: [
        { number: 8, repository: { nameWithOwner: "example/project" } },
        { number: 999, repository: { nameWithOwner: "example/foreign" } },
      ],
      pageInfo: { hasNextPage: false },
    },
  });
  await f.flow().merge("27");
  expect(f.events).toContain("read issue 8");
  f.done();
});

test("recorded native closing connection decodes through GraphQL and completes only its linked issue", async () => {
  const f = fixture();
  const recording = structuredClone(closingReferences);
  recording.repository.pullRequest.closingIssuesReferences.nodes[0].repository.nameWithOwner =
    String(f.config.repo);
  f.set({ state: "MERGED", body: "Legacy prompt without a structured relation", issueNumber: 342 });
  const fetch = f.deps.fetch;
  let reads = 0;
  f.deps.fetch = async (input, init) => {
    if (String(input) === "https://api.github.com/graphql") {
      const payload = object(JSON.parse(String(init?.body)));
      expect(parse(String(payload.query)).definitions).toHaveLength(1);
      expect(payload.variables).toEqual({ owner: "vworlds", repo: "spacerocks", pr: 346 });
      reads++;
      return Response.json({ data: recording });
    }
    return fetch(input, init);
  };
  const thread = f.host.thread;
  f.host.thread = async (ref, kind) => {
    const item = await thread(ref, kind);
    if (kind !== "pr") {
      return item;
    }
    const decoded = object(
      await f.host.github.graphql(
        `query TaskLinkRecording($owner: String!, $repo: String!, $pr: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            number
            closingIssuesReferences(first: 100) {
              nodes { number repository { nameWithOwner } }
              pageInfo { hasNextPage }
            }
          }
        }
      }`,
        { owner: "vworlds", repo: "spacerocks", pr: 346 }
      )
    );
    return {
      ...item,
      closingIssuesReferences: object(object(decoded.repository).pullRequest)
        .closingIssuesReferences,
    };
  };
  await f.flow().merge("27");
  expect(reads).toBe(1);
  expect(f.writes.filter((w) => w.body.state === "closed")).toEqual([
    {
      path: "/repos/example/project/issues/342",
      body: { state: "closed", state_reason: "completed" },
    },
  ]);
  expect(f.touched).toContainEqual(
    expect.objectContaining({ id: "issue", field: "Status", value: "Done" })
  );
  expect(f.events).not.toContain("read issue 8");
  f.done();
});

test("recorded Development add/remove lifecycle backfills, re-reads idempotently and promotes without body references", async () => {
  const f = fixture();
  const originalBody =
    '# Task: feat: task (issue #68)\n\nYou are a worker.\nPrompt unchanged.\n<!-- vmethod-task {"issues":[68]} -->';
  f.set({ body: originalBody, issueNumber: 68 });
  const captures = structuredClone(developmentLinks);
  for (const read of [
    captures.before,
    captures.afterAdd,
    captures.afterIdempotentAdd,
    captures.afterRemove,
    captures.final,
  ]) {
    for (const node of read.data.repository.pullRequest.closingIssuesReferences.nodes) {
      node.repository.nameWithOwner = String(f.config.repo);
    }
  }
  const reads = [
    captures.before,
    captures.afterAdd,
    captures.afterIdempotentAdd,
    captures.afterRemove,
    captures.afterRemove,
    captures.afterRemove,
    captures.final,
  ];
  const mutations = [captures.add, captures.remove, captures.finalAdd];
  const mutationNames = [
    "addCloseIssueReferences",
    "removeCloseIssueReferences",
    "addCloseIssueReferences",
  ];
  let readIndex = 0,
    mutationIndex = 0;
  const fetch = f.deps.fetch;
  f.deps.fetch = async (input, init) => {
    if (String(input) !== "https://api.github.com/graphql") {
      return fetch(input, init);
    }
    const payload = object(JSON.parse(String(init?.body)));
    const query = String(payload.query);
    parse(query);
    if (query.includes("query RecordedDevelopment")) {
      expect(payload.variables).toEqual({ owner: "vworlds", repo: "vmethod", pr: 74 });
      const read = reads[readIndex++];
      if (!read) {
        throw new Error("Unexpected recorded read");
      }
      return Response.json(read);
    }
    const mutation = mutationNames[mutationIndex];
    const response = mutations[mutationIndex++];
    if (!response) {
      throw new Error("Unexpected recorded mutation");
    }
    expect(query).toContain(
      `${mutation}(input: {issueId: $issueId, pullRequestIds: $pullRequestIds})`
    );
    expect(payload.variables).toEqual({ issueId: "issue", pullRequestIds: ["pr"] });
    return Response.json(response);
  };
  const thread = f.host.thread;
  f.host.thread = async (ref, kind) => {
    const item = await thread(ref, kind);
    if (kind !== "pr") {
      return item;
    }
    const decoded = object(
      await f.host.github.graphql(
        `query RecordedDevelopment($owner: String!, $repo: String!, $pr: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            number
            closingIssuesReferences(first: 100) {
              nodes { number repository { nameWithOwner } }
              pageInfo { hasNextPage }
            }
          }
        }
      }`,
        { owner: "vworlds", repo: "vmethod", pr: 74 }
      )
    );
    return {
      ...item,
      closingIssuesReferences: object(object(decoded.repository).pullRequest)
        .closingIssuesReferences,
    };
  };
  await expect(f.flow().link("27")).resolves.toBe("Linked task #27");
  await expect(f.flow().link("27")).resolves.toContain("already current");
  expect(f.writes.filter((w) => w.path.endsWith("/pulls/27"))).toEqual([]);
  await expect(f.flow().link("27", false, true)).resolves.toBe("Unlinked task #27");
  await expect(f.flow().link("27")).resolves.toContain("already current");
  await expect(f.flow().link("27", true)).resolves.toBe("Linked task #27 as completing");
  await expect(f.flow().link("27")).resolves.toContain("already current");
  expect(readIndex).toBe(reads.length);
  expect(mutationIndex).toBe(mutations.length);
  const bodies = f.writes
    .filter((w) => w.path.endsWith("/pulls/27"))
    .map((w) => String(w.body.body));
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toContain("(part of issue #68)");
  expect(bodies[1]).toContain("(issue #68)");
  for (const body of bodies) {
    expect(body).not.toMatch(/(?:closes|part of)\s+#68/i);
    expect(body).toContain("You are a worker.\nPrompt unchanged.");
  }
  expect(captures.addAgain).toEqual(captures.add);
  expect(captures.afterIdempotentAdd).toEqual(captures.afterAdd);
  f.done();
});

test.each(["unapproved", "gated", "handoff"])(
  "open-task refuses %s before mutation",
  async (reason) => {
    const f = fixture();
    if (reason === "unapproved") {
      f.set({ issueApproved: false });
    }
    if (reason === "handoff") {
      f.set({ body: "## Handoff breakpoints\n\nReview then format" });
    }
    await expect(
      f.flow().open({ issue: "8", model: reason === "gated" ? "astra" : "sol" })
    ).rejects.toThrow(
      reason === "unapproved"
        ? "scope not approved"
        : reason === "gated"
          ? "--owner-approved"
          : "expensive"
    );
    expect(f.writes).toEqual([]);
    f.done();
  }
);

test.each(["astra", "fable"])(
  "open-task honors --owner-approved only with the owner's verified line (%s, #218)",
  async (family) => {
    const f = fixture();
    if (family === "fable") {
      writeFileSync(
        join(f.root, "models.yaml"),
        stringify([
          {
            family: "sol",
            model: "example/replace-me",
            kind: "opencode",
            gate: "none",
            tier: "standard",
          },
          {
            family: "fable",
            model: "claude-code/claude-fable-5-1",
            kind: "opencode",
            gate: "owner",
            tier: "expensive",
            fallback: ["sol"],
          },
        ])
      );
    }
    // The orchestrator's flag alone is not owner authority: the gateway verifies
    // the owner's APPROVE MODEL line on the issue before any mutation.
    f.set({ modelApproval: false });
    await expect(f.flow().open({ issue: "8", model: family, ownerApproved: true })).rejects.toThrow(
      `APPROVE MODEL ${family}`
    );
    expect(f.writes).toEqual([]);
    expect(f.events).toContain(`model-approval 8 ${family}`);
    // The owner's verified line authorizes the launch.
    f.set({ modelApproval: true });
    await expect(
      f.flow().open({ issue: "8", model: family, ownerApproved: true })
    ).resolves.toContain("27");
    expect(f.touched).toContainEqual(
      expect.objectContaining({ id: "pr", field: "Model", value: family })
    );
    f.done();
  }
);

test("open-task refuses a gated model without --owner-approved before any verification query", async () => {
  const f = fixture();
  await expect(f.flow().open({ issue: "8", model: "astra" })).rejects.toThrow(
    "Model requires --owner-approved"
  );
  expect(f.events).not.toContain("model-approval 8 astra");
  f.done();
});

test("open-task creates a draft with a manual Development link, clears issue Progress and never estimates PRs", async () => {
  const f = fixture();
  f.set({ body: "## Approved spec\n\nImplement the test." });
  await expect(f.flow().open({ issue: "8", model: "sol", hold: true })).resolves.toContain(
    "draft PR #27"
  );
  const create = f.writes.find((w) => w.path.endsWith("/pulls"))!;
  expect(create.body).toMatchObject({ draft: true, base: "dev", title: "feat: task" });
  expect(create.body.body).toContain("https://github.com/example/project/issues/8");
  expect(create.body.body).toContain("# Task: feat: task (issue #8)");
  expect(create.body.body).toContain("<!-- points_open: 13 -->");
  expect(String(create.body.body)).not.toMatch(/(?:closes|part of)\s+#8/i);
  expect(
    f.writes.filter((w) => String(w.body.query).includes("addCloseIssueReferences"))
  ).toHaveLength(1);
  expect(create.body.body).not.toContain("<specifics>");
  expect(f.touched).toContainEqual(
    expect.objectContaining({ id: "pr", field: "Status", value: "Executing", progress: "⛔" })
  );
  expect(f.touched).toContainEqual(
    expect.objectContaining({ id: "issue", field: "Status", progress: null })
  );
  expect(f.touched.some((write) => write.field === "Estimate")).toBe(false);
  f.done();
});

test("expensive breakpoints stay verbatim; unapproved exception is posted", async () => {
  const f = fixture();
  f.set({ body: "## Handoff breakpoints\n\nAfter implementation.", issueApproved: false });
  await f
    .flow()
    .open({ issue: "8", model: "astra", ownerApproved: true, unapproved: "Reproducer attached" });
  expect(f.writes.find((w) => w.path.endsWith("/pulls"))!.body.body).toContain(
    "## Task specification\n\n## Handoff breakpoints\n\nAfter implementation."
  );
  expect(f.writes.find((w) => w.path.endsWith("/8/comments"))!.body.body).toContain(
    "Reproducer attached"
  );
  f.done();
});

test.each([0, 0.5, 1, 2, 3, 5, 8, 13, 20, 40, 100, 999])(
  "points_open freezes numeric issue estimate %s without estimating the PR",
  async (estimate) => {
    const f = fixture();
    f.cards[0].values.Estimate = estimate;
    await f.flow().open({ issue: "8", model: "sol" });
    const body = String(f.writes.find((write) => write.path.endsWith("/pulls"))!.body.body);
    expect(body.split("\n")[0]).toBe("# Task: feat: task (issue #8)");
    expect(body).toContain(`<!-- points_open: ${estimate} -->`);
    expect(f.touched.some((write) => write.field === "Estimate")).toBe(false);
    f.done();
  }
);

test.each([4, 1.5, -1, Infinity, NaN])(
  "off-scale opening Estimate %s is refused before writes",
  async (estimate) => {
    const f = fixture();
    f.cards[0].values.Estimate = estimate;
    await expect(f.flow().open({ issue: "8", model: "sol" })).rejects.toThrow(
      "0, 0.5, 1, 2, 3, 5, 8, 13, 20, 40, 100, 999"
    );
    expect(f.writes).toEqual([]);
    f.done();
  }
);

test("missing opening issue Estimate is refused before branch or PR writes", async () => {
  const f = fixture();
  f.cards[0].values.Estimate = null;
  await expect(f.flow().open({ issue: "8", model: "sol" })).rejects.toThrow("Estimate at opening");
  expect(f.writes).toEqual([]);
  f.done();
});

test.each(["owner", "changes", "answer", "ask", "approve"] as const)(
  "review %s posts protocol and maintains next actor",
  async (outcome) => {
    const f = fixture();
    const file = join(f.root, "review.md");
    writeFileSync(file, "Review evidence.");
    f.comments.push({ body: "[orchestrator] REVIEW round 2" });
    if (outcome === "answer") {
      // A reply target is only valid on a worker protocol ask (the refusals are tested above).
      f.set({
        replyTarget: {
          author: { ...people[1] },
          issue: 27,
          firstLine: "[worker] QUESTION\n\nWhich variant?",
        },
      });
    }
    await f.flow().review({
      ref: "27",
      outcome,
      file,
      replyTo: "https://github.com/example/project/pull/27#issuecomment-1",
    });
    const comment = String(f.writes.find((w) => w.path.endsWith("/comments"))!.body.body);
    expect(comment).toContain("in reply to https://github.com/");
    if (outcome === "owner") {
      expect(comment).toContain(sha);
      expect(
        f.writes.some((w) => String(w.body.query).includes("markPullRequestReadyForReview"))
      ).toBe(true);
      expect(f.touched).toContainEqual(
        expect.objectContaining({ field: "Status", value: "Owner review", progress: "👤🔍" })
      );
      expect(f.writes.some((w) => w.path.endsWith("/assignees"))).toBe(true);
    }
    if (outcome === "changes") {
      expect(comment).toContain("REVIEW round 3");
      expect(f.touched).toContainEqual(expect.objectContaining({ progress: "🤖🔨 🔁3️⃣" }));
    }
    f.done();
  }
);

test.each(["approval", "stale", "red", "base", "worker", "unknown", "title"])(
  "merge refusal: %s",
  async (refusal) => {
    const f = fixture();
    if (["approval", "stale"].includes(refusal)) {
      f.set({ approved: false, ...(refusal === "stale" ? { head: "d".repeat(40) } : {}) });
    }
    if (refusal === "red") {
      f.red();
    }
    if (refusal === "base") {
      f.set({ fail: "base" });
    }
    if (refusal === "worker") {
      f.set({ worker: "live" });
    }
    if (refusal === "unknown") {
      delete f.deps.workers;
    }
    if (refusal === "title") {
      f.set({ title: "feat(scope): rejected" });
    }
    await expect(f.flow().merge("27")).rejects.toThrow();
    expect(f.writes.some((w) => w.path.endsWith("/merge"))).toBe(false);
    f.done();
  }
);

test("squash merges frozen head; board and archive precede fast-forward and install is last", async () => {
  const f = fixture();
  await f.flow().merge("27");
  expect(f.writes.find((w) => w.path.endsWith("/merge"))!.body).toMatchObject({
    sha,
    merge_method: "squash",
    commit_title: "feat: task (#27)",
  });
  expect(f.events.at(-1)).toBe("sh -c npm ci");
  expect(f.events.indexOf("done-cap")).toBeLessThan(
    f.events.findIndex((event) => event.startsWith("git merge --ff-only"))
  );
  expect(f.events).toContain("report revise estimates: #9");
  expect(f.touched.some((write) => write.id === "issue" && write.value === "Done")).toBe(true);
  f.done();
});

test.each(["live", "unknown"] as const)(
  "already merged follows up with %s worker after best-effort stop",
  async (worker) => {
    const f = fixture();
    f.set({ state: "MERGED", worker });
    f.deps.workers!.stop = async () => {
      f.events.push("worker-stop");
      throw new Error("unreachable");
    };
    await expect(f.flow().merge("27")).resolves.toBe("Merged #27");
    expect(f.events).toContain("worker-stop");
    expect(f.events.some((e) => e.includes("worker stop failed"))).toBe(true);
    expect(f.events).toContain("sh -c npm ci");
    f.done();
  }
);

test("post-merge worker push is reported and branch kept before cleanup", async () => {
  const f = fixture();
  f.set({ state: "MERGED", worker: "live" });
  let remoteHead = sha;
  f.deps.workers!.stop = async () => {
    f.events.push("worker-stop");
    remoteHead = mergedSha;
  };
  const fetch = f.deps.fetch;
  f.deps.fetch = async (input, init) => {
    if (String(input).includes("/git/matching-refs/heads/")) {
      f.events.push("read-branch");
      return Response.json([{ ref: "refs/heads/8-task", object: { sha: remoteHead } }]);
    }
    if (String(input).includes(`/compare/${sha}...${mergedSha}`)) {
      return Response.json({ commits: [{ sha: mergedSha }], total_commits: 1 });
    }
    return fetch(input, init);
  };
  await f.flow().merge("27");
  expect(f.events.indexOf("worker-stop")).toBeLessThan(f.events.indexOf("read-branch"));
  expect(f.events).toContain(`report post-merge commits on 8-task: ${mergedSha}`);
  expect(f.events.some((e) => e.startsWith("DELETE"))).toBe(false);
  expect(f.events).toContain("sh -c npm ci");
  f.done();
});

test.each(["track/topic", "pack/topic"])(
  "integration base %s leaves issues and main alone",
  async (base) => {
    const f = fixture();
    f.set({ base });
    await f.flow().merge("27");
    expect(f.events.some((event) => event.includes("--ff-only") || event.startsWith("sh "))).toBe(
      false
    );
    expect(f.touched.some((write) => write.id === "issue")).toBe(false);
    f.done();
  }
);

test("pack head requires merge commit and is kept", async () => {
  const f = fixture();
  f.set({ branch: "pack/batch" });
  await expect(f.flow().merge("27")).rejects.toThrow("--merge-commit");
  await f.flow().merge("27", true);
  expect(f.writes.find((w) => w.path.endsWith("/merge"))!.body.merge_method).toBe("merge");
  expect(f.writes.some((w) => w.path.includes("/git/refs"))).toBe(false);
  f.done();
});

test.each([true, false])("live base ancestry gates merge (current=%s)", async (current) => {
  const f = fixture();
  f.set({ liveBase: mergedSha });
  const exec = f.deps.exec;
  let checkedBase = "";
  f.deps.exec = async (file, args, options) => {
    if (file === "git" && args[0] === "merge-base" && args[1] === "--is-ancestor") {
      checkedBase = String(args[2]);
      // The PR snapshot still reports baseSha; only the fetched base is current.
      if (args[2] === mergedSha && !current) {
        throw new Error("live base is not an ancestor");
      }
      return "";
    }
    return exec(file, args, options);
  };
  if (current) {
    await expect(f.flow().merge("27")).resolves.toBe("Merged #27");
  } else {
    await expect(f.flow().merge("27")).rejects.toThrow(
      "CI tested an older base; run refresh-checks 27"
    );
    expect(f.writes.some((w) => w.path.endsWith("/merge"))).toBe(false);
  }
  expect(checkedBase).toBe(mergedSha);
  f.done();
});

test.each(["pass", "fail", "missing", "conflict", "base moved"])(
  "requireCurrentBase false verifies the live merge result: %s",
  async (scenario) => {
    const f = fixture();
    f.set({ liveBase: mergedSha });
    f.config.merge = { requireCurrentBase: false };
    const exec = f.deps.exec;
    let worktree = "",
      removed = false,
      ranHook = false;
    f.deps.exec = async (file, args, options) => {
      if (file === "git" && args[0] === "worktree") {
        if (args[1] === "add") {
          expect(args.slice(0, 3)).toEqual(["worktree", "add", "--detach"]);
          expect(args[4]).toBe(mergedSha);
          worktree = String(args[3]);
          mkdirSync(join(worktree, "scripts/vmethod-hooks"), { recursive: true });
          if (scenario !== "missing") {
            writeFileSync(join(worktree, "scripts/vmethod-hooks/verify"), "fake hook");
          }
        } else {
          expect(args).toEqual(["worktree", "remove", "--force", worktree]);
          rmSync(worktree, { recursive: true });
          removed = true;
        }
        return "";
      }
      if (file === "git" && args.includes("merge") && options?.cwd === worktree) {
        expect(args.slice(-4)).toEqual(["merge", "-q", "--no-edit", sha]);
        if (scenario === "conflict") {
          throw new Error("conflict");
        }
        return "";
      }
      if (file === "/bin/sh") {
        ranHook = true;
        expect(options?.cwd).toBe(worktree);
        expect(options?.env).not.toHaveProperty("EXAMPLE_GITHUB_TOKEN");
        expect(options?.env).not.toHaveProperty("GIT_AUTHOR_NAME");
        expect(args[4]).toBe(join(worktree, "scripts/vmethod-hooks/verify"));
        expect(args[5]).toBe("--logs");
        expect(args.slice(7)).toEqual(["--scope", "merge"]);
        writeFileSync(String(args[3]), scenario === "fail" ? "typecheck FAILED" : "checks ok");
        if (scenario === "base moved") {
          f.set({ liveBase: "d".repeat(40) });
        }
        if (scenario === "fail") {
          throw new Error("hook failed");
        }
        return "";
      }
      return exec(file, args, options);
    };
    if (scenario === "pass") {
      await expect(f.flow().merge("27")).resolves.toBe("Merged #27");
    } else {
      await expect(f.flow().merge("27")).rejects.toThrow(
        scenario === "fail"
          ? "typecheck FAILED"
          : scenario === "missing"
            ? "requireCurrentBase is false but no verify hook is configured; run refresh-checks 27"
            : scenario === "base moved"
              ? "Head or base moved during merge checks"
              : "does not merge cleanly"
      );
      expect(f.writes.some((w) => w.path.endsWith("/merge"))).toBe(false);
    }
    expect(worktree).not.toBe("");
    expect(removed).toBe(true);
    expect(ranHook).toBe(["pass", "fail", "base moved"].includes(scenario));
    expect(existsSync(join(worktree, ".."))).toBe(false);
    f.done();
  }
);

test("a PR with no recorded worker session merges through the real session guard", async () => {
  const f = fixture();
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected worker hook");
  };
  const workers = new WorkerService(f.root, f.config, f.env, f.deps, {
    metadata: unexpected,
    prepare: unexpected,
    setModel: unexpected,
    modelComment: unexpected,
    setEstimate: unexpected,
    locate: unexpected,
    issue: unexpected,
    modelApproval: unexpected,
  });
  f.deps.workers!.status = (pr, forMerge) => workers.mergeStatus(pr, forMerge);
  f.deps.workers!.recorded = (pr) => workers.recorded(pr);
  f.deps.workers!.stop = async () => {
    f.events.push("worker-stop");
    throw new Error("Stop must not be attempted without a worker record");
  };
  f.deps.workers!.close = async () => {
    f.events.push("worker-close");
    return true;
  };
  await expect(f.flow().status("27")).resolves.toBe("unknown");
  await expect(f.flow().merge("27")).resolves.toBe("Merged #27");
  // #275: with no record the worker is absent; the follow-up skips stop and close silently.
  expect(f.events).not.toContain("worker-stop");
  expect(f.events).not.toContain("worker-close");
  expect(f.events.some((event) => event.includes("worker stop"))).toBe(false);
  expect(f.events.some((event) => event.includes("session not closed"))).toBe(false);
  const journal = JSON.parse(
    readFileSync(
      join(f.env.XDG_STATE_HOME, "vmethod", String(f.config.stateName), "merge-27.json"),
      "utf8"
    )
  );
  expect(journal.done).toContain("session");
  f.done();
});

test("a recorded worker that cannot be resolved keeps the cautious stop and cleanup skip", async () => {
  const f = fixture();
  f.set({ state: "MERGED", worker: "unknown" });
  f.deps.workers!.recorded = async () => true;
  f.deps.workers!.stop = async () => {
    f.events.push("worker-stop");
    throw new Error("session unknown");
  };
  await expect(f.flow().merge("27")).resolves.toBe("Merged #27");
  expect(f.events).toContain("worker-stop");
  expect(f.events.some((event) => event.includes("worker stop failed"))).toBe(true);
  const journal = JSON.parse(
    readFileSync(
      join(f.env.XDG_STATE_HOME, "vmethod", String(f.config.stateName), "merge-27.json"),
      "utf8"
    )
  );
  expect(journal.done).not.toContain("session");
  expect(journal.done).not.toContain("worktree");
  f.done();
});

test("an unknown recorded worker still blocks merging", async () => {
  const f = fixture();
  f.set({ worker: "unknown" });
  f.config.merge = { requireCurrentBase: false };
  await expect(f.flow().merge("27")).rejects.toThrow("Stop the worker");
  expect(f.writes.some((w) => w.path.endsWith("/merge"))).toBe(false);
  f.done();
});

test.each([true, false])("merge gateway recomputes clean base proof (clean=%s)", async (clean) => {
  const f = fixture();
  const old = "d".repeat(40),
    tree = "e".repeat(40);
  f.host.approved = async (_ref, historical) => historical === old;
  f.host.candidates = async () => [old];
  const exec = f.deps.exec;
  const commands: Record<string, string> = {
    [`rev-list --first-parent --parents ${old}..${sha}`]: clean
      ? `${sha} ${old} ${baseSha}`
      : `${sha} ${old}`,
    [`merge-tree --write-tree ${old} ${baseSha}`]: tree,
    [`rev-parse ${sha}^{tree}`]: tree,
    [`merge-base ${old} ${baseSha}`]: old,
    [`merge-base ${sha} ${baseSha}`]: baseSha,
    [`diff --name-only -z ${old} ${old}`]: "task.ts\0",
    [`diff --name-only -z ${baseSha} ${sha}`]: "task.ts\0",
    [`diff --binary --full-index ${old} ${old} -- task.ts`]: "patch",
    [`diff --binary --full-index ${baseSha} ${sha} -- task.ts`]: "patch",
  };
  f.deps.exec = async (file, args, options) => {
    const key = args.join(" ");
    if (file === "git" && key in commands) {
      f.events.push(`git ${key}`);
      return commands[key];
    }
    return exec(file, args, options);
  };
  if (clean) {
    await expect(f.flow().merge("27")).resolves.toContain("Merged");
    expect(f.writes.some((write) => write.path.endsWith("/merge"))).toBe(true);
  } else {
    await expect(f.flow().merge("27")).rejects.toThrow("Owner approval");
    expect(f.writes.some((write) => write.path.endsWith("/merge"))).toBe(false);
  }
  f.done();
});

test.each([
  "merge",
  "commit",
  "no approval",
  "red",
  "base",
  "worker",
  "conflicting",
  "head moved",
  "comment failure",
  "escalated path",
])("explicit approval carry: %s", async (scenario) => {
  const f = fixture();
  const old = "d".repeat(40);
  if (scenario === "escalated path") {
    f.config.conflicts = { escalatePaths: ["src/**"] };
  }
  f.host.approved = async (_ref, historical) => historical === old;
  f.host.candidates = async () => (scenario === "no approval" ? [] : [old]);
  const exec = f.deps.exec;
  f.deps.exec = async (file, args, options) => {
    if (file === "git" && args.join(" ") === `rev-list --parents ${old}..${sha} --not ${baseSha}`) {
      return scenario === "commit" ? `${sha} ${old}` : `${sha} ${old} ${baseSha}`;
    }
    if (file === "git" && args[0] === "show") {
      expect(args).toEqual(["show", "--remerge-diff", "--format=", "--name-only", "-z", sha]);
      return "src/conflict.ts\0";
    }
    if (file === "git" && args.join(" ") === `merge-base --is-ancestor ${baseSha} ${baseSha}`) {
      return "";
    }
    return exec(file, args, options);
  };
  if (scenario === "red") {
    f.red();
  }
  if (scenario === "base") {
    f.set({ fail: "base" });
  }
  if (scenario === "worker") {
    f.set({ worker: "live" });
  }
  if (scenario === "comment failure") {
    f.set({ fail: "/comments" });
  }
  if (["conflicting", "head moved"].includes(scenario)) {
    const thread = f.host.thread;
    let reads = 0;
    f.host.thread = async (ref, kind) => {
      const item = await thread(ref, kind);
      if (kind === "pr") {
        if (scenario === "conflicting") {
          item.mergeable = "CONFLICTING";
        }
        if (++reads > 1 && scenario === "head moved") {
          item.headRefOid = old;
        }
      }
      return item;
    };
  }
  if (scenario === "merge") {
    await expect(
      f.flow().merge("27", false, "Conflict resolution only; no behaviour change")
    ).resolves.toBe("Merged #27");
    const certification = f.writes.find((w) => w.path.endsWith("/comments"))!;
    expect(certification.body.body).toContain(
      `[orchestrator] APPROVAL CARRIED from ${old} to ${sha}: Conflict resolution only; no behaviour change`
    );
    expect(certification.body.body).toContain("src/conflict.ts");
    expect(f.events.indexOf("POST /repos/example/project/issues/27/comments")).toBeLessThan(
      f.events.indexOf("PUT /repos/example/project/pulls/27/merge")
    );
  } else {
    await expect(f.flow().merge("27", false, "Conflict only")).rejects.toThrow(
      scenario === "red"
        ? "CI is not green"
        : scenario === "base"
          ? "CI tested an older base"
          : scenario === "worker"
            ? "Stop the worker"
            : scenario === "conflicting"
              ? "conflicting"
              : scenario === "head moved"
                ? "moved during"
                : scenario === "comment failure"
                  ? "GitHub network request failed"
                  : "cannot be carried"
    );
    expect(f.writes.some((w) => w.path.endsWith("/merge"))).toBe(false);
  }
  f.done();
});

test("independent conflict rejection names files and gives the blocked PR back to the orchestrator", async () => {
  const f = fixture();
  f.set({ boardValues: { Status: "Executing", Progress: "🤖🔨" } });
  await f
    .flow()
    .escalateConflict("27", "escalated path requires owner review", ["src/conflict.ts"]);
  expect(f.writes.find((write) => write.path.endsWith("/comments"))?.body.body).toContain(
    "src/conflict.ts"
  );
  expect(f.touched).toContainEqual(
    expect.objectContaining({ field: "Status", value: "Executing", progress: "🤖🚫" })
  );
  expect(f.writes.some((write) => write.path.endsWith("/merge"))).toBe(false);
  expect(f.writes.some((write) => write.path.endsWith("/assignees"))).toBe(true);
  f.done();
});

test("conflict escalation on an owner-approved card keeps Approved and reports it", async () => {
  const f = fixture();
  f.set({ boardValues: { Status: "Approved", Progress: "🧭🔍" } });
  await f
    .flow()
    .escalateConflict("27", "escalated path requires owner review", ["src/conflict.ts"]);
  const note = f.writes.find((write) => write.path.endsWith("/comments"))?.body.body;
  expect(String(note)).toContain("escalated path requires owner review");
  expect(String(note)).toContain("Owner approval kept: the card stays Approved.");
  expect(f.touched).toEqual([expect.objectContaining({ field: "Progress", value: "🤖🚫" })]);
  expect(f.writes.some((write) => write.path.endsWith("/merge"))).toBe(false);
  f.done();
});

test("Approved conflict dispatch, escalation and restore write neither Status nor Model", async () => {
  const f = fixture();
  f.set({
    boardValues: { Status: "Approved", Model: "sol", Progress: "🧭🔍" },
    assignees: ["owner"],
  });
  const flow = f.flow();
  const prior = await flow.cardPrior("27");
  await flow.cardConflict("27");
  await flow.escalateConflict("27", "merge verify hook failed", ["src/conflict.ts"]);
  expect(await flow.cardRestore("27", prior)).toBe("approval-kept");
  expect(f.touched.filter((write) => ["Status", "Model"].includes(String(write.field)))).toEqual(
    []
  );
  expect(f.touched.map((write) => write.value)).toEqual(["💥", "🤖🚫", "🧭🔍"]);
  expect(String(f.writes.find((write) => write.path.endsWith("/comments"))?.body.body)).toContain(
    "Owner approval kept: the card stays Approved."
  );
  f.done();
});

test("card prior captures the interrupted turn from the board and the PR", async () => {
  const f = fixture();
  f.set({ boardValues: { Status: "Owner review", Progress: "👤🔍" }, assignees: ["owner"] });
  expect(await f.flow().cardPrior("27")).toEqual({
    status: "Owner review",
    progress: "👤🔍",
    assignees: ["owner"],
  });
  f.done();
});

test("card conflict hands the turn to the fixing worker under 💥", async () => {
  const f = fixture();
  f.set({ assignees: ["owner"] });
  await f.flow().cardConflict("27");
  expect(f.touched).toContainEqual(
    expect.objectContaining({ id: "pr", field: "Progress", value: "💥" })
  );
  expect(f.writes).toContainEqual({
    path: "/repos/example/project/issues/27/assignees",
    body: { assignees: ["worker"] },
  });
  f.done();
});

test("card restore returns the stored turn to the board and the PR", async () => {
  const f = fixture();
  f.set({ assignees: ["worker"], boardValues: { Status: "Executing", Progress: "🤖🔨" } });
  await f.flow().cardRestore("27", {
    status: "Owner review",
    progress: "👤🔍",
    assignees: ["owner"],
  });
  expect(f.touched).toContainEqual(
    expect.objectContaining({
      id: "pr",
      field: "Status",
      value: "Owner review",
      progress: "👤🔍",
    })
  );
  expect(f.writes).toContainEqual({
    path: "/repos/example/project/issues/27/assignees",
    body: { assignees: ["owner"] },
  });
  f.done();
});

test("card restore keeps an owner approval found while the fixer ran (#244)", async () => {
  const f = fixture();
  // The prior was Owner review at dispatch; the owner moved the card to Approved
  // while the fixer episode ran. The restore must keep the owner's decision.
  f.set({ boardValues: { Status: "Approved", Progress: "💥" }, assignees: ["worker"] });
  const outcome = await f.flow().cardRestore("27", {
    status: "Owner review",
    progress: "👤🔍",
    assignees: ["owner"],
  });
  expect(outcome).toBe("approval-kept");
  expect(f.touched).toEqual([expect.objectContaining({ field: "Progress", value: "🧭🔍" })]);
  // The pre-dispatch ["owner"] turn is not resurrected; the managed turn releases
  // exactly like the owner's own Approved move does.
  expect(f.writes.some((write) => write.path.endsWith("/assignees"))).toBe(false);
  f.done();
});

test.each(["cardConflict", "cardRestore"] as const)(
  "board-disabled configuration still moves the %s assignees without board writes",
  async (verb) => {
    const f = fixture();
    f.config.board = { ...object(f.config.board), enabled: false };
    f.set({ assignees: verb === "cardRestore" ? ["worker"] : ["owner"] });
    await f.flow()[verb]("27", {
      status: "Owner review",
      progress: "👤🔍",
      assignees: ["owner"],
    });
    expect(f.touched).toEqual([]);
    const assigneeWrites = f.writes
      .filter((write) => write.path.endsWith("/assignees"))
      .map((write) => [write.body.assignees, write.path.split("/").at(-2)]);
    if (verb === "cardRestore") {
      expect(assigneeWrites).toEqual([
        [["worker"], "27"],
        [["owner"], "27"],
      ]);
    } else {
      expect(assigneeWrites).toEqual([
        [["owner"], "27"],
        [["worker"], "27"],
      ]);
    }
    f.done();
  }
);

test("card prior reads only the PR when the board is disabled", async () => {
  const f = fixture();
  f.config.board = { ...object(f.config.board), enabled: false };
  f.set({ boardValues: { Status: "Owner review" }, assignees: ["owner"] });
  expect(await f.flow().cardPrior("27")).toEqual({
    status: null,
    progress: null,
    assignees: ["owner"],
  });
  f.done();
});

test("review owner clears queued wakes; other outcomes keep them", async () => {
  const f = fixture();
  const cleared: number[] = [];
  f.deps.workers!.clearWake = async (pr) => {
    cleared.push(pr);
  };
  const file = join(f.root, "review.md");
  writeFileSync(file, "Owner decides.\n");
  await f.flow().review({ ref: "27", outcome: "owner", file });
  expect(cleared).toEqual([27]);
  cleared.length = 0;
  f.deps.workers!.clearWake = async () => {
    throw new Error("must not clear on other outcomes");
  };
  await f.flow().review({ ref: "27", outcome: "answer", file });
  expect(cleared).toEqual([]);
  f.done();
});

test.each(["head", "base", "worker"])("last recheck refuses %s movement", async (moved) => {
  const f = fixture();
  const thread = f.host.thread;
  let reads = 0,
    statuses = 0;
  f.host.thread = async (ref, kind) => {
    const item = await thread(ref, kind);
    if (kind === "pr" && ++reads > 1) {
      if (moved === "head") {
        item.headRefOid = "d".repeat(40);
      }
      if (moved === "base") {
        item.baseRefOid = "d".repeat(40);
      }
    }
    return item;
  };
  f.deps.workers!.status = async () => (moved === "worker" && ++statuses > 1 ? "live" : "stopped");
  await expect(f.flow().merge("27")).rejects.toThrow(
    moved === "worker" ? "Worker restarted" : "moved during"
  );
  expect(f.writes.some((write) => write.path.endsWith("/merge"))).toBe(false);
  f.done();
});

test("install replacing the pinned package cannot load or spawn the replacement mid-run", async () => {
  const f = fixture();
  const directory = join(f.root, "node_modules/@vworlds/vmethod");
  mkdirSync(directory, { recursive: true });
  const module = join(directory, "index.mjs");
  writeFileSync(module, 'export const version = "old";');
  const exec = f.deps.exec;
  let replaced = false;
  f.deps.exec = async (file, args, options) => {
    if (file === "git" && args[0] === "merge") {
      writeFileSync(module, 'throw new Error("mixed new version");');
      replaced = true;
    }
    if (file === "sh") {
      expect(replaced).toBe(true);
      writeFileSync(module, 'throw new Error("installed replacement");');
    }
    return exec(file, args, options);
  };
  await expect(f.flow().merge("27")).resolves.toBe("Merged #27");
  expect(readFileSync(module, "utf8")).toContain("installed replacement");
  expect(f.events.at(-1)).toBe("sh -c npm ci");
  f.done();
});

test("track override never changes the canonical main base for follow-up", async () => {
  const f = fixture();
  f.config.baseBranch = "track/session";
  f.set({ base: "track/session" });
  await f.flow().merge("27");
  expect(f.touched.some((write) => write.id === "issue")).toBe(false);
  expect(f.events.some((event) => event.includes("--ff-only"))).toBe(false);
  f.done();
});

test("partial board failure resumes without repeating merge or issue closure", async () => {
  const f = fixture();
  f.set({ fail: "board" });
  await expect(f.flow().merge("27")).rejects.toThrow("board failed");
  f.set({ fail: "" });
  await f.flow().merge("27");
  expect(f.writes.filter((w) => w.path.endsWith("/merge"))).toHaveLength(1);
  expect(
    f.writes.filter((w) => w.path.endsWith("/issues/8") && w.body.state === "closed")
  ).toHaveLength(1);
  f.done();
});

test("failed install resumes with original trigger delta even though checkout already fast-forwarded", async () => {
  const f = fixture();
  f.set({ fail: "install" });
  await expect(f.flow().merge("27")).rejects.toThrow("install failed");
  f.set({ fail: "" });
  await f.flow().merge("27");
  expect(f.events.filter((event) => event === "sh -c npm ci")).toHaveLength(2);
  expect(f.events.filter((event) => event.startsWith("git merge --ff-only"))).toHaveLength(1);
  expect(f.events.at(-1)).toBe("sh -c npm ci");
  f.done();
});

test("button merge with bad historical title and only Closes header still finishes legacy follow-up", async () => {
  const f = fixture();
  f.set({ state: "MERGED", title: "Old task title", body: "Closes #8\n\nLegacy prompt." });
  await f.flow().merge("27");
  expect(f.events.some((event) => event.includes("warning: already-merged"))).toBe(true);
  expect(f.events.some((event) => event.includes("legacy link"))).toBe(true);
  expect(f.touched.some((write) => write.id === "issue" && write.value === "Done")).toBe(true);
  expect(f.writes.some((w) => w.path.endsWith("/merge"))).toBe(false);
  f.done();
});

test("unchanged lockfile avoids install; release-hold posts GO, clears hold and resumes", async () => {
  const f = fixture();
  f.set({ changed: false });
  await f.flow().merge("27");
  expect(f.events.some((event) => event.startsWith("sh "))).toBe(false);
  f.set({ state: "OPEN", body: `${holdBanner}\n\n<!-- vmethod-task {"issues":[8]} -->` });
  await f.flow().release("27");
  expect(f.writes.some((w) => String(w.body.body).startsWith("[orchestrator] GO"))).toBe(true);
  expect(f.events.at(-1)).toBe("worker-resume");
  expect(f.resumes).toEqual([
    {
      pr: 27,
      prompt: "[orchestrator] GO is on your PR; read it with vmethod read pr 27 --new and act.",
    },
  ]);
  f.done();
});

test("open held task, release, and worker start; second release has no side effects", async () => {
  const f = fixture();
  await f.flow().open({ issue: "8", hold: true });
  const held = await f.host.thread("27", "pr");
  expect(String(held.body)).toContain(holdBanner);
  const directory = join(f.root, ".worktrees/8-task");
  mkdirSync(join(directory, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(directory, "node_modules/.bin/vmethod"), "fake", { mode: 0o755 });
  const requests: string[] = [];
  const service = new WorkerService(
    f.root,
    f.config,
    {
      ...f.env,
      OPENCODE_BASE_URL: "https://opencode.invalid",
      OPENCODE_SERVER_USERNAME: "worker",
      OPENCODE_SERVER_PASSWORD: "password",
    },
    {
      ...f.deps,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        expect(url.origin).toBe("https://opencode.invalid");
        requests.push(url.pathname);
        if (url.pathname === "/api/session/ses_hold" && init?.method === "GET") {
          return Response.json({ data: { id: "ses_hold", title: "project#27" } });
        }
        expect(init?.method).toBe("POST");
        if (url.pathname === "/api/session") {
          return Response.json({ data: { id: "ses_hold" } });
        }
        if (url.pathname === "/api/session/ses_hold/prompt") {
          expect(JSON.parse(String(init?.body)).text).not.toContain(holdBanner);
          return Response.json({ data: {} });
        }
        throw new Error(`Unexpected worker request ${url.pathname}`);
      },
    },
    {
      metadata: async () => {
        const pr = await f.host.thread("27", "pr");
        return {
          pr: 27,
          issue: 8,
          base: "dev",
          branch: "8-task",
          title: String(pr.title),
          body: String(pr.body),
          state: String(pr.state),
          draft: Boolean(pr.isDraft),
          blocked: false,
          pointsOpen: 13,
          model: "glm",
          kind: "tooling",
          merged: false,
          comments: [],
        };
      },
      prepare: async () => directory,
      setModel: async () => {},
      modelComment: async () => {},
      setEstimate: async () => {},
      setCost: async () => {},
      gradeComment: async () => {},
      submitLearnings: async () => "unused",
      locate: async () => directory,
      issue: async () => {
        throw new Error("Unexpected issue read");
      },
      modelApproval: async () => {
        throw new Error("Unexpected model gate");
      },
    }
  );
  await expect(service.command(["start", "27"])).rejects.toThrow("on hold");
  expect(requests).toEqual([]);
  await f.flow().release("27");
  const released = await f.host.thread("27", "pr");
  expect(released.body).toBe(String(held.body).replace(`${holdBanner}\n`, ""));
  expect(f.touched).toContainEqual(
    expect.objectContaining({ field: "Status", value: "Executing" })
  );
  const before = { writes: f.writes.length, touched: f.touched.length, resumes: f.resumes.length };
  await expect(f.flow().release("27")).rejects.toThrow("not on hold");
  expect({ writes: f.writes.length, touched: f.touched.length, resumes: f.resumes.length }).toEqual(
    before
  );
  await service.command(["start", "27"]);
  expect(requests).toEqual([
    "/api/session",
    "/api/session/ses_hold/prompt",
    "/api/session/ses_hold",
  ]);
  f.done();
});

test("release removes paired title/banner markers but preserves all other prompt text", async () => {
  const f = fixture();
  const prompt = `# Task\n\n${holdBanner}\n\nProse about ON HOLD and [HOLD: examples].\n\n<!-- vmethod-task {"issues":[8]} -->`;
  f.set({ title: "[HOLD: waiting for #7] feat: task", body: prompt });
  await f.flow().release("27");
  const edits = f.writes.filter((w) => w.path.endsWith("/pulls/27"));
  expect(edits).toEqual([
    {
      path: "/repos/example/project/pulls/27",
      body: {
        title: "feat: task",
        body: prompt.replace(`${holdBanner}\n`, ""),
      },
    },
  ]);
  f.done();
});

test("release refuses a concurrent prompt edit rather than overwriting it", async () => {
  const f = fixture();
  f.set({ body: `${holdBanner}\n\nOriginal prompt` });
  const thread = f.host.thread;
  let reads = 0;
  f.host.thread = async (ref, kind) => {
    if (++reads === 2) {
      f.set({ body: `${holdBanner}\n\nNew orchestrator amendment` });
    }
    return thread(ref, kind);
  };
  await expect(f.flow().release("27")).rejects.toThrow("changed");
  expect(f.writes).toEqual([]);
  expect(f.resumes).toEqual([]);
  f.done();
});

test("release refuses prose-only holds and never posts GO after an edit failure", async () => {
  const f = fixture();
  f.set({ body: "This prompt discusses ON HOLD and [HOLD: examples]." });
  await expect(f.flow().release("27")).rejects.toThrow("not on hold");
  expect(f.writes).toEqual([]);
  f.set({ body: `${holdBanner}\n\nPrompt`, fail: "/pulls/27" });
  await expect(f.flow().release("27")).rejects.toThrow("GitHub network request failed");
  expect(f.writes.some((w) => w.path.endsWith("/comments"))).toBe(false);
  expect(f.touched).toEqual([]);
  expect(f.resumes).toEqual([]);
  f.done();
});

test.each(["feat: normal", "BREAKING CHANGE: interface", "fix: $(hostile); `data`"])(
  "conforming title %s",
  (title) => expect(conformingTitle(title)).toBe(true)
);
test.each(["feat(scope): invalid", "feat: ", "feat: hi\nnew line", "plain title"])(
  "nonconforming title %s",
  (title) => expect(conformingTitle(title)).toBe(false)
);
