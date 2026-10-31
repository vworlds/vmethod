import { expect, test } from "vitest";
import {
  executingCards,
  executingOrder,
  positionMoves,
  type OrderCard,
} from "../../src/board/order.js";
import { WatchFake } from "../gateway/watch-fake.js";
import { object } from "../../src/gateway/people.js";
import { FakeBoard } from "./fake.js";

const card = (id: string, ...dependencies: string[]): OrderCard => ({
  id,
  repo: "example/project",
  dependencies,
});

test("no dependencies preserves today's order, with activity first", () => {
  const cards = [card("a"), card("b"), card("c")];
  expect(executingOrder(cards)).toEqual({ order: ["a", "b", "c"], cycles: [] });
  expect(executingOrder(cards, "c").order).toEqual(["c", "a", "b"]);
  expect(executingOrder(cards, "missing").order).toEqual(["a", "b", "c"]);
});

test("earliest available dependency wins; chains are transitive and outside cards ignored", () => {
  expect(executingOrder([card("a", "b"), card("free"), card("b", "c"), card("c")]).order).toEqual([
    "free",
    "c",
    "b",
    "a",
  ]);
  expect(executingOrder([card("a", "outside"), card("b")]).order).toEqual(["a", "b"]);
});

test("cycles retain recency without trapping their dependants", () => {
  const cards = [card("dependent", "a"), card("b", "a"), card("a", "b"), card("free")];
  expect(executingOrder(cards)).toEqual({
    order: ["b", "a", "dependent", "free"],
    cycles: [["b", "a"]],
  });
  expect(executingOrder(cards, "a").order).toEqual(["a", "b", "dependent", "free"]);
  expect(executingOrder([card("self", "self")]).cycles).toEqual([["self"]]);
});

test("write list uses only necessary top-down predecessor moves and never moves foreign cards", () => {
  const current = ["a", "b", "c"];
  const owned = new Set(current);
  expect(positionMoves(current, current, owned)).toEqual([]);
  expect(positionMoves(current, ["c", "a", "b"], owned)).toEqual([{ itemId: "c", afterId: null }]);
  expect(positionMoves(current, ["b", "c", "a"], owned)).toEqual([
    { itemId: "b", afterId: null },
    { itemId: "c", afterId: "b" },
  ]);
  expect(positionMoves(current, ["c", "a", "b"], new Set(["a", "b"]))).toEqual([
    { itemId: "a", afterId: "c" },
    { itemId: "b", afterId: "a" },
  ]);
});

test("closing PRs, native blockers and sub-issues precede their issues; partial tasks do not", () => {
  const fake = new WatchFake();
  const epic = fake.card(1, "Executing");
  const issue = fake.card(2, "Executing");
  const blocker = fake.card(3, "Executing");
  const pr = fake.card(4, "Executing", "PullRequest");
  object(epic.content).subIssues = { nodes: [{ id: object(issue.content).id }] };
  object(issue.content).blockedBy = {
    nodes: [{ number: 3, repository: { nameWithOwner: "example/project" } }],
  };
  object(pr.content).body = '<!-- vmethod-task {"issues":[2]} -->';
  const graph = executingCards([epic, issue, blocker, pr]);
  expect(executingOrder(graph).order).toEqual([blocker.id, pr.id, issue.id, epic.id]);
  object(pr.content).body = '<!-- vmethod-task {"issues":[2],"part":true} -->';
  expect(executingCards([issue, pr])[0].dependencies).toEqual([]);
  object(pr.content).closingIssuesReferences = {
    nodes: [{ number: 2, repository: { nameWithOwner: "example/project" } }],
  };
  expect(executingCards([issue, pr])[0].dependencies).toEqual([pr.id]);
  object(pr.content).body = '<!-- vmethod-task {"issues":"not an array"} -->';
  expect(executingCards([issue, pr])[0].dependencies).toEqual([pr.id]);
});

test("non-Executing and archived dependencies never create a chain", () => {
  const fake = new WatchFake();
  const parent = fake.card(1, "Executing");
  const outside = fake.card(2, "Backlog");
  const child = fake.card(3, "Executing");
  object(parent.content).subIssues = { nodes: [{ id: object(outside.content).id }] };
  object(outside.content).subIssues = { nodes: [{ id: object(child.content).id }] };
  expect(executingOrder(executingCards([parent, outside, child])).order).toEqual([
    parent.id,
    child.id,
  ]);
  child.isArchived = true;
  expect(executingCards([parent, outside, child]).map((card) => card.id)).toEqual([parent.id]);
});

test("cycle reporting is once until it changes, and successful order writes are minimal", async () => {
  const fake = new FakeBoard();
  fake.card("a");
  fake.card("b");
  const service = fake.service();
  const cards = [card("a", "b"), card("b", "a")];
  await service.orderExecuting(cards, undefined, "project");
  await service.orderExecuting(cards, undefined, "project");
  expect(fake.reports.filter((line) => line.includes("dependency cycle"))).toHaveLength(1);
  expect(fake.mutations).toEqual([]);
  await service.orderExecuting([card("a"), card("b")], undefined, "project");
  await service.orderExecuting(cards, undefined, "project");
  expect(fake.reports.filter((line) => line.includes("dependency cycle"))).toHaveLength(2);
  await service.orderExecuting([card("a", "b"), card("b")], undefined, "project");
  expect(fake.cards.map((card) => card.id)).toEqual(["b", "a"]);
  expect(fake.mutations).toEqual(["BoardPosition"]);
});

test("Progress activity re-sorts the whole column through the real board read and position writes", async () => {
  const fake = new FakeBoard();
  const dependent = fake.card("dependent");
  const blocker = fake.card("blocker");
  const unrelated = fake.card("unrelated");
  dependent.number = 1;
  blocker.number = 2;
  unrelated.number = 3;
  for (const card of fake.cards) {
    card.values.Status = "Executing";
  }
  const service = fake.service();
  fake.orderingContent.set(dependent.id, {
    blockedBy: {
      nodes: [
        { number: blocker.number, repository: { nameWithOwner: blocker.repo }, state: "OPEN" },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
      totalCount: 1,
    },
  });
  // Calling the activity hook uses the same path as the common Progress writer.
  await service.moveToTop(dependent.id, "project");
  expect(fake.cards.map((card) => card.id)).toEqual([blocker.id, dependent.id, unrelated.id]);
  expect(fake.mutations).toEqual(["BoardPosition"]);
  await service.moveToTop(unrelated.id, "project");
  expect(fake.cards.map((card) => card.id)).toEqual([unrelated.id, blocker.id, dependent.id]);
  expect(fake.reports).toEqual([]);
  expect(fake.unexpected).toEqual([]);
});

test("watcher activity reuses its complete snapshot and updates the working manual order", async () => {
  const recorded = new WatchFake();
  const issue = recorded.card(6, "Executing");
  const pr = recorded.card(7, "Executing", "PullRequest");
  object(pr.content).body = '<!-- vmethod-task {"issues":[6]} -->';
  const nodes = [issue, pr];
  const fake = new FakeBoard();
  fake.card(String(issue.id));
  fake.card(String(pr.id));
  await fake.service().moveToTop(String(issue.id), "project", nodes);
  expect(fake.requests).toEqual(["BoardPosition"]);
  expect(nodes.map((node) => node.id)).toEqual([pr.id, issue.id]);
  expect(fake.cards.map((card) => card.id)).toEqual([pr.id, issue.id]);
  expect(fake.reports).toEqual([]);
});
