import { expect, test } from "vitest";
import { parse } from "graphql";
import { ownerForTurn, turnAssignees } from "../../src/gateway/turn.js";
import { GitHubClient } from "../../src/gateway/client.js";
import { object, type ObjectData, type Person } from "../../src/gateway/people.js";
import { actor, fakeServer, people } from "./helpers.js";
import { scopeComment, scopeMove } from "./scope-fixture.js";
import { WatchFake } from "./watch-fake.js";
import labels from "../fixtures/github/autopilot-wire.json" with { type: "json" };

const second: Person = { login: "second-owner", id: 105, type: "User", role: "owner" };
const secondActor = { login: second.login, databaseId: second.id, __typename: second.type };
const registry = [...people, second];
// Timeline nodes project the recorded comment, board and label response shapes;
// pageInfo uses GitHub's backward-connection fields instead of forward fields.
const page = (nodes: ObjectData[], previous = false, cursor = "older") => ({
  nodes,
  pageInfo: { hasPreviousPage: previous, startCursor: cursor },
});

test.each([
  scopeComment({ __typename: "IssueComment", author: secondActor }),
  scopeMove({ actor: secondActor }),
  { ...labels.data.repository.issue.timelineItems.nodes[0], actor: secondActor },
  scopeComment({ __typename: "PullRequestReview", author: secondActor }),
])("latest owner interaction selects exactly that owner: $__typename", async (interaction) => {
  const f = new WatchFake();
  const github = new GitHubClient(f.config, f.env, f.deps);
  const latest = { ...interaction, createdAt: "2026-10-28T12:00:00Z" };
  const selected = await ownerForTurn(
    github,
    registry,
    "example/project",
    8,
    page([
      scopeMove({ actor: actor(), createdAt: "2026-10-27T12:00:00Z" }),
      latest,
      scopeComment({ author: actor(1), createdAt: "2026-10-29T12:00:00Z" }),
    ])
  );
  expect(
    turnAssignees(registry, "example/project", ["owner", "worker"], "owner", selected)
  ).toEqual([second.login]);
  expect(f.requests).toEqual([]);
});

test("no owner interaction uses registry order, ignoring forged identities and tags", async () => {
  const f = new WatchFake();
  const github = new GitHubClient(f.config, f.env, f.deps);
  for (const author of [
    actor(1),
    { ...secondActor, databaseId: 999 },
    { ...secondActor, login: "imposter" },
    { ...secondActor, __typename: "Bot" },
  ]) {
    const selected = await ownerForTurn(
      github,
      registry,
      "example/project",
      8,
      page([scopeComment({ author, body: "[owner] APPROVE MODEL astra" })])
    );
    expect(turnAssignees(registry, "example/project", [], "owner", selected)).toEqual(["owner"]);
  }
  expect(await ownerForTurn(github, [second, ...people], "example/project", 8, page([]))).toBe(
    second.login
  );
});

test("edited comments use the pinned editor, never the original owner's identity", async () => {
  const f = new WatchFake();
  const github = new GitHubClient(f.config, f.env, f.deps);
  const edited = scopeComment({
    author: actor(),
    editor: secondActor,
    lastEditedAt: "2026-10-28T00:00:00Z",
  });
  expect(await ownerForTurn(github, registry, "example/project", 8, page([edited]))).toBe(
    second.login
  );
  expect(
    await ownerForTurn(
      github,
      registry,
      "example/project",
      8,
      page([{ ...edited, editor: actor(1) }])
    )
  ).toBe("owner");
});

test.each([false, true])(
  "owner selection reads older activity, including newer edits (edit=%s)",
  async (edit) => {
    const f = new WatchFake();
    const fake = fakeServer([
      {
        path: "/graphql",
        checkQuery(query, variables) {
          parse(query);
          expect(variables).toEqual({
            owner: "example",
            name: "project",
            number: 8,
            before: "older",
          });
          expect(query).not.toContain("body");
        },
        json: {
          data: {
            repository: {
              issueOrPullRequest: {
                ownerActivity: page([
                  edit
                    ? scopeComment({
                        author: actor(),
                        editor: secondActor,
                        lastEditedAt: "2026-10-28T12:00:00Z",
                      })
                    : scopeMove({ actor: secondActor }),
                ]),
              },
            },
          },
        },
      },
    ]);
    const github = new GitHubClient(f.config, f.env, { ...f.deps, fetch: fake.fetch });
    expect(
      await ownerForTurn(
        github,
        registry,
        "example/project",
        8,
        page(
          edit
            ? [
                scopeMove({
                  createdAt: "2026-10-27T12:00:00Z",
                }),
              ]
            : [],
          true
        )
      )
    ).toBe(second.login);
    fake.done();
  }
);

test("watcher follows a new interaction by either owner on subsequent polls", async () => {
  const f = new WatchFake();
  f.watchPeople = registry;
  const card = f.card(8, "Spec review");
  object(card.progress).text = "👤🔍";
  const content = object(card.content);
  content.ownerActivity = page([]);
  content.assignees = { nodes: [{ login: "owner" }] };
  f.cards = [card];
  const loop = f.loop();
  await f.once(loop);
  const secondMove = scopeMove({ actor: secondActor, createdAt: "2026-10-28T12:00:00Z" });
  content.ownerActivity = page([secondMove]);
  f.advance();
  await f.once(loop);
  expect(content.assignees).toEqual({ nodes: [{ login: second.login }] });
  content.ownerActivity = page([secondMove, scopeMove({ createdAt: "2026-10-29T12:00:00Z" })]);
  f.advance();
  await f.once(loop);
  expect(content.assignees).toEqual({ nodes: [{ login: "owner" }] });
  expect(f.reports).toEqual([]);
  f.done();
});

test.each([{}, { nodes: [], pageInfo: {} }, page([scopeMove({ createdAt: "invalid" })])])(
  "incomplete or invalid owner evidence fails visibly",
  async (initial) => {
    const f = new WatchFake();
    const github = new GitHubClient(f.config, f.env, f.deps);
    await expect(ownerForTurn(github, registry, "example/project", 8, initial)).rejects.toThrow();
  }
);

test.each([false, true])(
  "watcher poll with two owners selects the turn without errors (activity=%s)",
  async (activity) => {
    const f = new WatchFake();
    f.watchPeople = registry;
    const card = f.card(8, "Spec review");
    object(card.progress).text = "👤🔍";
    object(card.content).ownerActivity = page(activity ? [scopeMove({ actor: secondActor })] : []);
    object(card.content).assignees = { nodes: [{ login: activity ? second.login : "owner" }] };
    f.cards = [card];
    const loop = f.loop();
    await f.once(loop);
    f.advance();
    await f.once(loop);
    expect(f.reports).toEqual([]);
    expect(f.unexpected).toEqual([]);
    expect(object(card.content).assignees).toEqual({
      nodes: [{ login: activity ? second.login : "owner" }],
    });
    f.done();
  }
);
