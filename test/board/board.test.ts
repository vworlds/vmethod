import { afterEach, expect, test } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { readState, writeState } from "../../src/board/readme.js";
import { validateMigrations } from "../../src/board/migrations.js";
import { createGateway } from "../../src/gateway/server.js";
import { gatewayVerb } from "../../src/cli/gateway.js";
import { validProject } from "../helpers.js";
import { people } from "../gateway/helpers.js";
import type { Migration } from "../../src/board/types.js";
import { baseline, FakeBoard } from "./fake.js";
import recordedFields from "../fixtures/github/board-fields.json" with { type: "json" };

let fake: FakeBoard;
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
  const service = board.service();
  expect((await service.snapshot()).fields[0].createdAt).toBe(Date.parse("2026-10-16T11:12:25Z"));
  await expect(
    service.set({ itemId: card.id, field: "Progress", value: "🤖🤝 🔁2️⃣" })
  ).resolves.toBe("Board field updated");
  expect(card.values.Progress).toBe("🤖🤝 🔁2️⃣");
  expect(board.mutations).toContain("BoardSetCards");
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

test("new operations use the same orchestrator policy and board CLI transport seam", async () => {
  const board = setup();
  const root = validProject();
  writeFileSync(join(root, "vmethod.yaml"), stringify(board.config));
  writeFileSync(join(root, "people.yaml"), stringify(people));
  const transport = createGateway(
    root,
    { FAKE_TOKEN: "offline", XDG_STATE_HOME: join(root, "state") },
    board.deps
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
  expect(
    JSON.parse(
      await gatewayVerb(transport, "board", ["status"], {
        VMETHOD_ROLE: "orchestrator",
      })
    ).state.version
  ).toBe(0);
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
