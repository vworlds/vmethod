import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parse, visit } from "graphql";
import { createGateway } from "../../src/gateway/server.js";
import { fixtureServer, graph, type Request } from "./helpers.js";
import { scopeIssue } from "./scope-fixture.js";
import { gatewayVerb } from "../../src/cli/gateway.js";
import type { ObjectData } from "../../src/gateway/people.js";

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

/** The sub-issue's own parent read: structural fields only, keyed by the same repository query. */
function parentQuery(childNumber: number, parent: ObjectData | null): Request {
  return {
    path: "/graphql",
    json: { data: { repository: { issue: { parent } } } },
    checkQuery(query, variables) {
      expect(queriedFields(query)).toEqual([
        "repository",
        "issue",
        "parent",
        "id",
        "number",
        "repository",
        "nameWithOwner",
      ]);
      expect(variables).toEqual({ owner: "example", name: "project", number: childNumber });
    },
  };
}

/** The epic's node id is resolved through a repository query, not the accept-filtered thread read. */
function epicNodeQuery(owner: string, name: string, number: number, id: string): Request {
  return {
    path: "/graphql",
    json: { data: { repository: { issue: { id } } } },
    checkQuery(query, variables) {
      expect(queriedFields(query)).toEqual(["repository", "issue", "id"]);
      expect(variables).toEqual({ owner, name, number });
    },
  };
}

/** GitHub's sub-issue relation mutation; `issueId` is the epic, `subIssueId` the child. */
function subIssueMutation(
  mutation: "addSubIssue" | "removeSubIssue",
  issueId: string,
  subIssueId: string
): Request {
  return {
    path: "/graphql",
    json: {
      data: { [mutation]: { issue: { number: 379 }, subIssue: { number: 8 } } },
    },
    checkQuery(query, variables) {
      const names = queriedFields(query);
      expect(names).toContain(mutation);
      expect(names).not.toContain(mutation === "addSubIssue" ? "removeSubIssue" : "addSubIssue");
      expect(variables).toEqual({ issueId, subIssueId });
    },
  };
}

const epicParent = {
  id: "epic-node",
  number: 379,
  repository: { nameWithOwner: "example/project" },
};
const otherParent = {
  id: "other-node",
  number: 400,
  repository: { nameWithOwner: "example/project" },
};

test("issue parent attaches a sub-issue to a same-repository epic through addSubIssue", async () => {
  const f = fixtureServer([
    graph({ repository: { issue: issue() } }),
    graph({ node: issue() }),
    parentQuery(8, null),
    epicNodeQuery("example", "project", 379, "epic-node"),
    subIssueMutation("addSubIssue", "epic-node", "node-1"),
  ]);
  await expect(
    gatewayVerb(f.transport, "issue", ["parent", "8", "#379"], { VMETHOD_ROLE: "orchestrator" })
  ).resolves.toBe("Added sub-issue #8 to epic #379");
  f.done();
});

test("issue parent is a read-only no-op when the issue is already attached to that epic", async () => {
  const f = fixtureServer([
    graph({ repository: { issue: issue() } }),
    graph({ node: issue() }),
    parentQuery(8, epicParent),
  ]);
  await expect(f.transport.call("issueParent", { ref: "8", epic: "#379" })).resolves.toBe(
    "Issue #8 is already a sub-issue of epic #379; nothing attached"
  );
  f.done();
});

test("issue parent refuses an issue already parented elsewhere before any write", async () => {
  const f = fixtureServer([
    graph({ repository: { issue: issue() } }),
    graph({ node: issue() }),
    parentQuery(8, otherParent),
  ]);
  await expect(f.transport.call("issueParent", { ref: "8", epic: "#379" })).rejects.toThrow(
    "Issue #8 is already a sub-issue of #400; detach it before re-attaching"
  );
  f.done();
});

test("issue unparent removes the sub-issue relation through removeSubIssue", async () => {
  const f = fixtureServer([
    graph({ repository: { issue: issue() } }),
    graph({ node: issue() }),
    parentQuery(8, epicParent),
    epicNodeQuery("example", "project", 379, "epic-node"),
    subIssueMutation("removeSubIssue", "epic-node", "node-1"),
  ]);
  await expect(f.transport.call("issueUnparent", { ref: "8", epic: "379" })).resolves.toBe(
    "Removed sub-issue #8 from epic #379"
  );
  f.done();
});

test("issue unparent is a read-only no-op when the sub-issue has no parent", async () => {
  const f = fixtureServer([
    graph({ repository: { issue: issue() } }),
    graph({ node: issue() }),
    parentQuery(8, null),
  ]);
  await expect(f.transport.call("issueUnparent", { ref: "8", epic: "#379" })).resolves.toBe(
    "Issue #8 is not a sub-issue of epic #379; nothing removed"
  );
  f.done();
});

test("issue unparent refuses when the sub-issue has a different parent", async () => {
  const f = fixtureServer([
    graph({ repository: { issue: issue() } }),
    graph({ node: issue() }),
    parentQuery(8, otherParent),
  ]);
  await expect(f.transport.call("issueUnparent", { ref: "8", epic: "#379" })).rejects.toThrow(
    "Issue #8 is not a sub-issue of epic #379; it is a sub-issue of #400"
  );
  f.done();
});

test.each(["issueParent", "issueUnparent"] as const)(
  "%s refuses a cross-repository epic before any write",
  async (operation) => {
    const f = fixtureServer([]);
    await expect(
      f.transport.call(operation, { ref: "8", epic: "example/other#7" })
    ).rejects.toThrow("Sub-issue parent must be in the configured repository, not example/other#7");
    f.done();
  }
);

test("issue unparent refuses a parent outside the configured org before any write", async () => {
  const f = fixtureServer([]);
  await expect(
    f.transport.call("issueParent", { ref: "8", epic: "others/project#7" })
  ).rejects.toThrow("Repository is outside configured org");
  f.done();
});

test.each(["issueParent", "issueUnparent"] as const)(
  "%s is denied to workers before reading a file or calling GitHub",
  async (operation) => {
    const f = fixtureServer([]);
    await expect(
      f.gateway.call(operation, { ref: "8", epic: "#379" }, { role: "worker", taskPr: 140 })
    ).rejects.toThrow("denied for client role");
    f.done();
  }
);

test("issue create --parent attaches the created issue to a configured-repository epic", async () => {
  const f = fixtureServer([
    {
      path: "/repos/example/project/issues",
      body: { title: "A title", body: "A body\n", labels: [] },
      json: { number: 37, node_id: "issue-node-37" },
    },
    parentQuery(37, null),
    epicNodeQuery("example", "project", 342, "epic-node-342"),
    subIssueMutation("addSubIssue", "epic-node-342", "issue-node-37"),
  ]);
  const config = join(f.root, "vmethod.yaml");
  writeFileSync(config, readFileSync(config, "utf8").replace("enabled: true", "enabled: false"));
  const gateway = createGateway(f.root, f.env, f.deps);
  const file = join(f.root, "body.md");
  writeFileSync(file, "A body\n");
  await expect(
    gateway.call(
      "issueCreate",
      { title: "A title", file, parent: "#342" },
      { role: "orchestrator" }
    )
  ).resolves.toBe("Created issue #37; attached to epic #342");
  f.done();
}, 15000);

test("a failed create --parent attachment names the issue parent retry and keeps the issue", async () => {
  const f = fixtureServer([
    {
      path: "/repos/example/project/issues",
      json: { number: 37, node_id: "issue-node-37" },
    },
    parentQuery(37, null),
    epicNodeQuery("example", "project", 342, "epic-node-342"),
    { path: "/graphql", json: { errors: [{ message: "add refused" }] } },
  ]);
  const config = join(f.root, "vmethod.yaml");
  writeFileSync(config, readFileSync(config, "utf8").replace("enabled: true", "enabled: false"));
  const gateway = createGateway(f.root, f.env, f.deps);
  const file = join(f.root, "body.md");
  writeFileSync(file, "A body\n");
  await expect(
    gatewayVerb(gateway, "issue", ["create", "A title", file, "--parent", "#342"], {
      VMETHOD_ROLE: "orchestrator",
    })
  ).rejects.toThrow(
    /parent attachment failed[\s\S]*add refused[\s\S]*retry with: vmethod issue parent 37 #342/
  );
  expect(f.sleeps).toEqual([]);
  f.done();
}, 15000);

test.each([{ epic: "example/other#7" }, { epic: "others/project#7" }])(
  "issue create refuses a parent outside the configured repository before the create: %s",
  async ({ epic }) => {
    const f = fixtureServer([]);
    await expect(
      f.transport.call("issueCreate", { title: "A title", file: "must-not-read", parent: epic })
    ).rejects.toThrow();
    f.done();
  }
);

test("issue parent and create --parent reject bad argument shapes through the CLI", async () => {
  const f = fixtureServer([]);
  await expect(
    gatewayVerb(f.transport, "issue", ["parent", "8"], { VMETHOD_ROLE: "orchestrator" })
  ).rejects.toThrow("issue parent <n> <epic>");
  await expect(
    gatewayVerb(f.transport, "issue", ["unparent", "8", "#379", "extra"], {
      VMETHOD_ROLE: "orchestrator",
    })
  ).rejects.toThrow("issue unparent <n> <epic>");
  const file = join(f.root, "body.md");
  writeFileSync(file, "A body\n");
  await expect(
    gatewayVerb(f.transport, "issue", ["create", "Title", file, "--parent"], {
      VMETHOD_ROLE: "orchestrator",
    })
  ).rejects.toThrow("--parent epic");
  f.done();
}, 15000);
