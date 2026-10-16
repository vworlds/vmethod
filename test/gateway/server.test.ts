import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createGateway } from "../../src/gateway/server.js";
import { gatewayVerb } from "../../src/cli/gateway.js";
import { actor, fixtureServer, graph, hostile, item, sha } from "./helpers.js";

test("PR metadata is gated before content, hostile titles/bodies remain fenced, and unknown comments have no follow-up read", async () => {
  const fixture = fixtureServer([
    graph({ repository: { pullRequest: item() } }),
    graph({ node: item({ title: hostile, body: hostile }) }),
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
      node: item({ id: "comment-good", author: actor(), body: hostile }),
    }),
  ]);
  const output = await gatewayVerb(fixture.transport, "read", ["pr", "3"]);
  expect(output).toContain("from worker (worker)\nUNTRUSTED DATA\n````text");
  expect(output).toContain("from owner (owner)\nUNTRUSTED DATA");
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
  const fixture = fixtureServer([
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
  "invalid Markdown or closing syntax is refused before any network call: %s",
  async (body) => {
    const fixture = fixtureServer([]);
    const file = join(fixture.root, "post.md");
    writeFileSync(file, body);
    await expect(fixture.transport.call("post", { ref: "3", file })).rejects.toThrow();
    fixture.done();
  },
  15000
);

test("out-of-org posts, mentions in foreign endpoints, methods and malformed CLI arguments are refused offline", async () => {
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
  ])
    await expect(fixture.transport.call("ghRead", { source })).rejects.toThrow("permits");
  for (const [verb, args] of [
    ["read", ["pr", "3", "--bad"]],
    ["read", ["issue", "3", "--diff"]],
    ["post", ["3"]],
    ["gh-read", []],
    ["dropped", ["--since"]],
  ] as [string, string[]][])
    await expect(gatewayVerb(fixture.transport, verb, args)).rejects.toThrow("Usage");
  fixture.done();
}, 15000);

test("dropped requires no token and persisted digest contains no hostile content", async () => {
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
  expect(
    await gatewayVerb(transport, "dropped", [], {
      VMETHOD_ROLE: "orchestrator",
    })
  ).toContain("Dropped: 1");
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

test("registry reads use the injected fetch without GitHub credentials and label all metadata untrusted", async () => {
  const fixture = fixtureServer([]);
  const transport = createGateway(
    fixture.root,
    {},
    {
      ...fixture.deps,
      fetch: async (url, init) => {
        expect(String(url)).toBe("https://registry.npmjs.org/%40example%2Fpackage");
        expect(init?.headers).toBeUndefined();
        expect(init?.redirect).toBe("error");
        return Response.json({
          name: "@example/package",
          description: hostile,
        });
      },
    }
  );
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
    if (++count === 4)
      expect(JSON.parse(String(init?.body)).variables).toEqual({
        id: "node-1",
        cursor: "cursor-1",
      });
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
    if (scenario === "moved-away")
      events.unshift({
        ...events[0],
        status: "In progress",
        previousStatus: "Approved",
        createdAt: "2026-01-01T03:00:00Z",
      });
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
          for (const field of ["createdAt", "previousStatus", "project { number }"])
            expect(query).toContain(field);
        },
      },
    ]);
    expect(await fixture.transport.call("ownerApproved", { ref: "3" })).toBe(false);
    fixture.done();
  },
  15000
);
