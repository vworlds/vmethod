import { expect, test } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { actor, fixtureServer, graph, item, people, sha } from "./helpers.js";
import developmentLinks from "../fixtures/github/task-development-links.json" with { type: "json" };
import { scopeIssue, scopeMove, scopeConnection, scopeGraph } from "./scope-fixture.js";

test("workers cannot invoke conflict automation or gain merge authority", async () => {
  const f = fixtureServer([], actor(1));
  await expect(
    f.gateway.call("resolveConflicts", { ref: "27" }, { role: "worker", taskPr: 27 })
  ).rejects.toThrow("denied for client role");
  f.done();
});

test.each(["fork", "track", "hold", "closed", "not task"])(
  "conflict entry rejects %s before any git or update-branch side effect",
  async (reason) => {
    const f = fixtureServer([
      graph({ repository: { pullRequest: item() } }),
      graph({
        node: item({
          title: reason === "hold" ? "[HOLD: dependency] feat: task" : "feat: task",
          body: reason === "not task" ? "not a task" : '<!-- vmethod-task {"issues":[]} -->',
          state: reason === "closed" ? "CLOSED" : "OPEN",
          headRefName: "8-task",
          baseRefName: "dev",
          headRefOid: sha,
          baseRefOid: sha,
          headRepository: { nameWithOwner: reason === "fork" ? "outside/fork" : "example/project" },
          labels: {
            nodes: reason === "track" ? [{ name: "track:other" }] : [],
            pageInfo: { hasNextPage: false },
          },
        }),
      }),
    ]);
    await expect(f.transport.call("resolveConflicts", { ref: "27" })).rejects.toThrow(
      reason === "fork" ? "fork" : reason === "track" ? "another track" : "open, non-held task"
    );
    f.done();
  }
);

test.each(["", "   ", "reason\nforged line"])(
  "gateway forwards and validates carry reason %j before PR reads",
  async (carryApproval) => {
    const f = fixtureServer([]);
    await expect(f.transport.call("mergeTask", { ref: "27", carryApproval })).rejects.toThrow(
      "nonempty single-line reason"
    );
    f.done();
  }
);

test("link-task reaches the authenticated Development mutation path without editing the body", async () => {
  const body = "# Task: feat: task (issue #8)\n\nYou are a worker.\nPrompt.";
  const f = fixtureServer([
    graph({ repository: { pullRequest: item() } }),
    graph({
      node: item({
        body,
        title: "feat: task",
        state: "OPEN",
        headRefName: "8-task",
        baseRefName: "dev",
        headRepository: { nameWithOwner: "example/project" },
        labels: { nodes: [], pageInfo: { hasNextPage: false } },
        closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
      }),
    }),
    graph({ repository: { issue: item() } }),
    graph({
      node: item({
        state: "OPEN",
        title: "feat: issue",
        body: "Spec",
        labels: { nodes: [], pageInfo: { hasNextPage: false } },
      }),
    }),
    {
      path: "/graphql",
      json: developmentLinks.add,
      checkQuery(query, variables) {
        expect(query).toContain(
          "addCloseIssueReferences(input: {issueId: $issueId, pullRequestIds: $pullRequestIds})"
        );
        expect(variables).toEqual({ issueId: "node-1", pullRequestIds: ["node-1"] });
      },
    },
  ]);
  await expect(f.transport.call("linkTask", { ref: "27" })).resolves.toBe("Linked task #27");
  f.done();
});

test("open-task checks the issue timeline actor at the server, not the card's Status", async () => {
  const f = fixtureServer([
    graph({ repository: { issue: item() } }),
    graph({
      node: item({
        body: "Approved specification",
        title: "feat: task",
        state: "OPEN",
        labels: { nodes: [], pageInfo: { hasNextPage: false } },
      }),
    }),
    scopeGraph({ nodes: [scopeIssue()] }),
    scopeGraph({ nodes: [scopeIssue()] }),
    scopeGraph({ n0: scopeIssue({ comments: scopeConnection([]) }) }),
    scopeGraph({
      n0: scopeIssue({ timelineItems: scopeConnection([scopeMove({ actor: actor(2) })]) }),
    }),
  ]);
  await expect(f.transport.call("openTask", { issue: "8", model: "sol" })).rejects.toThrow(
    "scope not approved: post SCOPE REVIEW first"
  );
  f.done();
});

test("worker status goes through accepted metadata and defaults to unknown, never stopped", async () => {
  const f = fixtureServer([
    graph({ repository: { pullRequest: item() } }),
    graph({
      node: item({
        body: "task",
        title: "feat: task",
        labels: { nodes: [], pageInfo: { hasNextPage: false } },
      }),
    }),
  ]);
  await expect(f.transport.call("workerStatus", { ref: "27" })).resolves.toBe("unknown");
  f.done();
});

test("merge is refused at the gateway when worker management reports live, without touching GitHub merge", async () => {
  const f = fixtureServer([
    graph({ repository: { pullRequest: item() } }),
    graph({
      node: item({
        body: "task",
        title: "feat: task",
        state: "OPEN",
        headRefName: "8-task",
        baseRefName: "dev",
        baseRefOid: sha,
        headRepository: { nameWithOwner: "example/project" },
        labels: { nodes: [], pageInfo: { hasNextPage: false } },
      }),
    }),
  ]);
  f.deps.workers = {
    status: async (pr) => {
      expect(pr).toBe(27);
      return "live";
    },
    resume: async () => {
      throw new Error("Unexpected resume");
    },
  };
  await expect(f.transport.call("mergeTask", { ref: "27" })).rejects.toThrow("Stop the worker");
  f.done();
});

const REPLY_REFUSAL =
  "answer replies to a worker QUESTION or BLOCKED; to reply to the owner use review <pr> ask --in-reply-to <url>";

/** A scripted open task PR: the request list after this thread read stays small. */
function reviewThread() {
  return [
    graph({ repository: { pullRequest: item() } }),
    graph({
      node: item({
        title: "feat: task",
        body: "",
        state: "OPEN",
        headRefName: "8-task",
        baseRefName: "dev",
        baseRefOid: sha,
        isDraft: true,
        headRepository: { nameWithOwner: "example/project" },
        labels: { nodes: [], pageInfo: { hasNextPage: false } },
      }),
    }),
    graph({ node: item({ comments: scopeConnection([]) }) }),
  ];
}

const REVIEW_REPLY = {
  ref: "27",
  outcome: "answer" as const,
  replyTo: "https://github.com/example/project/pull/27#issuecomment-5",
};

test("review answer --in-reply-to an owner comment refuses after classifying the target, posting nothing", async () => {
  const f = fixtureServer([
    ...reviewThread(),
    {
      path: "/repos/example/project/issues/comments/5",
      method: "GET",
      json: { id: 5, node_id: "comment-5", user: { id: 101, type: "User", login: "owner" } },
    },
    graph({
      node: item({
        id: "comment-5",
        author: actor(),
        editor: null,
        lastEditedAt: null,
        body: "Which case runs the nightly suite?",
        issue: { number: 27 },
      }),
    }),
  ]);
  const file = join(f.root, "answer.md");
  writeFileSync(file, "The nightly case only.\n");
  await expect(f.transport.call("reviewTask", { ...REVIEW_REPLY, file })).rejects.toThrow(
    REPLY_REFUSAL
  );
  f.done();
});

test("review answer --in-reply-to an unknown comment id refuses without classifying a body", async () => {
  const f = fixtureServer([
    ...reviewThread(),
    {
      path: "/repos/example/project/issues/comments/5",
      method: "GET",
      status: 404,
      json: { message: "Not Found" },
    },
  ]);
  const file = join(f.root, "answer.md");
  writeFileSync(file, "Answer.\n");
  await expect(f.transport.call("reviewTask", { ...REVIEW_REPLY, file })).rejects.toThrow(
    REPLY_REFUSAL
  );
  f.done();
});

test("review answer --in-reply-to a worker QUESTION edited by an unknown editor refuses", async () => {
  const f = fixtureServer([
    ...reviewThread(),
    {
      path: "/repos/example/project/issues/comments/5",
      method: "GET",
      json: { id: 5, node_id: "comment-5", user: { id: 102, type: "User", login: "worker" } },
    },
    graph({
      node: item({
        id: "comment-5",
        author: actor(1),
        editor: { ...actor(), databaseId: 999 },
        lastEditedAt: "2026-10-19T10:01:00Z",
        body: "[worker] QUESTION\n\nWhich case?",
        issue: { number: 27 },
      }),
    }),
  ]);
  const file = join(f.root, "answer.md");
  writeFileSync(file, "Answer.\n");
  await expect(f.transport.call("reviewTask", { ...REVIEW_REPLY, file })).rejects.toThrow(
    REPLY_REFUSAL
  );
  f.done();
});

test("review answer --in-reply-to a worker QUESTION posts and wakes exactly as before", async () => {
  const f = fixtureServer(
    [
      ...reviewThread(),
      {
        path: "/repos/example/project/issues/comments/5",
        method: "GET",
        json: { id: 5, node_id: "comment-5", user: { id: 102, type: "User", login: "worker" } },
      },
      graph({
        node: item({
          id: "comment-5",
          author: actor(1),
          editor: null,
          lastEditedAt: null,
          body: "[worker] QUESTION\n\nWhich case?",
          issue: { number: 27 },
        }),
      }),
      {
        path: "/repos/example/project/issues/27/comments",
        body: {
          body: "[orchestrator] ANSWER\n\nin reply to https://github.com/example/project/pull/27#issuecomment-5\n\nThe nightly case only.\n",
        },
      },
      { path: "/repos/example/project/issues/27", method: "GET", json: { assignees: [] } },
    ],
    actor(2),
    people,
    (root) => {
      // The board writes are covered by the in-process flow fixture; the reply gate is the subject here.
      writeFileSync(
        join(root, "vmethod.yaml"),
        readFileSync(join(root, "vmethod.yaml"), "utf8").replace("enabled: true", "enabled: false")
      );
    }
  );
  const file = join(f.root, "answer.md");
  writeFileSync(file, "The nightly case only.\n");
  expect(await f.transport.call("reviewTask", { ...REVIEW_REPLY, file })).toBe(
    "Posted ANSWER on #27\nno worker session for #27; nothing sent"
  );
  f.done();
});
