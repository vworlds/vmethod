import { expect, test } from "vitest";
import { accountUsage } from "../../src/sessions/usage.js";
import { opencodeRequests, opencodeUsage, type Usage } from "../../src/cost.js";
import session from "../fixtures/usage/opencode-session.json" with { type: "json" };
import messages from "../fixtures/usage/opencode-message.json" with { type: "json" };

// Same recordings as cost.test.ts and gateway/workers.test.ts. Projections below
// change ids, models, times and counts only to exercise polling/switch boundaries.
const models = [
  {
    family: "sol",
    model: "codexbal/gpt-6.1-sol",
    price: { input: 2, output: 10, cached: 0.2 },
    tiers: [{ minPrompt: 272000, input: 4, output: 15, cached: 0.4 }],
  },
];
const at = new Date(messages.data[0].time.created).toISOString();
const segment = { family: "sol", model: models[0].model, at, rounds: [1], why: "start" };
const record = () => ({ version: 1, segments: [{ ...segment }] });
const usage = opencodeUsage(session.data)!;
const requests = opencodeRequests(messages.data);
const messageUsage = opencodeUsage(messages.data[0])!;

test("recorded cumulative totals retain the totals-only golden cost", () => {
  const before = record();
  const result = accountUsage(before, { usage }, models)!;
  expect(result).toEqual({
    ...before,
    segments: [
      {
        ...segment,
        usage: {
          tokens: { input: 118893, output: 17446, cached: 3907968 },
          reportedUsd: 0,
        },
        requests: {},
        usd: 1.1938396,
        lowerBound: true,
      },
    ],
  });
  expect(before).toEqual(record());
});

test("recorded request history retains exact prices and full-history marker", () => {
  const result = accountUsage(record(), { usage: messageUsage, requests }, models)!;
  expect(result).toEqual({
    ...record(),
    costHistoryLoaded: true,
    segments: [
      {
        ...segment,
        usage: { tokens: { input: 722, output: 65, cached: 83712 }, reportedUsd: 0 },
        requests: {
          msg_recorded: {
            tokens: { input: 722, output: 65, cached: 83712 },
            usd: 0.018836400000000003,
          },
        },
        usd: 0.018836400000000003,
        lowerBound: false,
      },
    ],
  });
  const before = structuredClone(result);
  const repricedModels = models.map((model) => ({
    ...model,
    price: { input: 99, output: 99, cached: 99 },
  }));
  expect(accountUsage(result, { usage: messageUsage, requests }, repricedModels)).toEqual(before);
  expect(accountUsage(result, { usage: messageUsage, requests: [] }, models)).toEqual(before);
  expect(result).toEqual(before);
});

test("streaming changes reprice a cached request without mutating the prior poll", () => {
  const first = accountUsage(record(), { usage: messageUsage, requests }, models)!;
  const before = structuredClone(first);
  const tokens = { input: 722, output: 130, cached: 83712 };
  const updated = accountUsage(
    first,
    {
      usage: { tokens, reportedUsd: 0 },
      requests: [{ ...requests[0], tokens }],
    },
    models
  )!;
  expect(updated.segments[0]).toMatchObject({
    usage: { tokens, reportedUsd: 0 },
    usd: 0.0194864,
    lowerBound: false,
    requests: { msg_recorded: { tokens, usd: 0.0194864 } },
  });
  expect(first).toEqual(before);
});

test("partial request history prices only its unmeasured remainder at base rates", () => {
  const result = accountUsage(record(), { usage, requests }, models)!;
  expect(result.segments[0]).toMatchObject({ usage, usd: 1.1938396000000002, lowerBound: true });
});

test("request tier cost differs from cumulative base-price lower bound", () => {
  const projected = {
    ...messages.data[0],
    tokens: { input: 300000, output: 1000, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  const result = accountUsage(
    record(),
    {
      usage: opencodeUsage(projected),
      requests: opencodeRequests([projected]),
    },
    models
  )!;
  expect(result.segments[0]).toMatchObject({
    usage: { tokens: { input: 300000, output: 1000, cached: 0 }, reportedUsd: 0 },
    usd: 1.215,
    lowerBound: false,
  });
});

test.each([
  "unique model",
  "repeated model",
  "missing model",
  "prior id",
  "excess history",
  "cached excess",
])("switch attribution preserves prior segments: %s", (mode) => {
  const prior = {
    ...segment,
    model: mode === "repeated model" ? segment.model : "fake/luna",
    usage: { tokens: { input: 100, output: 20, cached: 30 }, reportedUsd: 0 },
    usd: 0.0123,
    ...(mode === "prior id"
      ? { requests: { old: { tokens: { input: 100, output: 20, cached: 30 }, usd: 0.0123 } } }
      : {}),
  };
  const current = {
    ...segment,
    baseline: prior.usage,
    ...(mode === "cached excess"
      ? { requests: { contaminated: { tokens: { input: 400, output: 40, cached: 60 }, usd: 9 } } }
      : {}),
  };
  const before = { segments: [prior, current] };
  const snapshot = structuredClone(before);
  const projected = (id: string, created: number, input: number) => ({
    ...messages.data[0],
    id,
    model: mode === "missing model" ? undefined : messages.data[0].model,
    time: { ...messages.data[0].time, created },
    tokens: { input, output: 20, reasoning: 0, cache: { read: 30, write: 0 } },
  });
  const result = accountUsage(
    before,
    {
      usage: { tokens: { input: 400, output: 40, cached: 60 }, reportedUsd: 0 },
      requests: opencodeRequests([
        projected("old", Date.parse(at) - 1, 100),
        projected(
          "new",
          Date.parse(at) - Number(mode === "unique model"),
          mode === "excess history" ? 301 : 300
        ),
      ]).map((request) =>
        mode === "unique model" && request.id === "old"
          ? { ...request, model: "fake/luna" }
          : request
      ),
    },
    models
  )!;
  const fallback = ["excess history", "cached excess"].includes(mode);
  // In the unique-model case a pre-start request is eligible too; its old model
  // above excludes it. Repeated/missing models instead use creation boundaries.
  expect(result.segments[0]).toEqual(prior);
  expect(result.segments[1]).toEqual({
    ...current,
    usage: { tokens: { input: 300, output: 20, cached: 30 }, reportedUsd: 0 },
    requests: fallback
      ? {}
      : { new: { tokens: { input: 300, output: 20, cached: 30 }, usd: 0.000806 } },
    usd: 0.000806,
    lowerBound: fallback,
  });
  expect(before).toEqual(snapshot);
});

test("compactions merge once at the inclusive current-segment boundary", () => {
  const before = { segments: [{ ...segment, compactionIds: ["seen"] }] };
  const result = accountUsage(
    before,
    {
      usage,
      compactions: [
        { id: "old", created: Date.parse(at) - 1 },
        { id: "seen", created: Date.parse(at) },
        { id: "new", created: Date.parse(at) },
        { id: "new", created: Date.parse(at) + 1 },
      ],
    },
    models
  )!;
  expect(result.segments[0].compactionIds).toEqual(["seen", "new"]);
  expect(before.segments[0].compactionIds).toEqual(["seen"]);
  expect(
    accountUsage(record(), { usage, compactions: [] }, models)!.segments[0].compactionIds
  ).toEqual([]);
  expect(accountUsage(record(), { usage }, models)!.segments[0].compactionIds).toBeUndefined();
});

test("missing usage and finalized records produce no write; missing prices stay null", () => {
  expect(accountUsage(record(), {}, models)).toBeUndefined();
  expect(
    accountUsage({ ...record(), finalized: true }, { usage, requests }, models)
  ).toBeUndefined();
  expect(accountUsage(record(), { usage }, [])!.segments[0].usd).toBeNull();
  expect(accountUsage(record(), { usage: messageUsage, requests }, [])!.segments[0]).toMatchObject({
    usd: null,
    lowerBound: false,
  });
});

test.each([
  { tokens: { input: 723, output: 65, cached: 83712 } },
  { tokens: messageUsage.tokens, reportedUsd: 1 },
] satisfies Usage[])(
  "provider decreases still throw without changing the record: %j",
  (baseline) => {
    const before = { segments: [{ ...segment, baseline }] };
    const snapshot = structuredClone(before);
    expect(() => accountUsage(before, { usage: messageUsage, requests }, models)).toThrow(
      "decreased; cannot account for segment"
    );
    expect(before).toEqual(snapshot);
  }
);
