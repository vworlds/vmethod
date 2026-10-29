import { expect, test } from "vitest";
import { TaskFlow } from "../../src/gateway/task-flow.js";
import { BoardService } from "../../src/gateway/board.js";
import { GitHubClient } from "../../src/gateway/client.js";
import { object } from "../../src/gateway/people.js";
import { people } from "./helpers.js";
import { WatchFake } from "./watch-fake.js";
import { ConflictOutcome } from "../../src/conflicts/outcomes.js";

const rows = [
  {
    name: "C4 #244/#245 restore keeps Approved at dispatch",
    action: "restore",
    initial: "Approved",
    live: "Approved",
    expected: "Approved",
  },
  {
    name: "C4 #244 restore re-reads approval during fixer",
    action: "restore",
    initial: "Owner review",
    live: "Approved",
    expected: "Approved",
  },
  {
    name: "C4 #274 restore prior turn without intervening approval",
    action: "restore",
    initial: "Owner review",
    live: "Executing",
    expected: "Owner review",
  },
  {
    name: "C4 #245 escalation keeps Approved",
    action: "escalate",
    initial: "Approved",
    live: "Approved",
    expected: "Approved",
  },
  {
    name: "C4 #274 escalation re-reads intervening approval",
    action: "escalate",
    initial: "Owner review",
    live: "Approved",
    expected: "Approved",
  },
];

test("conflict card characterization table is non-empty", () =>
  expect(rows.length).toBeGreaterThan(0));
test.each(["MERGED", "CLOSED", "non-task", "held"])(
  "conflict task gate distinguishes expected lifecycle races from holds: %s",
  async (state) => {
    const f = new WatchFake();
    const unexpected = async (): Promise<never> => {
      throw new Error("Unexpected task gate");
    };
    const flow = new TaskFlow(f.root, f.env, f.config, f.deps, {
      people,
      github: new GitHubClient(f.config, f.env, f.deps),
      board: () => {
        throw new Error("Unexpected board read");
      },
      thread: async () => ({
        state: ["MERGED", "CLOSED"].includes(state) ? state : "OPEN",
        title: state === "held" ? "[HOLD] task" : "task",
        body: state === "non-task" ? "" : '<!-- vmethod-task {"issues":[8]} -->',
        headRefName: "8-task",
        baseRefName: "dev",
        headRepository: { nameWithOwner: "example/project" },
        labels: { nodes: [] },
      }),
      comments: unexpected,
      replyTarget: unexpected,
      approved: unexpected,
      candidates: unexpected,
      issueApproved: unexpected,
      approvalRefusal: unexpected,
      scopeRefusal: unexpected,
      modelApproval: unexpected,
    });
    try {
      const result = flow.conflictTask("27");
      if (state === "held") {
        await expect(result).rejects.toThrow("non-held task PR");
      } else {
        await expect(result).rejects.toBeInstanceOf(ConflictOutcome);
        await expect(result).rejects.toMatchObject({ outcome: "closed" });
      }
    } finally {
      f.done();
    }
  }
);
test.each(rows)("$name", async (row) => {
  const f = new WatchFake();
  f.enableWrites = true;
  const card = f.card(27, row.initial, "PullRequest");
  card.progress = { text: "👤🔍" };
  object(card.content).assignees = { nodes: [{ login: "owner" }] };
  f.cards = [card];
  const github = new GitHubClient(f.config, f.env, f.deps);
  const board = new BoardService(f.config, github, f.deps);
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected task gate");
  };
  const flow = new TaskFlow(f.root, f.env, f.config, f.deps, {
    people,
    github,
    board: () => board,
    thread: async (ref, kind) => {
      expect([ref, kind]).toEqual(["27", "pr"]);
      return {
        ...object(card.content),
        headRefName: "8-task",
        baseRefName: "dev",
        headRepository: { nameWithOwner: "example/project" },
      };
    },
    comments: unexpected,
    replyTarget: unexpected,
    approved: unexpected,
    candidates: unexpected,
    issueApproved: unexpected,
    approvalRefusal: unexpected,
    scopeRefusal: unexpected,
    modelApproval: unexpected,
  });
  try {
    const prior = await flow.cardPrior("27");
    expect(prior).toEqual({ status: row.initial, progress: "👤🔍", assignees: ["owner"] });
    await flow.cardConflict("27");
    // Simulate the live board changing after dispatch, with the same flow/board instances.
    card.status = { ...object(card.status), name: row.live };
    f.writes.length = 0;
    if (row.action === "restore") {
      expect(await flow.cardRestore("27", prior)).toBe(
        row.live === "Approved" ? "approval-kept" : undefined
      );
    } else {
      await flow.escalateConflict("27", "merge verify hook failed", ["src/conflict.ts"]);
      expect(f.comments["example/project"].at(-1)?.body).toContain(
        "Owner approval kept: the card stays Approved."
      );
    }
    expect(object(card.status).name).toBe(row.expected);
    expect(object(card.progress).text).toBe(
      row.action === "escalate" ? "🤖🚫" : row.live === "Approved" ? "🧭🔍" : "👤🔍"
    );
    expect(f.writes.filter((write) => write.field === "Model")).toEqual([]);
    if (row.live === "Approved") {
      expect(f.writes.filter((write) => write.field === "Status")).toEqual([]);
    }
    expect(object(object(card.content).assignees).nodes).toEqual(
      row.live !== "Approved"
        ? [{ login: "owner" }]
        : row.action === "escalate"
          ? [{ login: "peer" }]
          : [{ login: "worker" }]
    );
  } finally {
    f.done();
  }
});
