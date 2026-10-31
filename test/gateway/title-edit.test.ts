import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { gatewayVerb } from "../../src/cli/gateway.js";
import { taskFlowVerb } from "../../src/cli/task-flow.js";
import { bodyHash } from "../../src/evidence/scope.js";
import { fixtureServer, graph, item } from "./helpers.js";

test.each(["issue", "pr"] as const)(
  "%s title-only edit preserves the body and journals the verb",
  async (kind) => {
    const thread = item({
      number: 8,
      __typename: kind === "pr" ? "PullRequest" : "Issue",
      body: "Original body",
      labels: { nodes: [], pageInfo: { hasNextPage: false } },
    });
    const endpoint = kind === "pr" ? "pulls" : "issues";
    const f = fixtureServer([
      graph({ repository: { [kind === "pr" ? "pullRequest" : "issue"]: thread } }),
      graph({ node: thread }),
      {
        path: `/repos/example/project/${endpoint}/8`,
        method: "PATCH",
        body: { title: "New title" },
        json: {},
      },
    ]);
    // A title edit must neither require nor refresh the body-read snapshot.
    mkdirSync(join(f.root, ".tmp"));
    const snapshot = join(f.root, ".tmp/issue-read-8.sha256");
    writeFileSync(snapshot, bodyHash("Older read"));
    const run = kind === "pr" ? taskFlowVerb : gatewayVerb;
    await expect(
      run(f.transport, kind, ["edit", "8", "--title", "New title"], {
        VMETHOD_ROLE: "orchestrator",
      })
    ).resolves.toContain("#8");
    expect(readFileSync(snapshot, "utf8")).toBe(bodyHash("Older read"));
    const entries = readFileSync(
      join(f.env.XDG_STATE_HOME, "vmethod/example-state/writes.jsonl"),
      "utf8"
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries).toContainEqual(
      expect.objectContaining({ kind: "operation", op: `${kind} edit`, number: 8 })
    );
    f.done();
  }
);

test("pr edit writes body and title together", async () => {
  const thread = item({
    __typename: "PullRequest",
    number: 8,
    body: "Old body",
    labels: { nodes: [], pageInfo: { hasNextPage: false } },
  });
  const f = fixtureServer([
    graph({ repository: { pullRequest: thread } }),
    graph({ node: thread }),
    {
      path: "/repos/example/project/pulls/8",
      method: "PATCH",
      body: { body: "New body", title: "New title" },
      json: {},
    },
  ]);
  const file = join(f.root, "body.md");
  writeFileSync(file, "New body");
  await taskFlowVerb(f.transport, "pr", ["edit", "8", file, "--title", "New title"], {
    VMETHOD_ROLE: "orchestrator",
  });
  f.done();
});

test.each(["issueEdit", "prEdit"] as const)(
  "%s validates title and required content before writes",
  async (operation) => {
    const f = fixtureServer([]);
    const file = join(f.root, "body.md");
    writeFileSync(file, "Valid body");
    for (const title of ["Fixes #12", "Resolves example/project#12"]) {
      await expect(f.transport.call(operation, { ref: "8", title })).rejects.toThrow(
        "forbidden closing keyword"
      );
      await expect(f.transport.call(operation, { ref: "8", file, title })).rejects.toThrow(
        "forbidden closing keyword"
      );
    }
    for (const title of ["", "   ", "Line\nbreak", "Bad\0title"]) {
      await expect(f.transport.call(operation, { ref: "8", title })).rejects.toThrow();
    }
    await expect(f.transport.call(operation, { ref: "8" })).rejects.toThrow("requires a body file");
    await expect(
      f.transport.call(operation, { ref: "8", title: "Title" }, { role: "worker", taskPr: 8 })
    ).rejects.toThrow("denied for client role");
    f.done();
  }
);

test("title-only issue edits cannot pair scope review without a body", async () => {
  const f = fixtureServer([]);
  await expect(
    f.transport.call("issueEdit", { ref: "8", title: "Title", scopeReview: "missing.md" })
  ).rejects.toThrow("--scope-review requires a body file");
  await expect(
    gatewayVerb(
      f.transport,
      "issue",
      ["edit", "8", "--title", "Title", "--scope-review", "summary.md"],
      { VMETHOD_ROLE: "orchestrator" }
    )
  ).rejects.toThrow("--scope-review requires a body file");
  f.done();
});

test.each(["issue", "pr"] as const)("%s edit refuses malformed title arguments", async (kind) => {
  const f = fixtureServer([]);
  const run = kind === "pr" ? taskFlowVerb : gatewayVerb;
  for (const args of [
    ["edit", "8"],
    ["edit", "8", "--title"],
    ["edit", "8", "--title", "A", "--title", "B"],
    ["edit", "8", "a.md", "b.md"],
    ["edit", "8", "--unknown", "A"],
  ]) {
    await expect(run(f.transport, kind, args, { VMETHOD_ROLE: "orchestrator" })).rejects.toThrow();
  }
  f.done();
});
