import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { stringify } from "yaml";
import { actor, fixtureServer, graph, item, people } from "./helpers.js";
import { gatewayVerb } from "../../src/cli/gateway.js";
import { createGateway } from "../../src/gateway/server.js";
import { object, type ObjectData } from "../../src/gateway/people.js";
import issueResponse from "../fixtures/github/issue-response.json" with { type: "json" };
import boardRecording from "../fixtures/github/board-write-inputs.json" with { type: "json" };
import { WatchFake } from "./watch-fake.js";
import { bodyHash } from "../../src/gateway/scope.js";
import autopilotWire from "../fixtures/github/autopilot-wire.json" with { type: "json" };
import { scopeGraph, scopeMove } from "./scope-fixture.js";

test("scope-review advances both gates under verified owner autopilot and comments on each step", async () => {
  const recording = structuredClone(boardRecording);
  const card = recording.items.nodes[0];
  const status = recording.fields.nodes.find((field) => field.name === "Status")!;
  status.options![0].name = "Spec review";
  status.options!.push({ ...status.options![0], id: "executing", name: "Executing" });
  const issue = {
    ...acceptedIssue(),
    __typename: "Issue",
    number: 39,
    id: card.content.id,
    labels: { nodes: [{ name: "autopilot" }], pageInfo: { hasNextPage: false } },
  };
  const history = {
    ...autopilotWire.data.repository.issue.timelineItems,
    nodes: [
      {
        ...autopilotWire.data.repository.issue.timelineItems.nodes[0],
        actor: actor(),
        label: { name: "autopilot" },
      },
    ],
  };
  const authority = () => [
    scopeGraph({ nodes: [issue] }),
    scopeGraph({ nodes: [issue] }),
    scopeGraph({ n0: { ...issue, timelineItems: history } }),
  ];
  const mutations = (values: unknown[]) => ({
    path: "/graphql",
    json: {
      data: { m0: { projectV2Item: { id: card.id } }, m1: { projectV2Item: { id: card.id } } },
    },
    checkQuery(_query: string, variables: Record<string, unknown>) {
      expect(Object.values(variables).map((value) => (value as { value: unknown }).value)).toEqual(
        values
      );
    },
  });
  const f = fixtureServer([
    graph({ repository: { issue: item({ id: issue.id }) } }),
    graph({ node: issue }),
    ...boardReads(recording).slice(0, 2),
    { path: "/graphql", json: { data: { node: { items: recording.items } } } },
    ...authority(),
    graph({
      node: item({ id: issue.id, assignees: { nodes: [], pageInfo: { hasNextPage: false } } }),
    }),
    {
      path: "/repos/example/project/issues/39/assignees",
      body: { assignees: ["owner"] },
      json: {},
    },
    {
      path: "/repos/example/project/issues/39/comments",
      json: {},
      checkQuery: undefined,
      body: {
        body: `[orchestrator] SCOPE REVIEW\n\nI have updated the main body to the final scope.\n\nEstimate: 5\n\nSettled scope.\n\nAutopilot: scope approved.\n\nScoping → Spec review under autopilot.\n\nbody sha256: ${bodyHash("Specification")}`,
      },
    },
    ...boardReads(recording),
    mutations([{ text: "👤🔍" }, { singleSelectOptionId: status.options![0].id }]),
    ...authority(),
    {
      path: "/repos/example/project/issues/39/comments",
      body: {
        body: "[orchestrator] AUTOPILOT\n\nSpec review → Executing under autopilot, on my scope review.",
      },
      json: {},
    },
    {
      path: "/repos/example/project/issues/39/assignees",
      method: "DELETE",
      body: { assignees: ["owner"] },
      json: {},
    },
    ...boardReads(recording),
    mutations([undefined, { singleSelectOptionId: "executing" }]),
    {
      path: "/graphql",
      json: { data: { updateProjectV2ItemPosition: { clientMutationId: null } } },
      checkQuery(query, variables) {
        expect(query).toContain("updateProjectV2ItemPosition");
        expect(variables).toEqual({
          input: { projectId: recording.id, itemId: card.id, afterId: null },
        });
      },
    },
  ]);
  const file = join(f.root, "summary.md");
  writeFileSync(file, "Settled scope.");
  await expect(f.transport.call("scopeReview", { ref: "39", file })).resolves.toBe(
    "Scope approved under autopilot for #39"
  );
  f.done();
});

test.each([false, true])(
  "scope-review publishes the body hash and assigns one owner (multiple=%s)",
  async (multiple) => {
    const second = { ...people[0], login: "second-owner", id: 105 };
    const selected = multiple ? second.login : "owner";
    const recording = structuredClone(boardRecording);
    const card = recording.items.nodes[0];
    const status = recording.fields.nodes.find((field) => field.name === "Status")!;
    const option = status.options![0];
    option.name = "Spec review";
    const issue = { ...acceptedIssue(), id: card.content.id };
    const summary =
      "- Folded the agreed acceptance cases into the body. Estimate revised to 5 because the new cases add work.";
    const f = fixtureServer(
      [
        graph({ repository: { issue: item({ id: issue.id }) } }),
        graph({ node: issue }),
        ...boardReads(recording).slice(0, 2),
        { path: "/graphql", json: { data: { node: { items: recording.items } } } },
        graph({
          node: item({
            id: issue.id,
            assignees: { nodes: [{ login: "peer" }], pageInfo: { hasNextPage: false } },
          }),
        }),
        ...(multiple
          ? [
              {
                path: "/graphql",
                json: {
                  data: {
                    repository: {
                      issueOrPullRequest: {
                        ownerActivity: {
                          nodes: [
                            scopeMove({
                              actor: {
                                login: second.login,
                                databaseId: second.id,
                                __typename: second.type,
                              },
                            }),
                          ],
                          pageInfo: { hasPreviousPage: false, startCursor: null },
                        },
                      },
                    },
                  },
                },
              },
            ]
          : []),
        {
          path: "/repos/example/project/issues/39/assignees",
          method: "DELETE",
          body: { assignees: ["peer"] },
          json: {},
        },
        {
          path: "/repos/example/project/issues/39/assignees",
          method: "POST",
          body: { assignees: [selected] },
          json: {},
        },
        {
          path: "/repos/example/project/issues/39/comments",
          body: {
            body: `[orchestrator] SCOPE REVIEW\n\nI have updated the main body to the final scope.\n\nEstimate: 5\n\n${summary}\n\nbody sha256: ${bodyHash("Specification")}`,
          },
          json: {},
        },
        ...boardReads(recording),
        {
          path: "/graphql",
          json: {
            data: {
              m0: { projectV2Item: { id: card.id } },
              m1: { projectV2Item: { id: card.id } },
            },
          },
          checkQuery(_query, variables) {
            expect(
              Object.values(variables).map((value) => (value as { value: unknown }).value)
            ).toEqual([{ text: "👤🔍" }, { singleSelectOptionId: option.id }]);
          },
        },
      ],
      actor(2),
      multiple ? [...people, second] : people
    );
    const file = join(f.root, "scope-summary.md");
    writeFileSync(file, summary);
    await expect(
      gatewayVerb(f.transport, "scope-review", ["39", file], { VMETHOD_ROLE: "orchestrator" })
    ).resolves.toBe("Scope review requested for #39");
    // The write journal records the operation first and each write at its landing:
    // the watcher's violation checks skip exactly this in-flight window (#199).
    const entries = readFileSync(
      join(f.env.XDG_STATE_HOME, "vmethod", "example-state", "writes.jsonl"),
      "utf8"
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries.map((entry) => entry.kind)).toEqual([
      "operation",
      "unassigned",
      "assigned",
      "comment",
      "board",
      "board",
    ]);
    expect(entries[0]).toMatchObject({ op: "scope-review", number: 39 });
    expect(entries.map((entry) => entry.at)).toHaveLength(6);
    f.done();
  }
);

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
      if (verb === "issue close") {
        // Both the writing session and an observer use the same orchestrator account.
        expect(events).toEqual([]);
      } else if (owner) {
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

test.each(["5", "0.5", "2"])(
  "issue estimate %s writes an existing issue card through the shared field writer",
  async (points) => {
    const card = boardRecording.items.nodes[0];
    const fieldId = boardRecording.fields.nodes.find((f) => f.name === "Estimate")!.id;
    const f = fixtureServer([
      graph({ repository: { issue: item({ id: card.content.id }) } }),
      graph({ node: { ...acceptedIssue(), id: card.content.id } }),
      ...boardReads(),
      {
        path: "/graphql",
        checkQuery(query, variables) {
          expect(query).toContain("mutation BoardSetCards");
          expect(variables).toEqual({
            m0: {
              projectId: boardRecording.id,
              itemId: card.id,
              fieldId,
              value: { number: Number(points) },
            },
          });
        },
        json: { data: { m0: { projectV2Item: { id: card.id } } } },
      },
    ]);
    await expect(
      gatewayVerb(f.transport, "issue", ["estimate", "39", points], {
        VMETHOD_ROLE: "orchestrator",
      })
    ).resolves.toBe("Board field updated");
    f.done();
  },
  15000
);

test.each(["1.5", "4", "1000000"])(
  "issue estimate refuses off-scale %s with the allowed-values error before any write",
  async (points) => {
    const f = fixtureServer([]);
    await expect(
      gatewayVerb(f.transport, "issue", ["estimate", "39", points], {
        VMETHOD_ROLE: "orchestrator",
      })
    ).rejects.toThrow("Estimate must be one of: 0, 0.5, 1, 2, 3, 5, 8, 13, 20, 40, 100, 999");
    f.done();
  },
  15000
);

test("issue create sends validated file content and repeated labels to the configured repository", async () => {
  const recording = createdCard();
  const card = recording.items.nodes[0];
  const progressField = recording.fields.nodes.find((field) => field.name === "Progress")!;
  const statusField = recording.fields.nodes.find((field) => field.name === "Status")!;
  const backlog = { id: "6f1a2b3c", name: "Backlog", color: "GRAY", description: "" };
  statusField.options!.push(backlog);
  const f = fixtureServer([
    {
      path: "/repos/example/project/issues",
      body: { title: "A title", body: "A body\n", labels: ["bug", "task"] },
      json: { number: issueResponse.number, node_id: issueResponse.node_id },
    },
    ...createBoardReads(recording),
    ...boardReads(recording),
    {
      ...boardGraph({
        m0: { projectV2Item: { id: card.id } },
        m1: { projectV2Item: { id: card.id } },
      }),
      checkQuery(query, variables) {
        expect(query).toContain("mutation BoardSetCards");
        expect(variables).toEqual({
          m0: { projectId: recording.id, itemId: card.id, fieldId: progressField.id },
          m1: {
            projectId: recording.id,
            itemId: card.id,
            fieldId: statusField.id,
            value: { singleSelectOptionId: backlog.id },
          },
        });
      },
    },
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

test("issue create without --status sets the first column (Backlog) on the new card", async () => {
  const recording = createdCard();
  const card = recording.items.nodes[0];
  const statusField = recording.fields.nodes.find((field) => field.name === "Status")!;
  const backlog = { id: "6f1a2b3c", name: "Backlog", color: "GRAY", description: "" };
  statusField.options!.push(backlog);
  const f = fixtureServer([
    {
      path: "/repos/example/project/issues",
      json: { number: issueResponse.number, node_id: issueResponse.node_id },
    },
    ...createBoardReads(recording),
    ...boardReads(recording),
    {
      ...boardGraph({
        m0: { projectV2Item: { id: card.id } },
        m1: { projectV2Item: { id: card.id } },
      }),
      checkQuery(query, variables) {
        expect(query).toContain("clearProjectV2ItemFieldValue");
        expect(query).toContain("updateProjectV2ItemFieldValue");
        expect(variables).toEqual({
          m0: {
            projectId: recording.id,
            itemId: card.id,
            fieldId: recording.fields.nodes.find((field) => field.name === "Progress")!.id,
          },
          m1: {
            projectId: recording.id,
            itemId: card.id,
            fieldId: statusField.id,
            value: { singleSelectOptionId: backlog.id },
          },
        });
      },
    },
  ]);
  const file = join(f.root, "body.md");
  writeFileSync(file, "Body");
  expect(
    await gatewayVerb(f.transport, "issue", ["create", "Title", file], {
      VMETHOD_ROLE: "orchestrator",
    })
  ).toBe("Created issue #37");
  f.done();
}, 15000);

function createdCard() {
  const recording = structuredClone(boardRecording);
  recording.items.nodes[0].content.id = issueResponse.node_id;
  recording.items.nodes[0].content.number = issueResponse.number;
  return recording;
}

const boardGraph = (data: unknown) => ({ path: "/graphql", json: { data } });

function createBoardReads(recording = createdCard()) {
  const card = recording.items.nodes[0];
  return [
    ...boardReads(recording).slice(0, 2),
    boardGraph({ node: { __typename: "Issue", repository: { nameWithOwner: "example/project" } } }),
    membershipRead(recording, false),
    {
      ...boardGraph({ addProjectV2ItemById: { item: { id: card.id } } }),
      checkQuery(query: string, variables: unknown) {
        expect(query).toContain("mutation BoardAdd");
        expect(variables).toEqual({
          input: { projectId: recording.id, contentId: issueResponse.node_id },
        });
      },
    },
  ];
}

test("issue create applies optional estimate/status in one ordered operation without relying on the lagging board listing", async () => {
  const recording = createdCard();
  const card = recording.items.nodes[0];
  const statusField = recording.fields.nodes.find((field) => field.name === "Status")!;
  const ready = statusField.options!.find((option) => option.name === "In progress")!;
  ready.name = "Ready";
  const stored: Record<string, unknown> = {};
  const f = fixtureServer([
    {
      path: "/repos/example/project/issues",
      json: { number: issueResponse.number, node_id: issueResponse.node_id },
    },
    ...createBoardReads(recording),
    ...boardReads(recording),
    {
      // Estimate and Status ride one ordered mutation (#199): Estimate first, then
      // the Status write with its progress companion, Status last.
      ...boardGraph({
        m0: { projectV2Item: { id: card.id } },
        m1: { projectV2Item: { id: card.id } },
        m2: { projectV2Item: { id: card.id } },
      }),
      checkQuery(query, variables) {
        expect(query).toContain("mutation BoardSetCards");
        expect(variables).toEqual({
          m0: {
            projectId: recording.id,
            itemId: card.id,
            fieldId: recording.fields.nodes.find((f) => f.name === "Estimate")!.id,
            value: { number: 1 },
          },
          m1: {
            projectId: recording.id,
            itemId: card.id,
            fieldId: recording.fields.nodes.find((f) => f.name === "Progress")!.id,
          },
          m2: {
            projectId: recording.id,
            itemId: card.id,
            fieldId: recording.fields.nodes.find((f) => f.name === "Status")!.id,
            value: { singleSelectOptionId: ready.id },
          },
        });
        stored.Estimate = 1;
        stored.Status = "Ready";
      },
    },
    graph({ repository: { issue: item({ id: card.content.id }) } }),
    graph({ node: { ...acceptedIssue(), id: card.content.id } }),
    ...boardReads(recording),
    {
      ...boardGraph({ m0: { projectV2Item: { id: card.id } } }),
      checkQuery(query, variables) {
        expect(query).toContain("mutation BoardSetCards");
        expect(variables.m0).toEqual({
          projectId: recording.id,
          itemId: card.id,
          fieldId: recording.fields.nodes.find((field) => field.name === "Estimate")!.id,
          value: { number: 2 },
        });
        stored.Estimate = 2;
      },
    },
  ]);
  // GitHub's board-wide listing never includes this new item during the test.
  const fetch = f.deps.fetch;
  f.deps.fetch = async (input, init) => {
    if (
      String(input).endsWith("/graphql") &&
      JSON.parse(String(init?.body)).query.includes("query BoardCards")
    ) {
      return Response.json({
        data: { node: { items: { nodes: [], pageInfo: { hasNextPage: false } } } },
      });
    }
    return fetch(input, init);
  };
  const file = join(f.root, "body.md");
  writeFileSync(file, "Body");
  expect(
    await gatewayVerb(
      f.transport,
      "issue",
      ["create", "Title", file, "--estimate", "1", "--status", "Ready"],
      { VMETHOD_ROLE: "orchestrator" }
    )
  ).toBe("Created issue #37");
  expect(stored).toEqual({ Estimate: 1, Status: "Ready" });
  expect(
    await gatewayVerb(f.transport, "board", ["set", "37", "Estimate", "2"], {
      VMETHOD_ROLE: "orchestrator",
    })
  ).toBe("Board field updated");
  expect(stored).toEqual({ Estimate: 2, Status: "Ready" });
  // The board init journals one operation record (#199) and then each successful
  // write at its landing: created issue, operation, membership add, ordered fields.
  const entries = readFileSync(
    join(f.env.XDG_STATE_HOME, "vmethod", "example-state", "writes.jsonl"),
    "utf8"
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(entries.map((entry) => entry.kind)).toEqual([
    "created",
    "operation",
    "addProjectV2ItemById",
    "board",
    "board",
    "board",
    "board",
  ]);
  expect(f.sleeps).toEqual([]);
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
    if (reason === "missing") {
      recorded.items.nodes = [];
    }
    const reads = boardReads(recorded);
    if (reason === "foreign") {
      recorded.items.nodes[0].content.repository.nameWithOwner = "example/foreign";
    } else if (reason === "PR") {
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
  ["board", ["add"]],
  ["board", ["add", "39", "--estimate"]],
  ["board", ["add", "39", "--estimate", "NaN"]],
  ["board", ["add", "39", "--bogus", "x"]],
  ["board", ["add", "39", "--status", "Done", "--status", "Done"]],
  ["board", ["set", "39", "Progress", "👤❓", "--clear"]],
  ["board", ["set", "39", "Estimate", "--clear", "5"]],
  ["board", ["set", "39", "Estimate", "5", "--repo", "foreign"]],
  ["issue", ["estimate", "39"]],
  ["issue", ["estimate", "39", "abc"]],
  ["issue", ["estimate", "39", "-1"]],
  ["issue", ["estimate", "39", "NaN"]],
  ["issue", ["estimate", "39", "NaN", "junk"]],
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

test.each([
  "issueCreate",
  "issueClose",
  "issueEstimate",
  "boardSetIssue",
  "boardSetAssignees",
  "boardAdd",
] as const)(
  "%s denies workers before any network",
  async (operation) => {
    const f = fixtureServer([]);
    const inputs = {
      issueCreate: { title: "Title", file: "missing" },
      issueClose: { ref: "37" },
      issueEstimate: { ref: "37", points: 5 },
      boardSetIssue: { ref: "37", field: "Estimate", value: "5" },
      boardSetAssignees: { ref: "37", value: null },
      boardAdd: { ref: "37" },
    };
    await expect(
      f.transport.call(operation, inputs[operation], { role: "worker", taskPr: 40 })
    ).rejects.toThrow("denied");
    f.done();
  },
  15000
);

test.each([
  "issueClose",
  "issueEstimate",
  "boardSetIssue",
  "boardSetAssignees",
  "boardAdd",
] as const)(
  "%s rejects foreign references before networking",
  async (operation) => {
    const f = fixtureServer([]);
    const input =
      operation === "issueEstimate"
        ? { ref: "example/foreign#37", points: 5 }
        : operation === "boardSetAssignees"
          ? { ref: "example/foreign#37", value: "owner" as const }
          : { ref: "example/foreign#37", field: "Estimate", value: "5" };
    await expect(f.transport.call(operation, input)).rejects.toThrow("configured repository");
    f.done();
  },
  15000
);

test.each(["issueClose", "issueEstimate", "boardSetIssue"] as const)(
  "%s filters unknown issue authors before requesting text",
  async (operation) => {
    const f = fixtureServer([
      graph({ repository: { issue: item({ author: { ...actor(), databaseId: 999 } }) } }),
    ]);
    await expect(
      f.transport.call(
        operation,
        operation === "issueEstimate"
          ? { ref: "37", points: 5 }
          : { ref: "37", field: "Estimate", value: "5" }
      )
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
  for (const card of recording.items.nodes) {
    card.content.repository.nameWithOwner = "example/project";
  }
  return [
    {
      path: "/graphql",
      json: {
        data: { organization: { projectV2: { id: recording.id, readme: recording.readme } } },
      },
    },
    { path: "/graphql", json: { data: { node: { fields: recording.fields } } } },
    membershipRead(recording),
  ];
}

// Project the recorded item's native fields into the issue-side membership connection.
function membershipRead(recording = createdCard(), present = true) {
  return {
    path: "/graphql",
    json: {
      data: {
        node: {
          projectItems: {
            nodes: present
              ? recording.items.nodes.map((card) => ({ ...card, project: { id: recording.id } }))
              : [],
            pageInfo: { hasNextPage: false },
          },
        },
      },
    },
    checkQuery(query: string) {
      expect(query).toContain("query BoardContentItems");
      expect(query).not.toContain("items(");
    },
  };
}

test.each(["other project", "incomplete", "missing connection"])(
  "board set refuses %s membership metadata without a write",
  async (reason) => {
    const recording = createdCard();
    const card = recording.items.nodes[0];
    const membership = membershipRead(recording);
    const connection = membership.json.data.node.projectItems;
    if (reason === "other project") {
      connection.nodes[0].project.id = "different-project";
    } else if (reason === "incomplete") {
      connection.pageInfo.hasNextPage = true;
    } else {
      delete (membership.json.data.node as { projectItems?: unknown }).projectItems;
    }
    const f = fixtureServer([
      graph({ repository: { issue: item({ id: card.content.id }) } }),
      graph({ node: { ...acceptedIssue(), id: card.content.id } }),
      ...boardReads(recording).slice(0, 2),
      membership,
    ]);
    await expect(
      f.transport.call("boardSetIssue", {
        ref: "37",
        field: "Estimate",
        value: "1",
      })
    ).rejects.toThrow(
      reason === "other project"
        ? "not on configured board"
        : reason === "incomplete"
          ? "incomplete metadata"
          : "Missing board connection"
    );
    f.done();
  }
);

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

test("issue create names the board add retry command on a failed follow-up and board add repairs it", async () => {
  const recording = createdCard();
  const card = recording.items.nodes[0];
  const statusField = recording.fields.nodes.find((field) => field.name === "Status")!;
  const backlog = { id: "6f1a2b3c", name: "Backlog", color: "GRAY", description: "" };
  statusField.options!.push(backlog);
  const f = fixtureServer([
    {
      path: "/repos/example/project/issues",
      json: { number: issueResponse.number, node_id: issueResponse.node_id },
    },
    // The membership add mutation fails: the issue exists, the board never saw it.
    ...createBoardReads(recording).slice(0, 4),
    { path: "/graphql", json: { errors: [{ message: "add refused" }] } },
    // The named retry command repairs it: membership, Estimate and default Status.
    graph({ repository: { issue: item({ id: issueResponse.node_id }) } }),
    graph({ node: { ...acceptedIssue(), id: issueResponse.node_id } }),
    ...boardReads(recording).slice(0, 2),
    membershipRead(recording, false),
    ...createBoardReads(recording),
    ...boardReads(recording),
    {
      ...boardGraph({
        m0: { projectV2Item: { id: card.id } },
        m1: { projectV2Item: { id: card.id } },
        m2: { projectV2Item: { id: card.id } },
      }),
      checkQuery(query, variables) {
        expect(query).toContain("mutation BoardSetCards");
        expect(variables).toEqual({
          m0: {
            projectId: recording.id,
            itemId: card.id,
            fieldId: recording.fields.nodes.find((f) => f.name === "Estimate")!.id,
            value: { number: 2 },
          },
          m1: {
            projectId: recording.id,
            itemId: card.id,
            fieldId: recording.fields.nodes.find((f) => f.name === "Progress")!.id,
          },
          m2: {
            projectId: recording.id,
            itemId: card.id,
            fieldId: statusField.id,
            value: { singleSelectOptionId: backlog.id },
          },
        });
      },
    },
  ]);
  const file = join(f.root, "body.md");
  writeFileSync(file, "Body");
  await expect(
    gatewayVerb(f.transport, "issue", ["create", "Title", file, "--estimate", "2"], {
      VMETHOD_ROLE: "orchestrator",
    })
  ).rejects.toThrow("retry with: vmethod board add 37 --estimate 2");
  expect(f.sleeps).toEqual([]);
  expect(
    await gatewayVerb(f.transport, "board", ["add", "37", "--estimate", "2"], {
      VMETHOD_ROLE: "orchestrator",
    })
  ).toBe("Added issue #37 to the board");
  f.done();
}, 15000);

test("board add is idempotent: a bare re-run on an on-board issue makes no write", async () => {
  const recording = structuredClone(boardRecording);
  const card = recording.items.nodes[0];
  const f = fixtureServer([
    graph({ repository: { issue: item({ id: card.content.id }) } }),
    graph({ node: { ...acceptedIssue(), id: card.content.id } }),
    ...boardReads(recording),
    ...boardReads(recording).slice(0, 2),
    boardGraph({ node: { __typename: "Issue", repository: { nameWithOwner: "example/project" } } }),
    membershipRead(recording),
  ]);
  await expect(
    gatewayVerb(f.transport, "board", ["add", "39"], { VMETHOD_ROLE: "orchestrator" })
  ).resolves.toBe("Issue #39 is already on the board");
  f.done();
}, 15000);

test("board add on an on-board issue writes only its passed field and keeps the Status", async () => {
  const recording = structuredClone(boardRecording);
  const card = recording.items.nodes[0];
  const f = fixtureServer([
    graph({ repository: { issue: item({ id: card.content.id }) } }),
    graph({ node: { ...acceptedIssue(), id: card.content.id } }),
    ...boardReads(recording),
    ...boardReads(recording).slice(0, 2),
    boardGraph({ node: { __typename: "Issue", repository: { nameWithOwner: "example/project" } } }),
    membershipRead(recording),
    ...boardReads(recording),
    {
      ...boardGraph({ m0: { projectV2Item: { id: card.id } } }),
      checkQuery(query, variables) {
        expect(query).toContain("mutation BoardSetCards");
        expect(Object.keys(variables)).toEqual(["m0"]);
        expect(variables.m0).toEqual({
          projectId: recording.id,
          itemId: card.id,
          fieldId: recording.fields.nodes.find((field) => field.name === "Estimate")!.id,
          value: { number: 3 },
        });
      },
    },
  ]);
  await expect(
    gatewayVerb(f.transport, "board", ["add", "39", "--estimate", "3"], {
      VMETHOD_ROLE: "orchestrator",
    })
  ).resolves.toBe("Repaired issue #39 board fields");
  f.done();
}, 15000);

test("board add --status is the only re-run form that moves an on-board card's Status", async () => {
  const recording = structuredClone(boardRecording);
  const card = recording.items.nodes[0];
  const statusField = recording.fields.nodes.find((field) => field.name === "Status")!;
  const done = statusField.options!.find((option) => option.name === "Done")!;
  const f = fixtureServer([
    graph({ repository: { issue: item({ id: card.content.id }) } }),
    graph({ node: { ...acceptedIssue(), id: card.content.id } }),
    ...boardReads(recording),
    ...boardReads(recording).slice(0, 2),
    boardGraph({ node: { __typename: "Issue", repository: { nameWithOwner: "example/project" } } }),
    membershipRead(recording),
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
            fieldId: recording.fields.nodes.find((field) => field.name === "Progress")!.id,
          },
          m1: {
            projectId: recording.id,
            itemId: card.id,
            fieldId: statusField.id,
            value: { singleSelectOptionId: done.id },
          },
        });
      },
    },
  ]);
  await expect(
    gatewayVerb(f.transport, "board", ["add", "39", "--status", "Done"], {
      VMETHOD_ROLE: "orchestrator",
    })
  ).resolves.toBe("Repaired issue #39 board fields");
  f.done();
}, 15000);

test("board add requires a configured board", async () => {
  const f = fixtureServer([]);
  const config = join(f.root, "vmethod.yaml");
  writeFileSync(config, readFileSync(config, "utf8").replace("enabled: true", "enabled: false"));
  const gateway = createGateway(f.root, f.env, f.deps);
  await expect(gateway.call("boardAdd", { ref: "37" }, { role: "orchestrator" })).rejects.toThrow(
    "Board is disabled"
  );
  f.done();
});

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

test.each([
  [NaN, "Estimate must be one of"],
  [Infinity, "Estimate must be one of"],
  [-1, "Estimate must be one of"],
  [4, "0, 0.5, 1, 2, 3, 5, 8, 13, 20, 40, 100, 999"],
])("board add rejects invalid estimate %s before networking", async (estimate, message) => {
  const f = fixtureServer([]);
  await expect(f.transport.call("boardAdd", { ref: "37", estimate })).rejects.toThrow(message);
  f.done();
});

test("board add refuses a closed issue without writing", async () => {
  const card = structuredClone(boardRecording).items.nodes[0];
  const f = fixtureServer([
    graph({ repository: { issue: item({ id: card.content.id }) } }),
    graph({ node: { ...acceptedIssue(), id: card.content.id, state: "CLOSED" } }),
  ]);
  await expect(f.transport.call("boardAdd", { ref: "39" })).rejects.toThrow(
    "Refusing board add on closed issue #39"
  );
  f.done();
}, 15000);

test("board add refuses a PR before any write", async () => {
  const f = fixtureServer([graph({ repository: { issue: null } })]);
  await expect(f.transport.call("boardAdd", { ref: "39" })).rejects.toThrow(
    "GitHub thread not found"
  );
  f.done();
}, 15000);

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

// --- board set Assignees (issue #257): journaled management-turn housekeeping ---

function assigneeRecording(
  scenario: {
    status?: string;
    progress?: string | null;
    assignees?: { login: string }[];
    number?: number;
    kind?: "Issue" | "PullRequest";
    archived?: boolean;
  } = {}
) {
  const recording = structuredClone(boardRecording);
  const card = object(recording.items.nodes[0]);
  const content = object(card.content);
  const repository = object(content.repository);
  content.number = scenario.number ?? 39;
  repository.nameWithOwner = "example/project";
  if (scenario.kind) {
    content.__typename = scenario.kind;
  }
  if (scenario.archived) {
    card.isArchived = true;
  }
  content.assignees = { nodes: scenario.assignees ?? [] };
  card.fieldValues = {
    nodes: [
      ...(scenario.status === undefined
        ? []
        : [{ name: scenario.status, field: { name: "Status" } }]),
      ...(scenario.progress ? [{ text: scenario.progress, field: { name: "Progress" } }] : []),
    ],
    pageInfo: { hasNextPage: false, endCursor: "NA" },
  };
  return recording;
}

function assigneeIssue(number: number, recording: ObjectData, assignees: { login: string }[]) {
  const nodes = object(recording.items).nodes;
  const card = object((Array.isArray(nodes) ? nodes : [])[0]);
  return {
    path: `/repos/example/project/issues/${number}`,
    method: "GET" as const,
    json: { number, node_id: object(card.content).id, assignees },
  };
}

function journalRecords(env: Record<string, string>): ObjectData[] {
  const path = join(env.XDG_STATE_HOME, "vmethod", "example-state", "writes.jsonl");
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ObjectData);
}

test("board set Assignees --clear on an Executing linked issue removes the stale owner, journals the write and the watcher reports nothing", async () => {
  const w = new WatchFake();
  try {
    w.task();
    w.enableWrites = true;
    const issue = w.card(6, "Executing");
    object(issue.content).assignees = { nodes: [{ login: "owner" }] };
    w.cards = [w.cards[0], issue];
    writeFileSync(join(w.root, "vmethod.yaml"), stringify(w.config));
    writeFileSync(join(w.root, "people.yaml"), stringify(w.watchPeople));
    const gateway = createGateway(w.root, w.env, w.deps);
    const loop = w.loop();
    expect(await w.tick(loop)).toEqual([]);
    w.advance();
    expect(
      await gateway.call("boardSetAssignees", { ref: "6", value: null }, { role: "orchestrator" })
    ).toBe("Cleared the management assignee on #6");
    expect(object(object(issue.content).assignees).nodes).toEqual([]);
    const records = readFileSync(
      join(w.env.XDG_STATE_HOME, "vmethod", "watch-test", "writes.jsonl"),
      "utf8"
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ObjectData);
    expect(
      records.some((record) => record.op === "board set assignees" && record.number === 6)
    ).toBe(true);
    expect(
      records.some(
        (record) =>
          record.kind === "unassigned" && record.field === "Assignee" && record.value === "owner"
      )
    ).toBe(true);
    expect(await w.tick(loop)).toEqual([]);
    expect(w.reports).toEqual([]);
  } finally {
    w.done();
  }
}, 15000);

test("board set Assignees refuses a worker-protocol item's owner set before any write", async () => {
  const recording = assigneeRecording({
    status: "Executing",
    assignees: [{ login: "worker" }, { login: "owner" }],
  });
  const f = fixtureServer([
    ...boardReads(recording).slice(0, 2),
    assigneeIssue(39, recording, [{ login: "worker" }, { login: "owner" }]),
    membershipRead(recording),
  ]);
  await expect(
    f.transport.call("boardSetAssignees", { ref: "39", value: "owner" })
  ).rejects.toThrow("Refusing owner assignee: expected no management assignee on #39");
  expect(existsSyncJournal(f.env)).toBe(false);
  f.done();
}, 15000);

function existsSyncJournal(env: Record<string, string>): boolean {
  return existsSync(join(env.XDG_STATE_HOME, "vmethod", "example-state", "writes.jsonl"));
}

test("board set Assignees refuses a 👤❓ item's orchestrator set and names the expected owner", async () => {
  const recording = assigneeRecording({
    status: "Scoping",
    progress: "👤❓ 🔁2️⃣",
    assignees: [],
  });
  const f = fixtureServer([
    ...boardReads(recording).slice(0, 2),
    assigneeIssue(39, recording, []),
    membershipRead(recording),
  ]);
  await expect(
    f.transport.call("boardSetAssignees", { ref: "39", value: "orchestrator" })
  ).rejects.toThrow("Refusing orchestrator assignee: expected owner (owner) on #39");
  expect(existsSyncJournal(f.env)).toBe(false);
  f.done();
}, 15000);

test("board set Assignees refuses a 🤖👍 item's owner set and names the expected orchestrator", async () => {
  const recording = assigneeRecording({
    status: "Executing",
    progress: "🤖👍",
    assignees: [],
  });
  const f = fixtureServer([
    ...boardReads(recording).slice(0, 2),
    assigneeIssue(39, recording, []),
    membershipRead(recording),
  ]);
  await expect(
    f.transport.call("boardSetAssignees", { ref: "39", value: "owner" })
  ).rejects.toThrow("Refusing owner assignee: expected orchestrator (peer) on #39");
  f.done();
}, 15000);

test("board set Assignees refuses to clear a Spec review card holding the owner turn", async () => {
  const recording = assigneeRecording({
    status: "Spec review",
    assignees: [{ login: "owner" }],
  });
  const f = fixtureServer([
    ...boardReads(recording).slice(0, 2),
    assigneeIssue(39, recording, [{ login: "owner" }]),
    membershipRead(recording),
  ]);
  await expect(f.transport.call("boardSetAssignees", { ref: "39", value: null })).rejects.toThrow(
    "Refusing to clear assignees: owner (owner) holds the turn on #39"
  );
  expect(existsSyncJournal(f.env)).toBe(false);
  f.done();
}, 15000);

test("board set Assignees --clear on a working card removes the owner and keeps the worker", async () => {
  const recording = assigneeRecording({
    status: "Executing",
    progress: "🤖🔨 🔁2️⃣",
    assignees: [{ login: "worker" }, { login: "owner" }],
  });
  const f = fixtureServer([
    ...boardReads(recording).slice(0, 2),
    assigneeIssue(39, recording, [{ login: "worker" }, { login: "owner" }]),
    membershipRead(recording),
    {
      path: "/repos/example/project/issues/39/assignees",
      method: "DELETE",
      body: { assignees: ["owner"] },
      json: { assignees: [{ login: "worker" }] },
    },
  ]);
  expect(await f.transport.call("boardSetAssignees", { ref: "39", value: null })).toBe(
    "Cleared the management assignee on #39"
  );
  const records = journalRecords(f.env);
  expect(
    records.filter(
      (record) =>
        record.kind === "unassigned" && record.field === "Assignee" && record.value === "owner"
    )
  ).toHaveLength(1);
  expect(records.some((record) => record.op === "board set assignees")).toBe(true);
  f.done();
}, 15000);

test("board set Assignees on an owner-review PR sets the owner through the CLI and journals the assignment", async () => {
  const recording = assigneeRecording({
    status: "Owner review",
    kind: "PullRequest",
    assignees: [{ login: "worker" }],
  });
  const f = fixtureServer([
    ...boardReads(recording).slice(0, 2),
    assigneeIssue(39, recording, [{ login: "worker" }]),
    membershipRead(recording),
    {
      path: "/repos/example/project/issues/39/assignees",
      method: "POST",
      body: { assignees: ["owner"] },
      json: { assignees: [{ login: "worker" }, { login: "owner" }] },
    },
  ]);
  expect(
    await gatewayVerb(f.transport, "board", ["set", "39", "Assignees", "owner"], {
      VMETHOD_ROLE: "orchestrator",
    })
  ).toBe("Assigned the owner turn on #39");
  expect(
    journalRecords(f.env).filter(
      (record) =>
        record.kind === "assigned" && record.field === "Assignee" && record.value === "owner"
    )
  ).toHaveLength(1);
  f.done();
}, 15000);

test("board set Assignees on a 🤖👍 card sets the orchestrator while the worker keeps the assignment", async () => {
  const recording = assigneeRecording({
    status: "Executing",
    progress: "🤖👍",
    assignees: [{ login: "worker" }],
  });
  const f = fixtureServer([
    ...boardReads(recording).slice(0, 2),
    assigneeIssue(39, recording, [{ login: "worker" }]),
    membershipRead(recording),
    {
      path: "/repos/example/project/issues/39/assignees",
      method: "POST",
      body: { assignees: ["peer"] },
      json: { assignees: [{ login: "worker" }, { login: "peer" }] },
    },
  ]);
  expect(await f.transport.call("boardSetAssignees", { ref: "39", value: "orchestrator" })).toBe(
    "Assigned the orchestrator turn on #39"
  );
  f.done();
}, 15000);

test("board set Assignees refuses an off-board item before any write", async () => {
  const recording = assigneeRecording();
  const f = fixtureServer([
    ...boardReads(recording).slice(0, 2),
    assigneeIssue(39, recording, []),
    membershipRead(recording, false),
  ]);
  await expect(f.transport.call("boardSetAssignees", { ref: "39", value: null })).rejects.toThrow(
    "Item is not on the configured board"
  );
  expect(existsSyncJournal(f.env)).toBe(false);
  f.done();
}, 15000);

test("board set Assignees refuses an archived card before any write", async () => {
  const recording = assigneeRecording({
    status: "Done",
    archived: true,
    assignees: [{ login: "owner" }],
  });
  const f = fixtureServer([
    ...boardReads(recording).slice(0, 2),
    assigneeIssue(39, recording, [{ login: "owner" }]),
    membershipRead(recording),
  ]);
  await expect(f.transport.call("boardSetAssignees", { ref: "39", value: null })).rejects.toThrow(
    "Refusing assignee housekeeping on an archived board item"
  );
  expect(existsSyncJournal(f.env)).toBe(false);
  f.done();
}, 15000);

test("board set Assignees agrees when the requested turn already holds and writes nothing", async () => {
  const recording = assigneeRecording({
    status: "Spec review",
    progress: "👤🔍",
    assignees: [{ login: "owner" }],
  });
  const f = fixtureServer([
    ...boardReads(recording).slice(0, 2),
    assigneeIssue(39, recording, [{ login: "owner" }]),
    membershipRead(recording),
  ]);
  expect(await f.transport.call("boardSetAssignees", { ref: "39", value: "owner" })).toBe(
    "Turn assignees already agree on #39"
  );
  const records = journalRecords(f.env);
  expect(records).toHaveLength(1);
  expect(records[0].kind).toBe("operation");
  expect(records[0].op).toBe("board set assignees");
  f.done();
}, 15000);

test("board set Assignees rejects an unknown value at the CLI without any request", async () => {
  const f = fixtureServer([]);
  await expect(
    gatewayVerb(f.transport, "board", ["set", "39", "Assignees", "worker"], {
      VMETHOD_ROLE: "orchestrator",
    })
  ).rejects.toThrow("Usage: board set <issue|pr> Assignees owner|orchestrator|--clear");
  f.done();
}, 15000);
