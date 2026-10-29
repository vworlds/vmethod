import { expect, test } from "vitest";
import { cleanBaseMerges } from "../../src/evidence/clean-base.js";

const old = "a".repeat(40),
  head = "b".repeat(40),
  base = "c".repeat(40),
  tree = "d".repeat(40);
function fake(overrides: Record<string, string | Error> = {}) {
  const answers: Record<string, string | Error> = {
    [`rev-list --first-parent --parents ${old}..${head}`]: `${head} ${old} ${base}`,
    [`merge-base --is-ancestor ${base} ${base}`]: "",
    [`merge-tree --write-tree ${old} ${base}`]: tree,
    [`rev-parse ${head}^{tree}`]: tree,
    [`merge-base ${old} ${base}`]: old,
    [`merge-base ${head} ${base}`]: base,
    [`diff --name-only -z ${old} ${old}`]: "task.ts\0",
    [`diff --name-only -z ${base} ${head}`]: "task.ts\0",
    [`diff --binary --full-index ${old} ${old} -- task.ts`]: "patch",
    [`diff --binary --full-index ${base} ${head} -- task.ts`]: "patch",
    ...overrides,
  };
  return async (...args: string[]) => {
    const key = args.join(" ");
    if (!(key in answers)) {
      throw new Error(`Unexpected git ${key}`);
    }
    const value = answers[key];
    if (value instanceof Error) {
      throw value;
    }
    return value;
  };
}
test("approval survives only recomputed clean base merges with identical task patches", async () => {
  expect(await cleanBaseMerges(fake(), old, head, base)).toBe(true);
  expect(
    await cleanBaseMerges(fake({ [`rev-parse ${head}^{tree}`]: "e".repeat(40) }), old, head, base)
  ).toBe(false);
  expect(
    await cleanBaseMerges(
      fake({ [`diff --binary --full-index ${base} ${head} -- task.ts`]: "changed" }),
      old,
      head,
      base
    )
  ).toBe(false);
  expect(
    await cleanBaseMerges(
      fake({ [`merge-tree --write-tree ${old} ${base}`]: new Error("conflict") }),
      old,
      head,
      base
    )
  ).toBe(false);
  expect(
    await cleanBaseMerges(
      fake({ [`rev-list --first-parent --parents ${old}..${head}`]: `${head} ${old}` }),
      old,
      head,
      base
    )
  ).toBe(false);
});
