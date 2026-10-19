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
  requestCost,
  claudeRequests,
  type RequestCosts,
} from "../src/cost.js";
import { learningReport } from "../src/learnings.js";
import { validateYaml } from "../src/config.js";
import session from "./fixtures/usage/opencode-session.json" with { type: "json" };
import results from "./fixtures/usage/claude-results.json" with { type: "json" };

const base = { input: 0.1, output: 0.5, cached: 0.01 };
const tiers = [{ minPrompt: 272000, input: 0.2, output: 0.75, cached: 0.02 }];

test.each([
  [300000, 0.06075],
  [30000, 0.0035],
  [272000, 0.0277],
  [272001, 0.0551502],
])("whole request with %s prompt tokens uses the matching tier", (input, expected) => {
  expect(dollars({ input, output: 1000, cached: 0 }, base, tiers)).toBeCloseTo(expected, 10);
});

test("cache reads and writes select the tier, output tokens do not", () => {
  const tokens = opencodeUsage({
    tokens: { input: 10000, output: 1000, reasoning: 0, cache: { read: 260000, write: 30000 } },
  })!.tokens;
  expect(dollars(tokens, base, tiers)).toBeCloseTo(0.01395, 10);
  expect(dollars({ input: 30000, output: 300000, cached: 0 }, base, tiers)).toBeCloseTo(0.153, 10);
});

test("per-message prices are summed, cached across polls and updated for streaming usage", () => {
  const cache: RequestCosts = {};
  let calls = 0;
  const rates = () => {
    calls++;
    return { price: base, tiers };
  };
  const requests = Array.from({ length: 10 }, (_, i) => ({
    id: `m${i}`,
    tokens: { input: 30000, output: 1000, cached: 0 },
  }));
  const total = { input: 300000, output: 10000, cached: 0 };
  expect(requestCost(total, requests, rates, base, cache)).toEqual({
    usd: expect.closeTo(0.035, 10),
    lowerBound: false,
  });
  requestCost(total, requests, rates, base, cache);
  expect(calls).toBe(10);
  const changed = { ...requests[0], tokens: { input: 300000, output: 1000, cached: 0 } };
  expect(requestCost({ ...total, input: 570000 }, [changed], rates, base, cache).usd).toBeCloseTo(
    0.09225,
    10
  );
  expect(calls).toBe(11);
});

test("totals-only and incomplete histories stay base-price lower bounds; unknown stays null", () => {
  const total = { input: 300000, output: 1000, cached: 0 };
  const cost = requestCost(
    total,
    [],
    () => {
      throw new Error("No requests");
    },
    base
  );
  expect(cost).toEqual({ usd: 0.0305, lowerBound: true });
  expect(boardCost(cost.usd, cost.lowerBound)).toBe("≥ $0.03");
  expect(requestCost(total, [], () => ({}), undefined).usd).toBeNull();
  expect(() =>
    requestCost(
      { input: 0, output: 0, cached: 0 },
      [{ id: "m", tokens: total }],
      () => ({ price: base }),
      base
    )
  ).toThrow("decreased");
});

// Derived from the recorded vecs usage block; the assistant envelope/id is the
// stream-json projection documented in issue 132, not a new raw capture.
test("Claude assistant usage is per request, deduplicated by message.id rather than result totals", () => {
  const first = { type: "assistant", message: { id: "msg-1", usage: results[0].usage } };
  const second = {
    type: "assistant",
    message: { id: "msg-2", usage: { ...results[1].usage, cache_read_input_tokens: 300000 } },
  };
  const events = [first, first, second, results[0], { ...results[1], usage: second.message.usage }];
  const requests = claudeRequests(events);
  expect(requests).toHaveLength(2);
  const usage = claudeUsage(events)!;
  expect(usage.tokens).toEqual({ input: 24357, output: 6, cached: 310873 });
  expect(usage.reportedUsd).toBeCloseTo(0.1027202, 8);
  expect(requestCost(usage.tokens, requests, () => ({ price: base, tiers }), base)).toEqual({
    usd: expect.closeTo(0.00967068, 8),
    lowerBound: false,
  });
});

test.each([
  [{ minPrompt: 0, ...base }],
  [{ minPrompt: 1.5, ...base }],
  [{ minPrompt: "272000", ...base }],
  [{ minPrompt: 272000, input: 1, output: 1 }],
  [{ minPrompt: 272000, ...base, extra: 1 }],
  [{ minPrompt: 272000, ...base, cached: -1 }],
  [
    { minPrompt: 272000, ...base },
    { minPrompt: 272000, input: 1, output: 1, cached: 1 },
  ],
  [{ minPrompt: 272000, ...base, input: 0 }],
])("invalid price tiers are rejected: %j", (...tiers) => {
  expect(() =>
    validateYaml(
      JSON.stringify([
        {
          family: "sol",
          model: "test/sol",
          kind: "opencode",
          gate: "none",
          tier: "standard",
          price: base,
          tiers,
        },
      ]),
      "models",
      "models.yaml"
    )
  ).toThrow();
});

test.each([
  [6.10557, "$6.11"],
  [0.004, "$0.00"],
  [4.2411964, "$4.24"],
] as const)("board Cost formats %s as %s", (usd, expected) =>
  expect(boardCost(usd)).toBe(expected)
);

test("board Cost reads formatted values and leaves malformed values unknown", () => {
  expect(parseBoardCost("$6.11")).toBe(6.11);
  expect(parseBoardCost("≥ $6.11")).toBe(6.11);
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

test("Claude running requests count after earlier results, then reconcile when their result arrives", () => {
  const events = results.map((result, index) => ({
    type: "assistant",
    message: { id: `running-${index}`, usage: result.usage },
  }));
  const running = [events[0], results[0], events[0], events[1], events[1]];
  expect(claudeUsage(running)?.tokens).toEqual({ input: 24357, output: 6, cached: 26201 });
  expect(claudeUsage([...running, results[1]])?.tokens).toEqual(claudeUsage(running)?.tokens);
  expect(claudeUsage(events)?.tokens).toEqual(claudeUsage(running)?.tokens);
});

test("tier order is independent of configuration order and tiers require base prices", () => {
  expect(
    dollars({ input: 600000, output: 1000, cached: 0 }, base, [
      { minPrompt: 500000, input: 1, output: 2, cached: 0.1 },
      ...tiers,
    ])
  ).toBeCloseTo(0.602, 10);
  expect(() =>
    validateYaml(
      JSON.stringify([
        {
          family: "sol",
          model: "test/sol",
          kind: "opencode",
          gate: "none",
          tier: "standard",
          tiers,
        },
      ]),
      "models",
      "models.yaml"
    )
  ).toThrow();
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
