import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parse } from "graphql";
import { TaskFlow, conformingTitle } from "../../src/gateway/task-flow.js";
import { GitHubClient, type Dependencies } from "../../src/gateway/client.js";
import { getConfig } from "../../src/config.js";
import { object, type ObjectData } from "../../src/gateway/people.js";
import type { Card } from "../../src/board/types.js";
import { validProject } from "../helpers.js";
import { people, sha } from "./helpers.js";
import legacyBodies from "../fixtures/github/legacy-task-bodies.json" with { type: "json" };
import closingReferences from "../fixtures/github/task-closing-references.json" with { type: "json" };
import developmentLinks from "../fixtures/github/task-development-links.json" with { type: "json" };
import { BoardService } from "../../src/gateway/board.js";
import { WatchFake } from "./watch-fake.js";
import { writeState } from "../../src/board/readme.js";
import { taskFlowVerb } from "../../src/cli/task-flow.js";
import type { Operations, Transport } from "../../src/gateway/transport.js";

const baseSha = "b".repeat(40),
  mergedSha = "c".repeat(40);

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
      w.watchPeople = [
        ...w.watchPeople,
        { login: "me", id: 999, type: "User", role: "orchestrator", repos: ["example/project"] },
      ];
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
      status.options = ["Backlog", "Ready", "In progress", "In review", "Approved", "Done"].map(
        (name, index) => ({ id: `option-${index}`, name, color: "GRAY", description: "" })
      );
      w.fields.push({
        id: "model",
        name: "Model",
        dataType: "SINGLE_SELECT",
        createdAt: "2026-10-16T11:12:25Z",
        options: [{ id: "model-sol", name: "sol", color: "GRAY", description: "" }],
      });
      w.cards = [w.card(8, "In review")];
      object(w.cards[0].content).id = "issue";
      object(w.cards[0].content).assignees = { nodes: [{ login: "owner" }] };
      w.issues = [{ number: 8, labels: [] }];
      if (verb !== "open-task") {
        const pr = w.card(27, "In progress", "PullRequest");
        object(pr.content).id = "pr";
        w.cards.push(pr);
        w.pulls = [
          {
            number: 27,
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
          card.progress = { text: "👤🔍" };
          object(card.content).assignees = { nodes: [{ login: "owner" }] };
        }
        object(w.cards.find((card) => object(card.content).number === 27)!.status).name =
          "In review";
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
      } else {
        const file = join(f.root, ".tmp", "review.md");
        mkdirSync(join(f.root, ".tmp"), { recursive: true });
        writeFileSync(file, "Review body\n");
        await taskFlowVerb(transport, "review", ["27", verb.split(" ")[1], file], commandEnv);
      }
      let events = await once();
      if (verb === "merge-task" && identity === "sibling") {
        expect(events.some((event) => event.kind === "button-merge")).toBe(false);
        events = await once();
      }
      if (verb.startsWith("review ")) {
        const ownerTurn = ["review owner", "review ask"].includes(verb);
        const prCard = w.cards.find((card) => object(card.content).number === 27)!;
        const issueCard = w.cards.find((card) => object(card.content).number === 8)!;
        expect(object(object(prCard.content).assignees).nodes).toEqual(
          ownerTurn ? [{ login: "owner" }] : verb === "review approve" ? [{ login: "me" }] : []
        );
        expect(object(object(issueCard.content).assignees).nodes).toEqual(
          ownerTurn ? [{ login: "owner" }] : []
        );
        expect(object(issueCard.progress).text).toBe(
          ownerTurn ? (verb === "review ask" ? "👤❓" : "👤🔍") : null
        );
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
      if (identity !== "self") {
        expect(events.map((event) => event.kind)).toContain(
          verb === "open-task" ? "owner-done" : verb === "merge-task" ? "button-merge" : "comment"
        );
      } else {
        expect(events).toEqual([]);
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
          commentId: w.comments["example/project"][0].id,
          nodeId: w.comments["example/project"][0].node_id,
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
    issueApproved: boolean | "unknown" = true;
  let worker: "live" | "stopped" | "unknown" = "stopped";
  let fail = "",
    currentHead = sha,
    title = "feat: task";
  let prState = "OPEN",
    actualBase = "dev",
    branch = "8-task";
  let body = '<!-- vmethod-task {"issues":[8]} -->';
  let issueNumber = 8;
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
  const comments: ObjectData[] = [];
  const cards: Card[] = [
    {
      id: "issue-card",
      contentId: "issue",
      repo: "example/project",
      kind: "Issue",
      assignees: [],
      values: { Estimate: 13 },
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
        const mutation = query.includes("addCloseIssueReferences")
          ? "addCloseIssueReferences"
          : query.includes("removeCloseIssueReferences")
            ? "removeCloseIssueReferences"
            : undefined;
        if (mutation) {
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
        data = { number: 27, node_id: "pr" };
      } else if (method === "PATCH" && path === "/repos/example/project/pulls/27") {
        expect(typeof payload.body).toBe("string");
        body = String(payload.body);
        data = { number: 27, node_id: "pr" };
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
        data = { assignees: [] };
      } else if (
        method === "POST" &&
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
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        if (fail === "base") {
          throw new Error("base moved");
        }
        return "";
      }
      if (args.join(" ") === "rev-parse --abbrev-ref HEAD") {
        return "dev";
      }
      if (args.join(" ") === "status --porcelain") {
        return dirty ? " M package-lock.json" : "";
      }
      if (args.join(" ") === "rev-parse HEAD") {
        return checkoutHead;
      }
      if (args.join(" ") === "rev-parse refs/remotes/origin/dev") {
        return mergedSha;
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
    EXAMPLE_GITHUB_TOKEN: "secret",
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
      cards: async () => cards,
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
        mergeable: "MERGEABLE",
        isDraft: true,
        headRepository: { nameWithOwner: "example/project" },
        labels: { nodes: [] },
      };
    },
    comments: async () => comments,
    approved: async () => approved,
    candidates: async () => [],
    issueApproved: async () => issueApproved,
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
      worker?: typeof worker;
      fail?: string;
      head?: string;
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
    }) => {
      approved = values.approved ?? approved;
      issueApproved = values.issueApproved ?? issueApproved;
      worker = values.worker ?? worker;
      fail = values.fail ?? fail;
      currentHead = values.head ?? currentHead;
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

test.each(["owner", "ask"] as const)(
  "review %s mirrors the owner's turn on the issue",
  async (outcome) => {
    const f = fixture();
    const file = join(f.root, "review.md");
    writeFileSync(file, "Please decide.\n");
    await f.flow().review({ ref: "27", outcome, file });
    expect(f.touched).toContainEqual(
      expect.objectContaining({
        id: "issue",
        field: "Progress",
        value: outcome === "ask" ? "👤❓" : "👤🔍",
      })
    );
    expect(f.writes).toContainEqual({
      path: "/repos/example/project/issues/8/assignees",
      body: { assignees: ["owner"] },
    });
    if (outcome === "ask") {
      expect(f.writes.find((write) => write.path.endsWith("/comments"))?.body.body).toMatch(
        /^\[orchestrator\] OWNER QUESTION/
      );
    }
    f.done();
  }
);

test.each([
  ["changes", "[orchestrator] REVIEW round 1\nRead your task PR and act on the review."],
  ["answer", "[orchestrator] ANSWER\nRead your task PR and act on the review."],
] as const)("review %s resumes the worker", async (outcome, prompt) => {
  const f = fixture();
  const file = join(f.root, "review.md");
  writeFileSync(file, "Please address this.\n");
  await f.flow().review({ ref: "27", outcome, file });
  expect(f.resumes).toEqual([{ pr: 27, prompt }]);
  f.done();
});

test("review changes works without worker control", async () => {
  const f = fixture();
  f.deps.workers = undefined;
  const file = join(f.root, "review.md");
  writeFileSync(file, "Please address this.\n");
  await f.flow().review({ ref: "27", outcome: "changes", file });
  expect(f.resumes).toEqual([]);
  f.done();
});

test.each([false, true])(
  "issue ask refuses a live task (%s) and otherwise tracks the owner",
  async (live) => {
    const f = fixture();
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
        expect.objectContaining({ id: "issue", field: "Progress", value: "👤❓" })
      );
      expect(f.writes).toContainEqual({
        path: "/repos/example/project/issues/8/assignees",
        body: { assignees: ["owner"] },
      });
      expect(f.writes.find((write) => write.path.endsWith("/comments"))?.body.body).toMatch(
        /^\[orchestrator\] OWNER QUESTION/
      );
    }
    f.done();
  }
);

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
  "open-task fills worker commands with the created PR number: %j",
  async (input) => {
    const f = fixture();
    await f.flow().open(input);
    const body = String(
      f.writes.find((write) => write.path === "/repos/example/project/pulls/27")?.body.body
    );
    expect(body).toContain("## Commands");
    for (const command of [
      "read-pr 27",
      "pr-comment 27 .tmp/<file>.md",
      "push",
      "wait-checks 27",
    ]) {
      expect(body).toContain(
        `VMETHOD_ROLE=worker VMETHOD_TASK_PR=27 npm exec --no -- vmethod ${command}\n`
      );
    }
    expect(body).toContain("Every vmethod command needs this prefix");
    expect(body).toContain("'denied for client role' or 'own taskPr'");
    expect(body).not.toContain("<task PR number>");
    f.done();
  }
);

test("open-task reports the created draft when updating commands fails", async () => {
  const f = fixture();
  f.set({ fail: "/pulls/27" });
  await expect(f.flow().open({ issue: "8" })).rejects.toThrow(
    "Created draft PR #27, but command rendering failed; inspect it before retrying open-task"
  );
  expect(f.writes.filter((write) => write.path.endsWith("/pulls"))).toHaveLength(1);
  expect(f.touched).toEqual([]);
  f.done();
});

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
      reason === "unapproved" ? "Approved" : reason === "gated" ? "--owner-approved" : "expensive"
    );
    expect(f.writes).toEqual([]);
    f.done();
  }
);

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
    expect.objectContaining({ id: "pr", field: "Status", value: "In progress", progress: "⛔" })
  );
  expect(f.touched).toContainEqual(
    expect.objectContaining({ id: "issue", field: "Status", progress: null })
  );
  expect(f.touched.some((write) => write.field === "Estimate")).toBe(false);
  f.done();
});

test("expensive breakpoints tell workers to HANDOFF and end turn; unapproved exception is posted", async () => {
  const f = fixture();
  f.set({ body: "## Handoff breakpoints\n\nAfter implementation.", issueApproved: false });
  await f
    .flow()
    .open({ issue: "8", model: "astra", ownerApproved: true, unapproved: "Reproducer attached" });
  expect(f.writes.find((w) => w.path.endsWith("/pulls"))!.body.body).toContain(
    "then end your turn"
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
        expect.objectContaining({ field: "Status", value: "In review", progress: "👤🔍" })
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

test("requireCurrentBase false allows conflict-free green-head squash on moved base", async () => {
  const f = fixture();
  f.set({ fail: "base" });
  f.config.merge = { requireCurrentBase: false };
  await f.flow().merge("27");
  expect(f.events.some((event) => event.includes("merge-base --is-ancestor"))).toBe(false);
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
])("explicit approval carry: %s", async (scenario) => {
  const f = fixture();
  const old = "d".repeat(40);
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
          ? "Base moved"
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
  f.set({ state: "OPEN" });
  await f.flow().release("27");
  expect(f.writes.some((w) => String(w.body.body).startsWith("[orchestrator] GO"))).toBe(true);
  expect(f.events.at(-1)).toBe("worker-resume");
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
