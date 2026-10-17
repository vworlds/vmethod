import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { getConfig } from "../../src/config.js";
import { GitHubClient } from "../../src/gateway/client.js";
import { fixtureServer } from "./helpers.js";
import boardRecording from "../fixtures/github/board-write-inputs.json" with { type: "json" };

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
