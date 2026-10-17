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
    ["self", "owner", ...(["review owner", "merge-task"].includes(verb) ? ["sibling"] : [])].map(
      (identity) => ({ verb, identity })
    )
  )
)(
  "$verb through real board/client writes then watch --once (identity=$identity)",
  async ({ verb, identity }) => {
    const f = fixture();
    const w = new WatchFake();
    let sibling: WatchFake | undefined;
    try {
      w.enableWrites = true;
      w.watchPeople = [
        ...w.watchPeople,
        { login: "me", id: 999, type: "User", role: "orchestrator" },
      ];
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
        return /\/git\/(matching-refs|refs)\/|\/dependencies\/blocking$/.test(path)
          ? originalFetch(input, init)
          : w.deps.fetch(input, init);
      };
      f.deps.now = w.deps.now;
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
            return (await f.flow().merge((input as Operations["mergeTask"]["input"]).ref)) as never;
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
      if (verb === "open-task") {
        await taskFlowVerb(transport, verb, ["8", "--model", "sol"], commandEnv);
      } else if (verb === "merge-task") {
        await taskFlowVerb(transport, verb, ["27"], commandEnv);
      } else {
        const file = join(f.root, ".tmp", "review.md");
        mkdirSync(join(f.root, ".tmp"), { recursive: true });
        writeFileSync(file, "Review body\n");
        await taskFlowVerb(transport, "review", ["27", verb.split(" ")[1], file], commandEnv);
      }
      const events = await once();
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
  let references: ObjectData = { nodes: [], pageInfo: { hasNextPage: false } };
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
        data = { data: {} };
      } else if (method === "GET" && path.includes("/check-runs?")) {
        data = { check_runs: checks };
      } else if (method === "PUT" && path === "/repos/example/project/pulls/27/merge") {
        expect(payload.sha).toBe(sha);
        prState = "MERGED";
        data = { merged: true };
      } else if (method === "POST" && path === "/repos/example/project/pulls") {
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
      } else if (method === "POST" && path === "/repos/example/project/issues/27/assignees") {
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
      resume: async () => {
        events.push("worker-resume");
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

test("open-task --part records matching structured relations without closing syntax", async () => {
  const f = fixture();
  await f.flow().open({ issue: "8", part: true });
  const body = String(f.writes.find((w) => w.path.endsWith("/pulls"))!.body.body);
  expect(body).toContain("# Task: feat: task (part of issue #8)");
  expect(body).toContain('<!-- vmethod-task {"issues":[8],"part":true} -->');
  expect(body).not.toMatch(/(?:closes|fixes|resolves|part of)\s+#8/i);
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

test("open-task creates a draft, links without closing syntax, clears issue Progress and never estimates PRs", async () => {
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
  expect(create.body.body).not.toMatch(/(?:closes|part of)\s+#8/i);
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

test.each([0, 0.5, 13])(
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
