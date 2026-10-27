import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createGateway } from "../../src/gateway/server.js";
import { gatewayVerb } from "../../src/cli/gateway.js";
import {
  actor,
  fixtureServer,
  graph,
  selectedGraph,
  hostile,
  item,
  sha,
  workerFixtureServer,
} from "./helpers.js";
import recordedBoard from "../fixtures/github/board-write-inputs.json" with { type: "json" };

test.each(["owner", "worker", "unknown", "untrusted edit"])(
  "plain post on an orchestrator turn checks the latest %s comment without handing back",
  async (author) => {
    // Project the recorded board wire shape, substituting identities and turn values.
    const recorded = structuredClone(recordedBoard.items.nodes[0]);
    const card = {
      ...recorded,
      content: {
        ...recorded.content,
        __typename: "PullRequest",
        id: "node-1",
        assignees: { nodes: [{ login: "peer" }] },
      },
      fieldValues: {
        ...recorded.fieldValues,
        nodes: [
          { name: "Owner review", field: { name: "Status" } },
          { text: "🧭🔍", field: { name: "Progress" } },
        ],
      },
    };
    const comment = item({
      author:
        author === "worker"
          ? actor(1)
          : author === "unknown"
            ? { ...actor(0), databaseId: 9999 }
            : actor(0),
      createdAt: "2026-10-19T10:00:00Z",
      ...(author === "untrusted edit"
        ? { lastEditedAt: "2026-10-19T10:01:00Z", editor: { ...actor(0), databaseId: 9999 } }
        : {}),
    });
    const fixture = fixtureServer([
      graph({ repository: { issueOrPullRequest: item({ __typename: "PullRequest" }) } }),
      { path: "/graphql", json: { data: { organization: { projectV2: recordedBoard } } } },
      { path: "/graphql", json: { data: { node: { fields: recordedBoard.fields } } } },
      {
        path: "/graphql",
        json: { data: { node: { items: { nodes: [card], pageInfo: { hasNextPage: false } } } } },
      },
      graph({
        node: item({
          comments: {
            nodes: [item({ author: actor(1) }), comment, item({ author: actor(2) })],
            pageInfo: { hasNextPage: false },
          },
        }),
      }),
      {
        path: "/repos/example/project/issues/3/comments",
        method: "POST",
        body: { body: "Answer\n" },
      },
    ]);
    const file = join(fixture.root, "answer.md");
    writeFileSync(file, "Answer\n");
    const output = await fixture.transport.call("post", { ref: "3", file });
    expect(output.includes("this does not hand the turn back; use review 3 owner")).toBe(
      author === "owner"
    );
    fixture.done();
  }
);

test("PR metadata is gated before content, hostile titles/bodies remain fenced, and unknown comments have no follow-up read", async () => {
  const fixture = fixtureServer([
    graph({ repository: { pullRequest: item() } }),
    graph({
      node: item({
        title: hostile,
        body: hostile,
        isDraft: false,
        state: "OPEN",
        createdAt: "2026-10-27T09:12:00Z",
      }),
    }),
    graph({
      node: item({
        comments: {
          nodes: [
            item({
              id: "comment-unknown",
              author: { ...actor(), databaseId: 999 },
            }),
            item({ id: "comment-good", author: actor() }),
          ],
          pageInfo: { hasNextPage: false },
        },
      }),
    }),
    graph({
      node: item({
        id: "comment-good",
        author: actor(),
        body: hostile,
        databaseId: 6437236013,
        createdAt: "2026-10-27T09:12:00Z",
      }),
    }),
    graph({ node: item({ reviews: { nodes: [], pageInfo: { hasNextPage: false } } }) }),
    graph({
      node: item({ reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } }),
    }),
  ]);
  const output = await gatewayVerb(fixture.transport, "read", ["pr", "3"]);
  expect(output).toContain("### pr 3, worker (worker), 2026-10-27T09:12Z");
  expect(output).toContain("### comment 6437236013, owner (owner), 2026-10-27T09:12Z");
  expect(output).toContain("UNTRUSTED DATA\n````text");
  expect(output).toContain(hostile);
  expect(await fixture.transport.call("dropped", {})).toBe(
    "Dropped: 1\n1 https://github.com/example/project/issues/3"
  );
  fixture.done();
}, 15000);

test.each([
  item({ author: { ...actor(), databaseId: 999 } }),
  item({ author: actor(3) }),
  item({ lastEditedAt: "now", editor: { ...actor(), databaseId: 999 } }),
  item({
    repository: {
      owner: { login: "outside" },
      nameWithOwner: "outside/project",
    },
  }),
])(
  "dropped PR identity never triggers any content or checks reads: %j",
  async (meta) => {
    const fixture = fixtureServer([graph({ repository: { pullRequest: meta } })]);
    expect(
      await fixture.transport.call("read", {
        kind: "pr",
        ref: "3",
        option: "--checks",
      })
    ).toBe("No accepted thread");
    fixture.done();
  },
  15000
);

test("a non-author edit between metadata and body reads is re-filtered", async () => {
  const fixture = fixtureServer([
    graph({ repository: { issue: item() } }),
    graph({
      node: item({
        body: "NEVER DELIVER",
        lastEditedAt: "now",
        editor: { ...actor(), databaseId: 999 },
      }),
    }),
  ]);
  expect(await fixture.transport.call("read", { kind: "issue", ref: "3" })).toBe(
    "No accepted thread"
  );
  fixture.done();
}, 15000);

test("checks pass by app id and structured fields only, never workflow free text or a forged name", async () => {
  const fixture = fixtureServer([
    graph({ repository: { pullRequest: item() } }),
    {
      path: `/repos/example/project/commits/${sha}/check-runs?per_page=100&page=1`,
      method: "GET",
      json: {
        check_runs: [
          {
            app: { id: 909 },
            name: hostile,
            status: "completed",
            conclusion: "success",
            output: { text: "NEVER DELIVER" },
          },
          {
            app: { id: 999 },
            name: "CI",
            status: "completed",
            conclusion: "success",
          },
        ],
      },
    },
  ]);
  const output = await fixture.transport.call("read", {
    kind: "checks",
    ref: "3",
  });
  expect(output).toContain("from github-actions[bot] (system)");
  expect(output).toContain('"conclusion":"success"');
  expect(output).not.toContain("NEVER DELIVER");
  expect(output).not.toContain("APPROVED");
  fixture.done();
}, 15000);

test.each(["--files", "--diff"] as const)(
  "PR %s output is labelled untrusted and never executed by git",
  async (option) => {
    const fixture = fixtureServer([
      graph({ repository: { pullRequest: item() } }),
      option === "--diff"
        ? {
            path: "/repos/example/project/pulls/3",
            method: "GET",
            text: hostile,
          }
        : {
            path: "/repos/example/project/pulls/3/files?per_page=100&page=1",
            method: "GET",
            json: [{ filename: hostile, patch: hostile }],
          },
    ]);
    expect(await fixture.transport.call("read", { kind: "pr", ref: "3", option })).toContain(
      "from worker (worker)\nUNTRUSTED DATA"
    );
    fixture.done();
  },
  15000
);

test("comment reads verify REST identity then GraphQL editor before fetching body", async () => {
  const fixture = fixtureServer([
    {
      path: "/repos/example/project/issues/comments/44",
      method: "GET",
      json: {
        user: { id: 102, type: "User", login: "worker" },
        node_id: "comment",
        issue_url: "https://api.github.com/repos/example/project/issues/3",
      },
    },
    graph({
      node: item({ id: "comment", lastEditedAt: "now", editor: actor(2) }),
    }),
    graph({
      node: item({
        id: "comment",
        lastEditedAt: "now",
        editor: actor(2),
        body: hostile,
      }),
    }),
  ]);
  expect(await fixture.transport.call("read", { kind: "comment", ref: "44" })).toContain(
    "from peer (orchestrator)"
  );
  fixture.done();
}, 15000);

test("post validates first, sends exact Markdown without footer, and supports a PR through issueOrPullRequest", async () => {
  const body = "[worker] ACK\n\nThis is data: `$(touch OWNED)`\n";
  const fixture = workerFixtureServer([
    graph({ repository: { issueOrPullRequest: item() } }),
    {
      path: "/repos/example/project/issues/3/comments",
      body: { body },
      json: { id: 44 },
    },
  ]);
  const file = join(fixture.root, "post.md");
  writeFileSync(file, body);
  expect(
    await gatewayVerb(fixture.transport, "post", ["3", file], {
      VMETHOD_TASK_PR: "3",
    })
  ).toBe("Posted to https://github.com/example/project/issues/3");
  fixture.done();
}, 15000);

test.each(["discussion_r4363811103", "issuecomment-44"])(
  "post --in-reply-to routes %s without changing the file content",
  async (anchor) => {
    const body = "A reply with `$(touch OWNED)` as data.\n";
    const inline = anchor.startsWith("discussion_r");
    const fixture = workerFixtureServer([
      selectedGraph({ repository: { issueOrPullRequest: item({ __typename: "PullRequest" }) } }),
      {
        path: inline
          ? "/repos/example/project/pulls/3/comments/4363811103/replies"
          : "/repos/example/project/issues/3/comments",
        body: { body },
        // Projection of the REST reply supplied in PR 214's authenticated ANSWER.
        json: { id: 4363811370, node_id: "PRRC_kwDOVMIbYc8AAAABBBp6Kg" },
      },
    ]);
    const file = join(fixture.root, "reply.md");
    writeFileSync(file, body);
    expect(
      await gatewayVerb(
        fixture.transport,
        "post",
        ["3", file, "--in-reply-to", `https://github.com/example/project/pull/3#${anchor}`],
        { VMETHOD_TASK_PR: "3" }
      )
    ).toBe("Posted to https://github.com/example/project/issues/3");
    fixture.done();
  },
  15000
);

test.each([
  "https://github.com/example/project/pull/4#discussion_r1",
  "https://github.com/foreign/project/pull/3#discussion_r1",
  "https://github.com/example/project/issues/3#discussion_r1",
  "https://evil.invalid/example/project/pull/3#discussion_r1",
  "https://github.com/example/project/pull/3?x=1#discussion_r1",
  "https://user@github.com/example/project/pull/3#discussion_r1",
  "https://github.com/example/project/pull/3#discussion_r0",
  "https://github.com/example/project/pull/3#discussion_r9999999999999999999999",
])(
  "post refuses an invalid or cross-target reply URL before operation I/O: %s",
  async (replyTo) => {
    const fixture = workerFixtureServer([]);
    await expect(
      fixture.transport.call(
        "post",
        { ref: "3", file: "nonexistent", replyTo },
        { role: "worker", taskPr: 3 }
      )
    ).rejects.toThrow(/reply URL/);
    fixture.done();
  }
);

test("inline post refuses an Issue returned by the real union selection without writing", async () => {
  const fixture = workerFixtureServer([
    selectedGraph({ repository: { issueOrPullRequest: item({ __typename: "Issue" }) } }),
  ]);
  const file = join(fixture.root, "reply.md");
  writeFileSync(file, "A reply.\n");
  await expect(
    fixture.transport.call(
      "post",
      {
        ref: "3",
        file,
        replyTo: "https://github.com/example/project/pull/3#discussion_r4363811103",
      },
      { role: "worker", taskPr: 3 }
    )
  ).rejects.toThrow("Inline replies require a PR");
  fixture.done();
});

test.each([
  "Fixes #3",
  "CLOSES example/project#3",
  "Resolved: #3",
  "Part of #3",
  "**Fixes** [#3](https://github.com/example/project/issues/3)",
  "Closes https://github.com/example/project/issues/3",
  "```mermaid\ngraph TD\n",
  "```\nunclosed",
])(
  "invalid Markdown or closing syntax is refused before target reads or writes: %s",
  async (body) => {
    const fixture = fixtureServer([]);
    const file = join(fixture.root, "post.md");
    writeFileSync(file, body);
    await expect(fixture.transport.call("post", { ref: "3", file })).rejects.toThrow();
    fixture.done();
  },
  15000
);

test("out-of-org posts, mentions in foreign endpoints, methods and malformed CLI arguments are refused before operation I/O", async () => {
  const fixture = fixtureServer([]);
  await expect(
    fixture.transport.call("post", {
      ref: "outside/project#3",
      file: "nonexistent",
    })
  ).rejects.toThrow("outside");
  for (const source of [
    "/repos/outside/project/issues/3",
    "POST /repos/example/project",
    "https://api.github.com/repos/example/project",
    "/repos/example/project/../outside",
    "/repos/example/project%2f..",
  ]) {
    await expect(fixture.transport.call("ghRead", { source })).rejects.toThrow("permits");
  }
  for (const [verb, args] of [
    ["read", ["pr", "3", "--bad"]],
    ["read", ["issue", "3", "--diff"]],
    ["post", ["3"]],
    ["gh-read", []],
    ["dropped", ["--since"]],
  ] as [string, string[]][]) {
    await expect(gatewayVerb(fixture.transport, verb, args)).rejects.toThrow("Usage");
  }
  fixture.done();
}, 15000);

test("dropped requires a credential and persisted digest contains no hostile content", async () => {
  const fixture = fixtureServer([
    graph({
      repository: {
        pullRequest: item({
          author: { ...actor(), databaseId: 999 },
          body: hostile,
        }),
      },
    }),
  ]);
  await fixture.transport.call("read", { kind: "pr", ref: "3" });
  const transport = createGateway(
    fixture.root,
    { XDG_STATE_HOME: fixture.env.XDG_STATE_HOME },
    fixture.deps
  );
  await expect(
    gatewayVerb(transport, "dropped", [], {
      VMETHOD_ROLE: "orchestrator",
    })
  ).rejects.toThrow("Missing GH_CONFIG_DIR");
  expect(await fixture.transport.call("dropped", {})).toContain("Dropped: 1");
  const text = readFileSync(
    join(fixture.env.XDG_STATE_HOME, "vmethod/example-state/dropped.jsonl"),
    "utf8"
  );
  expect(text).not.toContain("APPROVED");
  fixture.done();
}, 15000);

test("owner review approval is authoritative without a timeline read, and the current head is rechecked", async () => {
  const fixture = fixtureServer([
    graph({ repository: { pullRequest: item() } }),
    graph({
      node: item({
        reviews: {
          nodes: [item({ author: actor(), state: "APPROVED", commit: { oid: sha } })],
          pageInfo: { hasNextPage: false },
        },
      }),
    }),
    graph({ repository: { pullRequest: item() } }),
  ]);
  expect(await fixture.transport.call("ownerApproved", { ref: "3" })).toBe(true);
  fixture.done();
}, 15000);

test.each([actor(), actor(2), null])(
  "board approval uses the timeline actor, not current Status: %j",
  async (eventActor) => {
    const fixture = fixtureServer([
      graph({ repository: { pullRequest: item() } }),
      graph({
        node: item({
          reviews: { nodes: [], pageInfo: { hasNextPage: false } },
        }),
      }),
      graph({
        node: item({
          comments: {
            nodes: [item({ id: "handover", author: actor(2) })],
            pageInfo: { hasNextPage: false },
          },
        }),
      }),
      graph({
        node: item({
          id: "handover",
          author: actor(2),
          body: `[orchestrator] OWNER REVIEW\nHead ${sha}`,
          createdAt: "2026-01-01T00:00:00Z",
        }),
      }),
      graph({
        node: item({
          timelineItems: {
            nodes: [
              {
                __typename: "ProjectV2ItemStatusChangedEvent",
                status: "Approved",
                actor: eventActor,
                createdAt: "2026-01-01T01:00:00Z",
                previousStatus: "In review",
                project: { number: 1 },
              },
            ],
            pageInfo: { hasNextPage: false },
          },
        }),
      }),
    ]);
    expect(await fixture.transport.call("ownerApproved", { ref: "3" })).toBe(
      eventActor === null ? "unknown" : eventActor.databaseId === 101
    );
    fixture.done();
  },
  15000
);

test("registry reads authenticate first but never send GitHub credentials to npm", async () => {
  const fixture = fixtureServer([]);
  const transport = createGateway(fixture.root, fixture.env, {
    ...fixture.deps,
    fetch: async (url, init) => {
      if (String(url) === "https://api.github.com/graphql") {
        expect(JSON.parse(String(init?.body)).query).toBe(
          "query GatewayIdentity { viewer { databaseId login __typename } }"
        );
        return Response.json({ data: { viewer: actor(1) } });
      }
      expect(String(url)).toBe("https://registry.npmjs.org/%40example%2Fpackage");
      expect(init?.headers).toBeUndefined();
      expect(init?.redirect).toBe("error");
      return Response.json({
        name: "@example/package",
        description: hostile,
      });
    },
  });
  expect(
    await transport.call("read", { kind: "registry", ref: "@example/package" }, { role: "worker" })
  ).toContain("UNTRUSTED DATA");
  fixture.done();
}, 15000);

test("comment pagination carries the cursor, filters before follow-up reads, and labels a trusted editor", async () => {
  const fixture = fixtureServer([
    graph({ repository: { issue: item() } }),
    graph({ node: item({ title: "Issue", body: hostile }) }),
    graph({
      node: item({
        comments: {
          nodes: [item({ id: "unknown", author: { ...actor(), databaseId: 999 } })],
          pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
        },
      }),
    }),
    graph({
      node: item({
        comments: {
          nodes: [item({ id: "accepted", lastEditedAt: "now", editor: actor(2) })],
          pageInfo: { hasNextPage: false },
        },
      }),
    }),
    graph({
      node: item({
        id: "accepted",
        lastEditedAt: "now",
        editor: actor(2),
        body: hostile,
      }),
    }),
  ]);
  const fetch = fixture.deps.fetch;
  let count = 0;
  fixture.deps.fetch = async (url, init) => {
    if (JSON.parse(String(init?.body)).query.includes("query GatewayIdentity")) {
      return fetch(url, init);
    }
    if (++count === 4) {
      expect(JSON.parse(String(init?.body)).variables).toEqual({
        id: "node-1",
        cursor: "cursor-1",
      });
    }
    return fetch(url, init);
  };
  const result = await fixture.transport.call("read", {
    kind: "issue",
    ref: "3",
  });
  expect(result).toContain("from peer (orchestrator)");
  fixture.done();
}, 15000);

test("reviews are fetched only after metadata/editor identity passes", async () => {
  const fixture = fixtureServer([
    graph({ repository: { pullRequest: item() } }),
    graph({
      node: item({
        reviews: {
          nodes: [item({ id: "review", author: actor() })],
          pageInfo: { hasNextPage: false },
        },
      }),
    }),
    graph({ node: item({ id: "review", author: actor(), body: hostile }) }),
  ]);
  expect(
    await fixture.transport.call("read", {
      kind: "pr",
      ref: "3",
      option: "--reviews",
    })
  ).toContain("from owner (owner)");
  fixture.done();
}, 15000);

test("post refuses an unknown target author without issuing a write", async () => {
  const fixture = fixtureServer([
    graph({
      repository: {
        issueOrPullRequest: item({ author: { ...actor(), databaseId: 999 } }),
      },
    }),
  ]);
  const file = join(fixture.root, "post.md");
  writeFileSync(file, "[worker] ACK\n");
  await expect(fixture.transport.call("post", { ref: "3", file })).rejects.toThrow(
    "unaccepted thread"
  );
  fixture.done();
}, 15000);

test.each([
  "new-head",
  "moved-away",
  "other-project",
  "before-handover",
  "old-sha",
  "wrong-author",
])(
  "server rejects stale or unrelated board approval: %s",
  async (scenario) => {
    const head = scenario === "new-head" ? "b".repeat(40) : sha;
    const meta = item({ headRefOid: head });
    const handoverMeta = item({
      id: "handover",
      author: scenario === "wrong-author" ? actor(1) : actor(2),
    });
    const events = [
      {
        __typename: "ProjectV2ItemStatusChangedEvent",
        status: "Approved",
        previousStatus: "In review",
        actor: actor(),
        project: { number: scenario === "other-project" ? 2 : 1 },
        createdAt: scenario === "before-handover" ? "2026-01-01T00:00:00Z" : "2026-01-01T02:00:00Z",
      },
    ];
    if (scenario === "moved-away") {
      events.unshift({
        ...events[0],
        status: "In progress",
        previousStatus: "Approved",
        createdAt: "2026-01-01T03:00:00Z",
      });
    }
    const fixture = fixtureServer([
      graph({ repository: { pullRequest: meta } }),
      graph({
        node: {
          ...meta,
          reviews: { nodes: [], pageInfo: { hasNextPage: false } },
        },
      }),
      graph({
        node: {
          ...meta,
          comments: { nodes: [handoverMeta], pageInfo: { hasNextPage: false } },
        },
      }),
      ...(scenario === "wrong-author"
        ? []
        : [
            graph({
              node: {
                ...handoverMeta,
                body: `[orchestrator] OWNER REVIEW\nHead: ${scenario === "old-sha" ? "c".repeat(40) : sha}`,
                createdAt: "2026-01-01T01:00:00Z",
              },
            }),
          ]),
      {
        ...graph({
          node: {
            ...meta,
            timelineItems: { nodes: events, pageInfo: { hasNextPage: false } },
          },
        }),
        checkQuery(query: string) {
          // The live event fields must be requested, not merely present in the fake response.
          for (const field of ["createdAt", "previousStatus", "project { number }"]) {
            expect(query).toContain(field);
          }
        },
      },
    ]);
    expect(await fixture.transport.call("ownerApproved", { ref: "3" })).toBe(false);
    fixture.done();
  },
  15000
);
