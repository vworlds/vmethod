import { expect, test } from "vitest";
import { isModelApproved, modelGateError } from "../../src/evidence/model-gate.js";

const comment = (body: string, at: { createdAt?: string; lastEditedAt?: string | null } = {}) => ({
  body,
  createdAt: at.createdAt ?? "2026-10-20T10:00:00Z",
  lastEditedAt: at.lastEditedAt ?? null,
});

test("the exact owner line after the issue body's last edit approves the family", () => {
  const since = Date.parse("2026-10-19T00:00:00Z");
  expect(isModelApproved([comment("APPROVE MODEL fable")], "fable", since)).toBe(true);
  expect(isModelApproved([comment("APPROVE MODEL fable ")], "fable", since)).toBe(true);
  expect(isModelApproved([comment("APPROVE MODEL astra")], "astra", since)).toBe(true);
});

test("the line must be the comment's first line and the family must match exactly", () => {
  const since = Date.parse("2026-10-19T00:00:00Z");
  for (const body of [
    "I APPROVE MODEL fable",
    "please APPROVE MODEL fable",
    "APPROVE MODEL fable please",
    "APPROVE MODEL fable-extra",
    "APPROVE MODEL",
    "APPROVE THE MODEL fable",
    "approve model fable",
    "",
  ]) {
    expect(isModelApproved([comment(body)], "fable", since)).toBe(false);
  }
  // Later lines are data; only the first line carries the tag.
  expect(
    isModelApproved([comment("APPROVE MODEL fable\n\nsecond-line remarks")], "fable", since)
  ).toBe(true);
  expect(isModelApproved([comment("APPROVE MODEL fable")], "astra", since)).toBe(false);
});

test("an approval predating or equal to the last body edit is void", () => {
  const edited = "2026-10-20T10:00:00Z";
  const since = Date.parse(edited);
  expect(isModelApproved([comment("APPROVE MODEL fable")], "fable", since)).toBe(false);
  expect(
    isModelApproved(
      [
        comment("APPROVE MODEL fable", {
          createdAt: "2026-10-19T09:00:00Z",
          lastEditedAt: edited,
        }),
      ],
      "fable",
      since
    )
  ).toBe(false);
});

test("an approval posted after the last body edit wins, using the edit time when edited", () => {
  const since = Date.parse("2026-10-20T10:00:00Z");
  expect(
    isModelApproved(
      [comment("APPROVE MODEL fable", { createdAt: "2026-10-21T00:00:00Z" })],
      "fable",
      since
    )
  ).toBe(true);
  expect(
    isModelApproved(
      [comment("Discussion only", { createdAt: "2026-10-25T00:00:00Z" })],
      "fable",
      since
    )
  ).toBe(false);
  expect(
    isModelApproved(
      [
        comment("Wrong family here", { createdAt: "2026-10-19T00:00:00Z" }),
        comment("APPROVE MODEL fable", { createdAt: "2026-10-21T00:00:00Z" }),
      ],
      "fable",
      since
    )
  ).toBe(true);
});

test("unparseable times never qualify and a direct task without an issue is unbounded", () => {
  expect(
    isModelApproved(
      [{ body: "APPROVE MODEL fable", createdAt: undefined, lastEditedAt: null }],
      "fable",
      0
    )
  ).toBe(false);
  expect(
    isModelApproved(
      [{ body: "not the line", createdAt: "garbage", lastEditedAt: null }],
      "fable",
      undefined
    )
  ).toBe(false);
  // Direct tasks have no issue bound: any verified owner line approves.
  expect(isModelApproved([comment("APPROVE MODEL fable")], "fable", undefined)).toBe(true);
});

test("the refusal names both ways the owner can approve (#242)", () => {
  const message = modelGateError("fable").message;
  // The owner's two approval ways: the card's Model value, or the verifiable line.
  expect(message).toContain("card's Model to fable");
  expect(message).toContain("`APPROVE MODEL fable`");
  expect(message).toContain("issue or task PR");
  expect(() => {
    throw modelGateError("fable");
  }).toThrow(/APPROVE MODEL fable/);
});
