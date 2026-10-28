import { expect, test } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "graphql";
import { actor, fixtureServer, graph, item, people, sha } from "./helpers.js";
import type { Request } from "./helpers.js";
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
import { gatewayVerb } from "../../src/cli/gateway.js";
import { taskFlowVerb } from "../../src/cli/task-flow.js";

test("pr open crosses the authenticated gateway with configured repository and base", async () => {
  const f = fixtureServer([
    {
      path: "/repos/example/project/git/matching-refs/heads/adoption",
      method: "GET",
      json: [{ ref: "refs/heads/adoption", object: { sha } }],
    },
    {
      path: "/repos/example/project/pulls",
      body: {
        head: "adoption",
        base: "dev",
        title: "chore: adopt",
        body: "Adoption\n",
        draft: false,
      },
      json: { number: 27, node_id: "pr" },
    },
  ]);
  const file = join(f.root, "body.md");
  writeFileSync(file, "Adoption\n");
  await expect(
    taskFlowVerb(f.transport, "pr", ["open", "adoption", "chore: adopt", file], {
      VMETHOD_ROLE: "orchestrator",
    })
  ).resolves.toBe("https://github.com/example/project/pull/27");
  f.done();
});

test.each(["prOpen", "prMerge"] as const)(
  "%s refuses worker clients before API access",
  async (operation) => {
    const f = fixtureServer([]);
    await expect(
      f.transport.call(
        operation,
        operation === "prOpen"
          ? { branch: "adoption", title: "chore: adopt", file: "body.md" }
          : { ref: "27" },
        { role: "worker", taskPr: 27 }
      )
    ).rejects.toThrow("denied for client role");
    f.done();
  }
);

test.each(["issue", "pr"] as const)(
  "orchestrator can stop but not grant autopilot on an accepted %s",
  async (kind) => {
    const f = fixtureServer([
      graph({ repository: { [kind === "pr" ? "pullRequest" : "issue"]: item() } }),
      graph({
        node: item({
          __typename: kind === "pr" ? "PullRequest" : "Issue",
          body: "Task specification",
          labels: { nodes: [{ name: "autopilot" }], pageInfo: { hasNextPage: false } },
        }),
      }),
      { path: "/repos/example/project/issues/27/labels/autopilot", method: "DELETE", json: {} },
      {
        path: "/repos/example/project/issues/27/comments",
        body: {
          body: "[orchestrator] AUTOPILOT\n\nStopped autopilot; control returns to the owner at the current step. Completed work is not reverted.",
        },
        json: {},
      },
    ]);
    await expect(
      gatewayVerb(f.transport, "autopilot", ["stop", kind, "27"], { VMETHOD_ROLE: "orchestrator" })
    ).resolves.toBe("Autopilot stopped on #27");
    await expect(
      gatewayVerb(f.transport, "autopilot", ["start", kind, "27"], { VMETHOD_ROLE: "orchestrator" })
    ).rejects.toThrow("Usage");
    f.done();
  }
);

const grantHistory = {
  timelineItems: {
    nodes: [
      {
        __typename: "LabeledEvent",
        id: "grant",
        createdAt: "2026-01-01T00:00:00Z",
        actor: actor(0),
        label: { name: "autopilot" },
      },
    ],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
};

test.each(["non-owner", "bounce", "head"])(
  "pr merge exposes the authenticated %s approval refusal",
  async (cause) => {
    const old = "d".repeat(40);
    const pr = item({
      __typename: "PullRequest",
      number: 27,
      title: "chore: adoption",
      body: "Adoption",
      state: "OPEN",
      headRefName: "adoption",
      baseRefName: "dev",
      baseRefOid: sha,
      headRepository: { nameWithOwner: "example/project" },
      labels: { nodes: [], pageInfo: { hasNextPage: false } },
    });
    const thread = () => graph({ repository: { pullRequest: pr } });
    const comment = scopeComment({
      body: `[orchestrator] OWNER REVIEW\nHead: ${cause === "head" ? old : sha}`,
    });
    const approval = {
      ...scopeMove({
        actor: cause === "non-owner" ? actor(2) : actor(),
        status: "Approved",
        previousStatus: "Owner review",
      }),
    };
    const timeline = [
      approval,
      ...(cause === "bounce"
        ? [
            scopeMove({
              status: "Executing",
              previousStatus: "Approved",
              createdAt: "2026-01-04T00:00:00Z",
            }),
          ]
        : []),
    ];
    const evidence = () => [
      thread(),
      graph({ node: item({ reviews: scopeConnection([]) }) }),
      graph({ node: item({ comments: scopeConnection([comment]) }) }),
      graph({ node: comment }),
      graph({ node: item({ timelineItems: scopeConnection(timeline) }) }),
    ];
    const f = fixtureServer(
      [
        thread(),
        graph({ node: pr }),
        ...evidence(),
        // No current delegation: read the live PR and its comments without trusting tags alone.
        thread(),
        graph({ node: pr }),
        graph({ node: item({ comments: scopeConnection([comment]) }) }),
        graph({ node: comment }),
        ...evidence(),
      ],
      actor(2),
      people,
      (root) => {
        const file = join(root, "vmethod.yaml");
        writeFileSync(file, readFileSync(file, "utf8").replace("enabled: true", "enabled: false"));
      }
    );
    f.deps.workers = {
      status: async () => "stopped",
      resume: async () => {
        throw new Error("Unexpected worker resume");
      },
    };
    f.deps.exec = async (file, args) => {
      expect(file).toBe("git");
      if (args.includes("fetch")) {
        return "";
      }
      if (args[0] === "rev-parse") {
        return sha;
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    };
    const expected =
      cause === "non-owner"
        ? `approval by ${actor(2).login} does not count (not an owner in people.yaml); ask an owner to approve after review 27 owner`
        : cause === "bounce"
          ? "approval at 2026-01-03T00:00:00Z precedes a bounce to Executing; hand over again with review 27 owner"
          : `head moved from ${old} to ${sha} since approval; use --carry-approval if only base merges`;
    await expect(f.transport.call("prMerge", { ref: "27" })).rejects.toThrow(expected);
    f.done();
  }
);

test.each([false, true])(
  "historical autopilot review reaches the merge proof only with a current grant (revoked=%s)",
  async (revoked) => {
    const old = "d".repeat(40);
    const pr = item({
      __typename: "PullRequest",
      number: 27,
      title: "feat: task",
      body: '<!-- vmethod-task {"issues":[]} -->',
      state: "OPEN",
      headRefName: "8-task",
      baseRefName: "dev",
      baseRefOid: sha,
      headRepository: { nameWithOwner: "example/project" },
      labels: {
        nodes: revoked ? [] : [{ name: "autopilot" }],
        pageInfo: { hasNextPage: false },
      },
    });
    const comment = item({
      id: "approval",
      author: actor(2),
      body: `[orchestrator] AUTOPILOT APPROVED\n\nCurrent head: ${old}\n\nReviewed.`,
      createdAt: "2026-01-01T01:00:00Z",
    });
    const thread = () => graph({ repository: { pullRequest: item() } });
    const reviews = () => graph({ node: item({ reviews: scopeConnection([]) }) });
    const comments = () => [
      graph({
        node: item({ comments: scopeConnection([item({ id: "approval", author: actor(2) })]) }),
      }),
      graph({ node: comment }),
    ];
    const f = fixtureServer(
      [
        thread(),
        graph({ node: pr }),
        // Historical candidates must include the authenticated delegated review.
        thread(),
        reviews(),
        ...comments(),
        // It is not an owner approval.
        thread(),
        reviews(),
        ...comments(),
        graph({ node: item({ timelineItems: scopeConnection([]) }) }),
        // Validate the historical exact-head review against the live delegation.
        thread(),
        graph({ node: pr }),
        ...(revoked
          ? []
          : [
              { path: "/graphql", json: { data: { nodes: [pr] } } },
              { path: "/graphql", json: { data: { nodes: [pr] } } },
              graph({ n0: { ...pr, ...grantHistory } }),
            ]),
        ...comments(),
      ],
      actor(2),
      people,
      (root) => {
        const file = join(root, "vmethod.yaml");
        writeFileSync(file, readFileSync(file, "utf8").replace("enabled: true", "enabled: false"));
      }
    );
    f.deps.workers = {
      status: async () => "stopped",
      resume: async () => {
        throw new Error("Unexpected worker resume");
      },
    };
    const commands: string[] = [];
    f.deps.exec = async (file, args) => {
      expect(file).toBe("git");
      const command = args.join(" ");
      commands.push(command);
      if (args.includes("fetch") || args[0] === "merge-base") {
        return "";
      }
      if (args[0] === "rev-parse") {
        return sha;
      }
      if (command === `rev-list --first-parent --parents ${old}..${sha}`) {
        return `${sha} ${old}`; // A task commit, not a base-only two-parent merge.
      }
      throw new Error(`Unexpected git command: ${command}`);
    };
    await expect(
      f.transport.call("mergeTask", { ref: "27", carryApproval: "Base update" })
    ).rejects.toThrow(
      revoked ? "autopilot delegation is no longer current; ask the owner" : "cannot be carried"
    );
    expect(commands.includes(`rev-list --first-parent --parents ${old}..${sha}`)).toBe(!revoked);
    f.done();
  }
);

test("autopilot inherit re-copies a live issue grant onto the accepted task PR", async () => {
  const granted = item({
    __typename: "Issue",
    number: 8,
    body: "Grant source",
    labels: { nodes: [{ name: "autopilot" }], pageInfo: { hasNextPage: false } },
  });
  const f = fixtureServer([
    graph({ repository: { pullRequest: item({ author: actor(2) }) } }),
    graph({
      node: item({
        __typename: "PullRequest",
        number: 27,
        author: actor(2),
        body: 'Task text\n\n<!-- vmethod-task {"issues":[8]} -->\n',
        labels: { nodes: [], pageInfo: { hasNextPage: false } },
      }),
    }),
    graph({ repository: { issue: item() } }),
    graph({ node: granted }),
    scopeGraph({ nodes: [granted] }),
    scopeGraph({ nodes: [granted] }),
    graph({ n0: { ...item({ __typename: "Issue", number: 8 }), ...grantHistory } }),
    { path: "/repos/example/project/issues/27/labels", method: "POST", json: {} },
    graph({
      node: item({
        __typename: "PullRequest",
        author: actor(2),
        timelineItems: {
          nodes: [
            {
              __typename: "LabeledEvent",
              id: "copy",
              createdAt: "2026-01-01T00:00:01Z",
              actor: actor(2),
              label: { name: "autopilot" },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
    }),
    scopeGraph({ nodes: [granted] }),
    scopeGraph({ nodes: [granted] }),
    graph({ n0: { ...item({ __typename: "Issue", number: 8 }), ...grantHistory } }),
    {
      path: "/repos/example/project/pulls/27",
      method: "PATCH",
      body: {
        body: 'Task text\n\n<!-- vmethod-autopilot-copy {"event":"copy","source":"grant"} -->\n\n<!-- vmethod-task {"issues":[8]} -->\n',
      },
      json: {},
    },
    {
      path: "/repos/example/project/issues/27/comments",
      method: "POST",
      body: {
        body: "[orchestrator] AUTOPILOT\n\nCopied the task issue's owner-authorized autopilot grant onto this PR.",
      },
      json: {},
    },
  ]);
  await expect(
    gatewayVerb(f.transport, "autopilot", ["inherit", "27"], { VMETHOD_ROLE: "orchestrator" })
  ).resolves.toBe("Autopilot grant copied from #8 to #27");
  f.done();
});

test("autopilot inherit refuses task PRs without a linked task issue", async () => {
  const f = fixtureServer([
    graph({ repository: { pullRequest: item() } }),
    graph({
      node: item({
        __typename: "PullRequest",
        body: 'Task text\n\n<!-- vmethod-task {"issues":[]} -->\n',
        labels: { nodes: [], pageInfo: { hasNextPage: false } },
      }),
    }),
  ]);
  await expect(
    gatewayVerb(f.transport, "autopilot", ["inherit", "27"], { VMETHOD_ROLE: "orchestrator" })
  ).rejects.toThrow("No linked task issue to inherit the autopilot grant from");
  f.done();
});

test("autopilot inherit refuses when no linked issue holds the grant", async () => {
  const unlabeled = item({
    __typename: "Issue",
    number: 8,
    body: "Grant source",
    labels: { nodes: [], pageInfo: { hasNextPage: false } },
  });
  const f = fixtureServer([
    graph({ repository: { pullRequest: item() } }),
    graph({
      node: item({
        __typename: "PullRequest",
        body: 'Task text\n\n<!-- vmethod-task {"issues":[8]} -->\n',
        labels: { nodes: [], pageInfo: { hasNextPage: false } },
      }),
    }),
    graph({ repository: { issue: item() } }),
    graph({ node: unlabeled }),
    scopeGraph({ nodes: [unlabeled] }),
    scopeGraph({ nodes: [unlabeled] }),
    graph({
      n0: {
        ...item({ __typename: "Issue", number: 8 }),
        timelineItems: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      },
    }),
  ]);
  await expect(
    gatewayVerb(f.transport, "autopilot", ["inherit", "27"], { VMETHOD_ROLE: "orchestrator" })
  ).rejects.toThrow("No live autopilot grant on the task's linked issues: 8");
  f.done();
});

test("worker cannot stop delegation and issue creation cannot grant it", async () => {
  const f = fixtureServer([]);
  await expect(
    f.gateway.call("autopilotStop", { ref: "27", kind: "pr" }, { role: "worker", taskPr: 27 })
  ).rejects.toThrow("denied for client role");
  await expect(
    f.gateway.call("autopilotInherit", { ref: "27" }, { role: "worker", taskPr: 27 })
  ).rejects.toThrow("denied for client role");
  await expect(
    f.transport.call("issueCreate", { title: "Task", file: "unused.md", labels: ["autopilot"] })
  ).rejects.toThrow("Only the owner may add autopilot");
  f.done();
});

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

test.each([false, true])(
  "open-task reports scope evidence at the server (backlog=%s)",
  async (backlog) => {
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
        n0: scopeIssue({
          timelineItems: scopeConnection([
            scopeMove(
              backlog ? { status: "Executing", previousStatus: "Backlog" } : { actor: actor(2) }
            ),
          ]),
        }),
      }),
    ]);
    await expect(f.transport.call("openTask", { issue: "8", model: "sol" })).rejects.toThrow(
      backlog
        ? "Backlog → Executing is not a scope approval; move it Scoping → Executing, or run scope-review"
        : "scope not approved: run scope-review 8 <file> and ask the owner to move Spec review → Executing"
    );
    f.done();
  }
);

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
const secondOwner = { ...people[0], login: "second-owner", id: 105 };
const secondOwnerActor = { ...actor(), login: secondOwner.login, databaseId: secondOwner.id };

/** A task card on the configured board with one optional field value. */
const cardRead = (value?: ObjectData) =>
  graph({
    node: item({
      projectItems: {
        nodes: [
          {
            id: "card-1",
            project: { number: 1, owner: { login: "example" } },
            fieldValues: {
              nodes: value ? [value] : [],
              pageInfo: { hasNextPage: false },
            },
          },
        ],
        pageInfo: { hasNextPage: false },
      },
    }),
  });

interface GateScenario {
  case: string;
  edited: string | null;
  metas: ObjectData[];
  bodies: Request[];
  authorized: boolean;
  /** The issue card's Model value the gate reads (#242) after the comment path fails. */
  card?: ObjectData;
  /** The comment path approves; no card read happens, so no card response is scripted. */
  commentsFirst?: boolean;
}

const gateScenarios: GateScenario[] = [
  {
    case: "accepts APPROVE MODEL from the second pinned owner",
    edited: "2026-01-06T00:00:00Z",
    metas: [lineMeta(secondOwnerActor)],
    bodies: [lineBody("2026-01-07T00:00:00Z", secondOwnerActor)],
    authorized: true,
  },
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
  {
    case: "accepts an owner line before any card read (#242)",
    edited: "2026-01-06T00:00:00Z",
    metas: [lineMeta(actor(0))],
    bodies: [lineBody("2026-01-07T00:00:00Z", actor(0))],
    authorized: true,
    commentsFirst: true,
  },
  {
    case: "accepts the Model value the owner set on the issue card (#242)",
    edited: "2026-01-06T00:00:00Z",
    metas: [],
    bodies: [],
    authorized: true,
    card: { field: { name: "Model" }, name: "astra", creator: actor(0) },
  },
  {
    case: "accepts the Model value the owner set as card text (#242)",
    edited: "2026-01-06T00:00:00Z",
    metas: [],
    bodies: [],
    authorized: true,
    card: { field: { name: "Model" }, text: "astra", creator: actor(0) },
  },
  {
    case: "refuses the Model value the orchestrator set on the issue card (#242)",
    edited: "2026-01-06T00:00:00Z",
    metas: [],
    bodies: [],
    authorized: false,
    card: { field: { name: "Model" }, name: "astra", creator: actor(2) },
  },
  {
    case: "refuses the Model value of an unpinned card author (#242)",
    edited: "2026-01-06T00:00:00Z",
    metas: [],
    bodies: [],
    authorized: false,
    card: { field: { name: "Model" }, name: "astra", creator: imposter },
  },
  {
    case: "refuses an owner card value set for another family (#242)",
    edited: "2026-01-06T00:00:00Z",
    metas: [],
    bodies: [],
    authorized: false,
    card: { field: { name: "Model" }, name: "sonnet", creator: actor(0) },
  },
];

/** The gate refuses foreign lines unread; the owner's line authorizes the open flow,
 * which then stops at the fixture's first git call before any GitHub mutation. */
test.each(gateScenarios)(
  "open-task model gate verifies the owner line at the server: $case",
  async (scenario) => {
    // The board is off so the flow reaches the model gate with scope metadata reads only.
    const readsCard = !(scenario.authorized && scenario.bodies.length) && !scenario.commentsFirst;
    const f = fixtureServer(
      [
        ...approvedSpecScope(),
        graph({ repository: { issue: item() } }),
        editedIssue(scenario.edited),
        graph({ node: item({ comments: scopeConnection(scenario.metas) }) }),
        ...scenario.bodies,
        ...(readsCard ? [cardRead(scenario.card)] : []),
        // #339: once the gate passes, the launch's advisory advice re-reads the issue
        // through suggest-model's path; the card carries only an Estimate, and with no
        // local learnings the line prints without its evidence clause.
        ...(scenario.authorized
          ? [
              graph({ repository: { issue: item() } }),
              graph({
                node: item({
                  body: "Issue",
                  labels: { nodes: [], pageInfo: { hasNextPage: false } },
                  projectItems: {
                    nodes: [
                      {
                        id: "card-1",
                        project: { number: 1, owner: { login: "example" } },
                        fieldValues: {
                          nodes: [{ field: { name: "Estimate" }, number: 1 }],
                          pageInfo: { hasNextPage: false },
                        },
                      },
                    ],
                    pageInfo: { hasNextPage: false },
                  },
                }),
              }),
            ]
          : []),
      ],
      actor(2),
      [...people, secondOwner],
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
  }
);

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

test("close-task stops the recorded worker and closes an open task PR unmerged", async () => {
  const f = fixtureServer([
    graph({ repository: { pullRequest: item() } }),
    graph({
      node: item({
        __typename: "PullRequest",
        number: 27,
        title: "feat: task",
        body: 'Task text\n\n<!-- vmethod-task {"issues":[8]} -->\n',
        state: "OPEN",
        headRefName: "8-task",
        baseRefName: "dev",
        baseRefOid: sha,
        isDraft: true,
        headRepository: { nameWithOwner: "example/project" },
        labels: { nodes: [], pageInfo: { hasNextPage: false } },
      }),
    }),
    {
      path: "/repos/example/project/issues/27/comments",
      method: "POST",
      body: { body: "Delivery abandoned: the spike does not scale.\n" },
      json: {},
    },
    {
      path: "/repos/example/project/pulls/27",
      method: "PATCH",
      body: { state: "closed" },
      json: { state: "closed" },
    },
  ]);
  f.deps.workers = {
    status: async (pr, forMerge) => {
      expect({ pr, forMerge }).toEqual({ pr: 27, forMerge: false });
      return "stopped";
    },
    resume: async () => {
      throw new Error("Unexpected resume");
    },
    recorded: async (pr) => pr === 27,
    stop: async (pr) => {
      expect(pr).toBe(27);
      return "requested";
    },
  };
  const file = join(f.root, "close.md");
  writeFileSync(file, "Delivery abandoned: the spike does not scale.\n");
  await expect(
    taskFlowVerb(f.transport, "close-task", ["27", "--comment", file], {
      VMETHOD_ROLE: "orchestrator",
    })
  ).resolves.toBe("Closed #27\nReminder: run grade 27");
  expect(f.reports).toEqual([
    "#27 worker stop: requested",
    "#27 worker status after stop: stopped",
  ]);
  f.done();
});

test.each([
  {
    case: "foreign repository",
    ref: "example/foreign#27",
    body: "Task text",
    state: "OPEN",
    reads: false,
    message: "Expected own-repository",
  },
  {
    case: "non-task PR",
    ref: "27",
    body: "Task text",
    state: "OPEN",
    reads: true,
    message: "Closing requires a task PR",
  },
  {
    case: "closed task PR",
    ref: "27",
    body: 'Task text\n\n<!-- vmethod-task {"issues":[8]} -->\n',
    state: "CLOSED",
    reads: true,
    message: "PR is not open",
  },
])("close-task refuses a $case before any write", async ({ ref, body, state, reads, message }) => {
  const prReads = reads
    ? [
        graph({ repository: { pullRequest: item() } }),
        graph({
          node: item({
            __typename: "PullRequest",
            number: 27,
            title: "feat: task",
            body,
            state,
            headRefName: "8-task",
            baseRefName: "dev",
            baseRefOid: sha,
            headRepository: { nameWithOwner: "example/project" },
            labels: { nodes: [], pageInfo: { hasNextPage: false } },
          }),
        }),
      ]
    : [];
  const f = fixtureServer(prReads);
  f.deps.workers = undefined;
  // A refusal never posts, never PATCHes state and never stops a worker.
  await expect(f.transport.call("closeTask", { ref })).rejects.toThrow(message);
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
