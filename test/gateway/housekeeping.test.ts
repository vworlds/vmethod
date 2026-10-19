import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { actor, fixtureServer, graph, item } from "./helpers.js";
import { gatewayVerb } from "../../src/cli/gateway.js";
import { createGateway } from "../../src/gateway/server.js";
import issueResponse from "../fixtures/github/issue-response.json" with { type: "json" };
import boardRecording from "../fixtures/github/board-write-inputs.json" with { type: "json" };
import { WatchFake } from "./watch-fake.js";
import { bodyHash } from "../../src/gateway/scope.js";

test("scope-review publishes the body hash and hands the issue card to the owner without editing the body", async () => {
  const recording = structuredClone(boardRecording);
  const card = recording.items.nodes[0];
  const status = recording.fields.nodes.find((field) => field.name === "Status")!;
  const option = status.options![0];
  option.name = "In review";
  const issue = { ...acceptedIssue(), id: card.content.id };
  const summary = "- Folded the agreed acceptance cases into the body.";
  const f = fixtureServer([
    graph({ repository: { issue: item({ id: issue.id }) } }),
    graph({ node: issue }),
    graph({
      node: item({
        id: issue.id,
        assignees: { nodes: [{ login: "peer" }], pageInfo: { hasNextPage: false } },
      }),
    }),
    {
      path: "/repos/example/project/issues/39/comments",
      body: {
        body: `[orchestrator] SCOPE REVIEW\n\nI have updated the main body to the final scope.\n\n${summary}\n\nbody sha256: ${bodyHash("Specification")}`,
      },
      json: {},
    },
    ...boardReads(recording),
    {
      path: "/graphql",
      json: {
        data: { m0: { projectV2Item: { id: card.id } }, m1: { projectV2Item: { id: card.id } } },
      },
      checkQuery(_query, variables) {
        expect(
          Object.values(variables).map((value) => (value as { value: unknown }).value)
        ).toEqual([undefined, { singleSelectOptionId: option.id }]);
      },
    },
    ...boardReads(recording),
    {
      path: "/graphql",
      json: { data: { m0: { projectV2Item: { id: card.id } } } },
      checkQuery(_query, variables) {
        expect(
          Object.values(variables).map((value) => (value as { value: unknown }).value)
        ).toEqual([{ text: "👤🔍" }]);
      },
    },
    {
      path: "/repos/example/project/issues/39/assignees",
      method: "DELETE",
      body: { assignees: ["peer"] },
      json: {},
    },
    {
      path: "/repos/example/project/issues/39/assignees",
      method: "POST",
      body: { assignees: ["owner"] },
      json: {},
    },
  ]);
  const file = join(f.root, "scope-summary.md");
  writeFileSync(file, summary);
  await expect(
    gatewayVerb(f.transport, "scope-review", ["39", file], { VMETHOD_ROLE: "orchestrator" })
  ).resolves.toBe("Scope review requested for #39");
  f.done();
});

test.each(
  ["issue create", "issue close", "board set"].flatMap((verb) =>
    [false, true].map((owner) => ({ verb, owner }))
  )
)(
  "$verb then watch --once (owner=$owner)",
  async ({ verb, owner }) => {
    const recording = verb === "issue create" ? createdCard() : structuredClone(boardRecording);
    const card = recording.items.nodes[0];
    if (verb === "issue close") {
      card.fieldValues.nodes.push({ text: "👤❓", field: { name: "Progress" } } as never);
    }
    const metadata = [
      graph({ repository: { issue: item({ id: card.content.id }) } }),
      graph({ node: { ...acceptedIssue(), id: card.content.id } }),
    ];
    const mutation = boardGraph({
      m0: { projectV2Item: { id: card.id } },
      m1: { projectV2Item: { id: card.id } },
    });
    const requests =
      verb === "issue create"
        ? [
            {
              path: "/repos/example/project/issues",
              json: { number: issueResponse.number, node_id: issueResponse.node_id },
            },
            ...createBoardReads(recording),
            ...boardReads(recording),
            mutation,
          ]
        : verb === "issue close"
          ? [
              ...metadata,
              {
                path: `/repos/example/project/issues/${card.content.number}`,
                method: "PATCH",
                json: { number: card.content.number, node_id: card.content.id, state: "closed" },
              },
              ...boardReads(recording),
              mutation,
              ...boardReads(recording),
              boardGraph({ m0: { projectV2Item: { id: card.id } } }),
            ]
          : [...metadata, ...boardReads(recording), mutation];
    const f = fixtureServer(requests);
    const w = new WatchFake();
    try {
      w.attachWriter(f);
      if (owner) {
        w.config.stateName = "observer-session";
        w.dir = join(f.env.XDG_STATE_HOME, "vmethod", "observer-session");
      }
      if (verb !== "issue create") {
        const observed = w.card(card.content.number, "In progress");
        observed.id = card.id;
        w.cards = [observed];
        w.issues = [{ number: card.content.number, labels: [] }];
      }
      const loop = w.loop();
      const once = () => w.once(loop);
      expect(await once()).toEqual([]);
      // Keep the gateway's injected clock and GitHub value timestamps aligned.
      const file = join(f.root, ".tmp", "issue.md");
      mkdirSync(join(f.root, ".tmp"), { recursive: true });
      writeFileSync(file, "Body\n");
      if (verb === "issue create") {
        await gatewayVerb(f.transport, "issue", ["create", "Title", file, "--status", "Done"], {
          VMETHOD_ROLE: "orchestrator",
        });
      } else if (verb === "issue close") {
        await gatewayVerb(f.transport, "issue", ["close", String(card.content.number)], {
          VMETHOD_ROLE: "orchestrator",
        });
      } else {
        await gatewayVerb(
          f.transport,
          "board",
          ["set", String(card.content.number), "Status", "Done"],
          { VMETHOD_ROLE: "orchestrator" }
        );
      }
      const events = await once();
      if (owner) {
        expect(events.map((event) => event.kind)).toEqual(["board"]);
      } else {
        expect(events).toEqual([]);
      }
      expect(w.reports).toEqual([]);
      f.done();
    } finally {
      w.done();
    }
  },
  15000
);

const acceptedIssue = () =>
  item({
    state: "OPEN",
    title: "Issue",
    body: "Specification",
    labels: { nodes: [], pageInfo: { hasNextPage: false } },
  });

test.each(["Progress", "Estimate"])(
  "board set %s then --clear leaves the field empty",
  async (field) => {
    const card = boardRecording.items.nodes[0];
    const fieldId = boardRecording.fields.nodes.find((entry) => entry.name === field)!.id;
    const value = field === "Progress" ? "👤❓" : "5";
    let stored: string | number | null = null;
    const metadata = () => [
      graph({ repository: { issue: item({ id: card.content.id }) } }),
      graph({ node: { ...acceptedIssue(), id: card.content.id } }),
      ...boardReads(),
    ];
    const f = fixtureServer([
      ...metadata(),
      {
        path: "/graphql",
        checkQuery(query, variables) {
          expect(query).toContain("updateProjectV2ItemFieldValue");
          expect(variables).toEqual({
            m0: {
              projectId: boardRecording.id,
              itemId: card.id,
              fieldId,
              value: field === "Progress" ? { text: value } : { number: 5 },
            },
          });
          stored = field === "Progress" ? value : 5;
        },
        json: { data: { m0: { projectV2Item: { id: card.id } } } },
      },
      ...metadata(),
      {
        path: "/graphql",
        checkQuery(query, variables) {
          expect(query).toContain("clearProjectV2ItemFieldValue");
          expect(variables).toEqual({
            m0: { projectId: boardRecording.id, itemId: card.id, fieldId },
          });
          stored = null;
        },
        json: { data: { m0: { projectV2Item: { id: card.id } } } },
      },
    ]);
    const env = { VMETHOD_ROLE: "orchestrator" };
    await gatewayVerb(f.transport, "board", ["set", "39", field, value], env);
    expect(stored).toBe(field === "Progress" ? value : 5);
    await gatewayVerb(f.transport, "board", ["set", "39", field, "--clear"], env);
    expect(stored).toBeNull();
    f.done();
  },
  15000
);

test.each(["Status", "Model", "Missing"])(
  "board set %s --clear refuses unsupported clears before mutation",
  async (field) => {
    const card = boardRecording.items.nodes[0];
    const f = fixtureServer([
      graph({ repository: { issue: item({ id: card.content.id }) } }),
      graph({ node: { ...acceptedIssue(), id: card.content.id } }),
    ]);
    await expect(
      gatewayVerb(f.transport, "board", ["set", "39", field, "--clear"], {
        VMETHOD_ROLE: "orchestrator",
      })
    ).rejects.toThrow("Only Progress and Estimate support --clear");
    f.done();
  },
  15000
);

test.each(["Progress", "Estimate"])(
  "board set %s rejects an accidental empty string",
  async (field) => {
    const card = boardRecording.items.nodes[0];
    const f = fixtureServer([
      graph({ repository: { issue: item({ id: card.content.id }) } }),
      graph({ node: { ...acceptedIssue(), id: card.content.id } }),
    ]);
    await expect(
      gatewayVerb(f.transport, "board", ["set", "39", field, ""], { VMETHOD_ROLE: "orchestrator" })
    ).rejects.toThrow("Invalid board field/value");
    f.done();
  },
  15000
);

test("issue create sends validated file content and repeated labels to the configured repository", async () => {
  const recording = createdCard();
  const f = fixtureServer([
    {
      path: "/repos/example/project/issues",
      body: { title: "A title", body: "A body\n", labels: ["bug", "task"] },
      json: { number: issueResponse.number, node_id: issueResponse.node_id },
    },
    ...createBoardReads(recording),
    graph({ repository: { issue: item({ id: issueResponse.node_id }) } }),
    graph({ node: { ...acceptedIssue(), id: issueResponse.node_id } }),
    ...boardReads(recording),
    boardGraph({ m0: { projectV2Item: { id: recording.items.nodes[0].id } } }),
  ]);
  const file = join(f.root, "body.md");
  writeFileSync(file, "A body\n");
  expect(
    await gatewayVerb(
      f.transport,
      "issue",
      ["create", "A title", file, "--label", "bug", "--label", "task"],
      { VMETHOD_ROLE: "orchestrator" }
    )
  ).toBe("Created issue #37");
  expect(
    await f.transport.call("boardSetIssue", { ref: "37", field: "Estimate", value: "5" })
  ).toBe("Board field updated");
  f.done();
}, 15000);

function createdCard() {
  const recording = structuredClone(boardRecording);
  recording.items.nodes[0].content.id = issueResponse.node_id;
  recording.items.nodes[0].content.number = issueResponse.number;
  return recording;
}

const boardGraph = (data: unknown) => ({ path: "/graphql", json: { data } });

function createBoardReads(recording = createdCard(), lag = 0) {
  const card = recording.items.nodes[0];
  return [
    ...boardReads(recording).slice(0, 2),
    boardGraph({ node: { __typename: "Issue", repository: { nameWithOwner: "example/project" } } }),
    {
      ...boardGraph({ addProjectV2ItemById: { item: { id: card.id } } }),
      checkQuery(query: string, variables: unknown) {
        expect(query).toContain("mutation BoardAdd");
        expect(variables).toEqual({
          input: { projectId: recording.id, contentId: issueResponse.node_id },
        });
      },
    },
    ...boardReads(recording).slice(0, 2),
    ...Array.from({ length: lag }, () =>
      boardGraph({
        node: { items: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      })
    ),
    ...boardReads(recording).slice(2),
  ];
}

test("issue create waits for board listing lag and applies optional estimate/status", async () => {
  const recording = createdCard();
  const card = recording.items.nodes[0];
  const f = fixtureServer([
    {
      path: "/repos/example/project/issues",
      json: { number: issueResponse.number, node_id: issueResponse.node_id },
    },
    ...createBoardReads(recording, 1),
    ...boardReads(recording),
    {
      ...boardGraph({ m0: { projectV2Item: { id: card.id } } }),
      checkQuery(query, variables) {
        expect(query).toContain("mutation BoardSetCards");
        expect(variables).toEqual({
          m0: {
            projectId: recording.id,
            itemId: card.id,
            fieldId: recording.fields.nodes.find((f) => f.name === "Estimate")!.id,
            value: { number: 0.5 },
          },
        });
      },
    },
    ...boardReads(recording),
    {
      ...boardGraph({
        m0: { projectV2Item: { id: card.id } },
        m1: { projectV2Item: { id: card.id } },
      }),
      checkQuery(query, variables) {
        expect(query).toContain("mutation BoardSetCards");
        expect(variables).toEqual({
          m0: {
            projectId: recording.id,
            itemId: card.id,
            fieldId: recording.fields.nodes.find((f) => f.name === "Progress")!.id,
          },
          m1: {
            projectId: recording.id,
            itemId: card.id,
            fieldId: recording.fields.nodes.find((f) => f.name === "Status")!.id,
            value: { singleSelectOptionId: "5acf990d" },
          },
        });
      },
    },
  ]);
  const file = join(f.root, "body.md");
  writeFileSync(file, "Body");
  expect(
    await gatewayVerb(
      f.transport,
      "issue",
      ["create", "Title", file, "--estimate", "0.5", "--status", "In progress"],
      { VMETHOD_ROLE: "orchestrator" }
    )
  ).toBe("Created issue #37");
  expect(f.sleeps).toEqual([1000]);
  f.done();
}, 15000);

test.each([
  ["Estimate", "NaN", "Estimate must be one of"],
  ["Estimate", "1e999", "Estimate must be one of"],
  ["Estimate", "4", "0, 0.5, 1, 2, 3, 5, 8, 13, 20, 40, 100, 999"],
  ["Status", "Missing option", "Unknown Status option"],
  ["Progress", "text", "Invalid Progress"],
  ["Progress", "👤❓ junk", "Invalid Progress"],
  ["Progress", "👤❓ 🔁2", "Invalid Progress"],
  ["Progress", "👤❓ 🔴 🔴", "Invalid Progress"],
  ["Progress", "👤❓ 🔴 🔁2️⃣", "Invalid Progress"],
  ["Missing", "1", "single-select or number"],
])(
  "board set rejects %s=%s before mutation",
  async (field, value, message) => {
    const reads = boardReads();
    if (["Progress", "Missing"].includes(field)) {
      reads.pop();
    }
    const contentId = boardRecording.items.nodes[0].content.id;
    const f = fixtureServer([
      graph({ repository: { issue: item({ id: contentId }) } }),
      graph({ node: { ...acceptedIssue(), id: contentId } }),
      ...reads,
    ]);
    await expect(
      gatewayVerb(f.transport, "board", ["set", value === "4" ? "1" : "39", field, value], {
        VMETHOD_ROLE: "orchestrator",
      })
    ).rejects.toThrow(message);
    f.done();
  },
  15000
);

test.each(["missing", "foreign", "PR"])(
  "board set refuses %s card without writing",
  async (reason) => {
    const recorded = structuredClone(boardRecording);
    const reads = boardReads(recorded);
    if (reason === "missing") {
      recorded.items.nodes = [];
    } else if (reason === "foreign") {
      recorded.items.nodes[0].content.repository.nameWithOwner = "example/foreign";
    } else {
      recorded.items.nodes[0].content.__typename = "PullRequest";
    }
    const contentId = boardRecording.items.nodes[0].content.id;
    const f = fixtureServer([
      graph({ repository: { issue: item({ id: contentId }) } }),
      graph({ node: { ...acceptedIssue(), id: contentId } }),
      ...reads,
    ]);
    await expect(
      f.transport.call("boardSetIssue", { ref: "39", field: "Estimate", value: "5" })
    ).rejects.toThrow(reason === "foreign" ? "foreign repository" : "not on configured board");
    f.done();
  },
  15000
);

test.each([
  ["issue", ["create", "Title", "file", "--label"]],
  ["issue", ["create", "Title", "file", "--estimate", "NaN"]],
  ["issue", ["create", "Title", "file", "--estimate", "-1"]],
  ["issue", ["create", "Title", "file", "--status", "Done", "--status", "Done"]],
  ["issue", ["close", "37", "--comment"]],
  ["issue", ["close", "37", "--wrong", "file"]],
  ["board", ["set", "39", "Estimate"]],
  ["board", ["set", "39", "Progress", "👤❓", "--clear"]],
  ["board", ["set", "39", "Estimate", "--clear", "5"]],
  ["board", ["set", "39", "Estimate", "5", "--repo", "foreign"]],
])(
  "housekeeping CLI rejects malformed %s arguments %j without networking",
  async (verb, args) => {
    const f = fixtureServer([]);
    await expect(
      gatewayVerb(f.transport, verb, args, { VMETHOD_ROLE: "orchestrator" })
    ).rejects.toThrow("Usage");
    f.done();
  },
  15000
);

test("issue close gates identity and posts the exact checked comment before closing", async () => {
  const recording = structuredClone(boardRecording);
  const card = recording.items.nodes[0];
  card.fieldValues.nodes.push({ text: "👤❓", field: { name: "Progress" } } as never);
  const f = fixtureServer([
    graph({ repository: { issue: item() } }),
    graph({ node: acceptedIssue() }),
    {
      path: "/repos/example/project/issues/37/comments",
      body: { body: "Reason for closure\n" },
      json: { id: 1 },
    },
    {
      path: "/repos/example/project/issues/37",
      method: "PATCH",
      body: { state: "closed", state_reason: "completed", assignees: [] },
      json: { ...issueResponse, node_id: card.content.id },
    },
    ...boardReads(recording),
    {
      ...boardGraph({
        m0: { projectV2Item: { id: card.id } },
        m1: { projectV2Item: { id: card.id } },
      }),
      checkQuery: (query, variables) => {
        expect(query).toContain("clearProjectV2ItemFieldValue");
        expect(variables.m0).toMatchObject({
          itemId: card.id,
          fieldId: recording.fields.nodes.find((field) => field.name === "Progress")!.id,
        });
        expect(variables.m1).toMatchObject({
          itemId: card.id,
          fieldId: recording.fields.nodes.find((field) => field.name === "Status")!.id,
          value: { singleSelectOptionId: expect.any(String) },
        });
      },
    },
    ...boardReads(recording),
    {
      ...boardGraph({ m0: { projectV2Item: { id: card.id } } }),
      checkQuery: (query, variables) => {
        expect(query).toContain("clearProjectV2ItemFieldValue");
        expect(variables.m0).toMatchObject({
          itemId: card.id,
          fieldId: recording.fields.nodes.find((field) => field.name === "Progress")!.id,
        });
      },
    },
  ]);
  const file = join(f.root, "comment.md");
  writeFileSync(file, "Reason for closure\n");
  expect(
    await gatewayVerb(f.transport, "issue", ["close", "37", "--comment", file], {
      VMETHOD_ROLE: "orchestrator",
    })
  ).toBe("Closed issue #37");
  f.done();
}, 15000);

test.each(["issueCreate", "issueClose", "boardSetIssue"] as const)(
  "%s denies workers before any network",
  async (operation) => {
    const f = fixtureServer([]);
    const inputs = {
      issueCreate: { title: "Title", file: "missing" },
      issueClose: { ref: "37" },
      boardSetIssue: { ref: "37", field: "Estimate", value: "5" },
    };
    await expect(
      f.transport.call(operation, inputs[operation], { role: "worker", taskPr: 40 })
    ).rejects.toThrow("denied");
    f.done();
  },
  15000
);

test.each(["issueClose", "boardSetIssue"] as const)(
  "%s rejects foreign references before networking",
  async (operation) => {
    const f = fixtureServer([]);
    await expect(
      f.transport.call(operation, { ref: "example/foreign#37", field: "Estimate", value: "5" })
    ).rejects.toThrow("configured repository");
    f.done();
  },
  15000
);

test.each(["issueClose", "boardSetIssue"] as const)(
  "%s filters unknown issue authors before requesting text",
  async (operation) => {
    const f = fixtureServer([
      graph({ repository: { issue: item({ author: { ...actor(), databaseId: 999 } }) } }),
    ]);
    await expect(
      f.transport.call(operation, { ref: "37", field: "Estimate", value: "5" })
    ).rejects.toThrow("accepted task thread");
    f.done();
  },
  15000
);

test.each(["issueCreate", "issueClose"] as const)(
  "%s refuses unsafe Markdown before mutations",
  async (operation) => {
    const f = fixtureServer([]);
    const file = join(f.root, "bad.md");
    writeFileSync(file, "Fixes #37\n");
    await expect(
      f.transport.call(operation, { ref: "37", title: "Title", file, comment: file })
    ).rejects.toThrow();
    f.done();
  },
  15000
);

function boardReads(recording = structuredClone(boardRecording)) {
  // Only repository scope is renamed to the offline test project's configured repository.
  recording.items.nodes[0].content.repository.nameWithOwner = "example/project";
  return [
    {
      path: "/graphql",
      json: {
        data: { organization: { projectV2: { id: recording.id, readme: recording.readme } } },
      },
    },
    { path: "/graphql", json: { data: { node: { fields: recording.fields } } } },
    { path: "/graphql", json: { data: { node: { items: recording.items } } } },
  ];
}

test("board mutation failure never records a completed Status move", async () => {
  const contentId = boardRecording.items.nodes[0].content.id;
  const f = fixtureServer([
    graph({ repository: { issue: item({ id: contentId }) } }),
    graph({ node: { ...acceptedIssue(), id: contentId } }),
    ...boardReads(),
    { path: "/graphql", json: { errors: [{ message: "write refused" }] } },
  ]);
  await expect(
    f.transport.call("boardSetIssue", { ref: "39", field: "Status", value: "Done" })
  ).rejects.toThrow("write refused");
  expect(() =>
    readFileSync(
      join(
        f.env.XDG_STATE_HOME,
        "vmethod",
        "example-state",
        "board",
        boardRecording.items.nodes[0].id
      )
    )
  ).toThrow();
  f.done();
}, 15000);

test("issue create reports failure without retrying a non-idempotent write", async () => {
  const f = fixtureServer([
    { path: "/repos/example/project/issues", status: 500, json: { message: "failed" } },
  ]);
  const file = join(f.root, "body.md");
  writeFileSync(file, "Body");
  await expect(f.transport.call("issueCreate", { title: "Title", file })).rejects.toThrow();
  expect(f.sleeps).toEqual([]);
  f.done();
}, 15000);

test("issue create bounds board visibility waiting and identifies the issue without recreating it", async () => {
  const requests = createBoardReads(createdCard(), 6);
  requests.pop(); // All six listing reads are absent; no successful seventh read.
  const f = fixtureServer([
    {
      path: "/repos/example/project/issues",
      json: { number: issueResponse.number, node_id: issueResponse.node_id },
    },
    ...requests,
  ]);
  const file = join(f.root, "body.md");
  writeFileSync(file, "Body");
  await expect(f.transport.call("issueCreate", { title: "Title", file })).rejects.toThrow(
    "Created issue #37; board follow-up failed: Board item not readable after 6 reads. Do not recreate"
  );
  expect(f.sleeps).toEqual([1000, 2000, 4000, 8000, 16000]);
  f.done();
}, 15000);

test.each([NaN, Infinity, -1, 4, 1.5])(
  "issue create rejects invalid estimate %s before networking",
  async (estimate) => {
    const f = fixtureServer([]);
    await expect(
      f.transport.call("issueCreate", { title: "Title", file: "missing", estimate })
    ).rejects.toThrow("0, 0.5, 1, 2, 3, 5, 8, 13, 20, 40, 100, 999");
    f.done();
  }
);

test("issue create with disabled board preserves standalone creation", async () => {
  const f = fixtureServer([
    {
      path: "/repos/example/project/issues",
      json: { number: issueResponse.number, node_id: issueResponse.node_id },
    },
  ]);
  const config = join(f.root, "vmethod.yaml");
  writeFileSync(config, readFileSync(config, "utf8").replace("enabled: true", "enabled: false"));
  const gateway = createGateway(f.root, f.env, f.deps);
  const file = join(f.root, "body.md");
  writeFileSync(file, "Body");
  await expect(
    gateway.call("issueCreate", { title: "Title", file }, { role: "orchestrator" })
  ).resolves.toBe("Created issue #37");
  await expect(
    gateway.call("issueCreate", { title: "Title", file, estimate: 1 }, { role: "orchestrator" })
  ).rejects.toThrow("Board is disabled");
  f.done();
}, 15000);

test.each(["Estimate", "Status", "Progress"])(
  "board set %s decodes recordings, writes exact values and records Status moves",
  async (field) => {
    const card = boardRecording.items.nodes[0];
    const value = field === "Estimate" ? "0.5" : field === "Progress" ? "👤❓ 🔁2️⃣ 🔴" : "Done";
    const progressId = boardRecording.fields.nodes.find((f) => f.name === "Progress")!.id;
    const fieldId = boardRecording.fields.nodes.find((f) => f.name === field)!.id;
    const f = fixtureServer([
      graph({ repository: { issue: item({ id: card.content.id }) } }),
      graph({ node: { ...acceptedIssue(), id: card.content.id } }),
      ...boardReads(),
      {
        path: "/graphql",
        checkQuery(query, variables) {
          expect(query).toContain("mutation BoardSetCards");
          const update = {
            projectId: boardRecording.id,
            itemId: card.id,
            fieldId,
            value:
              field === "Estimate"
                ? { number: 0.5 }
                : field === "Progress"
                  ? { text: value }
                  : { singleSelectOptionId: "e807513c" },
          };
          expect(variables).toEqual(
            field === "Status"
              ? {
                  m0: { projectId: boardRecording.id, itemId: card.id, fieldId: progressId },
                  m1: update,
                }
              : { m0: update }
          );
        },
        json: {
          data: {
            m0: { projectV2Item: { id: card.id } },
            ...(field === "Status" ? { m1: { projectV2Item: { id: card.id } } } : {}),
          },
        },
      },
    ]);
    await expect(
      gatewayVerb(f.transport, "board", ["set", "39", field, value], {
        VMETHOD_ROLE: "orchestrator",
      })
    ).resolves.toBe("Board field updated");
    if (field === "Status") {
      const path = join(f.env.XDG_STATE_HOME, "vmethod", "example-state", "writes.jsonl");
      expect(readFileSync(path, "utf8")).toContain('"field":"Status","value":"Done"');
    }
    f.done();
  },
  15000
);
