import { expect, test } from "vitest";
import { parseProgress, renderProgress, progressStates } from "../../src/board/progress.js";
import { loadMigrations } from "../../src/board/migrations.js";
import { compatibility, readState } from "../../src/board/readme.js";
import { FakeBoard } from "./fake.js";
import type { Migration } from "../../src/board/types.js";

test.each([false, true])("HANDOFF is distinct from the round marker, red=%s", (red) => {
  const text = `🤖🤝 🔁2️⃣${red ? " 🔴" : ""}`;
  expect(parseProgress(text)).toEqual({ state: "handoff", round: 2, red });
  expect(renderProgress(parseProgress(text))).toBe(text);
});

test("migration 0002 expands the Progress table without contracting version-1 cards or scripts", async () => {
  const board = new FakeBoard();
  board.stamp(1, 1);
  const card = board.card();
  const before = structuredClone(card);
  const migrations = loadMigrations().slice(0, 2);
  const result = await board.service(migrations).migrate({});
  expect(result.state.version).toBe(2);
  expect(result.state.minCompatible).toBe(1);
  expect(result.drift).toEqual([]);
  expect(card).toEqual(before);
  expect(migrations[1].up).toEqual([]);
  expect(migrations[1].requires).toBeUndefined();
  expect(
    Object.fromEntries(
      migrations[1].expect.fields.Progress.states!.map(({ name, emoji }) => [name, emoji])
    )
  ).toEqual(progressStates);
  expect(() => compatibility(readState(board.readme), 1, () => {})).not.toThrow();
  const oldStates = Object.fromEntries(
    Object.entries(progressStates).filter(([name]) => name !== "handoff")
  );
  expect(parseProgress("🤖🤝 🔁2️⃣ 🔴", oldStates)).toEqual({ state: null, round: 2, red: true });
  expect(parseProgress(before.values.Progress)).toEqual(
    parseProgress(before.values.Progress, oldStates)
  );
  board.done();
});

test("migration history preserves 0003 numeric Cost and dry-runs 0004 text replacement", async () => {
  const board = new FakeBoard();
  board.stamp(2, 1);
  const before = structuredClone(board.card());
  const migrations = loadMigrations();
  expect(migrations[2].up).toEqual([{ op: "add_field", field: "Cost", type: "number" }]);
  expect(migrations[3].up).toEqual([
    { op: "remove_field", field: "Cost" },
    { op: "add_field", field: "Cost", type: "text" },
  ]);
  const dry = await board.service(migrations).migrate({ dryRun: true });
  expect(dry.message).toContain("v4: remove field Cost");
  expect(dry.message).toContain("v4: add field Cost (text)");
  expect(board.cards).toEqual([before]);
  expect(() => compatibility(readState(board.readme), 1, () => {})).not.toThrow();
  board.done();
});

test("migration 0003 dry run on v2 names Cost and the version bump without writes", async () => {
  const board = new FakeBoard();
  board.stamp(2, 1);
  const before = { readme: board.readme, fields: structuredClone(board.fields) };
  const result = await board.service(loadMigrations()).migrate({ dryRun: true });
  expect(result.message).toBe(
    "Dry run: 2 → 4; v3: add field Cost (number); v4: remove field Cost; v4: add field Cost (text)"
  );
  expect(result.state.version).toBe(2);
  expect(result.pending.map((migration) => migration.version)).toEqual([3, 4]);
  expect(board.mutations).toEqual([]);
  expect({ readme: board.readme, fields: board.fields }).toEqual(before);
  board.done();
});

test("version-only dry runs still announce a bump; only an up-to-date board says no changes", async () => {
  const board = new FakeBoard();
  board.stamp(1, 1);
  const service = board.service(loadMigrations().slice(0, 2));
  const versionOnly = await service.migrate({ dryRun: true });
  expect(versionOnly.message).toBe("Dry run: 1 → 2; v2: version only");
  board.stamp(2, 1);
  expect((await service.migrate({ dryRun: true })).message).toBe("Dry run: no changes");
  expect(board.mutations).toEqual([]);
  board.done();
});

test("dry-run descriptions list every pending operation across migrations", async () => {
  const board = new FakeBoard();
  board.stamp(1, 1);
  const baseline = loadMigrations()[0];
  const migrations: Migration[] = [
    baseline,
    {
      version: 2,
      requires: "1.0.0",
      up: [
        { op: "add_field", field: "Cost", type: "number" },
        { op: "add_field", field: "Decision", type: "single_select", options: ["yes", "no"] },
        { op: "add_option", field: "Model", option: "custom" },
        {
          op: "set_option_meta",
          field: "Model",
          option: "custom",
          color: "GREEN",
          description: "Selected",
        },
        { op: "rename_option", field: "Status", from: "Backlog", to: "Inbox" },
        { op: "add_progress_alias", from: "old", to: "new" },
        { op: "remove_option", field: "Model", option: "other" },
        { op: "remove_field", field: "Unused" },
      ],
      expect: baseline.expect,
    },
    {
      version: 3,
      requires: "1.0.0",
      up: [{ op: "rewrite_progress", from: "old", to: "new" }],
      expect: baseline.expect,
    },
  ];
  const result = await board.service(migrations).migrate({ dryRun: true });
  expect(result.message).toBe(
    [
      "Dry run: 1 → 3",
      "v2: add field Cost (number)",
      "v2: add field Decision (single_select) with options yes, no",
      "v2: add option custom to Model",
      'v2: set option metadata Model.custom ({"color":"GREEN","description":"Selected"})',
      "v2: rename option Status: Backlog → Inbox",
      "v2: add Progress alias old → new",
      "v2: remove option other from Model",
      "v2: remove field Unused",
      "v3: rewrite Progress prefix old → new",
    ].join("; ")
  );
  expect(board.mutations).toEqual([]);
  board.done();
});
