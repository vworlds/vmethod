import { expect, test } from "vitest";
import {
  step,
  type Effect,
  type Observation,
  type Phase,
  type Resolution,
} from "../../src/conflicts/machine.js";
import type { CiSnapshot } from "../../src/gateway/checks.js";
import {
  conflictTransitions,
  type Effect as OracleEffect,
  type TransitionRow,
} from "../gateway/conflict-table.js";

test("oracle covers every durable phase", () => {
  const phases: Phase[] = ["starting", "waiting", "resolved", "blocked", "merged"];
  const observed = conflictTransitions
    .flatMap((row) => [row.prior?.phase, row.expected.record?.phase])
    .filter(Boolean);
  expect(new Set(observed)).toEqual(new Set(phases));
});

test.each(conflictTransitions)("pure machine: $name", (row) => {
  const before = structuredClone(row);
  const result = run(row);
  expect(result.record).toEqual(row.expected.record);
  expect(result.effects).toEqual(row.expected.effects);
  expect(result.line).toBe(row.expected.line);
  expect(result.error).toBe(row.expected.error);
  expect(result.active).toBe(row.expected.active);
  expect(result.card).toEqual(row.expected.card);
  expect(!!result.record && ["starting", "waiting", "blocked"].includes(result.record.phase)).toBe(
    row.expected.pending
  );
  expect(
    !!result.record?.dispatched && ["starting", "waiting", "blocked"].includes(result.record.phase)
  ).toBe(row.expected.fixing);
  expect(row).toEqual(before);
});

test.each(["recheck", "recheck-preview"] as const)(
  "%s failure closes before raising the original error",
  (at) => {
    const error = { message: "fetch unavailable" };
    const record = structuredClone(conflictTransitions[0].prior!);
    const before = structuredClone(record);
    const result = step(record, {
      pr: 31,
      operation: "resolve",
      at,
      retry: false,
      root: ".",
      escalatePaths: [],
      readError: { error },
    });
    expect(result.record).toBeUndefined();
    expect(result.effects).toEqual([{ kind: "close" }, { kind: "raise", error }]);
    expect(result.effects[1]).toHaveProperty("error", error);
    expect(record).toEqual(before);
  }
);

test("empty auto-merge refusal remains resolved and restores, never marks merged", () => {
  const record = {
    ...structuredClone(conflictTransitions[0].prior!),
    phase: "resolved" as const,
    approved: true,
    resolvedHead: "R",
  };
  const result = step(record, {
    pr: 31,
    operation: "resolve",
    at: "merged",
    retry: false,
    root: ".",
    escalatePaths: [],
    mergeError: "",
  });
  expect(result.record).toEqual({
    ...record,
    reason: "auto-merge refused (); merge manually when ready",
  });
  expect(result.next).toBe("restore");
  expect(result.effects).toEqual([{ kind: "save" }]);
});

test("verify notice is claimed durably exactly once", () => {
  const record = structuredClone(conflictTransitions[0].prior!);
  const observation: Observation = {
    pr: 31,
    operation: "resolve",
    at: "verify-notice",
    retry: false,
    root: ".",
    escalatePaths: [],
  };
  const first = step(record, observation);
  expect(first.record).toEqual({ ...record, verifyNoticeReported: true });
  expect(first.effects).toEqual([{ kind: "save" }]);
  expect(step(first.record, observation).effects).toEqual([]);
  expect(record.verifyNoticeReported).toBeUndefined();
});

test("retry skips the deadline clock read, but ordinary reconciliation requests it", () => {
  const record = structuredClone(conflictTransitions[0].prior!);
  const observation: Observation = {
    pr: 31,
    operation: "resolve",
    at: "finish",
    retry: false,
    root: ".",
    escalatePaths: [],
    snapshot: symbolicSnapshot(conflictTransitions[0].observation.snapshot),
  };
  expect(step(record, observation).effects).toEqual([{ kind: "clock" }]);
  expect(step(record, { ...observation, retry: true }).effects).toEqual([]);
});

/** Adapt the unchanged oracle's symbolic git facts to ordered observations. No
 * service, filesystem, transport, clocks or production proof helpers are used. */
function run(row: TransitionRow) {
  const input = row.observation;
  let record: Resolution | undefined = structuredClone(row.prior) ?? undefined;
  let stored = structuredClone(row.prior);
  let card = structuredClone(input.card);
  let snapshot = symbolicSnapshot(input.snapshot);
  const o: Observation = {
    pr: 31,
    operation: row.operation,
    at: "start",
    retry: input.retry,
    root: ".",
    escalatePaths: input.escalated ? ["**/*.txt"] : [],
    ...(input.lock === "live"
      ? { busy: "PENDING #31: conflict resolution in progress (pid 5432)" }
      : {}),
  };
  const effects: OracleEffect[] = [];
  let line: string | undefined;
  let error: string | undefined;
  let active: boolean | undefined;
  const apply = (effect: Effect) => {
    switch (effect.kind) {
      case "lifecycle":
        o.lifecycle = input.lifecycle;
        break;
      case "snapshot":
        if (effect.current) {
          o.current = structuredClone(snapshot);
          o.refs = { head: snapshot.head, base: snapshot.baseSha };
        } else {
          o.snapshot = structuredClone(snapshot);
        }
        break;
      case "status":
        o.status = input.workerStatus;
        break;
      case "preview":
        o.preview =
          effect.head === "R" && !["wrong-parents", "foreign"].includes(input.proofs.merge)
            ? []
            : [...input.preview];
        break;
      case "ancestor":
        o.ancestor =
          effect.head === "R" &&
          effect.base === "B" &&
          !["wrong-parents", "foreign"].includes(input.proofs.merge)
            ? "B"
            : "A";
        break;
      case "approved":
        o.approved = input.approved;
        break;
      case "clock":
        o.now = input.now;
        break;
      case "card-prior":
        effects.push(effect);
        o.prior = structuredClone(card);
        if (input.beforeDispatch) {
          snapshot = {
            ...snapshot,
            head: input.beforeDispatch === "vanished" ? "R" : "M",
            conflict: input.beforeDispatch === "moved",
          };
        }
        break;
      case "dispatch":
        effects.push(effect);
        expect(stored?.phase).toBe("starting");
        expect(stored?.dispatched).toBeUndefined();
        expect(stored?.prior).toEqual(input.card);
        if (input.dispatchFailure) {
          throw new Error("dispatch failed");
        }
        o.dispatchStep = input.dispatchStep;
        break;
      case "card-conflict":
        effects.push(effect);
        card = { ...card, progress: "💥", assignees: ["worker"] };
        break;
      case "update-branch":
        effects.push(effect);
        if (input.update === "failure") {
          throw new Error("update failed");
        }
        o.update = input.update === "no-commits" ? "no-commits" : "updated";
        if (input.update === "merge") {
          snapshot = { ...snapshot, head: "R", conflict: false };
        }
        break;
      case "wait":
        effects.push(effect);
        o.waitCode = input.waitCode;
        break;
      case "clean":
        o.clean = input.proofs.merge === "clean";
        break;
      case "worker-blocked":
        o.workerBlocked = input.workerBlocked ?? false;
        break;
      case "directory":
        o.directory = ".";
        break;
      case "worktree":
        o.directory = effect.directory;
        o.worktreeHead = input.proofs.worktree ? snapshot.head : "H";
        break;
      case "dirty":
        o.dirty = false;
        break;
      case "fast-forward":
        break;
      case "proof":
        o.proof =
          input.proofs.merge === "hunks" ||
          (effect.files.every((file) => file.endsWith("package-lock.json")) &&
            input.proofs.merge === "outside-hunk");
        break;
      case "sync":
        effects.push({ kind: "sync", directory: "." });
        if (!input.proofs.sync) {
          o.syncError = "lockfile sync check failed at .: lockfile out of sync";
        }
        break;
      case "verify":
        effects.push({ kind: "verify", head: effect.head });
        if (input.verifyNotice) {
          const notice = step(record, { ...o, at: "verify-notice" });
          record = notice.record;
          for (const write of notice.effects) {
            apply(write);
          }
        }
        o.verified = input.proofs.verify;
        switch (input.afterVerify) {
          case "head":
            snapshot.head = "N";
            break;
          case "base":
            snapshot.baseSha = "N";
            break;
          case "branch":
            snapshot.branch = "changed";
            break;
          case "conflict":
            snapshot.conflict = true;
            break;
          case "red":
            snapshot.green = false;
            break;
          case "stale":
            snapshot.stale = true;
            break;
        }
        break;
      case "merge":
        effects.push(effect);
        if (input.mergeFailure) {
          o.mergeError = "merge refused";
        }
        break;
      case "restore":
        effects.push(effect);
        o.restoreError = input.restore === "failure";
        o.approvalKept = input.restore === "approval-kept";
        if (!o.restoreError && !o.approvalKept) {
          card = structuredClone(effect.prior);
        }
        break;
      case "stop":
      case "block":
        effects.push(effect);
        break;
      case "report":
        break;
      case "save":
        stored = structuredClone(record) ?? null;
        break;
      case "close":
        stored = null;
        break;
      case "throw":
        throw new Error(effect.message);
      case "raise":
        throw effect.error;
    }
  };
  for (let count = 0; count < 100; count++) {
    const before = structuredClone({ record, o });
    const result = step(record, o);
    expect(step(record, o)).toEqual(result);
    expect({ record, o }).toEqual(before);
    record = result.record;
    try {
      for (const effect of result.effects) {
        apply(effect);
      }
    } catch (caught) {
      error = (caught as Error).message;
      break;
    }
    if (!result.next) {
      line = row.operation === "resolve" ? result.line : undefined;
      active = result.active;
      return { record: stored, effects, card, line, error, active };
    }
    o.at = result.next;
    if (count === 99) {
      throw new Error("Machine did not terminate within 100 transitions");
    }
  }
  return { record: stored, effects, card, line, error, active };
}

function symbolicSnapshot(snapshot: TransitionRow["observation"]["snapshot"]): CiSnapshot {
  return {
    target: {
      owner: "example",
      name: "project",
      repo: "example/project",
      number: 31,
      link: "https://github.com/example/project/pull/31",
    },
    ...snapshot,
    base: "dev",
    runs: snapshot.red ? [{ status: "completed", conclusion: "failure" }] : [],
  };
}
