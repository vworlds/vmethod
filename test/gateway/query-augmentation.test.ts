import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSchema, graphqlSync, parse, validate } from "graphql";
import { expect, test } from "vitest";
import { readQuery } from "../../src/gateway/queries.js";
import { object } from "../../src/gateway/people.js";
import { actor, fixtureServer, item } from "./helpers.js";

const schema = buildSchema(readFileSync("test/fixtures/github/diagnostic-schema.graphql", "utf8"));
const repository = (selection: string) =>
  `{ repository(owner:"example",name:"project") { ${selection} } }`;
const content = (__typename: string) =>
  item({ __typename, title: "Known title", body: "Known body" });

test.each([
  {
    source: '{ search(query:"x") { nodes { __typename } } }',
    rootValue: { search: { nodes: [content("Issue"), content("PullRequest")] } },
    attributed: 2,
  },
  {
    source: '{ node(id:"x") { id } }',
    rootValue: { node: content("Issue") },
    attributed: 1,
  },
  {
    source: '{ nodes(ids:["x"]) { id } }',
    rootValue: {
      nodes: [
        "Issue",
        "PullRequest",
        "IssueComment",
        "PullRequestReview",
        "PullRequestReviewComment",
      ].map(content),
    },
    attributed: 5,
  },
  {
    source:
      '{ organization(login:"example") { projectsV2 { nodes { items { nodes { content { __typename } } } } } } }',
    rootValue: {
      organization: {
        projectsV2: {
          nodes: [
            {
              items: {
                nodes: [{ content: content("Issue") }, { content: content("PullRequest") }],
              },
            },
          ],
        },
      },
    },
    attributed: 2,
  },
  {
    source: repository(
      "issue(number:3) { comments { nodes { body } } timelineItems { nodes { __typename } } }"
    ),
    rootValue: {
      repository: {
        ...object(item().repository),
        issue: {
          ...content("Issue"),
          comments: { nodes: [content("IssueComment")] },
          timelineItems: { nodes: [content("IssueComment")] },
        },
      },
    },
    attributed: 3,
  },
  {
    source: repository(
      "pullRequest(number:3) { reviews { nodes { comments { nodes { body } } } } reviewThreads { nodes { comments { nodes { body } } } } timelineItems { nodes { __typename } } }"
    ),
    rootValue: {
      repository: {
        ...object(item().repository),
        pullRequest: {
          ...content("PullRequest"),
          reviews: {
            nodes: [
              {
                ...content("PullRequestReview"),
                comments: { nodes: [content("PullRequestReviewComment")] },
              },
            ],
          },
          reviewThreads: {
            nodes: [{ comments: { nodes: [content("PullRequestReviewComment")] } }],
          },
          timelineItems: { nodes: [content("PullRequestReview")] },
        },
      },
    },
    attributed: 5,
  },
])(
  "known content keeps verified attribution through $source",
  async ({ source, rootValue, attributed }) => {
    const result = graphqlSync({ schema, source: readQuery(source), rootValue });
    expect(result.errors).toBeUndefined();
    const fixture = fixtureServer([{ path: "/graphql", json: result }]);
    const file = join(fixture.root, "attribution.graphql");
    writeFileSync(file, source);
    const output = await fixture.transport.call("ghRead", { source: file });
    expect(output.match(/from worker \(worker\)/g)).toHaveLength(attributed);
    expect(output).toContain("0 items dropped by the people filter");
    expect(output).not.toContain("__vm_");
    fixture.done();
  }
);

test.each([
  repository("issue(number:3) { title }"),
  repository("pullRequest(number:3) { title }"),
  repository("issueOrPullRequest(number:3) { ... on Issue { title } }"),
  repository("issues(first:2) { edges { node { title } } }"),
  repository("pullRequests(first:2) { nodes { title } }"),
  repository(
    "issue(number:3) { comments { nodes { body } } timelineItems { nodes { __typename } } }"
  ),
  repository(
    "pullRequest(number:3) { comments { nodes { body } } reviews { nodes { body comments { nodes { body } } } } reviewThreads { nodes { comments { nodes { body } } } } timelineItems { nodes { __typename } } }"
  ),
  '{ search(query:"x",type:"ISSUE") { nodes { __typename } } }',
  '{ node(id:"x") { id } }',
  '{ nodes(ids:["x"]) { id } }',
  '{ node(id:"x") { ... on Issue { title } ... on ProjectV2 { title } } }',
  "{ gist { comments { nodes { body } } } }",
  '{ organization(login:"example") { projectsV2 { nodes { items { nodes { content { __typename } } } } } } }',
  '{ node(id:"x") { ... on ProjectV2 { items { nodes { ...Item } } } } } fragment Item on ProjectV2Item { content { __typename } }',
  repository("issue(number:3) { ...Text }") + " fragment Text on Issue { b:body }",
  repository("issue(number:3) { ... on Issue { title } }"),
])("augmented query passes schema validation: %s", (source) => {
  const errors = validate(schema, parse(readQuery(source)));
  expect(errors.map((error) => error.message)).toEqual([]);
});

test("unattributable label, repository and ProjectV2 field and option names survive", async () => {
  const source =
    '{ repository(owner:"example",name:"project") { name labels(first:2) { nodes { name description } } } organization(login:"example") { projectsV2 { nodes { fields(first:10) { nodes { ... on ProjectV2SingleSelectField { name options { name } } } } } } } }';
  const result = graphqlSync({
    schema,
    source: readQuery(source),
    rootValue: {
      repository: {
        ...object(item().repository),
        name: "project",
        labels: { nodes: [{ name: "bug", description: "NEVER DELIVER" }] },
      },
      organization: {
        projectsV2: {
          nodes: [
            {
              fields: {
                nodes: [
                  {
                    __typename: "ProjectV2SingleSelectField",
                    name: "Progress",
                    options: [{ name: "Todo" }, { name: "Done" }],
                  },
                ],
              },
            },
          ],
        },
      },
    },
  });
  expect(result.errors).toBeUndefined();
  const fixture = fixtureServer([{ path: "/graphql", json: result }]);
  const file = join(fixture.root, "structural-names.graphql");
  writeFileSync(file, source);
  const output = await fixture.transport.call("ghRead", { source: file });
  for (const name of ["project", "bug", "Progress", "Todo", "Done"]) {
    expect(output).toContain(`"name": "${name}"`);
  }
  expect(output).not.toContain("NEVER DELIVER");
  expect(output).toContain("0 items dropped by the people filter");
  expect(output).toContain("1 text fields redacted from unattributable items");
  fixture.done();
});

test("unattributable text aliases and all specified text fields are redacted without losing metadata", async () => {
  const source =
    '{ node(id:"x") { ...ProjectText } viewer { name label:login } gist { description comments { nodes { body bodyText html:bodyHTML } } } } fragment ProjectText on ProjectV2 { id number url createdAt label:title author:title shortDescription readme }';
  const result = graphqlSync({
    schema,
    source: readQuery(source),
    rootValue: {
      node: {
        __typename: "ProjectV2",
        id: "x",
        number: 5,
        url: "https://github.com/orgs/example/projects/5",
        createdAt: "2026-10-28T17:00:00Z",
        title: "NEVER DELIVER",
        shortDescription: "NEVER DELIVER",
        readme: "NEVER DELIVER",
      },
      viewer: { name: "Worker display name", login: "worker" },
      gist: {
        description: "NEVER DELIVER",
        comments: {
          nodes: [{ body: "NEVER DELIVER", bodyText: "NEVER DELIVER", bodyHTML: "NEVER DELIVER" }],
        },
      },
    },
  });
  expect(result.errors).toBeUndefined();
  const fixture = fixtureServer([{ path: "/graphql", json: result }]);
  const file = join(fixture.root, "aliases.graphql");
  writeFileSync(file, source);
  const output = await fixture.transport.call("ghRead", { source: file });
  expect(output).not.toContain("NEVER DELIVER");
  expect(output).toContain('"id": "x"');
  expect(output).toContain('"number": 5');
  expect(output).toContain('"createdAt": "2026-10-28T17:00:00Z"');
  expect(output).toContain('"label": "worker"');
  expect(output).toContain('"name": "Worker display name"');
  expect(output).toContain("0 items dropped by the people filter");
  expect(output).toContain("8 text fields redacted from unattributable items");
  fixture.done();
});

test("NNext projects query keeps numbers and URLs but redacts unattributable titles", async () => {
  const source =
    '{ viewer { login } organization(login:"example") { projectsV2(first:20) { nodes { number title url } } } }';
  // Execute against the explicit schema fixture so the response cannot mask invalid augmentation.
  const result = graphqlSync({
    schema,
    source: readQuery(source),
    rootValue: {
      viewer: { login: "worker" },
      organization: {
        projectsV2: {
          nodes: [
            {
              number: 5,
              title: "NEVER DELIVER PROJECT TITLE",
              url: "https://github.com/orgs/example/projects/5",
            },
            {
              number: 6,
              title: "NEVER DELIVER SECOND TITLE",
              url: "https://github.com/orgs/example/projects/6",
            },
          ],
        },
      },
    },
  });
  expect(result.errors).toBeUndefined();
  const fixture = fixtureServer([
    {
      path: "/graphql",
      json: result,
      checkQuery(query) {
        expect(validate(schema, parse(query))).toEqual([]);
      },
    },
  ]);
  const file = join(fixture.root, "projects.graphql");
  writeFileSync(file, source);
  const output = await fixture.transport.call("ghRead", { source: file });
  expect(output).toContain('"login": "worker"');
  expect(output).toContain('"number": 5');
  expect(output).toContain('"number": 6');
  expect(output).toContain('"url": "https://github.com/orgs/example/projects/5"');
  expect(output).not.toContain("NEVER DELIVER");
  expect(output).toContain("0 items dropped by the people filter");
  expect(output).toContain("2 text fields redacted from unattributable items");
  fixture.done();
});

test.each(["issue", "pullRequest"])(
  "%s still injects identity and drops an unpinned author",
  async (field) => {
    const source = repository(`${field}(number:3) { title body }`);
    const rootValue = (reason: string) => ({
      repository: {
        owner: { login: "example" },
        nameWithOwner: "example/project",
        [field]: item({
          title: reason !== "known" ? "NEVER DELIVER" : "Known title",
          body: "Known body",
          author:
            reason === "author"
              ? { ...actor(1), databaseId: 999 }
              : reason === "missing author"
                ? null
                : actor(1),
          editor: reason === "editor" ? { ...actor(1), databaseId: 999 } : null,
          lastEditedAt: reason === "editor" ? "2026-10-28T17:00:00Z" : null,
        }),
      },
    });
    for (const reason of ["known", "author", "editor", "missing author"]) {
      const result = graphqlSync({
        schema,
        source: readQuery(source),
        rootValue: rootValue(reason),
      });
      expect(result.errors).toBeUndefined();
      const fixture = fixtureServer([{ path: "/graphql", json: result }]);
      const file = join(fixture.root, "content.graphql");
      writeFileSync(file, source);
      const output = await fixture.transport.call("ghRead", { source: file });
      expect(output).not.toContain("NEVER DELIVER");
      if (reason !== "known") {
        expect(output).not.toContain("Known body");
        expect(output).toContain("1 nested values redacted");
      } else {
        expect(output).toContain("Known title");
        expect(output).toContain("Known body");
        expect(output).toContain("from worker (worker)");
      }
      expect(output).not.toContain("__vm_");
      fixture.done();
    }
  }
);
