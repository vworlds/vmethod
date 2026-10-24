import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "vitest";
import { getConfig } from "../../src/config.js";
import { GitHubClient } from "../../src/gateway/client.js";
import { WriteJournal } from "../../src/gateway/write-journal.js";
import { fixtureServer } from "./helpers.js";
import boardRecording from "../fixtures/github/board-write-inputs.json" with { type: "json" };
import commentRecording from "../fixtures/github/review-comment.json" with { type: "json" };

test.each([
  [58, commentRecording.created_at, "2026-10-17T23:09:05.668Z"],
  [73, "2026-10-18T11:43:02Z", "2026-10-18T11:43:03.119Z"],
])(
  "supplied legacy incident #%s matches without widening the time window",
  (number, created, at) => {
    const f = fixtureServer([]);
    const config = { ...getConfig(f.root, {}), repo: "vworlds/vmethod" };
    const dir = join(f.env.XDG_STATE_HOME, "vmethod", "example-state");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "writes.jsonl"),
      `${JSON.stringify({ at, kind: "comment", repo: "vworlds/vmethod", number })}\n`
    );
    const reader = new WriteJournal(config, f.env, () => Date.parse(at) + 60_000);
    expect(reader.matches({ kind: "comment", repo: "vworlds/vmethod", number }, created)).toBe(
      true
    );
    f.done();
  }
);

test("operation records and handoff status writes identify an in-flight window within two minutes", () => {
  const f = fixtureServer([]);
  const config = { ...getConfig(f.root, {}), repo: "example/project" };
  const now = Date.UTC(2026, 9, 17, 10);
  const entry = (number: number, at: string, kind: string, extra: Record<string, unknown> = {}) =>
    `${JSON.stringify({ at, kind, repo: "example/project", number, ...extra })}\n`;
  mkdirSync(join(f.env.XDG_STATE_HOME, "vmethod", "example-state"), { recursive: true });
  writeFileSync(
    join(f.env.XDG_STATE_HOME, "vmethod", "example-state", "writes.jsonl"),
    [
      entry(55, new Date(now).toISOString(), "operation", { op: "review" }),
      entry(58, new Date(now - 119_999).toISOString(), "operation", { op: "scope-review" }),
      entry(59, new Date(now - 120_000).toISOString(), "operation", { op: "release-hold" }),
      entry(60, new Date(now - 120_001).toISOString(), "operation", { op: "merge-task" }),
      entry(61, new Date(now).toISOString(), "board", { field: "Status", value: "Executing" }),
      entry(62, new Date(now).toISOString(), "board", { field: "Progress", value: "🤖🔨" }),
      entry(63, new Date(now).toISOString(), "unassigned", { field: "Assignee", value: "peer" }),
      entry(64, new Date(now - 121_000).toISOString(), "board", {
        field: "Status",
        value: "Spec review",
      }),
    ].join("")
  );
  const journal = new WriteJournal(config, f.env, () => now);
  // A fresh operation record keeps the card quiet; older ones age out at two minutes.
  expect(journal.recentlyWrote("example/project", 55)).toBe(true);
  expect(journal.recentlyWrote("example/project", 58)).toBe(true);
  expect(journal.recentlyWrote("example/project", 59)).toBe(true);
  expect(journal.recentlyWrote("example/project", 60)).toBe(false);
  // The #178 handoff match: a recent Status move into a delivery column, and nothing else.
  expect(journal.recentlyWrote("example/project", 61)).toBe(true);
  expect(journal.recentlyWrote("example/project", 62)).toBe(false);
  expect(journal.recentlyWrote("example/project", 63)).toBe(false);
  expect(journal.recentlyWrote("example/project", 64)).toBe(false);
  expect(journal.recentlyWrote("EXAMPLE/PROJECT", 55)).toBe(true);
  expect(journal.recentlyWrote("example/project", 65)).toBe(false);
  f.done();
});

test("GraphQL comment database/node ids use the same exact attribution as REST", async () => {
  const f = fixtureServer([
    { path: "/graphql", json: { data: { repository: { issue: { id: "issue-node" } } } } },
    {
      path: "/graphql",
      json: {
        data: {
          addComment: {
            commentEdge: {
              node: { id: commentRecording.node_id, databaseId: commentRecording.id },
            },
          },
        },
      },
    },
  ]);
  const client = new GitHubClient(getConfig(f.root, {}), f.env, f.deps);
  await client.graphql(
    'query { repository(owner: "example", name: "project") { issue(number: 58) { id } } }'
  );
  await client.graphql(
    'mutation { addComment(input: { subjectId: "issue-node", body: "review" }) { commentEdge { node { id databaseId } } } }'
  );
  const event = { kind: "comment", repo: "example/project", number: 58 };
  expect(client.writes.matches({ ...event, commentId: commentRecording.id }, "")).toBe(true);
  expect(client.writes.matches({ ...event, nodeId: commentRecording.node_id }, "")).toBe(true);
  expect(
    client.writes.matches(
      { ...event, commentId: commentRecording.id + 1 },
      new Date(f.deps.now()).toISOString()
    )
  ).toBe(false);
  f.done();
});

test("comment ids override time, distinguish concurrent same-account comments, and reread writes from another client", async () => {
  const f = fixtureServer([
    {
      path: "/repos/example/project/issues/58/comments",
      json: { id: 6242861295, node_id: "IC_comment" },
    },
  ]);
  f.deps.now = () => Date.parse("2026-10-17T23:09:05.668Z");
  const config = getConfig(f.root, {});
  const reader = new WriteJournal(config, f.env, f.deps.now);
  const event = { kind: "comment", repo: "example/project", number: 58, commentId: 6242861295 };
  expect(reader.matches(event, "2026-10-17T23:09:05Z")).toBe(false);
  const client = new GitHubClient(config, f.env, f.deps);
  await client.rest("/repos/example/project/issues/58/comments", "POST", { body: "review" });
  const entries = readFileSync(
    join(f.env.XDG_STATE_HOME, "vmethod", "example-state", "writes.jsonl"),
    "utf8"
  );
  expect(JSON.parse(entries)).toMatchObject({ commentId: 6242861295, nodeId: "IC_comment" });
  expect(reader.matches(event, "2026-10-17T23:09:05Z")).toBe(true);
  expect(reader.matches(event, "2026-10-17T23:00:00Z")).toBe(true);
  expect(reader.matches(event, "")).toBe(true);
  expect(reader.matches({ ...event, commentId: 6242861296 }, "2026-10-17T23:09:05Z")).toBe(false);
  expect(reader.matches({ ...event, number: 59 }, "2026-10-17T23:09:05Z")).toBe(false);
  expect(reader.matches({ ...event, repo: "other/project" }, "2026-10-17T23:09:05Z")).toBe(false);
  f.done();
});

test("GraphQL aliases/fragments decode recorded board IDs into exact field/value writes; query POSTs and refused mutations do not stamp", async () => {
  const recording = structuredClone(boardRecording);
  const card = recording.items.nodes[0];
  card.content.repository.nameWithOwner = "example/project";
  const status = recording.fields.nodes.find((field) => field.name === "Status")!;
  const f = fixtureServer([
    { path: "/graphql", json: { data: { node: { fields: recording.fields } } } },
    { path: "/graphql", json: { data: { node: { items: recording.items } } } },
    { path: "/graphql", json: { data: { m0: { projectV2Item: { id: card.id } } } } },
    { path: "/graphql", json: { errors: [{ message: "refused" }] } },
    { path: "/graphql", json: { data: { cleared: { projectV2Item: { id: card.id } } } } },
  ]);
  const client = new GitHubClient(getConfig(f.root, {}), f.env, f.deps);
  await client.graphql(
    'query Fields { node(id: "project") { ... on ProjectV2 { fields(first: 100) { nodes { ... on ProjectV2SingleSelectField { id name dataType options { id name } } } } } } }'
  );
  await client.graphql(
    'query Cards { node(id: "project") { ... on ProjectV2 { items(first: 100) { nodes { id content { ... on Issue { number repository { nameWithOwner } } } } } } } }'
  );
  const mutation =
    "mutation Write($input: UpdateProjectV2ItemFieldValueInput!) { ...F } fragment F on Mutation { m0: updateProjectV2ItemFieldValue(input: $input) { projectV2Item { id } } }";
  const input = {
    itemId: card.id,
    projectId: recording.id,
    fieldId: status.id,
    value: { singleSelectOptionId: "e807513c" },
  };
  await client.graphql(mutation, { input });
  await expect(client.graphql(mutation, { input })).rejects.toThrow("refused");
  await client.graphql(
    "mutation Clear($input: ClearProjectV2ItemFieldValueInput!) { ... on Mutation { cleared: clearProjectV2ItemFieldValue(input: $input) { projectV2Item { id } } } }",
    { input: { itemId: card.id, projectId: recording.id, fieldId: status.id } }
  );
  const path = join(f.env.XDG_STATE_HOME, "vmethod", "example-state", "writes.jsonl");
  const entries = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(entries).toHaveLength(2);
  expect(entries.map((entry) => entry.value)).toEqual(["Done", null]);
  expect(entries[0]).toMatchObject({ itemId: card.id, nodeId: card.content.id });
  const event = {
    kind: "board",
    repo: "example/project",
    number: card.content.number,
    itemId: card.id,
    field: "Status",
    value: "Done",
  };
  expect(client.writes.matches(event, entries[0].at)).toBe(true);
  expect(client.writes.matches({ ...event, value: "Ready" }, entries[0].at)).toBe(false);
  expect(client.writes.matches({ ...event, field: "Model" }, entries[0].at)).toBe(false);
  expect(client.writes.matches({ ...event, itemId: "other-card" }, entries[0].at)).toBe(false);
  f.done();
});

test("a card position write journals itself and never matches a board field event", async () => {
  const f = fixtureServer([
    {
      path: "/graphql",
      json: { data: { updateProjectV2ItemPosition: { clientMutationId: null } } },
    },
  ]);
  const client = new GitHubClient(getConfig(f.root, {}), f.env, f.deps);
  await client.graphql(
    "mutation BoardPosition($input: UpdateProjectV2ItemPositionInput!) { updateProjectV2ItemPosition(input: $input) { clientMutationId } }",
    { input: { projectId: "project", itemId: "item-1", afterId: null } }
  );
  const path = join(f.env.XDG_STATE_HOME, "vmethod", "example-state", "writes.jsonl");
  const entries = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    kind: "updateProjectV2ItemPosition",
    nodeId: "item-1",
    number: 0,
  });
  expect(
    client.writes.matches(
      {
        kind: "board",
        repo: "example/project",
        number: 24,
        itemId: "item-1",
        field: "Status",
        value: "Executing",
      },
      entries[0].at
    )
  ).toBe(false);
  f.done();
});

test("the client journals successful REST writes, not reads/failures; pruning and time/kind/item/value matching are bounded", async () => {
  const f = fixtureServer([
    { path: "/repos/example/project/issues/6", method: "GET", json: {} },
    { path: "/repos/example/project/issues/6/assignees", method: "DELETE", status: 204, text: "" },
    { path: "/repos/example/project/issues/6", method: "PATCH", json: {} },
    { path: "/repos/example/project/issues/6", method: "PATCH", status: 403 },
    { path: "/repos/example/project/issues/6/comments", json: {} },
    { path: "/repos/example/project/pulls/6/merge", method: "PUT", json: { merged: true } },
  ]);
  let now = Date.UTC(2026, 9, 17);
  f.deps.now = () => now;
  const client = new GitHubClient(getConfig(f.root, {}), f.env, f.deps);
  const path = join(f.env.XDG_STATE_HOME, "vmethod", "example-state", "writes.jsonl");
  mkdirSync(join(f.env.XDG_STATE_HOME, "vmethod", "example-state"), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ at: new Date(now - 86_400_001).toISOString(), kind: "closed", repo: "example/project", number: 6 })}\n`
  );
  await client.rest("/repos/example/project/issues/6");
  await client.rest("/repos/example/project/issues/6/assignees", "DELETE", {
    assignees: ["OWNER"],
  });
  await client.rest("/repos/example/project/issues/6", "PATCH", { state: "closed" });
  await expect(
    client.rest("/repos/example/project/issues/6", "PATCH", { state: "closed" })
  ).rejects.toThrow("403");
  await client.rest("/repos/example/project/issues/6/comments", "POST", {
    body: "text never stored",
  });
  await client.rest("/repos/example/project/pulls/6/merge", "PUT", {});
  const entries = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(entries.map((entry) => entry.kind)).toEqual(["unassigned", "closed", "comment", "merged"]);
  expect(readFileSync(path, "utf8")).not.toContain("text never stored");
  const event = {
    kind: "unassigned",
    repo: "example/project",
    number: 6,
    field: "Assignee",
    value: "owner",
  };
  expect(client.writes.matches(event, new Date(now + 120_000).toISOString())).toBe(true);
  expect(client.writes.matches(event, new Date(now + 120_001).toISOString())).toBe(false);
  expect(client.writes.matches({ ...event, value: "worker" }, new Date(now).toISOString())).toBe(
    false
  );
  expect(client.writes.matches({ ...event, number: 7 }, new Date(now).toISOString())).toBe(false);
  expect(client.writes.matches({ ...event, kind: "assigned" }, new Date(now).toISOString())).toBe(
    false
  );
  expect(client.writes.matches(event, "")).toBe(false);
  now += 86_400_001;
  expect(client.writes.matches(event, entries[0].at)).toBe(false);
  f.done();
});

test.each([{ WATCH_ONLY: "8,6,8" }, { WATCH_SKIP: "8 6" }, {}])(
  "write scopes share watcher naming and keep journals isolated: %j",
  async (scope) => {
    const f = fixtureServer([{ path: "/repos/example/project/issues/6/comments", json: {} }]);
    const config = getConfig(f.root, {});
    const client = new GitHubClient(config, { ...f.env, ...scope }, f.deps);
    await client.rest("/repos/example/project/issues/6/comments", "POST", { body: "Comment" });
    expect(
      client.writes.matches(
        { kind: "comment", repo: "example/project", number: 6 },
        new Date(f.deps.now()).toISOString()
      )
    ).toBe(true);
    const other = new GitHubClient(
      { ...config, stateName: "other-session" },
      { ...f.env, ...scope },
      f.deps
    );
    expect(
      other.writes.matches(
        { kind: "comment", repo: "example/project", number: 6 },
        new Date(f.deps.now()).toISOString()
      )
    ).toBe(false);
    f.done();
  }
);

test("journal errors are loud, never interpreted as an empty successful read", async () => {
  const f = fixtureServer([{ path: "/repos/example/project/issues/6/comments", json: {} }]);
  const client = new GitHubClient(getConfig(f.root, {}), f.env, f.deps);
  const dir = join(f.env.XDG_STATE_HOME, "vmethod", "example-state");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "writes.jsonl"), "broken\n");
  expect(() =>
    client.writes.matches(
      { kind: "comment", repo: "example/project", number: 6 },
      new Date(f.deps.now()).toISOString()
    )
  ).toThrow();
  writeFileSync(join(dir, "writes.jsonl.lock"), "active writer");
  await expect(client.rest("/repos/example/project/issues/6/comments", "POST", {})).rejects.toThrow(
    "journal"
  );
  f.done();
});

test("a dead process's old journal lock is reclaimed", async () => {
  const f = fixtureServer([{ path: "/repos/example/project/issues/6/comments", json: {} }]);
  const client = new GitHubClient(getConfig(f.root, {}), f.env, f.deps);
  const dir = join(f.env.XDG_STATE_HOME, "vmethod", "example-state");
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, "writes.jsonl.lock");
  writeFileSync(lock, "2147483647");
  const old = new Date(Date.now() - 10_000);
  utimesSync(lock, old, old);
  await client.rest("/repos/example/project/issues/6/comments", "POST", {});
  expect(readFileSync(join(dir, "writes.jsonl"), "utf8")).toContain('"kind":"comment"');
  f.done();
});

test("a brief journal lock contention is waited out", async () => {
  const f = fixtureServer([{ path: "/repos/example/project/issues/6/comments", json: {} }]);
  const client = new GitHubClient(getConfig(f.root, {}), f.env, f.deps);
  const dir = join(f.env.XDG_STATE_HOME, "vmethod", "example-state");
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, "writes.jsonl.lock");
  writeFileSync(lock, String(process.pid));
  const child = spawn(
    process.execPath,
    ["-e", 'setTimeout(() => require("node:fs").unlinkSync(process.argv[1]), 150)', lock],
    { stdio: "ignore" }
  );
  child.unref();
  await client.rest("/repos/example/project/issues/6/comments", "POST", {});
  expect(readFileSync(join(dir, "writes.jsonl"), "utf8")).toContain('"kind":"comment"');
  f.done();
});
