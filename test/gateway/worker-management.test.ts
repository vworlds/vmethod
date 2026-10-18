import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "graphql";
import { stringify } from "yaml";
import { expect, test, vi } from "vitest";
import { createGateway } from "../../src/gateway/server.js";
import recordedFields from "../fixtures/github/board-fields.json" with { type: "json" };
import legacyRecords from "../fixtures/legacy-workers/records.json" with { type: "json" };
import type { Dependencies } from "../../src/gateway/client.js";
import { object } from "../../src/gateway/people.js";
import { validProject } from "../helpers.js";
import { actor, item, people } from "./helpers.js";
import { WatchFake } from "./watch-fake.js";
import { gatewayVerb } from "../../src/cli/gateway.js";
import { getConfig } from "../../src/config.js";
import { WorkerService, type WorkerHooks } from "../../src/gateway/workers.js";

function fixture(prefix?: string, legacy = false) {
  const root = validProject();
  const directory = join(root, ".worktrees", `${legacy ? "" : (prefix ?? "")}9-task`);
  mkdirSync(join(directory, "node_modules/.bin"), { recursive: true });
  mkdirSync(join(directory, ".tmp"));
  writeFileSync(join(directory, "node_modules/.bin/vmethod"), "fake", { mode: 0o755 });
  writeFileSync(join(root, "people.yaml"), stringify(people));
  writeFileSync(
    join(root, "vmethod.yaml"),
    readFileSync(join(root, "vmethod.yaml"), "utf8")
      .replace("/replace/with/consumer/checkout", root)
      .replace(
        "branches:",
        `branches:${prefix === undefined ? "" : `\n  worktreePrefix: ${JSON.stringify(prefix)}`}`
      ) + "\ngateway: {maxRetries: 0}\n"
  );
  writeFileSync(
    join(root, "models.yaml"),
    stringify([
      { family: "glm", model: "fake/glm", kind: "opencode", gate: "none", tier: "cheap" },
      { family: "sonnet", model: "claude-fake", kind: "claude", gate: "none", tier: "standard" },
    ])
  );
  const projects = (id: string, field: string, value: unknown) => ({
    nodes: [
      {
        id,
        project: { number: 1, owner: { login: "example" } },
        fieldValues: {
          nodes: [
            {
              field: { name: field },
              ...(field === "Estimate" ? { number: value } : { name: value }),
            },
          ],
          pageInfo: { hasNextPage: false },
        },
      },
    ],
    pageInfo: { hasNextPage: false },
  });
  const pr = item({
    id: "PR31",
    title: "Task",
    body: "# Task: lifecycle (issue #9)\n\n**Estimate:** 8. **Model:** glm.",
    state: "OPEN",
    isDraft: true,
    merged: false,
    headRefName: "9-task",
    baseRefName: "dev",
    headRepository: { nameWithOwner: "example/project" },
    closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
    projectItems: projects("CARD31", "Model", "glm"),
  });
  const issue = item({
    id: "ISSUE9",
    title: "Issue",
    body: "Issue data",
    state: "OPEN",
    labels: { nodes: [{ name: "tooling" }] },
    blockedBy: { nodes: [], pageInfo: { hasNextPage: false } },
    projectItems: projects("CARD9", "Estimate", 13),
  });
  const comments: ReturnType<typeof item>[] = [];
  const mutations: Record<string, unknown>[] = [];
  const requests: string[] = [];
  const gradePosts: unknown[] = [];
  const unexpected: string[] = [];
  let viewer = actor(1),
    active = false,
    turnError: unknown;
  let permissions: unknown[] = [];
  const deps: Dependencies = {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      requests.push(`${init?.method} ${url.origin}${url.pathname}`);
      if (url.origin === "https://opencode.invalid") {
        expect(JSON.stringify(init?.headers)).not.toContain("orchestrator-token");
        if (url.pathname === "/api/session" && init?.method === "POST") {
          return Response.json({ data: { id: "ses_test", directory, model: "fake/glm" } });
        }
        if (url.pathname === "/api/session/ses_test/prompt") {
          return Response.json({ data: {} });
        }
        if (url.pathname === "/api/session/active") {
          return Response.json({ data: active ? { ses_test: {} } : {} });
        }
        if (url.pathname === "/api/session/ses_test") {
          return Response.json({ data: { id: "ses_test", directory, model: "fake/glm" } });
        }
        if (url.pathname === "/api/session/ses_test/permission") {
          return Response.json({ data: permissions });
        }
        if (url.pathname === "/api/session/ses_test/message") {
          return Response.json({
            data: turnError ? [{ type: "idle", outcome: "failed", error: turnError }] : [],
          });
        }
      } else if (
        url.origin === "https://api.github.com" &&
        url.pathname === "/repos/example/project/issues/9/comments" &&
        init?.method === "POST"
      ) {
        gradePosts.push(JSON.parse(String(init.body)));
        // The gateway does not consume response fields for a comment write.
        return Response.json({});
      } else if (url.origin === "https://api.github.com" && url.pathname === "/graphql") {
        const { query, variables } = JSON.parse(String(init?.body));
        parse(query);
        if (query.includes("query WorkerIdentity")) {
          expect(object(init?.headers).authorization).toBe("Bearer worker-token");
          return Response.json({ data: { viewer } });
        }
        if (query === "query GatewayIdentity { viewer { databaseId login __typename } }") {
          expect(object(init?.headers).authorization).toBe("Bearer orchestrator-token");
          return Response.json({ data: { viewer: actor(2) } });
        }
        expect(object(init?.headers).authorization).toBe("Bearer orchestrator-token");
        if (query.includes("query BoardProject")) {
          return Response.json({
            data: {
              organization: {
                projectV2: {
                  id: "PVT",
                  readme:
                    "<!-- vmethod-board -->\nversion: 1\nmin_compatible: 1\nmigrated: test\n<!-- /vmethod-board -->",
                },
              },
            },
          });
        }
        if (query.includes("query BoardFields")) {
          return Response.json({
            data: {
              node: {
                fields: {
                  nodes: [
                    {
                      id: "F_MODEL",
                      name: "Model",
                      dataType: "SINGLE_SELECT",
                      createdAt: recordedFields.node.fields.nodes[0].createdAt,
                      options: ["glm", "sonnet"].map((name) => ({
                        id: `O_${name}`,
                        name,
                        color: "GRAY",
                        description: "",
                      })),
                    },
                    {
                      id: "F_ESTIMATE",
                      name: "Estimate",
                      dataType: "NUMBER",
                      createdAt: recordedFields.node.fields.nodes[0].createdAt,
                    },
                    {
                      id: "F_COST",
                      name: "Cost",
                      dataType: "TEXT",
                      createdAt: recordedFields.node.fields.nodes[0].createdAt,
                    },
                  ],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          });
        }
        if (query.includes("query BoardItem")) {
          return Response.json({
            data: {
              node: {
                id: variables.id,
                project: { id: "PVT" },
                content: {
                  __typename: variables.id === "CARD31" ? "PullRequest" : "Issue",
                  number: variables.id === "CARD31" ? 31 : 9,
                  repository: { nameWithOwner: "example/project" },
                  assignees: { nodes: [] },
                },
                fieldValues: { nodes: [], pageInfo: { hasNextPage: false } },
              },
            },
          });
        }
        if (query.includes("mutation BoardSetCards")) {
          mutations.push(variables);
          return Response.json({ data: { m0: { projectV2Item: { id: "updated" } } } });
        }
        if (query.includes("repository(owner:")) {
          return Response.json({
            data: {
              repository: query.includes("pullRequest(number:")
                ? { pullRequest: pr }
                : { issue: variables.number === 9 ? issue : null },
            },
          });
        }
        if (query.includes("comments(first:")) {
          return Response.json({
            data: {
              node: { ...pr, comments: { nodes: comments, pageInfo: { hasNextPage: false } } },
            },
          });
        }
        if (variables.id === "PR31") {
          return Response.json({ data: { node: pr } });
        }
        if (variables.id === "ISSUE9") {
          return Response.json({ data: { node: issue } });
        }
        const comment = comments.find((c) => c.id === variables.id);
        if (comment) {
          return Response.json({ data: { node: comment } });
        }
      }
      unexpected.push(`${init?.method} ${url}`);
      throw new Error(`Unexpected fake request ${url}`);
    },
    exec: async (file, args, options) => {
      expect(file).toBe("git");
      expect(options?.cwd).toBe(directory);
      expect(JSON.stringify(options?.env)).not.toMatch(
        /orchestrator-token|worker-token|secret-password/
      );
      const key = args.join(" ");
      if (key === "rev-parse --show-toplevel") {
        return directory;
      }
      if (key === "rev-parse --abbrev-ref HEAD") {
        return "9-task";
      }
      if (key === "rev-parse --git-common-dir") {
        return join(root, ".git");
      }
      if (key === "rev-parse --git-dir") {
        return join(root, ".git/worktrees/9-task");
      }
      throw new Error(`Unexpected fake git ${key}`);
    },
    now: () => 0,
    sleep: async () => {
      throw new Error("Unexpected sleep");
    },
    report: vi.fn(),
    processes: {
      launch: vi.fn(async () => ({ pid: 123, born: "fake" })),
      alive: () => true,
      stop: vi.fn(),
    },
  };
  const env = {
    EXAMPLE_GITHUB_TOKEN: "orchestrator-token",
    EXAMPLE_WORKER_GITHUB_TOKEN: "worker-token",
    OPENCODE_BASE_URL: "https://opencode.invalid",
    OPENCODE_SERVER_USERNAME: "user",
    OPENCODE_SERVER_PASSWORD: "secret-password",
    XDG_STATE_HOME: join(root, "state"),
  };
  const transport = createGateway(root, env, deps);
  const ctx = { role: "orchestrator" as const };
  return {
    root,
    directory,
    pr,
    issue,
    comments,
    gradePosts,
    mutations,
    requests,
    deps,
    env,
    transport,
    ctx,
    setViewer: (index: number) => {
      viewer = actor(index);
    },
    setStatus: (busy: boolean, error?: unknown) => {
      active = busy;
      turnError = error;
    },
    setPermission: () => {
      permissions = [{ id: "permission", type: "shell" }];
    },
    done: () => expect(unexpected).toEqual([]),
  };
}

test.each(["auto-", "", "legacy"])(
  "started workers report each stop once via watch (prefix=%s)",
  async (prefix) => {
    for (const state of ["failed", "permission", "idle"] as const) {
      const f = fixture(prefix === "legacy" ? "auto-" : prefix, prefix === "legacy");
      const w = new WatchFake();
      try {
        w.attachWriter(f);
        w.config.branches = getConfig(f.root, {}).branches;
        w.fields.push({
          id: "F_MODEL",
          name: "Model",
          dataType: "SINGLE_SELECT",
          options: [{ id: "O_glm", name: "glm" }],
        });
        w.task();
        w.pulls[0].number = 31;
        object(w.pulls[0].head).ref = "9-task";
        w.issues[1].number = 31;
        w.cards = [w.card(31, "In progress", "PullRequest")];
        w.cards[0].id = "CARD31";
        w.history = [
          {
            body: "[orchestrator] ANSWER continue",
            user: { login: "me", id: 999, type: "User" },
            created_at: w.iso(),
            html_url: "https://github.com/example/project/pull/31#issuecomment-1",
          },
        ];
        const unexpected = () => {
          throw new Error("Unexpected worker hook while reading a recorded session");
        };
        const hooks: WorkerHooks = {
          metadata: unexpected,
          prepare: unexpected,
          setModel: unexpected,
          setEstimate: unexpected,
          workerIdentity: unexpected,
          issue: unexpected,
        };
        const service = new WorkerService(f.root, getConfig(f.root, {}), f.env, f.deps, hooks);
        w.workerStatus = (pr) => {
          expect(pr).toBe(31);
          return service.watchStatus(pr);
        };
        await f.transport.call("worker", { args: ["start", "31"] }, f.ctx);
        f.setStatus(true);
        const loop = w.loop();
        expect(await w.once(loop)).toEqual([]);
        if (state === "permission") {
          f.setPermission();
        } else {
          f.setStatus(false, state === "failed" ? { message: "scripted failure" } : undefined);
        }
        const events = [];
        for (let i = 0; i < 12; i++) {
          events.push(...(await w.once(loop)));
        }
        expect(events.map((event) => event.kind)).toEqual(["worker"]);
        expect(events[0].line).toContain(
          state === "failed"
            ? "its turn failed"
            : state === "permission"
              ? "waits for a permission"
              : "stopped without reply; send it a nudge"
        );
        expect(w.reports).toEqual([]);
        f.done();
      } finally {
        w.done();
      }
    }
  },
  15000
);

test.each([
  ["auto-", false],
  ["", false],
  ["auto-", true],
] as const)(
  "worker start/adopt/status share directory resolution (prefix=%j legacy=%s)",
  async (prefix, legacy) => {
    for (const verb of ["start", "adopt"]) {
      const f = fixture(prefix, legacy);
      await f.transport.call(
        "worker",
        { args: [verb, "31", ...(verb === "adopt" ? ["ses_test"] : [])] },
        f.ctx
      );
      const record = JSON.parse(
        readFileSync(join(f.env.XDG_STATE_HOME, "vmethod/example-state/workers/31.json"), "utf8")
      );
      expect(record.directory).toBe(f.directory);
      expect(await f.transport.call("worker", { args: ["status", "31"] }, f.ctx)).toContain(
        JSON.stringify(f.directory)
      );
      f.done();
    }
  }
);

test.each([false, true])(
  "worker start then watch --once (owner=%s)",
  async (owner) => {
    const f = fixture();
    const w = new WatchFake();
    try {
      w.attachWriter(f);
      if (owner) {
        w.config.stateName = "observer-session";
        w.dir = join(f.env.XDG_STATE_HOME, "vmethod", "observer-session");
      }
      w.fields.push({
        id: "F_MODEL",
        name: "Model",
        dataType: "SINGLE_SELECT",
        options: [{ id: "O_glm", name: "glm" }],
      });
      const card = w.card(31, "In progress", "PullRequest");
      card.id = "CARD31";
      w.cards = [card];
      w.issues = [{ number: 31, labels: [] }];
      const loop = w.loop();
      const once = () => w.once(loop);
      expect(await once()).toEqual([]);
      await gatewayVerb(f.transport, "worker", ["start", "31"], { VMETHOD_ROLE: "orchestrator" });
      expect(await once()).toEqual([]); // Model-only changes never woke the watcher.
      const records = readFileSync(
        join(f.env.XDG_STATE_HOME, "vmethod", "example-state", "writes.jsonl"),
        "utf8"
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records).toContainEqual(
        expect.objectContaining({ kind: "board", number: 31, field: "Model", value: "glm" })
      );
      expect(w.reports).toEqual([]);
      f.done();
    } finally {
      w.done();
    }
  },
  15000
);

test("gateway grades a delivery with Estimate on the linked issue and Cost only on the PR", async () => {
  const f = fixture();
  await f.transport.call("worker", { args: ["start", "31"] }, f.ctx);
  expect(f.mutations[0]).toMatchObject({
    m0: { itemId: "CARD31", fieldId: "F_MODEL", value: { singleSelectOptionId: "O_glm" } },
  });
  f.pr.state = "MERGED";
  f.pr.merged = true;
  await f.transport.call("grade", { ref: "31", points: 20 }, f.ctx);
  expect(f.mutations[1]).toMatchObject({
    m0: { itemId: "CARD9", fieldId: "F_ESTIMATE", value: { number: 20 } },
  });
  const log = JSON.parse(readFileSync(join(f.root, ".vmethod/model-log.jsonl"), "utf8"));
  expect(log).toMatchObject({
    pr: 31,
    points_open: 8,
    points_final: 20,
    segments: [{ family: "glm", why: "start" }],
    usd: null,
  });
  expect(f.mutations[2]).toMatchObject({
    m0: { itemId: "CARD31", fieldId: "F_COST" },
  });
  expect(f.gradePosts).toEqual([
    { body: "[orchestrator] GRADE\n\nGraded PR #31: issue #9 Estimate 20; USD unknown" },
  ]);
  f.done();
});

test("partial task headers still identify the issue for worker dispatch", async () => {
  const f = fixture();
  f.pr.body = "# Task: lifecycle (part of issue #9)\n\n**Estimate:** 8. **Model:** glm.";
  await f.transport.call("worker", { args: ["start", "31"] }, f.ctx);
  expect(f.mutations[0]).toMatchObject({
    m0: { itemId: "CARD31", fieldId: "F_MODEL", value: { singleSelectOptionId: "O_glm" } },
  });
  f.done();
});

function legacyAdoptionFixture(body = legacyRecords.spacerocksPrHeader) {
  const f = fixture();
  f.pr.body = body.replaceAll("#342", "#9").replaceAll("346-rogue-looter", "9-task");
  const configPath = join(f.root, "vmethod.yaml");
  writeFileSync(
    configPath,
    readFileSync(configPath, "utf8") + "\nlegacyWorkers: [spacerocks-orchestrator/workers]\n"
  );
  const directory = join(f.env.XDG_STATE_HOME, "spacerocks-orchestrator/workers");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "31.json"), JSON.stringify({ id: "ses_test" }));
  f.transport = createGateway(f.root, f.env, f.deps);
  return {
    ...f,
    record: () =>
      JSON.parse(
        readFileSync(join(f.env.XDG_STATE_HOME, "vmethod/example-state/workers/31.json"), "utf8")
      ),
  };
}

test.each([
  legacyRecords.spacerocksPrHeader,
  "> **Agent task for #342.** Branch `346-rogue-looter`, base `dev`.",
  "Closes #342.",
])(
  "legacy adoption snapshots the linked issue's Estimate and preserves provenance through grade: %s",
  async (body) => {
    const f = legacyAdoptionFixture(body);
    expect(await f.transport.call("worker", { args: ["adopt", "--from-legacy"] }, f.ctx)).toContain(
      "Adopted ses_test for #31"
    );
    expect(f.record()).toMatchObject({
      issue: 9,
      points_open: 13,
      segments: [{ why: "legacy snapshot at adoption" }],
    });
    // Later issue edits must not rewrite the opening snapshot or its provenance.
    f.issue.projectItems = {
      nodes: [
        {
          id: "CARD9",
          project: { number: 1, owner: { login: "example" } },
          fieldValues: {
            nodes: [{ field: { name: "Estimate" }, number: 5 }],
            pageInfo: { hasNextPage: false },
          },
        },
      ],
      pageInfo: { hasNextPage: false },
    };
    f.pr.state = "MERGED";
    f.pr.merged = true;
    await f.transport.call("grade", { ref: "31", points: 20 }, f.ctx);
    const log = JSON.parse(readFileSync(join(f.root, ".vmethod/model-log.jsonl"), "utf8"));
    expect(log).toMatchObject({
      points_open: 13,
      points_final: 20,
      segments: [{ why: "legacy snapshot at adoption" }],
    });
    f.done();
  }
);

test("legacy adoption reports a missing linked issue Estimate without saving or reaching opencode", async () => {
  const f = legacyAdoptionFixture();
  f.issue.projectItems = { nodes: [], pageInfo: { hasNextPage: false } };
  expect(await f.transport.call("worker", { args: ["adopt", "--from-legacy"] }, f.ctx)).toContain(
    "linked issue #9 has no Estimate; estimate it, then rerun"
  );
  expect(() => f.record()).toThrow();
  expect(f.requests.join("\n")).not.toContain("opencode.invalid");
  expect(f.mutations).toEqual([]);
  f.done();
});

test("explicit adoption still requires an opening snapshot even for a legacy relation with a board Estimate", async () => {
  const f = legacyAdoptionFixture();
  await expect(
    f.transport.call("worker", { args: ["adopt", "31", "ses_test"] }, f.ctx)
  ).rejects.toThrow("opening Estimate");
  expect(() => f.record()).toThrow();
  expect(f.requests.join("\n")).not.toContain("opencode.invalid");
  f.done();
});

test("legacy adoption retains an existing opening snapshot instead of using the current Estimate", async () => {
  const f = legacyAdoptionFixture(legacyRecords.spacerocksPrHeader + "\n<!-- points_open: 8 -->\n");
  expect(await f.transport.call("worker", { args: ["adopt", "--from-legacy"] }, f.ctx)).toContain(
    "Adopted"
  );
  expect(f.record()).toMatchObject({ points_open: 8, segments: [{ why: "adopt" }] });
  f.done();
});

test("legacy worker metadata refuses ambiguous fallback issue relations", async () => {
  const f = legacyAdoptionFixture("Agent task for #9\nCloses #10.\n");
  expect(await f.transport.call("worker", { args: ["adopt", "--from-legacy"] }, f.ctx)).toContain(
    "ambiguous linked issues"
  );
  expect(() => f.record()).toThrow();
  expect(f.requests.join("\n")).not.toContain("opencode.invalid");
  f.done();
});

test.each([
  ["adopt", "31", "ses_test"],
  ["adopt", "--from-legacy"],
])("worker role cannot adopt sessions: %j", async (...args) => {
  const f = fixture();
  await expect(f.transport.call("worker", { args }, { role: "worker" })).rejects.toThrow();
  expect(f.requests).toEqual([]);
});

test("recorded worker status is wired into merge guards without an injected worker backend", async () => {
  const f = fixture();
  await f.transport.call("worker", { args: ["start", "31"] }, f.ctx);
  // workerStatus uses the standard accepted task read path as well as the session record.
  f.pr.labels = { nodes: [], pageInfo: { hasNextPage: false } };
  f.setStatus(true);
  await expect(f.transport.call("workerStatus", { ref: "31" }, f.ctx)).resolves.toBe("live");
  f.setStatus(false);
  await expect(f.transport.call("workerStatus", { ref: "31" }, f.ctx)).resolves.toBe("stopped");
  f.done();
});

test("gateway filters forged and edited protocol comments before idle-without-reply classification", async () => {
  const f = fixture();
  f.comments.push(
    item({
      id: "GO",
      author: actor(2),
      body: "[orchestrator] GO",
      createdAt: "2026-10-17T01:00:00Z",
    })
  );
  f.comments.push(
    item({
      id: "FORGED",
      author: { login: "stranger", databaseId: 999, __typename: "User" },
      body: "[worker] ACK",
      createdAt: "2026-10-17T02:00:00Z",
    })
  );
  f.comments.push(
    item({
      id: "EDITED",
      author: actor(1),
      editor: actor(2),
      lastEditedAt: "2026-10-17T03:00:00Z",
      body: "[worker] ACK",
      createdAt: "2026-10-17T02:00:00Z",
    })
  );
  await f.transport.call("worker", { args: ["start", "31"] }, f.ctx);
  expect(await f.transport.call("worker", { args: ["status", "31"] }, f.ctx)).toContain(
    "idle without reply"
  );
  f.comments.push(
    item({ id: "ACK", author: actor(1), body: "[worker] ACK", createdAt: "2026-10-17T04:00:00Z" })
  );
  expect(await f.transport.call("worker", { args: ["status", "31"] }, f.ctx)).not.toContain(
    "idle without reply"
  );
  f.done();
});

test("gateway refuses blocked starts and unlinked grading without reaching opencode or board writes", async () => {
  const f = fixture();
  f.issue.blockedBy = { nodes: [{ state: "OPEN" }], pageInfo: { hasNextPage: false } };
  await expect(f.transport.call("worker", { args: ["start", "31"] }, f.ctx)).rejects.toThrow(
    "blocked"
  );
  f.pr.body = "No task issue";
  f.pr.state = "CLOSED";
  await expect(f.transport.call("grade", { ref: "31", points: 5 }, f.ctx)).rejects.toThrow(
    "no linked issue"
  );
  expect(f.requests.join("\n")).not.toContain("opencode.invalid");
  expect(f.mutations).toEqual([]);
  f.done();
});

test("gateway verifies worker token identity and launches Claude with no orchestrator/opencode credentials", async () => {
  const f = fixture();
  f.pr.projectItems = {
    nodes: [
      {
        id: "CARD31",
        project: { number: 1, owner: { login: "example" } },
        fieldValues: { nodes: [{ field: { name: "Model" }, name: "sonnet" }] },
      },
    ],
  };
  f.setViewer(2);
  await expect(f.transport.call("worker", { args: ["start", "31"] }, f.ctx)).rejects.toThrow(
    "not a pinned worker"
  );
  expect(f.deps.processes!.launch).not.toHaveBeenCalled();
  f.setViewer(1);
  await f.transport.call("worker", { args: ["start", "31"] }, f.ctx);
  expect(f.deps.processes!.launch).toHaveBeenCalledWith(
    expect.objectContaining({
      env: {
        GH_TOKEN: "worker-token",
        GITHUB_TOKEN: "worker-token",
        EXAMPLE_GITHUB_TOKEN: "worker-token",
        VMETHOD_ROLE: "worker",
        VMETHOD_TASK_PR: "31",
      },
    })
  );
  expect(f.requests.join("\n")).not.toContain("opencode.invalid");
  f.done();
});

test("Claude worker start refuses a missing worker credential before launch", async () => {
  const f = fixture();
  f.env.EXAMPLE_WORKER_GITHUB_TOKEN = "";
  await expect(
    f.transport.call("worker", { args: ["start", "31", "--model", "sonnet"] }, f.ctx)
  ).rejects.toThrow("Claude workers require credentials.workerGithubToken");
  expect(f.deps.processes!.launch).not.toHaveBeenCalled();
  expect(f.requests.join("\n")).not.toContain("opencode.invalid");
  f.done();
});

test("worker clients cannot control sessions, grade or select models", async () => {
  const f = fixture();
  const ctx = { role: "worker" as const, taskPr: 31 };
  await expect(f.transport.call("worker", { args: ["start", "31"] }, ctx)).rejects.toThrow(
    "denied"
  );
  await expect(f.transport.call("grade", { ref: "31", points: 5 }, ctx)).rejects.toThrow("denied");
  await expect(f.transport.call("suggestModel", { ref: "9" }, ctx)).rejects.toThrow("denied");
  expect(f.requests).toEqual([]);
  f.done();
});
