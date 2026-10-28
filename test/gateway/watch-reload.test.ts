import { writeFileSync, utimesSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { stringify } from "yaml";
import { createGateway } from "../../src/gateway/server.js";
import { object, type ObjectData } from "../../src/gateway/people.js";
import { WatchFake } from "./watch-fake.js";
import { actor, people } from "./helpers.js";
import { scopeIssue } from "./scope-fixture.js";
import recording from "../fixtures/github/autopilot-wire.json" with { type: "json" };

function setup() {
  const f = new WatchFake();
  const edit = (kind: string, text: string) => {
    const path = join(f.root, `${kind}.yaml`);
    writeFileSync(path, text);
    utimesSync(path, f.clock / 1000, f.clock / 1000);
  };
  edit("vmethod", stringify(f.config));
  edit("people", stringify(people));
  const gateway = createGateway(f.root, f.env, f.deps);
  const ctx = { role: "orchestrator" } as const;
  const poll = async () => {
    const batch = await gateway.call("nextEvents", { timeoutSeconds: 0, pollOnce: true }, ctx);
    await gateway.call(
      "nextEvents",
      { timeoutSeconds: 0, ack: batch.events.map((e) => e.id) },
      ctx
    );
    return batch.events;
  };
  return { f, edit, gateway, poll, ctx };
}

test("a running gateway accepts a newly pinned owner's autopilot label on its next poll", async () => {
  const { f, edit, poll } = setup();
  const wire = recording.data.repository.issue;
  const card = f.card(8, "Scoping");
  card.content = {
    ...object(card.content),
    ...scopeIssue({ __typename: "Issue", number: 8, id: "issue", labels: wire.labels }),
    id: "issue",
  };
  f.cards = [card];
  const original = f.deps.fetch;
  let history: ObjectData[] = [];
  const cleanup: string[] = [];
  f.deps.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (
      (path === "/repos/example/project/issues/8/labels/autopilot" && init?.method === "DELETE") ||
      (path === "/repos/example/project/issues/8/comments" && init?.method === "POST")
    ) {
      cleanup.push(String(init?.method));
      return Response.json({});
    }
    if (new URL(String(input)).pathname === "/graphql") {
      const { query } = JSON.parse(String(init?.body));
      if (query.includes("AutopilotNodes")) {
        return Response.json({ data: { nodes: [card.content] } });
      }
      if (query.includes("AutopilotHistory")) {
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
    return original(input, init);
  };
  try {
    await poll();
    f.advance();
    edit(
      "people",
      stringify([...people, { login: "new-owner", id: 105, type: "User", role: "owner" }])
    );
    object(card.content).labels = { ...wire.labels, nodes: [{ name: "autopilot" }] };
    history = [
      {
        ...wire.timelineItems.nodes[0],
        label: { name: "autopilot" },
        actor: { ...actor(), login: "new-owner", databaseId: 105 },
      },
    ];
    const result = await poll();
    expect(result.map((e) => e.line)).toContainEqual(expect.stringContaining("owner-delegated"));
    expect(cleanup).toEqual([]);
    expect(f.reports).toEqual(["people.yaml reloaded (owners: owner, new-owner)"]);
    f.advance();
    await poll();
    expect(f.reports).toHaveLength(1);
  } finally {
    f.done();
  }
});

test("edits during an active long poll apply before its next GitHub poll", async () => {
  const { f, edit, gateway, poll, ctx } = setup();
  let edited = false;
  const sleep = f.deps.sleep;
  f.deps.sleep = async (ms) => {
    await sleep(ms);
    if (!edited) {
      edited = true;
      edit("people", stringify(people.slice(1)));
      edit("vmethod", stringify({ ...f.config, watch: { preview: true } }));
      f.comment("Removed owner must not pass", 0);
      f.comment("Worker preview", 1);
    }
  };
  try {
    await poll();
    const batch = await gateway.call("nextEvents", { timeoutSeconds: 120 }, ctx);
    expect(edited).toBe(true);
    expect(batch.events.filter((e) => e.kind === "comment").map((e) => e.line)).toEqual([
      expect.stringContaining("Worker preview"),
    ]);
    expect(f.reports).toEqual(["people.yaml reloaded (owners: )", "vmethod.yaml reloaded"]);
  } finally {
    f.done();
  }
});

test("a rebuilt loop still refuses a concurrent reader of the same session", async () => {
  const { f, edit, gateway, poll, ctx } = setup();
  const sleep = f.deps.sleep;
  let sleeps = 0;
  f.deps.sleep = async (ms) => {
    await sleep(ms);
    sleeps++;
    if (sleeps === 1) {
      edit("vmethod", stringify({ ...f.config, watch: { preview: true } }));
    } else if (sleeps === 2) {
      await expect(gateway.call("nextEvents", { timeoutSeconds: 0 }, ctx)).rejects.toThrow(
        "another reader is already waiting"
      );
      f.comment("Finish after replacement", 0);
    }
  };
  try {
    await poll();
    const batch = await gateway.call("nextEvents", { timeoutSeconds: 180 }, ctx);
    expect(sleeps).toBe(2);
    expect(batch.events.map((e) => e.line)).toContainEqual(
      expect.stringContaining("Finish after replacement")
    );
  } finally {
    f.done();
  }
});

test.each([
  "invalid: [",
  stringify([{ ...people[0], id: "bad" }]),
  stringify([...people, people[0]]),
])(
  "an invalid people edit retains trusted identities and reports only once: %s",
  async (invalid) => {
    const { f, edit, poll } = setup();
    try {
      await poll();
      f.advance();
      edit("people", invalid);
      f.comment("Still trusted", 0);
      expect((await poll()).some((e) => e.kind === "comment")).toBe(true);
      f.advance();
      await poll();
      expect(f.reports).toEqual([
        expect.stringMatching(/^people.yaml reload failed: .*; keeping the previous list$/s),
      ]);
      f.advance();
      edit("people", stringify(people));
      await poll();
      expect(f.reports).toHaveLength(2);
      expect(f.reports[1]).toBe("people.yaml reloaded (owners: owner)");
    } finally {
      f.done();
    }
  }
);

test.each(["invalid: [", stringify({ repo: 123 })])(
  "invalid config edits during a long poll keep the previous config until a valid edit: %s",
  async (invalid) => {
    const { f, edit, gateway, poll, ctx } = setup();
    const sleep = f.deps.sleep;
    let edited = false;
    f.deps.sleep = async (ms) => {
      await sleep(ms);
      if (!edited) {
        edited = true;
        edit("vmethod", invalid);
        f.comment("Previous config still active", 0);
      }
    };
    try {
      await poll();
      const batch = await gateway.call("nextEvents", { timeoutSeconds: 120 }, ctx);
      expect(edited).toBe(true);
      expect(batch.events.filter((e) => e.kind === "comment")).toHaveLength(1);
      expect(batch.events[0].line).not.toContain("Previous config still active");
      await gateway.call(
        "nextEvents",
        { timeoutSeconds: 0, ack: batch.events.map((e) => e.id) },
        ctx
      );
      f.advance();
      f.comment("Polling continues", 0);
      expect((await poll()).filter((e) => e.kind === "comment")).toHaveLength(1);
      expect(f.reports).toEqual([
        expect.stringMatching(/^vmethod.yaml reload failed: .*; keeping the previous config$/s),
      ]);
      f.advance();
      edit("vmethod", stringify({ ...f.config, watch: { preview: true } }));
      f.comment("Valid edit applied", 0);
      expect((await poll()).map((e) => e.line)).toContainEqual(
        expect.stringContaining("Valid edit applied")
      );
      expect(f.reports).toHaveLength(2);
      expect(f.reports[1]).toBe("vmethod.yaml reloaded");
      f.advance();
      expect(await poll()).toEqual([]);
      expect(f.reports).toHaveLength(2);
    } finally {
      f.done();
    }
  }
);

test("config edits rebuild loop behavior while preserving state directory and acknowledged events", async () => {
  const { f, edit, poll } = setup();
  try {
    await poll();
    f.advance();
    f.comment("One event", 0);
    const before = await poll();
    expect(before.filter((e) => e.kind === "comment")).toHaveLength(1);
    const cursor = readFileSync(join(f.dir, "cursor"), "utf8");
    f.advance();
    edit("vmethod", stringify({ ...f.config, stateName: "changed", watch: { preview: true } }));
    expect(await poll()).toEqual([]);
    expect(readFileSync(join(f.dir, "cursor"), "utf8")).not.toBe(cursor);
    f.advance();
    f.comment("New preview", 0);
    const after = await poll();
    expect(after.filter((e) => e.kind === "comment")).toHaveLength(1);
    expect(after[0].line).toContain("New preview");
    expect(after.map((e) => e.id)).not.toContain(before[0].id);
    expect(f.reports).toEqual(["vmethod.yaml reloaded"]);
  } finally {
    f.done();
  }
});
