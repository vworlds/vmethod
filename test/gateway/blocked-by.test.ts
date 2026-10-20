import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parse, visit } from "graphql";
import { createGateway } from "../../src/gateway/server.js";
import { fixtureServer, graph, type Request } from "./helpers.js";
import { scopeIssue } from "./scope-fixture.js";

const issue = () => scopeIssue({ state: "OPEN" });

function queriedFields(query: string): string[] {
  const names: string[] = [];
  visit(parse(query), {
    Field(node) {
      names.push(node.name.value);
    },
  });
  return names;
}

/** The blocker's node is resolved through a repository query, not the accept-filtered thread read. */
function issueNodeQuery(owner: string, name: string, number: number, id: string): Request {
  return {
    path: "/graphql",
    json: { data: { repository: { issue: { id } } } },
    checkQuery(query, variables) {
      expect(queriedFields(query)).toEqual(["repository", "issue", "id"]);
      expect(variables).toEqual({ owner, name, number });
    },
  };
}

function blockedByMutation(
  mutation: "addBlockedBy" | "removeBlockedBy",
  issueId: string,
  blockingIssueId: string
): Request {
  return {
    path: "/graphql",
    json: {
      data: { [mutation]: { issue: { number: 8 }, blockingIssue: { number: 379 } } },
    },
    checkQuery(query, variables) {
      const names = queriedFields(query);
      expect(names).toContain(mutation);
      expect(names).not.toContain(mutation === "addBlockedBy" ? "removeBlockedBy" : "addBlockedBy");
      expect(variables).toEqual({ issueId, blockingIssueId });
    },
  };
}

const refused = "dependencies go in the blocked-by relation: vmethod issue block <n> <blocker>";

test("issue block writes the blocked-by relation to an issue in the same repository", async () => {
  const f = fixtureServer([
    graph({ repository: { issue: issue() } }),
    graph({ node: issue() }),
    issueNodeQuery("example", "project", 379, "blocker-node"),
    blockedByMutation("addBlockedBy", "node-1", "blocker-node"),
  ]);
  await expect(f.transport.call("issueBlock", { ref: "8", blocker: "#379" })).resolves.toBe(
    "Blocked #8 by #379"
  );
  f.done();
});

test("issue block accepts cross-repository blockers in the configured org", async () => {
  const f = fixtureServer([
    graph({ repository: { issue: issue() } }),
    graph({ node: issue() }),
    issueNodeQuery("example", "other", 7, "blocker-node"),
    blockedByMutation("addBlockedBy", "node-1", "blocker-node"),
  ]);
  await expect(
    f.transport.call("issueBlock", { ref: "8", blocker: "example/other#7" })
  ).resolves.toBe("Blocked #8 by example/other#7");
  f.done();
});

test("issue unblock clears the blocked-by relation", async () => {
  const f = fixtureServer([
    graph({ repository: { issue: issue() } }),
    graph({ node: issue() }),
    issueNodeQuery("example", "project", 379, "blocker-node"),
    blockedByMutation("removeBlockedBy", "node-1", "blocker-node"),
  ]);
  await expect(f.transport.call("issueUnblock", { ref: "8", blocker: "379" })).resolves.toBe(
    "Unblocked #8 from #379"
  );
  f.done();
});

test("issue unblock clears a cross-repository blocked-by relation", async () => {
  const f = fixtureServer([
    graph({ repository: { issue: issue() } }),
    graph({ node: issue() }),
    issueNodeQuery("example", "other", 7, "blocker-node"),
    blockedByMutation("removeBlockedBy", "node-1", "blocker-node"),
  ]);
  await expect(
    f.transport.call("issueUnblock", { ref: "8", blocker: "example/other#7" })
  ).resolves.toBe("Unblocked #8 from example/other#7");
  f.done();
});

test.each([
  { blocker: "#379", issue: null, label: "#379" },
  { blocker: "example/other#7", issue: {}, label: "example/other#7" },
])(
  "issue block refuses a missing blocker $blocker before any write",
  async ({ blocker, issue: missing, label }) => {
    const f = fixtureServer([
      graph({ repository: { issue: issue() } }),
      graph({ node: issue() }),
      { path: "/graphql", json: { data: { repository: { issue: missing } } } },
    ]);
    await expect(f.transport.call("issueBlock", { ref: "8", blocker })).rejects.toThrow(
      `Blocker issue not found: ${label}`
    );
    f.done();
  }
);

test.each(["issueBlock", "issueUnblock"] as const)(
  "%s is denied to workers before reading a file or calling GitHub",
  async (operation) => {
    const f = fixtureServer([]);
    await expect(
      f.gateway.call(operation, { ref: "8", blocker: "#379" }, { role: "worker", taskPr: 140 })
    ).rejects.toThrow("denied for client role");
    f.done();
  }
);

test.each([
  "**Blocked by #379**",
  "- Depends on #12",
  "blocked by #3",
  "- blocked by example/other#7",
])("issue create refuses a dependency-only body line before writing: %s", async (line) => {
  const f = fixtureServer([]);
  const file = join(f.root, "body.md");
  writeFileSync(file, `Context.\n${line}\n`);
  await expect(f.transport.call("issueCreate", { title: "Title", file })).rejects.toThrow(refused);
  f.done();
});

test("issue edit refuses a dependency-only body before any read or write", async () => {
  const f = fixtureServer([]);
  const file = join(f.root, "body.md");
  writeFileSync(file, "- Depends on #12");
  await expect(f.transport.call("issueEdit", { ref: "8", file })).rejects.toThrow(refused);
  f.done();
});

test("a body that only mentions an issue passes create", async () => {
  const f = fixtureServer([
    {
      path: "/repos/example/project/issues",
      json: { number: 37, node_id: "node-37" },
    },
  ]);
  const config = join(f.root, "vmethod.yaml");
  writeFileSync(config, readFileSync(config, "utf8").replace("enabled: true", "enabled: false"));
  const gateway = createGateway(f.root, f.env, f.deps);
  const file = join(f.root, "body.md");
  writeFileSync(
    file,
    "Uses the API from #379 (blocked by it earlier).\nDepends on the parser: see #12."
  );
  await expect(
    gateway.call("issueCreate", { title: "Title", file }, { role: "orchestrator" })
  ).resolves.toBe("Created issue #37");
  f.done();
}, 15000);

test("a body that only mentions an issue passes edit", async () => {
  const issueData = issue();
  const body = "Uses the API from #379 (blocked by it earlier).";
  const f = fixtureServer([
    graph({ repository: { issue: issueData } }),
    graph({ node: issueData }),
    graph({
      node: { ...issueData, comments: { nodes: [], pageInfo: { hasNextPage: false } } },
    }),
    graph({ repository: { issue: issueData } }),
    graph({ node: issueData }),
    { path: "/repos/example/project/issues/8", method: "PATCH", body: { body }, json: {} },
  ]);
  const file = join(f.root, "body.md");
  writeFileSync(file, body);
  await f.transport.call("read", { kind: "issue", ref: "8" });
  await expect(f.transport.call("issueEdit", { ref: "8", file })).resolves.toBe("Updated issue #8");
  f.done();
});
