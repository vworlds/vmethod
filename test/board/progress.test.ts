import { expect, test } from "vitest";
import { parseProgress, renderProgress, progressStates } from "../../src/board/progress.js";
import { loadMigrations } from "../../src/board/migrations.js";
import { compatibility, readState } from "../../src/board/readme.js";
import { FakeBoard } from "./fake.js";

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
  const migrations = loadMigrations();
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
