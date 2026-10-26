import { expect, test } from "vitest";
import { taskFlowVerb } from "../src/cli/task-flow.js";
import type { Transport } from "../src/gateway/transport.js";

test("review routes owner agreement independently of the reply target and rejects malformed flags", async () => {
  const calls: unknown[] = [];
  const transport: Transport = {
    call: async (operation, input) => {
      calls.push({ operation, input });
      return "ok" as never;
    },
  };
  const agreement = "https://github.com/example/project/pull/27#issuecomment-2";
  const reply = "https://github.com/example/project/pull/27#issuecomment-1";
  for (const options of [
    ["answer.md", "--owner-agreed", agreement, "--in-reply-to", reply],
    ["--in-reply-to", reply, "--owner-agreed", agreement, "answer.md"],
  ]) {
    await taskFlowVerb(transport, "review", ["27", "answer", ...options], {});
  }
  expect(calls).toEqual(
    Array(2).fill({
      operation: "reviewTask",
      input: {
        ref: "27",
        outcome: "answer",
        file: "answer.md",
        ownerAgreed: agreement,
        replyTo: reply,
      },
    })
  );
  calls.length = 0;
  for (const options of [
    ["answer.md", "--owner-agreed"],
    ["answer.md", "--owner-agreed", "--in-reply-to", reply],
    ["answer.md", "--owner-agreed", agreement, "--owner-agreed", agreement],
    ["answer.md", "--in-reply-to", reply, "--in-reply-to", reply],
    ["answer.md", "another.md"],
  ]) {
    await expect(
      taskFlowVerb(transport, "review", ["27", "answer", ...options], {})
    ).rejects.toThrow("Usage: review");
  }
  expect(calls).toEqual([]);
});

test("owner reply accepts the reply flag before the file", async () => {
  const transport: Transport = {
    call: async (operation, input) => {
      expect(operation).toBe("reviewTask");
      expect(input).toEqual({
        ref: "27",
        outcome: "owner",
        file: "answer.md",
        replyTo: "https://github.com/example/project/pull/27#issuecomment-1",
      });
      return "ok" as never;
    },
  };
  await taskFlowVerb(
    transport,
    "review",
    [
      "27",
      "owner",
      "--in-reply-to",
      "https://github.com/example/project/pull/27#issuecomment-1",
      "answer.md",
    ],
    { VMETHOD_ROLE: "orchestrator" }
  );
});

test("resolve-conflicts routes only its single PR argument through the orchestrator transport", async () => {
  const calls: unknown[] = [];
  const transport: Transport = {
    call: async (operation, input, ctx) => {
      calls.push({ operation, input, ctx });
      return "RESOLVED #27 (step 1)" as never;
    },
  };
  expect(
    await taskFlowVerb(transport, "resolve-conflicts", ["27"], { VMETHOD_ROLE: "orchestrator" })
  ).toBe("RESOLVED #27 (step 1)");
  expect(calls).toEqual([
    { operation: "resolveConflicts", input: { ref: "27" }, ctx: { role: "orchestrator" } },
  ]);
  calls.length = 0;
  await taskFlowVerb(transport, "resolve-conflicts", ["27", "--retry"], {
    VMETHOD_ROLE: "orchestrator",
  });
  expect(calls).toEqual([
    {
      operation: "resolveConflicts",
      input: { ref: "27", retry: true },
      ctx: { role: "orchestrator" },
    },
  ]);
  calls.length = 0;
  for (const args of [[], ["27", "--force"], ["27", "--retry", "--retry"], ["--retry"]]) {
    await expect(
      taskFlowVerb(transport, "resolve-conflicts", args, { VMETHOD_ROLE: "orchestrator" })
    ).rejects.toThrow("Usage: resolve-conflicts");
  }
  expect(calls).toEqual([]);
});

test("task-flow CLI routes typed inputs and rejects malformed options before transport", async () => {
  const calls: unknown[] = [];
  const transport: Transport = {
    call: async (operation, input, ctx) => {
      calls.push({ operation, input, ctx });
      return "ok" as never;
    },
  };
  const env = { VMETHOD_ROLE: "orchestrator" };
  await taskFlowVerb(
    transport,
    "open-task",
    ["8", "--model", "astra", "--hold", "--owner-approved", "--unapproved", "reproducer"],
    env
  );
  await taskFlowVerb(transport, "open-task", ["--direct", "fix: small task"], env);
  await taskFlowVerb(transport, "open-task", ["8", "--part"], env);
  await taskFlowVerb(transport, "open-task", ["8", "--from", "owner-side"], env);
  await taskFlowVerb(
    transport,
    "review",
    [
      "27",
      "owner",
      "review.md",
      "--in-reply-to",
      "https://github.com/example/project/pull/27#issuecomment-1",
    ],
    env
  );
  await taskFlowVerb(transport, "merge-task", ["27", "--merge-commit"], env);
  await taskFlowVerb(transport, "release-hold", ["27"], env);
  await taskFlowVerb(transport, "link-task", ["27"], env);
  await taskFlowVerb(transport, "link-task", ["27", "--complete"], env);
  await taskFlowVerb(transport, "link-task", ["27", "--unlink"], env);
  expect(calls).toEqual([
    {
      operation: "openTask",
      input: {
        issue: "8",
        model: "astra",
        hold: true,
        ownerApproved: true,
        unapproved: "reproducer",
      },
      ctx: { role: "orchestrator" },
    },
    { operation: "openTask", input: { direct: "fix: small task" }, ctx: { role: "orchestrator" } },
    { operation: "openTask", input: { issue: "8", part: true }, ctx: { role: "orchestrator" } },
    {
      operation: "openTask",
      input: { issue: "8", from: "owner-side" },
      ctx: { role: "orchestrator" },
    },
    {
      operation: "reviewTask",
      input: {
        ref: "27",
        outcome: "owner",
        file: "review.md",
        replyTo: "https://github.com/example/project/pull/27#issuecomment-1",
      },
      ctx: { role: "orchestrator" },
    },
    {
      operation: "mergeTask",
      input: { ref: "27", mergeCommit: true },
      ctx: { role: "orchestrator" },
    },
    { operation: "releaseHold", input: { ref: "27" }, ctx: { role: "orchestrator" } },
    {
      operation: "linkTask",
      input: { ref: "27", complete: false, unlink: false },
      ctx: { role: "orchestrator" },
    },
    {
      operation: "linkTask",
      input: { ref: "27", complete: true, unlink: false },
      ctx: { role: "orchestrator" },
    },
    {
      operation: "linkTask",
      input: { ref: "27", complete: false, unlink: true },
      ctx: { role: "orchestrator" },
    },
  ]);
  calls.length = 0;
  for (const [verb, args] of [
    ["open-task", ["8", "--unapproved"]],
    ["open-task", ["8", "--hold", "--hold"]],
    ["open-task", ["8", "--from"]],
    ["merge-task", ["27", "--force"]],
    ["link-task", []],
    ["link-task", ["27", "--force"]],
    ["link-task", ["27", "--complete", "--unlink"]],
    ["review", ["27", "owner"]],
    ["release-hold", []],
  ] as [string, string[]][]) {
    await expect(taskFlowVerb(transport, verb, args, env)).rejects.toThrow();
  }
  expect(calls).toEqual([]);
});

test("merge-task carries a nonempty certification reason and preserves merge mode", async () => {
  const calls: unknown[] = [];
  const transport: Transport = {
    call: async (operation, input) => {
      calls.push({ operation, input });
      return "ok" as never;
    },
  };
  await taskFlowVerb(
    transport,
    "merge-task",
    ["27", "--carry-approval", "Conflict only", "--merge-commit"],
    {}
  );
  expect(calls).toEqual([
    {
      operation: "mergeTask",
      input: { ref: "27", mergeCommit: true, carryApproval: "Conflict only" },
    },
  ]);
  for (const args of [
    ["27", "--carry-approval"],
    ["27", "--carry-approval", " "],
    ["27", "--carry-approval", "why", "--carry-approval", "again"],
  ]) {
    await expect(taskFlowVerb(transport, "merge-task", args, {})).rejects.toThrow();
  }
  expect(calls).toHaveLength(1);
});

test("open-task routes --model-override and refuses an empty reason before transport", async () => {
  const calls: unknown[] = [];
  const transport: Transport = {
    call: async (operation, input, ctx) => {
      calls.push({ operation, input, ctx });
      return "ok" as never;
    },
  };
  const env = { VMETHOD_ROLE: "orchestrator" };
  await taskFlowVerb(
    transport,
    "open-task",
    ["8", "--model", "sol", "--model-override", "bounded task"],
    env
  );
  expect(calls).toEqual([
    {
      operation: "openTask",
      input: { issue: "8", model: "sol", modelOverride: "bounded task" },
      ctx: { role: "orchestrator" },
    },
  ]);
  calls.length = 0;
  for (const args of [
    ["8", "--model", "sol", "--model-override"],
    ["8", "--model", "sol", "--model-override", ""],
  ]) {
    await expect(taskFlowVerb(transport, "open-task", args, env)).rejects.toThrow();
  }
  expect(calls).toEqual([]);
});
