import { afterEach, expect, test } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { readState, writeState } from "../../src/board/readme.js";
import { loadMigrations, validateMigrations } from "../../src/board/migrations.js";
import { createGateway } from "../../src/gateway/server.js";
import { gatewayVerb } from "../../src/cli/gateway.js";
import { validProject } from "../helpers.js";
import { people } from "../gateway/helpers.js";
import type { Migration } from "../../src/board/types.js";
import { baseline, FakeBoard } from "./fake.js";
import recordedFields from "../fixtures/github/board-fields.json" with { type: "json" };

let fake: FakeBoard;
test.each([5, 7])("v%s preserves every value across destructive option writes", async (version) => {
  const board = setup();
  const migrations = loadMigrations().slice(0, version);
  const previous = migrations[version - 2];
  board.stamp(version - 1, 4);
  board.fields = Object.entries(previous.expect.fields).map(([name, shape], index) => ({
    id: `field-${index}`,
    name,
    type: shape.type,
    createdAt: board.clock,
    options: (shape.options ?? []).map((option, i) => ({
      id: `old-${index}-${i}`,
      ...(typeof option === "string" ? { name: option, color: "GRAY", description: "" } : option),
    })),
  }));
  const fieldName = version === 5 ? "Model" : "Status";
  const names = board.fields
    .find(({ name }) => name === fieldName)!
    .options.map(({ name }) => name);
  names.forEach((name, index) => {
    const card = board.card(`value-${index}`, index % 2 ? "example/foreign" : "example/project");
    card.kind = index % 2 ? "DraftIssue" : "Issue";
    card.values[fieldName] = name;
  });
  board.card("unset").values[fieldName] = null;
  const before = structuredClone(board.cards.map(({ id, values }) => ({ id, values })));
  const dry = await board.service(migrations).migrate({ dryRun: true });
  for (const card of before) {
    expect(dry.message).toContain(`restore ${fieldName} on ${card.id}`);
  }
  if (version === 7) {
    for (const option of migrations[6].expect.fields.Status.options!) {
      expect(dry.message).toContain(
        JSON.stringify(typeof option === "string" ? option : option.description)
      );
    }
  }
  expect(board.mutations).toEqual([]);
  await board.service(migrations).migrate({});
  expect(board.cards.map(({ id, values }) => ({ id, values }))).toEqual(before);
  expect(readState(board.readme).version).toBe(version);
  expect(readState(board.readme).optionUpdate).toBeUndefined();
  expect(board.mutations).toContain("BoardOptions");
  if (version === 7) {
    expect(
      board.fields
        .find(({ name }) => name === "Status")!
        .options.map(({ name, color, description }) => ({ name, color, description }))
    ).toEqual(migrations[6].expect.fields.Status.options);
  }
});

test("option restore verification fails loudly and resumes from the original names", async () => {
  const board = setup();
  board.stamp(1);
  const card = board.card();
  board.ignoreMoves = true;
  await expect(board.service([baseline, expand]).migrate({})).rejects.toThrow(
    "Option restore verification failed"
  );
  expect(card.values.Status).toBeNull();
  expect(readState(board.readme)).toMatchObject({
    version: 1,
    optionUpdate: { values: [{ id: card.id, value: "Inbox" }] },
  });
  board.ignoreMoves = false;
  board.clock += 61 * 60_000;
  await board.service([baseline, expand]).migrate({ steal: true });
  expect(card.values.Status).toBe("Inbox");
  expect(readState(board.readme).version).toBe(2);
});

test.each(["lost-response", "partial-batch"])(
  "option update resumes after %s without replacing its snapshot",
  async (failure) => {
    const board = setup();
    board.stamp(1);
    for (let index = 0; index < 30; index++) {
      board.card(String(index));
    }
    board.dropOptions = failure === "lost-response";
    board.failBatch = failure === "partial-batch" ? 2 : 0;
    await expect(board.service([baseline, expand]).migrate({})).rejects.toThrow();
    expect(readState(board.readme).version).toBe(1);
    expect(readState(board.readme).optionUpdate!.values).toHaveLength(30);
    const writes = board.mutations.filter((name) => name === "BoardOptions").length;
    const dry = await board.service([baseline, expand]).migrate({ dryRun: true });
    expect(dry.message).toContain("resume restore Status on 29: Inbox");
    board.clock += 61 * 60_000;
    await board.service([baseline, expand]).migrate({ steal: true });
    expect(board.cards.every((card) => card.values.Status === "Inbox")).toBe(true);
    expect(board.mutations.filter((name) => name === "BoardOptions")).toHaveLength(writes);
  }
);

test("a disappearing value is reported before destructive writes, including dry-run", async () => {
  const board = setup();
  board.stamp(1);
  board.card().values.Status = "unknown-option";
  const add: Migration = {
    ...expand,
    up: [{ op: "add_option", field: "Status", option: "Inbox" }],
  };
  await expect(board.service([baseline, add]).migrate({ dryRun: true })).rejects.toThrow(
    "option unknown-option disappears"
  );
  expect(board.mutations).toEqual([]);
  await expect(board.service([baseline, add]).migrate({})).rejects.toThrow(
    "option unknown-option disappears"
  );
  expect(board.mutations).not.toContain("BoardOptions");
  expect(board.cards[0].values.Status).toBe("unknown-option");
});

test("option objects carry metadata into new fields and expect checks metadata", async () => {
  const board = setup();
  board.stamp(1);
  const options = [{ name: "yes", color: "GREEN", description: "Ready for delivery" }];
  const migration: Migration = {
    version: 2,
    up: [{ op: "add_field", field: "Decision", type: "single_select", options }],
    expect: {
      ...baseline.expect,
      fields: { ...baseline.expect.fields, Decision: { type: "single_select", options } },
    },
  };
  await board.service([baseline, migration]).migrate({});
  expect(
    board.fields
      .find(({ name }) => name === "Decision")!
      .options.map(({ name, color, description }) => ({ name, color, description }))
  ).toEqual(options);
  board.fields.find(({ name }) => name === "Decision")!.options[0].description = "Wrong";
  expect((await board.service([baseline, migration]).status()).drift).toHaveLength(1);
  board.stamp(1);
  await expect(board.service([baseline, migration]).migrate({})).rejects.toThrow("expect failed");
  expect(readState(board.readme).version).toBe(1);
});

test("restore journal round-trips option text without interpreting README markers", () => {
  const state = {
    version: 1,
    minCompatible: 0,
    aliases: {},
    completed: ["2/1"],
    optionUpdate: {
      position: "2/2",
      field: "Model",
      options: [
        {
          name: "special",
          color: "GREEN",
          description: "<!-- vmethod-board -->\n<!-- /vmethod-board -->",
        },
      ],
      values: [{ id: "card", value: "special" }],
    },
  };
  expect(readState(writeState("Human notes\n", state, true))).toMatchObject(state);
  const malformed = writeState("", state, true).replace('"value":"special"', '"value":42');
  expect(() => readState(malformed)).toThrow("Invalid option restore journal");
});

test.each(["none", "failure", "contract", "budget"])(
  "v6 remaps every legacy state with evidence and is resumable and idempotent (interrupt=%s)",
  async (interrupt) => {
    const board = setup();
    const migrations = loadMigrations().slice(0, 6);
    board.stamp(5, 4);
    board.pinSelf("example/project", "dev");
    board.fields = Object.entries(migrations[4].expect.fields).map(([name, shape], index) => ({
      id: `field-${index}`,
      name,
      type: shape.type,
      createdAt: board.clock,
      options: (shape.options ?? []).map((name, option) => ({
        id: `option-${index}-${option}`,
        name: typeof name === "string" ? name : name.name,
        color: "GRAY",
        description: "",
      })),
    }));
    const cases = [
      ["Issue", "Backlog", "Backlog", false, false, false],
      ["Issue", "Ready", "Scoping", false, false, false],
      ["Issue", "In progress", "Executing", false, false, false],
      ["Issue", "In review", "Spec review", false, true, true],
      ["Issue", "In review", "Scoping", false, false, false],
      ["Issue", "Approved", "Executing", true, false, false],
      ["Issue", "Approved", "Spec review", false, false, false],
      ["PullRequest", "In review", "Owner review", false, false, true],
      ["PullRequest", "In review", "Executing", false, false, false],
      ["PullRequest", "Approved", "Approved", false, false, false],
      ["PullRequest", "In progress", "Executing", false, false, false],
      ["Issue", "Done", "Done", false, false, false],
    ] as const;
    const evidence = new Map<
      string,
      { approved: boolean; reviewPending: boolean; ownerTurn: boolean }
    >();
    cases.forEach(([kind, from, , approved, reviewPending, ownerTurn], index) => {
      const card = board.card(`card-${index}`);
      card.kind = kind;
      card.number = index + 1;
      card.values.Status = from;
      evidence.set(card.id, { approved, reviewPending, ownerTurn });
    });
    const extra = interrupt === "budget" ? 30 : 0;
    for (let index = 0; index < extra; index++) {
      board.card(`extra-${index}`).values.Status = "Ready";
    }
    let service = board.service(migrations);
    service.workflowEvidence = async () => evidence;
    const dry = await service.migrate({ dryRun: true });
    expect(board.mutations).toEqual([]);
    cases.forEach(([kind, from, to], index) =>
      expect(dry.message).toContain(`#${index + 1} (${kind}): ${from} → ${to};`)
    );
    expect(dry.message).toContain("valid authenticated scope approval");
    expect(dry.message).toContain("authenticated SCOPE REVIEW pending");
    expect(dry.message).toContain("pinned owner holds the turn");
    if (interrupt === "failure") {
      board.failMove = true;
      await expect(service.migrate({})).rejects.toThrow();
      expect(readState(board.readme).version).toBe(5);
      expect(
        board.fields.find((field) => field.name === "Status")!.options.map((option) => option.name)
      ).toContain("Ready");
      board.failMove = false;
      board.clock += 61 * 60_000;
    }
    if (interrupt === "contract") {
      board.failBatch = 2;
      await expect(service.migrate({})).rejects.toThrow();
      expect(readState(board.readme).version).toBe(5);
      expect(readState(board.readme).optionUpdate!.values).toEqual(
        cases.map((entry, index) => ({ id: `card-${index}`, value: entry[2] }))
      );
      board.clock += 61 * 60_000;
    }
    if (interrupt === "budget") {
      board.budgetAfterBatch = true;
      const paused = await service.migrate({});
      expect(paused.message).toContain("cards left");
      expect(paused.state).toMatchObject({ version: 5, paused: "6/1" });
      expect(paused.state.lock).toBeUndefined();
      expect(board.cards.some((card) => card.values.Status === "Scoping")).toBe(true);
      expect(board.cards.some((card) => card.values.Status === null)).toBe(true);
      board.low = false;
      service = board.service(migrations);
      service.workflowEvidence = async () => evidence;
    }
    await service.migrate({ steal: interrupt === "failure" || interrupt === "contract" });
    expect(board.cards.map((card) => card.values.Status)).toEqual([
      ...cases.map((entry) => entry[2]),
      ...Array(extra).fill("Scoping"),
    ]);
    expect(readState(board.readme)).toMatchObject({ version: 6, minCompatible: 6 });
    expect(
      board.fields.find((field) => field.name === "Status")!.options.map((option) => option.name)
    ).toEqual([
      "Backlog",
      "Scoping",
      "Spec review",
      "Executing",
      "Owner review",
      "Approved",
      "Done",
    ]);
    const mutations = board.mutations.length;
    expect((await service.migrate({})).message).toContain("up to date");
    expect((await service.migrate({ dryRun: true })).message).toBe("Dry run: no changes");
    expect(board.mutations).toHaveLength(mutations);
  }
);
test.each(["Issue", "PullRequest"] as const)(
  "task-flow %s membership is scoped, compatibility-guarded and replay-safe",
  async (kind) => {
    const board = setup();
    board.stamp(1);
    const own = board.card("own");
    own.contentId = "node-own";
    own.kind = kind;
    const foreign = board.card("foreign", "example/other");
    foreign.contentId = "node-foreign";
    const draft = board.card("draft");
    draft.kind = "DraftIssue";
    draft.contentId = "node-draft";
    expect(await board.service().ensure("node-own")).toBe("own");
    expect(await board.service().ensure("node-own")).toBe("own");
    await expect(board.service().ensure("node-foreign")).rejects.toThrow("foreign or draft");
    await expect(board.service().ensure("node-draft")).rejects.toThrow("foreign or draft");
    expect(board.mutations.filter((name) => name === "BoardAdd")).toHaveLength(0);
    board.stamp(2, 2);
    await expect(board.service().ensure("node-own")).rejects.toThrow("INCOMPATIBLE");
  }
);
test("Done cap ranks all repositories but archives only own cards outside the newest six", async () => {
  const board = setup();
  board.stamp(1);
  board.pageSize = 3;
  for (let i = 0; i < 10; i++) {
    const card = board.card(`done-${i}`, i % 2 ? "example/foreign" : "example/project");
    card.closedAt = `2026-10-${String(20 - i).padStart(2, "0")}T00:00:00Z`;
    card.values.Status = "Done";
  }
  await board.service().capDone();
  expect(board.cards.map((card) => card.id)).not.toContain("done-6");
  expect(board.cards.map((card) => card.id)).not.toContain("done-8");
  expect(board.cards.map((card) => card.id)).toContain("done-7");
  expect(board.cards.map((card) => card.id)).toContain("done-9");
  expect(board.cards.map((card) => card.id)).toContain("done-4");
});

test("board status reports closed/open column mismatches and --fix reconciles them", async () => {
  const board = setup();
  board.stamp(1);
  const closed = board.card("closed");
  closed.number = 42;
  closed.closedAt = "2026-10-18T12:07:00Z";
  const open = board.card("open");
  open.number = 43;
  open.values.Status = "Done";
  const draft = board.card("draft");
  draft.kind = "DraftIssue";
  draft.values.Status = "Done";
  const status = await board.service().status();
  expect(status.mismatches).toEqual([
    {
      itemId: "closed",
      number: 42,
      closed: true,
      status: "Backlog",
      summary: "#42: closed, Status Backlog",
    },
    {
      itemId: "open",
      number: 43,
      closed: false,
      status: "Done",
      summary: "#43: open, Status Done",
    },
  ]);
  const fixed = await board.service().fixStatus();
  expect(fixed.mismatches).toEqual([]);
  expect(closed.values.Status).toBe("Done");
  expect(open.values.Status).toBe("Backlog");
  expect(closed.values.Progress).toBeNull();
  expect(draft.values.Status).toBe("Done");
});

test("board status reports empty Status cards and --fix reconciles them like the invariant", async () => {
  const board = setup();
  board.stamp(1);
  const open = board.card("open");
  open.number = 44;
  delete open.values.Status;
  const closed = board.card("closed");
  closed.number = 45;
  closed.closedAt = "2026-10-18T12:07:00Z";
  delete closed.values.Status;
  const status = await board.service().status();
  expect(status.mismatches).toEqual([
    {
      itemId: "open",
      number: 44,
      closed: false,
      status: null,
      summary: "#44: open, Status (unset)",
    },
    {
      itemId: "closed",
      number: 45,
      closed: true,
      status: null,
      summary: "#45: closed, Status (unset)",
    },
  ]);
  const fixed = await board.service().fixStatus();
  expect(fixed.mismatches).toEqual([]);
  expect(open.values.Status).toBe("Backlog");
  expect(closed.values.Status).toBe("Done");
  expect(open.values.Progress).toBeNull();
  expect(closed.values.Progress).toBeNull();
});
afterEach(() => fake?.done());
function setup() {
  fake = new FakeBoard();
  return fake;
}
const expand: Migration = {
  version: 2,
  up: [
    { op: "rename_option", field: "Status", from: "Backlog", to: "Inbox" },
    { op: "add_progress_alias", from: "🤖👍", to: "✅" },
  ],
  expect: {
    ...baseline.expect,
    fields: {
      ...baseline.expect.fields,
      Status: {
        type: "single_select",
        options: [...baseline.expect.fields.Status.options!, "Inbox"],
      },
    },
  },
};

test("live-reported ISO field creation time decodes through snapshot and permits a Progress write", async () => {
  const board = setup();
  board.stamp(1, 1);
  board.recordedFields = structuredClone(recordedFields);
  board.fields = [
    {
      id: "field-progress",
      name: "Progress",
      type: "text",
      createdAt: Date.parse("2026-10-16T11:12:25Z"),
      options: [],
    },
  ];
  const card = board.card();
  card.contentId = "recorded-progress-content";
  const service = board.service();
  expect((await service.snapshot()).fields[0].createdAt).toBe(Date.parse("2026-10-16T11:12:25Z"));
  // Task-flow ensures membership before writing Progress: exercise both paths with the
  // recorded ISO-string wire value, rather than a decoded numeric timestamp.
  await expect(service.ensure(card.contentId)).resolves.toBe(card.id);
  await expect(
    service.set({ itemId: card.id, field: "Progress", value: "🤖🤝 🔁2️⃣" })
  ).resolves.toBe("Board field updated");
  expect(card.values.Progress).toBe("🤖🤝 🔁2️⃣");
  expect(board.mutations).toContain("BoardSetCards");
  expect(board.mutations).not.toContain("BoardAdd");
});

test.each([undefined, null, "", "invalid-date", 1792149145000])(
  "field creation time %s fails closed before a write",
  async (createdAt) => {
    const board = setup();
    board.stamp(1, 1);
    const fields = structuredClone(recordedFields);
    board.recordedFields = {
      node: {
        fields: { ...fields.node.fields, nodes: [{ ...fields.node.fields.nodes[0], createdAt }] },
      },
    };
    const card = board.card();
    await expect(
      board.service().set({ itemId: card.id, field: "Progress", value: "🤖🤝" })
    ).rejects.toThrow("invalid board field creation time");
    expect(board.mutations).toEqual([]);
  }
);
const contract: Migration = {
  version: 3,
  requires: "1.2.0",
  up: [
    { op: "remove_option", field: "Status", option: "Backlog" },
    { op: "rewrite_progress", from: "🤖👍", to: "✅" },
  ],
  expect: {
    ...baseline.expect,
    fields: {
      ...baseline.expect.fields,
      Status: {
        type: "single_select",
        options: [...baseline.expect.fields.Status.options!.slice(1), "Inbox"],
      },
    },
  },
};

test("baseline is accepted as-is, stamps from zero, and preserves human README and exact Progress", async () => {
  const board = setup();
  const card = board.card();
  const progress = card.values.Progress;
  const result = await board.service().migrate({});
  expect(result.state.version).toBe(1);
  expect(result.state.lock).toBeUndefined();
  expect(result.state.migrating).toBeUndefined();
  expect(result.drift).toEqual([]);
  expect(result.pending).toEqual([]);
  expect(board.readme.startsWith("Human notes\n")).toBe(true);
  expect(card.values.Progress).toBe(progress);
  expect(board.mutations.filter((name) => name === "BoardSetCards")).toEqual([]);
  expect(board.announcements).toEqual([]);
  expect(board.fields.some((field) => field.name === "vmethod-migration-lock")).toBe(false);
});

test("dry-run lists active project workflows only when Status changes and makes no writes", async () => {
  const board = setup();
  board.stamp(1);
  board.config.board.announce = "example/project#9";
  const result = await board.service([baseline, expand]).migrate({ dryRun: true, steal: true });
  expect(result.workflows).toEqual(["Item closed → Done"]);
  expect(result.pending).toEqual([expand]);
  expect(board.mutations).toEqual([]);
  expect(board.announcements).toEqual([]);
});

test.each([0, 1, 2, 3])(
  "migrates from version %i, including old-option cards and Progress contract suffixes",
  async (version) => {
    const board = setup();
    if (version) {
      board.stamp(version);
    }
    const card = board.card();
    if (version >= 2) {
      board.fields
        .find((field) => field.name === "Status")!
        .options.push({
          id: "inbox",
          name: "Inbox",
          color: "GRAY",
          description: "",
        });
      const state = readState(board.readme);
      state.aliases["🤖👍"] = "✅";
      board.readme = writeState(board.readme, state);
      card.values.Status = "Inbox";
    }
    if (version === 3) {
      board.fields.find((field) => field.name === "Status")!.options.shift();
      card.values.Progress = "✅  🔁1️⃣2️⃣ 🔴 ";
    }
    board.pin("example/project", "dev", "1.2.0");
    board.config.board.announce = "example/project#9";
    const result = await board.service([baseline, expand, contract]).migrate({});
    expect(result.state.version).toBe(3);
    expect(card.values.Status).toBe("Inbox");
    expect(card.values.Progress).toBe("✅  🔁1️⃣2️⃣ 🔴 ");
    expect(board.announcements).toEqual(
      version < 3 ? [`[vmethod] board migration ${version}→3`] : []
    );
  }
);

test("expand preserves every Progress string exactly, across repositories, while quietly moving Status", async () => {
  const board = setup();
  board.stamp(1);
  for (const [index, progress] of [
    "🤖👍 🔁1️⃣ 🔴",
    "",
    " 🧭🔍 ",
    "unrecognized\nraw text",
  ].entries()) {
    board.card(String(index), index % 2 ? "example/other" : "example/project").values.Progress =
      progress;
  }
  const before = board.cards.map((card) => card.values.Progress);
  await board.service([baseline, expand]).migrate({});
  expect(board.cards.map((card) => card.values.Progress)).toEqual(before);
  expect(board.cards.every((card) => card.values.Status === "Inbox")).toBe(true);
});

test("interrupted mutation retains last verified version, then stale steal resumes idempotently", async () => {
  const board = setup();
  board.stamp(1);
  const card = board.card();
  board.failMove = true;
  await expect(board.service([baseline, expand]).migrate({})).rejects.toThrow("Interrupted move");
  expect(readState(board.readme).version).toBe(1);
  expect(readState(board.readme).lock).toBeDefined();
  board.clock += 3600001;
  await board.service([baseline, expand]).migrate({ steal: true });
  expect(card.values.Status).toBe("Inbox");
  expect(readState(board.readme).version).toBe(2);
  expect(
    board.fields
      .find((field) => field.name === "Status")!
      .options.filter((option) => option.name === "Inbox")
  ).toHaveLength(1);
});

test("concurrent acquirers have exactly one winner", async () => {
  const board = setup();
  const results = await Promise.allSettled([
    board.service().migrate({}),
    board.service().migrate({}),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect(readState(board.readme).version).toBe(1);
});

test("a lock still being acquired is refused, never stealable, and orphans after a minute", async () => {
  const board = setup();
  // Run A created the field moments ago; its holder write is still in flight.
  board.fields.push({
    id: "lock",
    name: "vmethod-migration-lock",
    createdAt: board.clock,
    type: "text",
    options: [],
  });
  await expect(board.service().migrate({})).rejects.toThrow("being acquired");
  await expect(board.service().migrate({ steal: true })).rejects.toThrow("being acquired");
  expect(board.mutations).toEqual([]);
  board.clock += 61000;
  await expect(board.service().migrate({})).rejects.toThrow("LOCK ORPHANED (no holder)");
  await board.service().migrate({ steal: true });
  expect(readState(board.readme).version).toBe(1);
  expect(board.fields.some((field) => field.name === "vmethod-migration-lock")).toBe(false);
});

test("a concurrent winner between snapshot and create is refused, then orphans after a minute", async () => {
  const board = setup();
  board.raceCreate = true;
  // The pre-check sees no field; the fake injects the winner before the create.
  await expect(board.service().migrate({})).rejects.toThrow("being acquired");
  expect(board.requests.filter((name) => name === "BoardCreateField")).toHaveLength(1);
  expect(board.mutations).not.toContain("BoardReadme");
  board.clock += 61000;
  await expect(board.service().migrate({})).rejects.toThrow("LOCK ORPHANED (no holder)");
  await board.service().migrate({ steal: true });
  expect(readState(board.readme).version).toBe(1);
});

test("lost create response is not retried or owned; the orphan steals after a minute", async () => {
  const board = setup();
  board.dropCreate = true;
  await expect(board.service().migrate({})).rejects.toThrow("being acquired");
  expect(board.requests.filter((name) => name === "BoardCreateField")).toHaveLength(1);
  expect(board.mutations).not.toContain("BoardReadme");
  board.clock += 61000;
  await expect(board.service().migrate({})).rejects.toThrow("LOCK ORPHANED (no holder)");
  await board.service().migrate({ steal: true });
  expect(readState(board.readme).version).toBe(1);
});

test("fresh lock cannot be stolen, stale lock requires explicit steal", async () => {
  const board = setup();
  board.fields.push({
    id: "lock",
    name: "vmethod-migration-lock",
    createdAt: board.clock,
    type: "text",
    options: [],
  });
  board.stamp(0);
  const state = readState(board.readme);
  state.lock = `run someone since ${new Date(board.clock).toISOString()}`;
  board.readme = writeState(board.readme, state);
  await expect(board.service().migrate({ steal: true })).rejects.toThrow("lock held");
  board.clock += 3600001;
  await expect(board.service().migrate({})).rejects.toThrow("lock held");
  await board.service().migrate({ steal: true });
  expect(readState(board.readme).version).toBe(1);
});

test("budget pauses with remaining-card count, releases lock using reserve, resumes without steal", async () => {
  const board = setup();
  board.stamp(1);
  for (let index = 0; index < 27; index++) {
    board.card(String(index));
  }
  board.budgetAfterBatch = true;
  const result = await board.service([baseline, expand]).migrate({});
  expect(result.message).toContain("2 cards left");
  expect(result.state.paused).toBe("2/1");
  expect(result.state.lock).toBeUndefined();
  expect(result.state.migrating).toBeUndefined();
  expect(result.state.version).toBe(1);
  expect(board.sleeps).toEqual([]);
  board.low = false;
  await board.service([baseline, expand]).migrate({});
  expect(board.cards.every((card) => card.values.Status === "Inbox")).toBe(true);
  expect(readState(board.readme).version).toBe(2);
});

test("failed expect and lost lock never advance version", async () => {
  const board = setup();
  board.stamp(1);
  board.card();
  board.failExpect = true;
  await expect(board.service([baseline, expand]).migrate({})).rejects.toThrow("expect failed");
  expect(readState(board.readme).version).toBe(1);
  board.failExpect = false;
  board.fields.find((field) => field.name === "Status")!.options.reverse();
  // Start a separate operation to exercise lock loss, not a completed journal entry.
  board.stamp(1);
  board.fields.find((field) => field.name === "Status")!.options = board.fields
    .find((field) => field.name === "Status")!
    .options.filter((option) => option.name !== "Inbox");
  board.cards[0].values.Status = "Backlog";
  board.clock += 3600001;
  board.stealBeforeBump = true;
  await expect(board.service([baseline, expand]).migrate({ steal: true })).rejects.toThrow(
    "lock lost"
  );
  expect(readState(board.readme).version).toBe(1);
});

test("contract waits for every base/track/pack lockfile, including a lagging foreign repo", async () => {
  const board = setup();
  board.stamp(1);
  board.card();
  board.config.board.repos.push("example/other");
  board.pin("example/project", "dev", "1.2.0");
  board.pin("example/other", "dev", "1.1.0");
  board.refs.set("example/other:track/", ["track/work"]);
  board.refs.set("example/other:pack/", ["pack/batch"]);
  board.pin("example/other", "track/work", "1.2.0");
  board.pin("example/other", "pack/batch", "1.2.0-rc.1");
  await expect(board.service([baseline, expand, contract]).migrate({})).rejects.toThrow(
    "example/other (dev)"
  );
  expect(readState(board.readme).version).toBe(2);
  board.pin("example/other", "dev", "1.2.0");
  board.clock += 3600001;
  await expect(
    board.service([baseline, expand, contract]).migrate({ steal: true })
  ).rejects.toThrow("pack/batch");
  board.pin("example/other", "pack/batch", "1.2.0");
  board.clock += 3600001;
  await board.service([baseline, expand, contract]).migrate({ steal: true });
  expect(readState(board.readme).minCompatible).toBe(3);
});

test("README rejects incomplete/duplicated blocks and refuses missing markers except first append", () => {
  setup();
  for (const value of [
    "<!-- vmethod-board -->",
    "<!-- /vmethod-board -->",
    "<!-- vmethod-board --><!-- vmethod-board --><!-- /vmethod-board -->",
    "<!-- /vmethod-board --><!-- vmethod-board -->",
  ]) {
    expect(() => readState(value)).toThrow();
  }
  const state = { version: 1, minCompatible: 0, aliases: {} };
  expect(() => writeState("human", state)).toThrow("missing markers");
  const managed = writeState("human", state, true) + "Tail notes";
  expect(writeState(managed, { ...state, version: 2 })).toBe(
    managed.replace("version: 1", "version: 2")
  );
});

test("README is re-read before writes, preserving a concurrent human edit", async () => {
  const board = setup();
  board.editsBeforeReadme = true;
  await board.service().migrate({});
  expect(board.readme).toContain("Human notes updated");
});

test("BOARD AHEAD warns but permits writes, INCOMPATIBLE refuses writes but permits reads; never downgrades", async () => {
  const board = setup();
  const card = board.card();
  board.stamp(2, 1);
  await board.service().set({ itemId: card.id, field: "Model", value: "luna" });
  expect(board.reports).toContain("BOARD AHEAD: upgrade @vworlds/vmethod");
  expect((await board.service().migrate({})).state.version).toBe(2);
  board.stamp(2, 2);
  expect((await board.service().item(card.id)).values.Model).toBe("luna");
  await expect(
    board.service().set({ itemId: card.id, field: "Model", value: "sol" })
  ).rejects.toThrow("BOARD INCOMPATIBLE");
  await expect(board.service().archive(card.id)).rejects.toThrow("BOARD INCOMPATIBLE");
});

test("card writes enforce content repo scope, Status+Progress, PR Estimate policy, and clear/archive", async () => {
  const board = setup();
  board.stamp(1);
  const card = board.card();
  const foreign = board.card("foreign", "example/other");
  await expect(
    board.service().set({ itemId: foreign.id, field: "Progress", value: "🤖🔨" })
  ).rejects.toThrow("foreign");
  await expect(board.service().archive(foreign.id)).rejects.toThrow("foreign");
  await expect(
    board.service().set({ itemId: card.id, field: "Status", value: "Ready" })
  ).rejects.toThrow("require Progress");
  expect(board.mutations).toEqual([]);
  await board.service().set({
    itemId: card.id,
    field: "Status",
    value: "Ready",
    progress: "🤖🔨",
  });
  expect(card.values.Status).toBe("Ready");
  expect(card.values.Progress).toBe("🤖🔨");
  expect(board.mutations).toEqual(["BoardSetCards"]);
  await board.service().set({ itemId: card.id, field: "Estimate", value: null });
  expect(card.values.Estimate).toBeNull();
  card.kind = "PullRequest";
  await expect(
    board.service().set({ itemId: card.id, field: "Estimate", value: 5 })
  ).rejects.toThrow("Never");
  await board.service().archive(card.id);
  expect(board.cards).toEqual([foreign]);
});

test("Cost is per PR; both issue write paths refuse it without mutations", async () => {
  const board = setup();
  board.stamp(1);
  board.fields.push({ id: "cost", name: "Cost", type: "text", createdAt: 1, options: [] });
  const issue = board.card("issue");
  issue.contentId = "issue-content";
  const pr = board.card("pr");
  pr.kind = "PullRequest";
  for (const value of ["$1.25", null]) {
    await expect(board.service().set({ itemId: issue.id, field: "Cost", value })).rejects.toThrow(
      "Never set Cost on an issue"
    );
  }
  await expect(board.service().setIssueField(issue.contentId, "Cost", "$1.25")).rejects.toThrow(
    "Never set Cost on an issue"
  );
  expect(board.mutations).toEqual([]);
  await board.service().set({ itemId: pr.id, field: "Cost", value: "$1.25" });
  expect(pr.values.Cost).toBe("$1.25");
  await board.service().set({ itemId: pr.id, field: "Cost", value: null });
  expect(pr.values.Cost).toBeNull();
  expect(issue.values.Cost).toBeUndefined();
});

test.each([4, 1.5, -1, Infinity, NaN])(
  "board Estimate %s is rejected without mutations",
  async (value) => {
    const board = setup();
    board.stamp(1);
    const card = board.card();
    await expect(
      board.service().set({ itemId: card.id, field: "Estimate", value })
    ).rejects.toThrow("0, 0.5, 1, 2, 3, 5, 8, 13, 20, 40, 100, 999");
    await expect(
      board.service().setIssueField(card.contentId!, "Estimate", String(value))
    ).rejects.toThrow("0, 0.5, 1, 2, 3, 5, 8, 13, 20, 40, 100, 999");
    expect(board.mutations).toEqual([]);
  }
);

test("new operations use the same orchestrator policy and board CLI transport seam", async () => {
  const board = setup();
  const mismatch = board.card("closed-issue");
  mismatch.number = 71;
  mismatch.closedAt = "2026-10-18T12:07:00Z";
  const root = validProject();
  writeFileSync(join(root, "vmethod.yaml"), stringify(board.config));
  writeFileSync(join(root, "people.yaml"), stringify(people));
  const transport = createGateway(
    root,
    { FAKE_TOKEN: "offline", XDG_STATE_HOME: join(root, "state") },
    {
      ...board.deps,
      fetch: async (url, init) => {
        if (
          String(url) === "https://api.github.com/graphql" &&
          JSON.parse(String(init?.body)).query ===
            "query GatewayIdentity { viewer { databaseId login __typename } }"
        ) {
          return Response.json({
            data: {
              viewer: {
                login: people[2].login,
                databaseId: people[2].id,
                __typename: people[2].type,
              },
            },
          });
        }
        return board.deps.fetch(url, init);
      },
    }
  );
  for (const operation of [
    "boardStatus",
    "boardMigrate",
    "boardItem",
    "boardSet",
    "boardArchive",
  ] as const) {
    await expect(
      transport.call(operation, {} as never, { role: "worker", taskPr: 22 })
    ).rejects.toThrow("denied");
  }
  expect(board.requests).toEqual([]);
  const statusOutput = JSON.parse(
    await gatewayVerb(transport, "board", ["status"], {
      VMETHOD_ROLE: "orchestrator",
    })
  );
  expect(statusOutput.state.version).toBe(0);
  expect(statusOutput.mismatches[0].summary).toBe("#71: closed, Status Backlog");
  expect(
    JSON.parse(
      await gatewayVerb(transport, "board", ["migrate", "--dry-run"], {
        VMETHOD_ROLE: "orchestrator",
      })
    ).dryRun
  ).toBe(true);
  for (const args of [
    [],
    ["status", "--steal"],
    ["migrate", "--unknown"],
    ["migrate", "--steal", "--steal"],
  ]) {
    await expect(gatewayVerb(transport, "board", args)).rejects.toThrow("Usage");
  }
});

test("invalid migrations fail closed before networking", () => {
  setup();
  expect(() => validateMigrations([baseline, { ...expand, version: 3 }])).toThrow("ordered");
  expect(() =>
    validateMigrations([baseline, { ...contract, version: 2, requires: undefined }])
  ).toThrow("requires");
  expect(() => validateMigrations([baseline, { ...contract, version: 2 }])).toThrow(
    "earlier expand"
  );
});

test("pagination covers fields, cards and card values without losing moves or Progress", async () => {
  const board = setup();
  board.stamp(1);
  board.pageSize = 2;
  for (let index = 0; index < 5; index++) {
    board.card(String(index));
  }
  await board.service([baseline, expand]).migrate({});
  expect(board.cards.every((card) => card.values.Status === "Inbox")).toBe(true);
  expect(board.cards.every((card) => card.values.Progress === "🤖👍  🔁1️⃣2️⃣ 🔴 ")).toBe(true);
  expect(board.requests).toContain("BoardValues");
});

test("interruption after a successful batch replays only cards still on the old option", async () => {
  const board = setup();
  board.stamp(1);
  board.failBatch = 2;
  for (let index = 0; index < 27; index++) {
    board.card(String(index));
  }
  await expect(board.service([baseline, expand]).migrate({})).rejects.toThrow("Interrupted move");
  expect(board.cards.filter((card) => card.values.Status === "Inbox")).toHaveLength(25);
  expect(readState(board.readme).version).toBe(1);
  board.clock += 3600001;
  await board.service([baseline, expand]).migrate({ steal: true });
  expect(board.cards.every((card) => card.values.Status === "Inbox")).toBe(true);
  expect(board.batches).toBe(3);
});

test("all field/option operations replay idempotently and ignore unrelated fields in expect", async () => {
  const board = setup();
  board.stamp(1);
  const added: Migration = {
    version: 2,
    up: [
      {
        op: "add_field",
        field: "Extra",
        type: "single_select",
        options: ["Old"],
      },
      {
        op: "add_field",
        field: "Extra",
        type: "single_select",
        options: ["Old"],
      },
      { op: "add_option", field: "Extra", option: "New", color: "BLUE" },
      { op: "add_option", field: "Extra", option: "New", color: "BLUE" },
      {
        op: "set_option_meta",
        field: "Extra",
        option: "New",
        description: "Description",
        color: "GREEN",
      },
      {
        op: "set_option_meta",
        field: "Extra",
        option: "New",
        description: "Description",
        color: "GREEN",
      },
    ],
    expect: {
      ...baseline.expect,
      fields: {
        ...baseline.expect.fields,
        Extra: { type: "single_select", options: ["Old", "New"] },
      },
    },
  };
  await board.service([baseline, added]).migrate({});
  const option = board.fields.find((field) => field.name === "Extra")!.options[1];
  expect(option).toMatchObject({
    name: "New",
    color: "GREEN",
    description: "Description",
  });
  board.pin("example/project", "dev", "2.0.0");
  const removed: Migration = {
    version: 3,
    requires: "2.0.0",
    up: [
      { op: "remove_option", field: "Extra", option: "Old" },
      { op: "remove_option", field: "Extra", option: "Old" },
      { op: "remove_field", field: "Extra" },
      { op: "remove_field", field: "Extra" },
    ],
    expect: baseline.expect,
  };
  board.fields.push({
    id: "unowned",
    name: "Unrelated",
    createdAt: board.clock,
    type: "other",
    options: [],
  });
  await board.service([baseline, added, removed]).migrate({});
  expect(board.fields.some((field) => field.name === "Extra")).toBe(false);
  expect(board.fields.some((field) => field.name === "Unrelated")).toBe(true);
});

test("an occupied option cannot be removed, baseline drift cannot be stamped, and lost markers cannot be rewritten", async () => {
  const board = setup();
  board.fields.find((field) => field.name === "Status")!.options.reverse();
  await expect(board.service().migrate({})).rejects.toThrow("expect failed");
  expect(readState(board.readme).version).toBe(0);
  board.fields.find((field) => field.name === "Status")!.options.reverse();
  board.clock += 3600001;
  board.stamp(1);
  board.card();
  board.pin("example/project", "dev", "1.2.0");
  const migration: Migration = {
    version: 2,
    requires: "1.2.0",
    up: [{ op: "remove_option", field: "Status", option: "Backlog" }],
    expect: baseline.expect,
  };
  await expect(board.service([baseline, migration]).migrate({ steal: true })).rejects.toThrow(
    "occupied"
  );
  expect(readState(board.readme).version).toBe(1);
});

test("Progress rewrite alters only the matched state, including empty suffix and unrelated emoji", async () => {
  const board = setup();
  const progress = [
    "🤖👍",
    "🤖👍🔁2️⃣🔴",
    "🤖👍  🔁1️⃣ 🔴 ",
    "🤖👍\t🔴\n",
    "🤖👍🏼 other",
    "🤖🔨 🔁1️⃣",
  ];
  for (const [index, value] of progress.entries()) {
    board.card(String(index)).values.Progress = value;
  }
  board.pin("example/project", "dev", "1.2.0");
  await board.service([baseline, expand, contract]).migrate({});
  expect(board.cards.map((card) => card.values.Progress)).toEqual([
    "✅",
    "✅🔁2️⃣🔴",
    "✅  🔁1️⃣ 🔴 ",
    "✅\t🔴\n",
    "🤖👍🏼 other",
    "🤖🔨 🔁1️⃣",
  ]);
});

test("the vmethod repository itself satisfies a migration's adoption requirement", async () => {
  const board = setup();
  board.pinSelf("example/project", "dev");
  const migration: Migration = {
    version: 2,
    requires: "9.9.9",
    up: [{ op: "add_field", field: "Extra", type: "text" }],
    expect: baseline.expect,
  };
  await board.service([baseline, migration]).migrate({});
  expect(readState(board.readme).version).toBe(2);
  board.pin("example/project", "dev", "1.0.0");
  const next: Migration = {
    ...migration,
    version: 3,
    up: [{ op: "remove_field", field: "Extra" }],
  };
  await expect(board.service([baseline, migration, next]).migrate({})).rejects.toThrow("to adopt");
});
