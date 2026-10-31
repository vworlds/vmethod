import { expect, test } from "vitest";
import { WatchFake } from "./watch-fake.js";
import { object } from "../../src/gateway/people.js";

test("a new task PR reorders its Executing issue without polling extra board data", async () => {
  const fake = new WatchFake();
  fake.enableWrites = true;
  const issue = fake.card(6, "Executing");
  fake.cards = [issue];
  const loop = fake.loop();
  await fake.once(loop);
  expect(fake.unexpected).toEqual([]);
  expect(fake.reports).toEqual([]);
  const pr = fake.card(7, "Executing", "PullRequest");
  object(pr.content).body = '<!-- vmethod-task {"issues":[6]} -->';
  fake.cards.push(pr);
  fake.advance();
  await fake.once(loop);
  expect(fake.reports).toEqual([]);
  expect(fake.cards.map((card) => card.id)).toEqual([pr.id, issue.id]);
  expect(fake.writes.filter((write) => "position" in write)).toEqual([
    { itemId: pr.id, position: null },
  ]);
  expect(fake.unexpected).toEqual([]);
});

test("blocked-by and sub-issue edits reorder; a hand drag holds until the next edit", async () => {
  const fake = new WatchFake();
  fake.enableWrites = true;
  const issue = fake.card(6, "Executing");
  const blocker = fake.card(7, "Executing");
  fake.cards = [issue, blocker];
  const loop = fake.loop();
  await fake.once(loop);
  object(issue.content).blockedBy = {
    totalCount: 1,
    nodes: [{ number: 7, state: "OPEN", repository: { nameWithOwner: "example/project" } }],
    pageInfo: { hasNextPage: false, endCursor: null },
  };
  fake.advance();
  await fake.once(loop);
  expect(fake.cards.map((card) => card.id)).toEqual([blocker.id, issue.id]);
  fake.cards = [issue, blocker];
  fake.advance();
  await fake.once(loop);
  expect(fake.cards.map((card) => card.id)).toEqual([issue.id, blocker.id]);
  object(issue.content).blockedBy = {
    totalCount: 0,
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  };
  // Remove the blocker, then add a fresh sub-issue dependency.
  fake.advance();
  await fake.once(loop);
  object(issue.content).subIssues = {
    nodes: [{ id: object(blocker.content).id }],
    pageInfo: { hasNextPage: false, endCursor: null },
  };
  fake.advance();
  await fake.once(loop);
  expect(fake.cards.map((card) => card.id)).toEqual([blocker.id, issue.id]);
  expect(fake.unexpected).toEqual([]);
});

test("a foreign dependency anchors ordering but is never moved", async () => {
  const fake = new WatchFake();
  fake.enableWrites = true;
  const issue = fake.card(6, "Executing");
  const foreign = fake.card(7, "Executing");
  object(foreign.content).repository = {
    nameWithOwner: "example/foreign",
    owner: { login: "example" },
  };
  fake.cards = [issue, foreign];
  const loop = fake.loop();
  await fake.once(loop);
  object(issue.content).blockedBy = {
    totalCount: 1,
    nodes: [{ number: 7, state: "OPEN", repository: { nameWithOwner: "example/foreign" } }],
    pageInfo: { hasNextPage: false, endCursor: null },
  };
  fake.advance();
  await fake.once(loop);
  expect(fake.cards.map((card) => card.id)).toEqual([foreign.id, issue.id]);
  expect(fake.writes.filter((write) => "position" in write)).toEqual([
    { itemId: issue.id, position: foreign.id },
  ]);
  expect(fake.unexpected).toEqual([]);
});

test("the watcher reports a cycle once until it changes and preserves member recency", async () => {
  const fake = new WatchFake();
  fake.enableWrites = true;
  const a = fake.card(6, "Executing");
  const b = fake.card(7, "Executing");
  fake.cards = [a, b];
  const loop = fake.loop();
  await fake.once(loop);
  const children = (id?: unknown) => ({
    nodes: id ? [{ id }] : [],
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  object(a.content).subIssues = children(object(b.content).id);
  object(b.content).subIssues = children(object(a.content).id);
  fake.advance();
  await fake.once(loop);
  fake.cards.push(fake.card(8, "Executing"));
  fake.advance();
  await fake.once(loop);
  expect(fake.reports.filter((line) => line.includes("dependency cycle"))).toHaveLength(1);
  expect(fake.cards.slice(0, 2).map((card) => card.id)).toEqual([a.id, b.id]);
  object(b.content).subIssues = children();
  fake.advance();
  await fake.once(loop);
  object(b.content).subIssues = children(object(a.content).id);
  fake.advance();
  await fake.once(loop);
  expect(fake.reports.filter((line) => line.includes("dependency cycle"))).toHaveLength(2);
  expect(fake.unexpected).toEqual([]);
});
