import { expect, test } from "vitest";
import {
  claudeUsage,
  boardCost,
  dollars,
  opencodeUsage,
  parseBoardCost,
  sumUsd,
  usageDelta,
  zeroTokens,
} from "../src/cost.js";
import { learningReport } from "../src/learnings.js";
import { validateYaml } from "../src/config.js";
import session from "./fixtures/usage/opencode-session.json" with { type: "json" };
import results from "./fixtures/usage/claude-results.json" with { type: "json" };

test.each([
  [6.10557, "$6.11"],
  [0.004, "$0.00"],
  [4.2411964, "$4.24"],
] as const)("board Cost formats %s as %s", (usd, expected) =>
  expect(boardCost(usd)).toBe(expected)
);

test("board Cost reads formatted values and leaves malformed values unknown", () => {
  expect(parseBoardCost("$6.11")).toBe(6.11);
  expect(parseBoardCost("abc")).toBeNull();
});

test.each([
  { input: 1, output: 2 },
  { input: 1, output: 2, cached: 3, reasoning: 4 },
  { input: 1, output: -2, cached: 3 },
  { input: "1", output: 2, cached: 3 },
])("model prices require exactly three nonnegative numeric categories: %j", (price) => {
  expect(() =>
    validateYaml(
      JSON.stringify([
        {
          family: "sol",
          model: "test/sol",
          kind: "opencode",
          gate: "none",
          tier: "standard",
          price,
        },
      ]),
      "models",
      "models.yaml"
    )
  ).toThrow();
});

test("recorded OpenCode cumulative totals use API prices, not reported subscription cost", () => {
  const usage = opencodeUsage(session.data)!;
  expect(usage).toEqual({
    tokens: { input: 118893, output: 17446, cached: 3907968 },
    reportedUsd: 0,
  });
  expect(dollars(usage.tokens, { input: 2, output: 10, cached: 0.2 })).toBeCloseTo(1.1938396, 8);
  expect(dollars(usage.tokens, undefined)).toBeNull();
  expect(opencodeUsage({})).toBeUndefined();
  expect(
    opencodeUsage({ tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } } })
      ?.tokens
  ).toEqual({ input: 6, output: 5, cached: 4 });
  expect(
    opencodeUsage(
      { tokens: { input: 1, output: 2, reasoning: 3, cache: { write: 5 } } },
      { tokens: { input: 10, output: 20, cached: 30 } }
    )?.tokens
  ).toEqual({ input: 6, output: 5, cached: 30 });
  expect(() => opencodeUsage({ tokens: { input: "bad" } })).toThrow("Invalid provider");
});

test("real vecs Claude results sum per-turn usage but retain the latest cumulative reported cost", () => {
  const usage = claudeUsage([{ type: "assistant" }, ...results])!;
  expect(usage.tokens).toEqual({ input: 24357, output: 6, cached: 26201 });
  expect(usage.reportedUsd).toBeCloseTo(0.1027202, 8);
  expect(dollars(usage.tokens, { input: 3, output: 15, cached: 0.3 })).toBeCloseTo(0.0810213, 8);
});

test("Claude reported totals retain the latest per session across replacement sessions", () => {
  // Restore synthetic session ids removed by upstream sanitization; usage/cost stay recorded.
  const usage = claudeUsage([
    ...results.map((result) => ({ ...result, session_id: "first" })),
    { ...results[0], session_id: "replacement" },
  ])!;
  expect(usage.reportedUsd).toBeCloseTo(0.1574488, 8);
  expect(usage.tokens).toEqual({ input: 37489, output: 9, cached: 37074 });
});

test("segment deltas price each family once and propagate unknown cost", () => {
  const first = { tokens: { input: 100, output: 200, cached: 300 }, reportedUsd: 5 };
  const last = { tokens: { input: 400, output: 500, cached: 600 }, reportedUsd: 12 };
  expect(usageDelta(first, { tokens: zeroTokens(), reportedUsd: 0 })).toEqual(first);
  const second = usageDelta(last, first);
  expect(second).toEqual({ tokens: { input: 300, output: 300, cached: 300 }, reportedUsd: 7 });
  expect(
    sumUsd([
      dollars(first.tokens, { input: 1, output: 2, cached: 0.1 }),
      dollars(second.tokens, { input: 3, output: 4, cached: 0.2 }),
    ])
  ).toBeCloseTo(0.00269, 8);
  expect(sumUsd([1, null])).toBeNull();
  expect(() => usageDelta(first, last)).toThrow("decreased");
});

test("report uses family segment dollars and kind delivery dollars per final estimate point", () => {
  const report = learningReport([
    {
      date: "2026-10-18",
      repo: "example/project",
      pr: 1,
      task: "test",
      kind: "feature",
      segments: [
        { family: "sol", model: "test/sol", rounds: [1], why: "start", usd: 2 },
        { family: "glm", model: "test/glm", rounds: [2], why: "quota", usd: 1 },
      ],
      usd: 3,
      points_open: 3,
      points_final: 5,
      rounds: 2,
      round_causes: [],
      outcome: "merged",
      prompt_defects: [],
      stalls: [],
      findings: [],
      notes: "",
    },
  ]);
  expect(report.usdPerPoint).toBe(0.6);
  expect(report.byFamily.sol.usdPerPoint).toBe(0.4);
  expect(report.byFamily.glm.usdPerPoint).toBe(0.2);
  expect(report.byKind.feature.usdPerPoint).toBe(0.6);
});
