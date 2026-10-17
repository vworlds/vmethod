import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { actor, fixtureServer, graph, item } from "./helpers.js";
import { gatewayVerb } from "../../src/cli/gateway.js";
import { createGateway } from "../../src/gateway/server.js";
import issueResponse from "../fixtures/github/issue-response.json" with { type: "json" };
import boardRecording from "../fixtures/github/board-write-inputs.json" with { type: "json" };
import { WatchFake } from "./watch-fake.js";

test.each(
  ["issue create", "issue close", "board set"].flatMap((verb) =>
    [false, true].map((owner) => ({ verb, owner }))
  )
)(
  "$verb then watch --once (owner=$owner)",
  async ({ verb, owner }) => {
    const recording = verb === "issue create" ? createdCard() : structuredClone(boardRecording);
    const card = recording.items.nodes[0];
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
                json: { number: card.content.number, state: "closed" },
              },
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
      if (owner && verb !== "issue close") {
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
            value: { number: 2.5 },
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
      ["create", "Title", file, "--estimate", "2.5", "--status", "In progress"],
      { VMETHOD_ROLE: "orchestrator" }
    )
  ).toBe("Created issue #37");
  expect(f.sleeps).toEqual([1000]);
  f.done();
}, 15000);

test.each([
  ["Estimate", "NaN", "finite numeric"],
  ["Estimate", "1e999", "finite numeric"],
  ["Status", "Missing option", "Unknown Status option"],
  ["Progress", "text", "single-select or number"],
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
    await expect(f.transport.call("boardSetIssue", { ref: "39", field, value })).rejects.toThrow(
      message
    );
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
      body: { state: "closed", state_reason: "completed" },
      json: issueResponse,
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

test.each([NaN, Infinity, -1])(
  "issue create rejects invalid estimate %s before networking",
  async (estimate) => {
    const f = fixtureServer([]);
    await expect(
      f.transport.call("issueCreate", { title: "Title", file: "missing", estimate })
    ).rejects.toThrow("finite nonnegative");
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

test.each(["Estimate", "Status"])(
  "board set %s decodes recordings, writes exact values and records Status moves",
  async (field) => {
    const card = boardRecording.items.nodes[0];
    const value = field === "Estimate" ? "2.5" : "Done";
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
            value: field === "Estimate" ? { number: 2.5 } : { singleSelectOptionId: "e807513c" },
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
