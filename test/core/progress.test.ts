import { expect, test, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  progressStates,
  parseProgress,
  renderProgress,
  expectedTurn,
  reconciledTurn,
  mayReplace,
  progressGuards,
  ownerReplyProgress,
  revivedProgressStates,
  hasOrchestratorProgress,
} from "../../src/core/progress.js";
import { workflowColumns } from "../../src/board/runner.js";
import { writeState } from "../../src/board/readme.js";
import { EventLoop } from "../../src/gateway/events.js";
import { BoardService } from "../../src/gateway/board.js";
import { TaskReview } from "../../src/tasks/review.js";
import { people } from "../gateway/helpers.js";
import { fixture } from "../helpers.js";

type Role = "owner" | "orchestrator" | null;
// Frozen pre-extraction oracle. The watcher deliberately leaves unrecognised/stuck
// turns alone; housekeeping instead falls back to the review column's owner.
const turns: Record<string, Role | undefined> = {
  hold: undefined,
  working: null,
  question: "orchestrator",
  design: "orchestrator",
  blocked: "orchestrator",
  ready: "orchestrator",
  verifying: "orchestrator",
  "owner-review": "owner",
  "owner-question": "owner",
  conflict: undefined,
  silent: undefined,
  permission: undefined,
  failed: undefined,
  idle: undefined,
  handoff: "orchestrator",
  empty: undefined,
};
const states = [...Object.keys(progressStates), null];
const text = (state: string | null) => renderProgress({ state, round: null, red: false });
const roleLogin = (role: Role) =>
  role === "owner" ? "owner" : role === "orchestrator" ? "peer" : null;

function watcher() {
  const rest = vi.fn(async (path: string, method: string, body: { assignees: string[] }) => {
    expect(path).toBe("/repos/example/project/issues/27/assignees");
    expect(["POST", "DELETE"]).toContain(method);
    expect(body.assignees.length).toBeGreaterThan(0);
    expect(body.assignees.every((login) => ["owner", "peer", "worker"].includes(login))).toBe(true);
    return {};
  });
  const loop = Object.assign(Object.create(EventLoop.prototype), {
    host: {
      filter: { people },
      github: { rest },
      board: { moveToTop: vi.fn() },
      deps: { report: vi.fn() },
    },
    taskIssues: new Map(),
    pendingMergedIssues: new Set(),
    isOwn: () => true,
  }) as {
    reconcileTurn(card: Record<string, unknown>, report: boolean): Promise<void>;
    applyProgress(card: Record<string, unknown>): Promise<void>;
    state: unknown;
    host: { board: { set: unknown }; deps: { report: ReturnType<typeof vi.fn> } };
  };
  return { loop, rest };
}

test.each(states.flatMap((state) => workflowColumns.map((column) => ({ state, column }))))(
  "old turn writers: $state in $column",
  async ({ state, column }) => {
    const explicit = turns[state ?? "empty"];
    const expected =
      explicit === undefined
        ? ["Spec review", "Owner review"].includes(column)
          ? "owner"
          : null
        : explicit;
    expect(expectedTurn(state, column)).toBe(expected);
    expect(reconciledTurn(state)).toBe(explicit);
    expect(ownerReplyProgress(text(state), column)).toBe(
      state === "verifying" && ["Executing", "Owner review"].includes(column)
    );
    expect(hasOrchestratorProgress(text(state))).toBe(state === "verifying");
    const { loop } = watcher();
    // Start on a different role, so preserving a turn is observable too.
    const card = {
      repo: "example/project",
      kind: "PR",
      number: 27,
      id: "card",
      column,
      progress: text(state),
      assignees: ["worker", "owner"],
    };
    await loop.reconcileTurn(card, false);
    expect(card.assignees).toEqual(
      explicit === undefined
        ? ["worker", "owner"]
        : roleLogin(explicit)
          ? [roleLogin(explicit)]
          : ["worker"]
    );

    const rest = vi.fn(async (path: string, method?: string) => {
      expect(path).toBe("/repos/example/project/issues/27");
      if (method) {
        throw new Error("Unexpected assignment write: already matching turn");
      }
      return {
        node_id: "node",
        assignees: [...["worker"], ...(roleLogin(expected) ? [roleLogin(expected)] : [])].map(
          (login) => ({ login })
        ),
      };
    });
    const service = Object.assign(Object.create(BoardService.prototype), {
      config: { repo: "example/project" },
      filter: { people },
      github: { rest, writes: { beginOperation: vi.fn() } },
      boardVersion: 7,
      report: vi.fn(),
      snapshot: async () => ({
        id: "board",
        readme: writeState("<!-- vmethod-board -->\n<!-- /vmethod-board -->", {
          version: 7,
          minCompatible: 0,
          aliases: {},
        }),
      }),
      issueSideItem: async () => ({}),
      decodeCard: async () => ({ values: { Status: column, Progress: text(state) } }),
      scope: () => {},
    }) as BoardService;
    await expect(service.setAssignees(27, expected)).resolves.toContain("already agree");
    await expect(service.setAssignees(27, expected === "owner" ? null : "owner")).rejects.toThrow(
      "Refusing"
    );
  }
);

// Every guarded arrow currently queued by events.ts (including both idle sites).
const arrows: [string, string[] | undefined][] = [
  ["working", ["silent", "permission", "failed", "idle", "conflict", "handoff"]],
  ["working", ["conflict"]],
  ["idle", ["working"]],
  ["silent", ["working"]],
  ["permission", ["working", "silent", "idle", "failed"]],
  ["failed", ["working", "silent", "idle", "permission"]],
  ["idle", ["working", "silent"]],
];
test.each(states)("old guarded arrows from %s", async (from) => {
  for (const [to, guard] of [...arrows, ...states.map((to) => [to, undefined] as const)]) {
    const { loop } = watcher();
    const pending = { state: to, if: guard };
    const remove = vi.fn();
    loop.state = {
      pr: () => ({ pendingProgress: { exists: () => true, readRequired: () => pending, remove } }),
    };
    loop.host.board.set = vi.fn();
    const card = { number: 27, column: "Scoping", progress: text(from) };
    await loop.applyProgress(card);
    const allowed = !guard || guard.includes(from ?? "");
    expect(mayReplace(from, to, guard)).toBe(allowed);
    expect(parseProgress(card.progress).state).toBe(allowed ? to : from);
    expect(remove).toHaveBeenCalledOnce();
    expect(loop.host.deps.report).not.toHaveBeenCalled();
  }
});

test("central arrow guards preserve every former call-site source list", () => {
  expect(Object.values(progressGuards)).toEqual(arrows.map(([, guard]) => guard));
  expect(revivedProgressStates).toEqual(arrows[0][1]);
  expect(mayReplace(null, "working", [])).toBe(false);
  expect(mayReplace(null, "working", [""])).toBe(true);
  expect(ownerReplyProgress("🧭future-state", "Executing")).toBe(true);
  expect(ownerReplyProgress(" 🧭🔍", "Executing")).toBe(false);
});

test.each(["owner-review", "owner-question"])(
  "Executing %s keeps its separate pause gate",
  async (from) => {
    for (const to of states) {
      for (const releaseOwner of [false, true]) {
        const { loop } = watcher();
        const pending = { state: to, releaseOwner, round: 3, ci: "red" };
        loop.state = {
          pr: () => ({
            pendingProgress: { exists: () => true, readRequired: () => pending, remove: vi.fn() },
          }),
        };
        loop.host.board.set = vi.fn();
        const card = {
          number: 27,
          repo: "example/project",
          id: "card",
          assignees: ["owner"],
          column: "Executing",
          progress: text(from),
        };
        await loop.applyProgress(card);
        expect(parseProgress(card.progress)).toEqual({
          state: releaseOwner || ["owner-review", "owner-question"].includes(to ?? "") ? to : from,
          round: 3,
          red: true,
        });
        expect(loop.host.deps.report).not.toHaveBeenCalled();
      }
    }
  }
);

test.each([
  ["changes", "working", null],
  ["answer", "working", null],
  ["owner", "owner-review", "owner"],
  ["ask", "owner-question", "owner"],
  ["approve", "verifying", "orchestrator"],
] as const)("old review outcome %s", async (outcome, state, role) => {
  const file = join(fixture(), "review.md");
  writeFileSync(file, "Review evidence.\n");
  const turn = vi.fn();
  const card = vi.fn();
  const flow = Object.assign(Object.create(TaskReview.prototype), {
    config: { repo: "example/project", board: { enabled: false } },
    deps: {},
    host: { comments: async () => [], github: { writes: { beginOperation: vi.fn() } } },
    pr: async () => ({ id: "node", state: "OPEN", body: "", headRefOid: "a".repeat(40) }),
    post: vi.fn(),
    ready: vi.fn(),
    turn,
    card,
    status: async () => "stopped",
    wake: vi.fn(),
  }) as TaskReview;
  await flow.review({ ref: "27", outcome, file });
  expect(turn).toHaveBeenCalledWith("27", role);
  expect(parseProgress(card.mock.calls[0][2]).state).toBe(state);
  expect(turn.mock.invocationCallOrder[0]).toBeLessThan(card.mock.invocationCallOrder[0]);
});
