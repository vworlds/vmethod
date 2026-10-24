import { rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parse } from "graphql";
import { AutopilotReader, autopilotStates, inheritAutopilot } from "../../src/gateway/autopilot.js";
import { GitHubClient } from "../../src/gateway/client.js";
import { PeopleFilter, type ObjectData } from "../../src/gateway/people.js";
import { Digest } from "../../src/gateway/digest.js";
import { getConfig } from "../../src/config.js";
import { validProject } from "../helpers.js";
import { actor, people } from "./helpers.js";
import { scopeIssue, scopeComment } from "./scope-fixture.js";
import { bodyHash, scopeApproved } from "../../src/gateway/scope.js";
import recording from "../fixtures/github/autopilot-wire.json" with { type: "json" };
import { WatchFake } from "./watch-fake.js";
import { object } from "../../src/gateway/people.js";

const wire = recording.data.repository.issue;
const event = (enabled = true, overrides: ObjectData = {}): ObjectData => ({
  ...structuredClone(wire.timelineItems.nodes[enabled ? 0 : 1]),
  id: enabled ? "grant" : "stop",
  label: { name: "autopilot" },
  actor: actor(),
  ...overrides,
});
const issue = (overrides: ObjectData = {}): ObjectData =>
  scopeIssue({
    __typename: "Issue",
    number: 8,
    id: "issue",
    labels: { ...wire.labels, nodes: [{ name: "autopilot" }] },
    ...overrides,
  });

test.each([
  { owner: false, status: "Scoping" },
  { owner: true, status: "Scoping" },
  { owner: true, status: "Approved" },
])(
  "watcher authenticates labels and returns revoked $status to its owner (owner=$owner)",
  async ({ owner, status }) => {
    const f = new WatchFake();
    const card = f.card(8, status);
    card.content = { ...object(card.content), ...issue(), id: "issue" };
    f.cards = [card];
    const original = f.deps.fetch;
    const writes: { path: string; method: string; body: ObjectData }[] = [];
    let history = [event(true, { actor: owner ? actor() : actor(1) })];
    f.deps.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/graphql") {
        const payload = JSON.parse(String(init?.body));
        if (String(payload.query).includes("AutopilotNodes")) {
          return Response.json({ data: { nodes: [card.content] } });
        }
        if (String(payload.query).includes("AutopilotHistory")) {
          return Response.json({
            data: {
              n0: {
                ...object(card.content),
                timelineItems: { ...wire.timelineItems, nodes: history },
              },
            },
          });
        }
      }
      if (
        path === "/repos/example/project/issues/8/labels/autopilot" ||
        (path === "/repos/example/project/issues/8/comments" && init?.method === "POST")
      ) {
        writes.push({
          path,
          method: String(init?.method),
          body: init?.body ? JSON.parse(String(init.body)) : {},
        });
        if (init?.method === "DELETE") {
          object(card.content).labels = structuredClone(wire.labels);
        }
        return Response.json({});
      }
      return original(input, init);
    };
    try {
      const loop = f.loop();
      const first = await f.once(loop);
      expect(
        first.some(
          (value) =>
            value.kind === "autopilot" &&
            value.line.includes(owner ? "owner-delegated" : "unauthorized label removed")
        )
      ).toBe(true);
      if (owner) {
        object(card.content).labels = structuredClone(wire.labels);
        history = [...history, event(false)];
        f.advance();
        const stopped = await f.once(loop);
        expect(
          stopped.some((value) =>
            value.line.includes("stopped; owner's control at the current step")
          )
        ).toBe(true);
        expect(writes).toEqual([]);
        if (status === "Approved") {
          expect(f.writes).toContainEqual(
            expect.objectContaining({ itemId: card.id, field: "Progress", value: "👤🔍" })
          );
          expect(object(card.content).assignees).toEqual({ nodes: [{ login: "owner" }] });
        }
      } else {
        expect(writes.map((write) => write.method)).toEqual(["DELETE", "POST"]);
        expect(writes[1].body.body).toContain("Removed an unauthorized autopilot label");
        f.advance();
        await f.once(loop);
        expect(writes).toHaveLength(2);
      }
    } finally {
      f.done();
    }
  }
);

function setup() {
  const root = validProject();
  const config = getConfig(root, {});
  const env = { EXAMPLE_GITHUB_TOKEN: "secret", XDG_STATE_HOME: join(root, "state") };
  const filter = new PeopleFilter(people, "example", new Digest(env, "autopilot", () => 0));
  return { root, config, env, filter };
}

test.each(["active", "absent", "revoked", "intervening actor"])(
  "task inheritance writes the label and exact copy proof only with live authority (%s)",
  async (scenario) => {
    const f = setup();
    const source = issue();
    const body = 'Task text\n\n<!-- vmethod-task {"issues":[8]} -->\n';
    const pr = issue({ __typename: "PullRequest", id: "pr", number: 27, body });
    let reads = 0;
    const writes: { path: string; method: string; payload: ObjectData }[] = [];
    const github = new GitHubClient({ ...f.config, gateway: { maxRetries: 0 } }, f.env, {
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        const payload = init?.body ? JSON.parse(String(init.body)) : {};
        if (path === "/graphql") {
          expect(() => parse(payload.query)).not.toThrow();
          if (payload.query.includes("AutopilotNodes")) {
            if (!payload.query.includes("body number")) {
              reads++;
            }
            const absent = scenario === "absent" || (scenario === "revoked" && reads > 1);
            return Response.json({
              data: { nodes: [{ ...source, labels: absent ? wire.labels : source.labels }] },
            });
          }
          if (payload.query.includes("AutopilotHistory")) {
            const events =
              scenario === "absent"
                ? []
                : scenario === "revoked" && reads > 1
                  ? [event(), event(false)]
                  : [event()];
            return Response.json({
              data: { n0: { ...source, timelineItems: { ...wire.timelineItems, nodes: events } } },
            });
          }
          if (payload.query.includes("AutopilotCopy")) {
            return Response.json({
              data: {
                node: {
                  ...pr,
                  timelineItems: {
                    nodes: [
                      event(true, {
                        id: "copy",
                        actor: scenario === "intervening actor" ? actor(1) : actor(2),
                      }),
                    ],
                  },
                },
              },
            });
          }
          throw new Error(`Unexpected query ${payload.query}`);
        }
        if (!(
          (path === "/repos/example/project/issues/27/labels" && init?.method === "POST") ||
          (path === "/repos/example/project/pulls/27" && init?.method === "PATCH") ||
          (path === "/repos/example/project/issues/27/comments" && init?.method === "POST")
        )) {
          throw new Error(`Unexpected write ${path}`);
        }
        writes.push({ path, method: String(init?.method), payload });
        return Response.json({});
      },
      exec: async () => {
        throw new Error("Unexpected exec");
      },
      now: () => 0,
      sleep: async () => {
        throw new Error("Unexpected sleep");
      },
      report: () => {},
    });
    try {
      const result = inheritAutopilot(github, f.filter, f.config, source, pr);
      if (scenario === "revoked" || scenario === "intervening actor") {
        await expect(result).rejects.toThrow(
          scenario === "revoked" ? "revoked during task creation" : "Cannot certify"
        );
        expect(writes).toHaveLength(1);
      } else {
        await result;
        if (scenario === "absent") {
          expect(writes).toEqual([]);
        } else {
          expect(writes.map((write) => write.method)).toEqual(["POST", "PATCH", "POST"]);
          expect(writes[0].payload).toEqual({ labels: ["autopilot"] });
          expect(writes[1].payload.body).toBe(
            `Task text\n\n<!-- vmethod-autopilot-copy {"event":"copy","source":"grant"} -->\n\n<!-- vmethod-task {"issues":[8]} -->\n`
          );
          expect(writes[2].payload.body).toContain("Task opened under autopilot");
        }
      }
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
);

test.each(["owner", "worker", "orchestrator", "unknown", "forged id", "forged type"])(
  "only a pinned owner grants autopilot (%s)",
  (kind) => {
    const f = setup();
    try {
      const actors: Record<string, ObjectData> = {
        owner: actor(),
        worker: actor(1),
        orchestrator: actor(2),
        unknown: { ...actor(), login: "outsider" },
        "forged id": { ...actor(), databaseId: 999 },
        "forged type": { ...actor(), __typename: "Bot" },
      };
      const state = autopilotStates(
        [{ item: issue(), events: [event(true, { actor: actors[kind] })] }],
        f.filter,
        "example/project"
      ).get("issue")!;
      expect(state.active).toBe(kind === "owner");
      expect(state.unauthorized).toBe(kind !== "owner");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
);

test("removal on either side stops the task; exact inherited event is the only non-owner copy", () => {
  const f = setup();
  try {
    const body =
      '<!-- vmethod-autopilot-copy {"event":"copy","source":"grant"} -->\n<!-- vmethod-task {"issues":[8]} -->';
    const pr = issue({ __typename: "PullRequest", id: "pr", number: 27, body });
    const copy = event(true, { id: "copy", actor: actor(2), createdAt: "2026-10-24T17:49:38Z" });
    const records = [
      { item: issue(), events: [event()] },
      { item: pr, events: [copy] },
    ];
    expect(
      [...autopilotStates(records, f.filter, "example/project").values()].map(
        (state) => state.active
      )
    ).toEqual([true, true]);
    for (const side of [0, 1]) {
      const revoked = structuredClone(records);
      revoked[side].events.push(event(false, { createdAt: "2026-10-24T17:49:39Z" }));
      revoked[side].item.labels = structuredClone(wire.labels);
      const states = autopilotStates(revoked, f.filter, "example/project");
      expect([...states.values()].every((state) => !state.active)).toBe(true);
      expect(states.get("issue")!.at(Date.parse("2026-10-24T17:49:38Z"))).toBe(true);
    }
    records[1].events = [event(true, { id: "later-add", actor: actor(2) })];
    expect(autopilotStates(records, f.filter, "example/project").get("pr")!.unauthorized).toBe(
      true
    );
    records[1].events = [copy];
    records[1].item.body = body.replace("[8]", "[9]");
    expect(autopilotStates(records, f.filter, "example/project").get("pr")!.unauthorized).toBe(
      true
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("ambiguous, missing and incomplete label history fail closed", () => {
  const f = setup();
  try {
    for (const record of [
      { item: issue(), events: [] },
      { item: issue(), events: [event(true, { createdAt: "invalid" })] },
      {
        item: issue({
          labels: { nodes: [{ name: "autopilot" }], pageInfo: { hasNextPage: true } },
        }),
        events: [event()],
      },
      { item: issue({ labels: wire.labels }), events: [event()] },
      {
        item: issue({ labels: wire.labels }),
        events: [event(), event(false, { createdAt: wire.timelineItems.nodes[0].createdAt })],
      },
    ]) {
      expect(autopilotStates([record], f.filter, "example/project").get("issue")!.active).toBe(
        false
      );
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("scope approval needs delegation at the exact authenticated review and unchanged body", () => {
  const f = setup();
  try {
    const item = issue();
    const state = autopilotStates([{ item, events: [event()] }], f.filter, "example/project").get(
      "issue"
    )!;
    const review = scopeComment({
      createdAt: "2026-10-24T17:49:38Z",
      body: `[orchestrator] SCOPE REVIEW\n\nAutopilot: scope approved.\n\nbody sha256: ${bodyHash(String(item.body))}`,
    });
    expect(scopeApproved(item, [review], [], f.config, f.filter, Infinity, state)).toBe(true);
    expect(scopeApproved(item, [review], [], f.config, f.filter)).toBe(false);
    expect(
      scopeApproved({ ...item, body: "changed" }, [review], [], f.config, f.filter, Infinity, state)
    ).toBe(false);
    expect(
      scopeApproved(
        item,
        [{ ...review, author: actor(1) }],
        [],
        f.config,
        f.filter,
        Infinity,
        state
      )
    ).toBe(false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("batch reader paginates recorded label history through the real GraphQL client", async () => {
  const f = setup();
  const items = [issue(), issue({ id: "second", number: 9 })];
  const requests: string[] = [];
  const github = new GitHubClient({ ...f.config, gateway: { maxRetries: 0 } }, f.env, {
    fetch: async (_input, init) => {
      const { query, variables } = JSON.parse(String(init?.body));
      expect(() => parse(query)).not.toThrow();
      expect(query).toContain("... on User { databaseId }");
      requests.push(query);
      if (query.includes("AutopilotNodes")) {
        return Response.json({ data: { nodes: items } });
      }
      if (!query.includes("AutopilotHistory")) {
        throw new Error(`Unexpected query ${query}`);
      }
      if (variables.cursor0 === "next") {
        return Response.json({
          data: {
            n0: { ...items[0], timelineItems: { ...wire.timelineItems, nodes: [event(false)] } },
          },
        });
      }
      return Response.json({
        data: {
          n0: {
            ...items[0],
            timelineItems: { nodes: [event()], pageInfo: { hasNextPage: true, endCursor: "next" } },
          },
          n1: { ...items[1], timelineItems: { ...wire.timelineItems, nodes: [event()] } },
        },
      });
    },
    exec: async () => {
      throw new Error("Unexpected exec");
    },
    now: () => 0,
    sleep: async () => {
      throw new Error("Unexpected sleep");
    },
    report: () => {},
  });
  try {
    items[0].labels = wire.labels;
    const states = await new AutopilotReader(github, f.filter, f.config).read(["issue", "second"]);
    expect(requests).toHaveLength(4);
    expect(states.get("issue")!.active).toBe(false);
    expect(states.get("second")!.active).toBe(true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
