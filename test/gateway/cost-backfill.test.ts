import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { backfillCosts } from "../../src/gateway/cost-backfill.js";
import { gatewayVerb } from "../../src/cli/gateway.js";
import capture from "../fixtures/usage/opencode-session.json" with { type: "json" };

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

test("prices recorded worker sessions using the recorded OpenCode session shape", async () => {
  const root = mkdtempSync(join(tmpdir(), "vmethod-cost-"));
  roots.push(root);
  const workers = join(root, "state/vmethod/test/workers");
  mkdirSync(workers, { recursive: true });
  writeFileSync(
    join(workers, "41.json"),
    JSON.stringify({
      pr: 41,
      repo: "vworlds/vmethod",
      sessions: ["ses_capture"],
      model: { kind: "opencode", family: "sol" },
    })
  );
  const currentCost = new Map<number, string>();
  const setCost = vi.fn(async (pr: number, value: string) => {
    currentCost.set(pr, value);
  });
  const deps = {
    root,
    config: { repo: "vworlds/vmethod", stateName: "test" },
    env: { XDG_STATE_HOME: join(root, "state") },
    models: [
      {
        family: "sol",
        model: "codexbal/gpt-6.1-sol",
        price: { input: 2, output: 10, cached: 0.1 },
      },
    ],
    readSession: async () => capture.data,
    inspectCard: async (pr: number) => ({ cost: currentCost.get(pr), archived: false }),
    setCost,
  };
  const result = await backfillCosts(deps);
  const rerun = await backfillCosts(deps);
  expect(result).toContain("#41: ≥ $");
  expect(rerun).toContain("#41: ≥ $");
  expect(setCost).toHaveBeenCalledOnce();
  expect(setCost.mock.calls[0][0]).toBe(41);
});

test("parses repeated PR selectors and keeps the command orchestrator-scoped", async () => {
  const calls: unknown[] = [];
  const transport = {
    call: async (operation: string, input: unknown, context: unknown) => {
      calls.push({ operation, input, context });
      return "ok";
    },
  } as never;
  await gatewayVerb(transport, "cost", ["backfill", "--dry-run", "--pr", "41", "--pr", "42"], {
    VMETHOD_ROLE: "orchestrator",
  });
  expect(calls[0]).toMatchObject({
    operation: "costBackfill",
    input: { dryRun: true, prs: [41, 42] },
    context: { role: "orchestrator" },
  });
});

test("backfill prices a 300k request at its tier and a 30k request at base, not cumulative size", async () => {
  const root = mkdtempSync(join(tmpdir(), "vmethod-cost-"));
  roots.push(root);
  const workers = join(root, "state/vmethod/test/workers");
  mkdirSync(workers, { recursive: true });
  writeFileSync(
    join(workers, "41.json"),
    JSON.stringify({ pr: 41, repo: "vworlds/vmethod", id: "ses_tier" })
  );
  const tokens = (input: number) => ({
    input,
    output: 1000,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  });
  const model = { providerID: "codexbal", id: "gpt-6-luna" };
  const setCost = vi.fn(async () => undefined);
  const result = await backfillCosts({
    root,
    config: { repo: "vworlds/vmethod", stateName: "test" },
    env: { XDG_STATE_HOME: join(root, "state") },
    models: [
      {
        family: "luna",
        model: "codexbal/gpt-6-luna",
        price: { input: 0.1, output: 0.5, cached: 0.01 },
        tiers: [{ minPrompt: 272000, input: 0.2, output: 0.75, cached: 0.02 }],
      },
    ],
    readSession: async () => ({
      session: { model, tokens: { ...tokens(330000), output: 2000 } },
      messages: [300000, 30000].map((input, i) => ({
        type: "assistant",
        id: `m${i}`,
        model,
        tokens: tokens(input),
      })),
    }),
    setCost,
  });
  expect(result).toContain("#41: $0.06");
  expect(result).not.toContain("≥");
  expect(setCost).toHaveBeenCalledWith(41, "$0.06");
});

test("dry-run reports unknown sessions without writing", async () => {
  const root = mkdtempSync(join(tmpdir(), "vmethod-cost-"));
  roots.push(root);
  const workers = join(root, "state/vmethod/test/workers");
  mkdirSync(workers, { recursive: true });
  writeFileSync(
    join(workers, "42.json"),
    JSON.stringify({
      pr: 42,
      repo: "vworlds/vmethod",
      id: "ses_gone",
      model: { kind: "opencode", family: "sol" },
    })
  );
  const setCost = vi.fn(async (pr: number, value: string) => void [pr, value]);
  const result = await backfillCosts(
    {
      root,
      config: { repo: "vworlds/vmethod", stateName: "test" },
      env: { XDG_STATE_HOME: join(root, "state") },
      models: [],
      readSession: async () => undefined,
      setCost,
    },
    { dryRun: true }
  );
  expect(result).toContain("#42: unknown");
  expect(result).toContain("session not found on server");
  expect(setCost).not.toHaveBeenCalled();
});

test("explains unreachable and still-running sessions without repeating connection reports", async () => {
  const root = mkdtempSync(join(tmpdir(), "vmethod-cost-"));
  roots.push(root);
  const workers = join(root, "state/vmethod/test/workers");
  mkdirSync(workers, { recursive: true });
  for (const pr of [46, 47, 48, 49]) {
    writeFileSync(
      join(workers, `${pr}.json`),
      JSON.stringify({ pr, repo: "vworlds/vmethod", id: `ses_${pr}` })
    );
  }
  const report = vi.fn();
  const output = await backfillCosts({
    root,
    config: { repo: "vworlds/vmethod", stateName: "test" },
    env: { XDG_STATE_HOME: join(root, "state") },
    models: [],
    readSession: async (id) => {
      if (id === "ses_48") {
        return { running: true, session: { tokens: {} } };
      }
      if (id === "ses_49") {
        return {
          session: {
            model: { providerID: "unknown", id: "model" },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          messages: [],
        };
      }
      throw new Error("unavailable");
    },
    setCost: async () => undefined,
    report,
  });
  expect(output).toContain("#46: unknown (opencode unreachable)");
  expect(output).toContain("#48: unknown (session still running (ses_48))");
  expect(output).toContain("#49: unknown (no price for unknown/model)");
  expect(report).toHaveBeenCalledOnce();
});

test("discovers legacy worktree sessions and prices assistant messages by family", async () => {
  const root = mkdtempSync(join(tmpdir(), "vmethod-cost-"));
  roots.push(root);
  const legacy = join(root, "state/old");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "job.worktrees_auto-43-test"), "ses_legacy\n");
  mkdirSync(join(root, ".vmethod"));
  writeFileSync(join(root, ".vmethod/model-log.jsonl"), JSON.stringify(logRecord(43)) + "\n");
  const messages = [
    {
      type: "assistant",
      model: { providerID: "codexbal", id: "gpt-6.1-sol" },
      tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    {
      type: "assistant",
      model: { providerID: "ollama-cloud", id: "glm-5.3" },
      tokens: { input: 0, output: 1_000_000, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  ];
  const setCost = vi.fn(async () => undefined);
  const result = await backfillCosts({
    root,
    config: {
      repo: "vworlds/vmethod",
      stateName: "test",
      legacyWorkers: ["old"],
      branches: { worktreePrefix: "auto-" },
    },
    env: { XDG_STATE_HOME: join(root, "state") },
    models: [
      {
        family: "sol",
        model: "codexbal/gpt-6.1-sol",
        price: { input: 2, output: 10, cached: 0.1 },
      },
      {
        family: "glm",
        model: "ollama-cloud/glm-5.3",
        price: { input: 0.079, output: 2.5, cached: 0.078 },
      },
    ],
    readSession: async () => ({
      session: {
        model: { providerID: "codexbal", id: "gpt-6.1-sol" },
        tokens: { input: 1_000_000, output: 1_000_000, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      messages,
    }),
    setCost,
  });
  expect(result).toContain("#43: ≥ $4.50 (legacy record, last session only)");
  expect(setCost).toHaveBeenCalledWith(43, "≥ $4.50");
  const log = JSON.parse(readFileSync(join(root, ".vmethod/model-log.jsonl"), "utf8"));
  expect(log).toMatchObject({ costSource: "backfill-partial", costCoverage: "partial", usd: 4.5 });
});

test("reconciles the first 200 messages against cumulative session totals", async () => {
  const root = mkdtempSync(join(tmpdir(), "vmethod-cost-"));
  roots.push(root);
  const workers = join(root, "state/vmethod/test/workers");
  mkdirSync(workers, { recursive: true });
  writeFileSync(
    join(workers, "45.json"),
    JSON.stringify({ pr: 45, repo: "vworlds/vmethod", sessions: ["ses_long"] })
  );
  mkdirSync(join(root, ".vmethod"));
  writeFileSync(join(root, ".vmethod/model-log.jsonl"), JSON.stringify(logRecord(45)) + "\n");
  const messages = Array.from({ length: 200 }, (_, index) => ({
    type: "assistant",
    id: `message-${index}`,
    model: { providerID: "codexbal", id: "gpt-6.1-sol" },
    tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }));
  const result = await backfillCosts({
    root,
    config: { repo: "vworlds/vmethod", stateName: "test" },
    env: { XDG_STATE_HOME: join(root, "state") },
    models: [
      { family: "sol", model: "codexbal/gpt-6.1-sol", price: { input: 1, output: 1, cached: 1 } },
    ],
    readSession: async () => ({
      session: {
        model: { providerID: "codexbal", id: "gpt-6.1-sol" },
        tokens: { input: 250_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      messages,
    }),
    setCost: async () => undefined,
  });
  expect(result).toContain("#45: ≥ $250.00");
  expect(result).toContain("partial message history; remainder priced at sol");
  const log = JSON.parse(readFileSync(join(root, ".vmethod/model-log.jsonl"), "utf8"));
  expect(log.usd).toBe(250);
});

test("fills missing model-log usd with backfill provenance", async () => {
  const root = mkdtempSync(join(tmpdir(), "vmethod-cost-"));
  roots.push(root);
  const workers = join(root, "state/vmethod/test/workers");
  mkdirSync(workers, { recursive: true });
  writeFileSync(
    join(workers, "44.json"),
    JSON.stringify({
      pr: 44,
      repo: "vworlds/vmethod",
      id: "ses_log",
      model: { kind: "opencode", family: "sol" },
    })
  );
  mkdirSync(join(root, ".vmethod"));
  writeFileSync(
    join(root, ".vmethod/model-log.jsonl"),
    JSON.stringify({
      date: "2026-10-18",
      repo: "vworlds/vmethod",
      pr: 44,
      task: "task",
      kind: "tooling",
      segments: [{ family: "sol", model: "codexbal/gpt-6.1-sol", rounds: [1], why: "start" }],
      points_open: 1,
      points_final: 1,
      rounds: 1,
      round_causes: [],
      outcome: "merged",
      prompt_defects: [],
      stalls: [],
      findings: [],
      notes: "",
    }) + "\n"
  );
  const setCost = vi.fn(async () => undefined);
  const report = await backfillCosts({
    root,
    config: { repo: "vworlds/vmethod", stateName: "test" },
    env: { XDG_STATE_HOME: join(root, "state") },
    models: [
      {
        family: "sol",
        model: "codexbal/gpt-6.1-sol",
        price: { input: 2, output: 10, cached: 0.1 },
      },
    ],
    readSession: async () => ({
      tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      model: { providerID: "codexbal", id: "gpt-6.1-sol" },
    }),
    inspectCard: async () => ({ cost: null, archived: true }),
    setCost,
  });
  expect(report).toContain("#44: archived; ≥ $2.00 recorded in the model log only");
  expect(setCost).not.toHaveBeenCalled();
  const log = JSON.parse(readFileSync(join(root, ".vmethod/model-log.jsonl"), "utf8"));
  expect(log).toMatchObject({
    usd: 2,
    costSource: "backfill-partial",
    costBasis: "api-list",
    costCoverage: "partial",
  });
});

test("keeps both archived PR costs when backfilling multiple model-log records", async () => {
  const root = mkdtempSync(join(tmpdir(), "vmethod-cost-"));
  roots.push(root);
  const workers = join(root, "state/vmethod/test/workers");
  mkdirSync(workers, { recursive: true });
  for (const pr of [51, 52]) {
    writeFileSync(
      join(workers, `${pr}.json`),
      JSON.stringify({
        pr,
        repo: "vworlds/vmethod",
        id: `ses_${pr}`,
      })
    );
  }
  mkdirSync(join(root, ".vmethod"));
  writeFileSync(
    join(root, ".vmethod/model-log.jsonl"),
    [logRecord(51), logRecord(52)].map((record) => JSON.stringify(record)).join("\n") + "\n"
  );
  const report = await backfillCosts({
    root,
    config: { repo: "vworlds/vmethod", stateName: "test" },
    env: { XDG_STATE_HOME: join(root, "state") },
    models: [
      {
        family: "sol",
        model: "codexbal/gpt-6.1-sol",
        price: { input: 2, output: 10, cached: 0.1 },
      },
    ],
    readSession: async () => capture.data,
    inspectCard: async () => ({ archived: true }),
    setCost: async () => undefined,
  });

  expect(report).toContain("#51: archived; ≥ $");
  expect(report).toContain("#52: archived; ≥ $");
  const records = readFileSync(join(root, ".vmethod/model-log.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records).toHaveLength(2);
  expect(records.map((record) => record.usd)).toEqual([expect.any(Number), expect.any(Number)]);
});

function logRecord(pr: number) {
  return {
    date: "2026-10-18",
    repo: "vworlds/vmethod",
    pr,
    task: "task",
    kind: "tooling",
    segments: [{ family: "sol", model: "codexbal/gpt-6.1-sol", rounds: [1], why: "start" }],
    points_open: 1,
    points_final: 1,
    rounds: 1,
    round_causes: [],
    outcome: "merged",
    prompt_defects: [],
    stalls: [],
    findings: [],
    notes: "",
  };
}
