import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "graphql";
import { stringify } from "yaml";
import { expect, test, vi } from "vitest";
import { createGateway } from "../../src/gateway/server.js";
import recordedFields from "../fixtures/github/board-fields.json" with { type: "json" };
import type { Dependencies } from "../../src/gateway/client.js";
import { object } from "../../src/gateway/people.js";
import { validProject } from "../helpers.js";
import { actor, item, people } from "./helpers.js";
import { WatchFake } from "./watch-fake.js";
import { gatewayVerb } from "../../src/cli/gateway.js";

function fixture() {
  const root = validProject();
  const directory = join(root, ".worktrees/9-task");
  mkdirSync(join(directory, "node_modules/.bin"), { recursive: true });
  mkdirSync(join(directory, ".tmp"));
  writeFileSync(join(directory, "node_modules/.bin/vmethod"), "fake", { mode: 0o755 });
  writeFileSync(join(root, "people.yaml"), stringify(people));
  writeFileSync(
    join(root, "vmethod.yaml"),
    readFileSync(join(root, "vmethod.yaml"), "utf8").replace(
      "/replace/with/consumer/checkout",
      root
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
  const unexpected: string[] = [];
  let viewer = actor(1),
    active = false,
    turnError: unknown;
  const deps: Dependencies = {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      requests.push(`${init?.method} ${url.origin}${url.pathname}`);
      if (url.origin === "https://opencode.invalid") {
        expect(JSON.stringify(init?.headers)).not.toContain("orchestrator-token");
        if (url.pathname === "/api/session" && init?.method === "POST") {
          return Response.json({ data: { id: "ses_test" } });
        }
        if (url.pathname === "/api/session/ses_test/prompt") {
          return Response.json({ data: {} });
        }
        if (url.pathname === "/api/session/active") {
          return Response.json({ data: active ? { ses_test: {} } : {} });
        }
        if (url.pathname === "/api/session/ses_test") {
          return Response.json({ data: { id: "ses_test" } });
        }
        if (url.pathname === "/api/session/ses_test/permission") {
          return Response.json({ data: [] });
        }
        if (url.pathname === "/api/session/ses_test/message") {
          return Response.json({
            data: turnError ? [{ type: "idle", outcome: "failed", error: turnError }] : [],
          });
        }
      } else if (url.origin === "https://api.github.com" && url.pathname === "/graphql") {
        const { query, variables } = JSON.parse(String(init?.body));
        parse(query);
        if (query.includes("query WorkerIdentity")) {
          expect(object(init?.headers).authorization).toBe("Bearer worker-token");
          return Response.json({ data: { viewer } });
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
    pr,
    issue,
    comments,
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
    done: () => expect(unexpected).toEqual([]),
  };
}

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

test("gateway dispatches a draft PR and grades its delivery, writing Estimate only on linked issue", async () => {
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
  });
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
