import { expect, test } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "graphql";
import { actor, fixtureServer, graph, item, people, sha } from "./helpers.js";
import developmentLinks from "../fixtures/github/task-development-links.json" with { type: "json" };
import boardRecording from "../fixtures/github/board-write-inputs.json" with { type: "json" };
import {
  scopeIssue,
  scopeComment,
  scopeMove,
  scopeConnection,
  scopeGraph,
} from "./scope-fixture.js";
import { bodyHash } from "../../src/gateway/scope.js";
import type { ObjectData } from "../../src/gateway/people.js";

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
    {
      path: "/graphql",
      json: {
        data: {
          organization: { projectV2: { id: boardRecording.id, readme: boardRecording.readme } },
        },
      },
    },
    { path: "/graphql", json: { data: { node: { fields: boardRecording.fields } } } },
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

const editedIssue = (lastEditedAt: string | null, createdAt = "2026-01-05T00:00:00Z") =>
  graph({
    node: item({
      id: "node-1",
      createdAt,
      // An edited body is delivered under its editor's identity.
      editor: lastEditedAt ? actor(0) : null,
      lastEditedAt,
    }),
  });

/** The owner's approval-line meta (identity fields only; the body is fetched separately). */
const lineMeta = (author: ObjectData, editedBy?: ObjectData) =>
  item({
    id: "comment-1",
    author,
    editor: editedBy ?? null,
    ...(editedBy ? { lastEditedAt: "2026-01-08T00:00:00Z" } : { lastEditedAt: null }),
  });

const lineBody = (createdAt: string, author: ObjectData) => {
  const comment = item({
    id: "comment-1",
    author,
    editor: null,
    lastEditedAt: null,
    createdAt,
    body: "APPROVE MODEL astra",
  });
  return {
    path: "/graphql",
    json: { data: { node: comment } },
    checkQuery(query: string, variables: ObjectData) {
      parse(query);
      expect(variables.id).toBe("comment-1");
      // Approval bodies are read only after the author's identity verifies.
      expect(query).toContain("body");
    },
  };
};

const approvedSpecScope = () => [
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
  scopeGraph({
    n0: scopeIssue({
      comments: scopeConnection([
        scopeComment({
          body: `[orchestrator] SCOPE REVIEW\n\nbody sha256: ${bodyHash("Final scope")}`,
        }),
      ]),
    }),
  }),
  scopeGraph({
    n0: scopeIssue({
      timelineItems: scopeConnection([scopeMove({ createdAt: "2026-01-04T00:00:00Z" })]),
    }),
  }),
  // The scope reader fetches its trusted comment bodies in a final ScopeNodes call.
  {
    path: "/graphql",
    json: {
      data: {
        nodes: [
          scopeComment({
            body: `[orchestrator] SCOPE REVIEW\n\nbody sha256: ${bodyHash("Final scope")}`,
          }),
        ],
      },
    },
    checkQuery(query: string) {
      parse(query);
      expect(query).toContain("body");
      expect(query).toContain("IssueComment");
    },
  },
];

const imposter = { login: "imposter", databaseId: 4242, __typename: "User" };

/** The gate refuses foreign lines unread; the owner's line authorizes the open flow,
 * which then stops at the fixture's first git call before any GitHub mutation. */
test.each([
  {
    case: "refuses a line predating the issue body's last edit",
    edited: "2026-01-06T00:00:00Z",
    metas: [lineMeta(actor(0))],
    bodies: [lineBody("2026-01-02T00:00:00Z", actor(0))],
    authorized: false,
  },
  {
    case: "refuses a line from a peer orchestrator and leaves its body unread",
    edited: "2026-01-06T00:00:00Z",
    metas: [lineMeta(actor(2))],
    bodies: [],
    authorized: false,
  },
  {
    case: "refuses a line from a pinned worker",
    edited: "2026-01-06T00:00:00Z",
    metas: [lineMeta(actor(1))],
    bodies: [],
    authorized: false,
  },
  {
    case: "refuses a line from a forged, unpinned author",
    edited: "2026-01-06T00:00:00Z",
    metas: [lineMeta(imposter)],
    bodies: [],
    authorized: false,
  },
  {
    case: "refuses an owner line edited by a non-owner",
    edited: "2026-01-06T00:00:00Z",
    metas: [lineMeta(actor(0), actor(1))],
    bodies: [],
    authorized: false,
  },
  {
    case: "accepts an owner line posted after the issue body's last edit",
    edited: "2026-01-06T00:00:00Z",
    metas: [lineMeta(actor(0))],
    bodies: [lineBody("2026-01-07T00:00:00Z", actor(0))],
    authorized: true,
  },
  {
    case: "accepts an owner line on an issue whose body was never edited",
    edited: null,
    metas: [lineMeta(actor(0))],
    bodies: [lineBody("2026-01-07T00:00:00Z", actor(0))],
    authorized: true,
  },
])("open-task model gate verifies the owner line at the server: $case", async (scenario) => {
  // The board is off so the flow reaches the model gate with scope metadata reads only.
  const f = fixtureServer(
    [
      ...approvedSpecScope(),
      graph({ repository: { issue: item() } }),
      editedIssue(scenario.edited),
      graph({ node: item({ comments: scopeConnection(scenario.metas) }) }),
      ...scenario.bodies,
    ],
    actor(2),
    people,
    (root) => {
      const file = join(root, "vmethod.yaml");
      writeFileSync(file, readFileSync(file, "utf8").replace("enabled: true", "enabled: false"));
    }
  );
  await expect(
    f.transport.call("openTask", { issue: "8", model: "astra", ownerApproved: true })
  ).rejects.toThrow(
    scenario.authorized
      ? // Authorized: the flow continues past the gate; the scripted harness stops it
        // at the base fetch (the first git call), so "Fetch failed" marks a pass.
        "Fetch failed"
      : // Unauthorized: the gate refusal names the owner line.
        "APPROVE MODEL astra"
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
  "answer replies to a worker QUESTION, BLOCKED, DESIGN or HANDOFF; to reply to the owner use review <pr> ask --in-reply-to <url>";

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
