import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { buildSchema, graphqlSync, parse, visit } from "graphql";
import { readQuery } from "../../src/gateway/queries.js";
import { actor, fixtureServer, graph, hostile, item, type Request } from "./helpers.js";

test.each([
  'mutation { addComment(input: { subjectId: "x", body: "x" }) { clientMutationId } }',
  "# query { viewer { login } }\nmutation Change { x }",
  "query Q { viewer { login } } mutation M { x }",
  "subscription { x }",
  "fragment X on User { login }",
  "query { __vm_author: viewer { login } }",
])(
  "gh-read refuses mutations, extra operations and reserved aliases before network: %s",
  async (source) => {
    const fixture = fixtureServer([]);
    const file = join(fixture.root, "query.graphql");
    writeFileSync(file, source);
    await expect(fixture.transport.call("ghRead", { source: file })).rejects.toThrow();
    fixture.done();
  },
  15000
);

/** Parse the fenced untrusted-data document, which is always valid JSON. */
function decode(output: string): unknown {
  const match = /\n(`{3,})text\n([\s\S]*)\n\1(?:\n|$)/.exec(output);
  expect(match).not.toBeNull();
  return JSON.parse(match![2]);
}

test("GraphQL parser handles strings, block strings and comments without confusing query data for operations", () => {
  const query = readQuery(
    'query Q { repository(owner: "example", name: "mutation") { issue(number: 3) { alias: body author { login } } } } # mutation\n'
  );
  const fields: string[] = [];
  visit(parse(query), {
    Field(node) {
      if (node.alias) {
        fields.push(node.alias.value);
      }
    },
  });
  expect(fields).toContain("alias");
  expect(fields).toContain("__vm_author");
  expect(fields).toContain("__vm_repository");
  expect(() =>
    readQuery('query { repository(owner: """mutation { not code }""", name: "x") { id } }')
  ).not.toThrow();
}, 15000);

test("GraphQL aliases and fragments cannot hide author-bearing text or foreign repositories", async () => {
  const injected = (overrides = {}) => ({
    __vm_author: actor(1),
    __vm_editor: null,
    __vm_edited: null,
    __vm_repository: item().repository,
    ...overrides,
  });
  const fixture = fixtureServer([
    {
      path: "/graphql",
      json: {
        data: {
          repo: {
            __vm_owner: { login: "example" },
            comments: [
              { innocentAlias: hostile, ...injected() },
              {
                innocentAlias: "NEVER DELIVER UNKNOWN",
                ...injected({ __vm_author: { ...actor(), databaseId: 999 } }),
              },
              {
                innocentAlias: "NEVER DELIVER EDIT",
                ...injected({
                  __vm_edited: "now",
                  __vm_editor: { ...actor(), databaseId: 999 },
                }),
              },
              {
                innocentAlias: "NEVER DELIVER FOREIGN",
                ...injected({
                  __vm_repository: { owner: { login: "outside" } },
                }),
              },
            ],
          },
          foreign: {
            __vm_owner: { login: "outside" },
            description: "NEVER DELIVER OUTSIDE",
          },
        },
      },
    },
  ]);
  const file = join(fixture.root, "query.graphql");
  writeFileSync(
    file,
    'query { repo: repository(owner:"example", name:"project") { comments: issue(number:3) { ...Text } } foreign: repository(owner:"outside", name:"project") { description } } fragment Text on Issue { innocentAlias: body }'
  );
  const output = await fixture.transport.call("ghRead", { source: file });
  expect(output).toContain("UNTRUSTED DATA\n````text");
  expect(output).toContain("from worker (worker)");
  expect(output).toContain("APPROVED");
  expect(output).not.toContain("NEVER DELIVER");
  expect(output).not.toContain("__vm_");
  expect(output.endsWith("1 items dropped by the people filter\n3 nested values redacted")).toBe(
    true
  );
  fixture.done();
}, 15000);

// Execute the outgoing augmented query, rather than returning pre-injected data.
// Account fields project the existing actor fixture into GitHub's User wire shape.
function accountRequest(): Request {
  const schema = buildSchema(`
    type Query { user(login: String!): User }
    type User { login: String!, databaseId: Int, bio: String }
  `);
  const request: Request = {
    path: "/graphql",
    checkQuery(query) {
      const result = graphqlSync({
        schema,
        source: query,
        rootValue: {
          user: ({ login }: { login: string }) =>
            login === "missing"
              ? null
              : { ...actor(1), login, bio: hostile, databaseId: login === "worker" ? 102 : 999 },
        },
      });
      expect(result.errors).toBeUndefined();
      request.json = result;
    },
  };
  return request;
}

const accountSelections = [
  {
    selection: "__typename login databaseId",
    selected: { __typename: "User", login: "worker", databaseId: 102 },
  },
  { selection: "login bio", selected: { login: "worker", bio: hostile } },
  { selection: "login", selected: { login: "worker" } },
  { selection: "handle: login", selected: { handle: "worker" } },
];
test.each(
  accountSelections.flatMap((selection) =>
    ["", "anyone: "].flatMap((alias) =>
      ["worker", "stranger"].map((login) => ({ ...selection, alias, login }))
    )
  )
)(
  "top-level accounts verify independently of selection: $alias $login $selection",
  async ({ selection, selected, alias, login }) => {
    const fixture = fixtureServer([accountRequest()]);
    const file = join(fixture.root, "query.graphql");
    writeFileSync(file, `query { ${alias}user(login:"${login}") { ${selection} } }`);
    const output = await fixture.transport.call("ghRead", { source: file });
    expect(decode(output)).toEqual(
      login === "worker"
        ? { [alias ? "anyone" : "user"]: { ...selected, attribution: "from worker (worker)" } }
        : {}
    );
    expect(
      output.endsWith(`${login === "worker" ? 0 : 1} items dropped by the people filter`)
    ).toBe(true);
    expect(output).not.toContain("__vm_");
    fixture.done();
  },
  15000
);

test.each([
  'query { ... on Query { user(login:"worker") { login } } }',
  'query { ...Accounts } fragment Accounts on Query { user(login:"worker") { login } }',
])(
  "top-level user identity injection works through query fragments: %s",
  async (query) => {
    const fixture = fixtureServer([accountRequest()]);
    const file = join(fixture.root, "query.graphql");
    writeFileSync(file, query);
    const output = await fixture.transport.call("ghRead", { source: file });
    expect(decode(output)).toEqual({
      user: { login: "worker", attribution: "from worker (worker)" },
    });
    fixture.done();
  },
  15000
);

test("a nonexistent top-level account stays null without a filter drop", async () => {
  const fixture = fixtureServer([accountRequest()]);
  const file = join(fixture.root, "query.graphql");
  writeFileSync(file, 'query { user(login:"missing") { login } }');
  const output = await fixture.transport.call("ghRead", { source: file });
  expect(decode(output)).toEqual({ user: null });
  expect(output.endsWith("0 items dropped by the people filter")).toBe(true);
  fixture.done();
}, 15000);

test.each([null, "102"])(
  "a malformed injected account ID %s fails closed",
  async (databaseId) => {
    const fixture = fixtureServer([
      {
        path: "/graphql",
        json: {
          data: {
            user: {
              bio: hostile,
              __vm_actor: "User",
              __vm_login: "worker",
              __vm_databaseId: databaseId,
            },
          },
        },
      },
    ]);
    const file = join(fixture.root, "query.graphql");
    writeFileSync(file, 'query { user(login:"worker") { bio } }');
    const output = await fixture.transport.call("ghRead", { source: file });
    expect(decode(output)).toEqual({});
    expect(output.endsWith("1 items dropped by the people filter")).toBe(true);
    fixture.done();
  },
  15000
);

test.each(["user", "anyone"])(
  "accepted account %s still filters nested authors and text aliases",
  async (field) => {
    const fixture = fixtureServer([
      {
        path: "/graphql",
        json: {
          data: {
            [field]: {
              login: "worker",
              __vm_actor: "User",
              __vm_login: "worker",
              __vm_databaseId: 102,
              issues: {
                nodes: [
                  {
                    body: hostile,
                    __vm_author: { ...actor(1), databaseId: 999 },
                    __vm_repository: item().repository,
                  },
                ],
              },
              projectsV2: { nodes: [{ number: 7, caption: hostile }] },
            },
          },
        },
      },
    ]);
    const file = join(fixture.root, "query.graphql");
    writeFileSync(
      file,
      `query { ${field === "user" ? "" : `${field}: `}user(login:"worker") {
    login issues(first:1) { nodes { body } }
    projectsV2(first:1) { nodes { number caption: title } }
  } }`
    );
    const output = await fixture.transport.call("ghRead", { source: file });
    expect(decode(output)).toEqual({
      [field]: {
        login: "worker",
        attribution: "from worker (worker)",
        issues: { nodes: [] },
        projectsV2: { nodes: [{ number: 7 }] },
      },
    });
    expect(
      output.endsWith(
        "0 items dropped by the people filter\n1 nested values redacted\n1 text fields redacted from unattributable items"
      )
    ).toBe(true);
    expect(output).not.toContain("__vm_");
    fixture.done();
  },
  15000
);

test("a GraphQL user lookup inside a repository no longer poses as a REST item author", async () => {
  const fixture = fixtureServer([
    {
      path: "/graphql",
      json: {
        data: {
          repo: { __vm_owner: { login: "example" }, user: actor(1) },
        },
      },
    },
  ]);
  const file = join(fixture.root, "query.graphql");
  writeFileSync(
    file,
    'query { repo: repository(owner:"example", name:"project") { user(login:"worker") { __typename login databaseId } } }'
  );
  const output = await fixture.transport.call("ghRead", { source: file });
  expect(decode(output)).toEqual({ repo: { user: actor(1) } });
  expect(output.endsWith("0 items dropped by the people filter")).toBe(true);
  fixture.done();
}, 15000);

test("a rejected REST single thread counts as a dropped item", async () => {
  const fixture = fixtureServer([
    {
      path: "/repos/example/project/issues/3",
      method: "GET",
      json: {
        node_id: "node-1",
        number: 3,
        title: "NEVER DELIVER",
        body: "NEVER DELIVER",
        user: { id: 999, type: "User", login: "stranger" },
      },
    },
  ]);
  const output = await fixture.transport.call("ghRead", {
    source: "repos/example/project/issues/3",
  });
  expect(decode(output)).toBeNull();
  expect(output).not.toContain("NEVER DELIVER");
  expect(output.endsWith("1 items dropped by the people filter")).toBe(true);
  fixture.done();
}, 15000);

test("REST diagnostics filter known author fields and unverifiable edits and never deliver raw system text", async () => {
  const fixture = fixtureServer([
    {
      path: "/repos/example/project/issues/3/comments",
      method: "GET",
      json: [
        {
          user: { id: 102, type: "User", login: "worker" },
          body: hostile,
          created_at: "same",
          updated_at: "same",
        },
        {
          user: { id: 999, type: "User", login: "worker" },
          body: "NEVER DELIVER UNKNOWN",
        },
        {
          user: { id: 102, type: "User", login: "worker" },
          body: "NEVER DELIVER EDIT",
          updated_at: "later",
          created_at: "before",
        },
        {
          user: { id: 104, type: "Bot", login: "github-actions[bot]" },
          body: "NEVER DELIVER SYSTEM",
        },
        { title: "NEVER DELIVER MISSING AUTHOR" },
      ],
    },
  ]);
  const output = await fixture.transport.call("ghRead", {
    source: "repos/example/project/issues/3/comments",
  });
  expect(output).toContain("from worker (worker)");
  expect(output).not.toContain("NEVER DELIVER");
  expect(
    output.endsWith(
      "3 items dropped by the people filter\n1 text fields redacted from unattributable items"
    )
  ).toBe(true);
  fixture.done();
}, 15000);

test("REST issue diagnostics resolve verified current text despite metadata update timestamps", async () => {
  const fixture = fixtureServer([
    {
      path: "/repos/example/project/issues/3",
      method: "GET",
      json: {
        node_id: "node-1",
        number: 3,
        title: "stale REST title",
        body: "stale REST text",
        user: { id: 102, type: "User", login: "worker" },
        created_at: "2026-10-16T10:00:00Z",
        updated_at: "2026-10-17T10:00:00Z",
      },
    },
    graph({ node: item() }),
    graph({ node: item({ title: "Verified title", body: "Verified body" }) }),
  ]);
  const output = await fixture.transport.call("ghRead", {
    source: "repos/example/project/issues/3",
  });
  expect(output).toContain("Verified title");
  expect(output).toContain("Verified body");
  expect(output).toContain('"number": 3');
  expect(output).not.toContain("stale REST");
  fixture.done();
}, 15000);

test.each(["author", "editor", "changed editor"])(
  "REST issue diagnostics reject an unknown %s",
  async (reason) => {
    const rest = {
      node_id: "node-1",
      number: 3,
      title: "NEVER DELIVER",
      body: "NEVER DELIVER",
      user: { id: reason === "author" ? 999 : 102, type: "User", login: "worker" },
    };
    const unknown = item({
      title: "NEVER DELIVER",
      body: "NEVER DELIVER",
      editor: { ...actor(), databaseId: 999 },
      lastEditedAt: "2026-10-17T10:00:00Z",
    });
    const metadata = { ...unknown };
    delete metadata.title;
    delete metadata.body;
    const f = fixtureServer([
      { path: "/repos/example/project/issues/3", method: "GET", json: rest },
      ...(reason === "author"
        ? []
        : reason === "editor"
          ? [graph({ node: metadata })]
          : [graph({ node: item() }), graph({ node: unknown })]),
    ]);
    expect(
      await f.transport.call("ghRead", { source: "repos/example/project/issues/3" })
    ).not.toContain("NEVER DELIVER");
    f.done();
  },
  15000
);

test("REST diagnostic check runs also enforce app pins and omit attacker-controlled output", async () => {
  const fixture = fixtureServer([
    {
      path: "/repos/example/project/commits/head/check-runs",
      method: "GET",
      json: {
        check_runs: [
          {
            app: { id: 909 },
            conclusion: "success",
            status: "completed",
            output: { text: hostile },
          },
          {
            app: { id: 999 },
            conclusion: "success",
            output: { text: "NEVER DELIVER" },
          },
        ],
      },
    },
  ]);
  const output = await fixture.transport.call("ghRead", {
    source: "/repos/example/project/commits/head/check-runs",
  });
  expect(output).toContain("from github-actions[bot] (system)");
  expect(output).toContain("success");
  expect(output).not.toContain("APPROVED");
  expect(output).not.toContain("NEVER DELIVER");
  fixture.done();
}, 15000);

test("GraphQL check-run aliases only deliver pinned structured conclusions", async () => {
  const fixture = fixtureServer([
    {
      path: "/graphql",
      json: {
        data: {
          results: [
            {
              renamedName: hostile,
              __vm_app: {
                app: { databaseId: 909 },
                repository: item().repository,
                commit: { oid: "a".repeat(40) },
              },
              __vm_status: "COMPLETED",
              __vm_conclusion: "SUCCESS",
            },
            {
              renamedName: "NEVER DELIVER",
              __vm_app: {
                app: { databaseId: 999 },
                repository: item().repository,
              },
              __vm_status: "COMPLETED",
              __vm_conclusion: "SUCCESS",
            },
          ],
        },
      },
    },
  ]);
  const file = join(fixture.root, "checks.graphql");
  writeFileSync(file, '{ node(id:"x") { ... on CheckRun { renamedName: name } } }');
  const output = await fixture.transport.call("ghRead", { source: file });
  expect(output).toContain("from github-actions[bot] (system)");
  expect(output).toContain("success");
  expect(output).not.toContain("APPROVED");
  expect(output).not.toContain("NEVER DELIVER");
  fixture.done();
}, 15000);

test("query instrumentation protects content selected through connection aliases and fragment-only bodies", () => {
  const result = readQuery(
    '{ repository(owner:"example",name:"project") { issues(first:2) { n:nodes { ...Body } } } } fragment Body on Issue { b:body }'
  );
  expect(result.match(/__vm_author:/g)?.length).toBe(2);
}, 15000);
