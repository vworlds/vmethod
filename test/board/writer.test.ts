import { expect, test } from "vitest";
import type { BoardOperation } from "../../src/gateway/board.js";
import { FakeBoard } from "./fake.js";

function scenario(absent = false, initialStatus = "Backlog") {
  const board = new FakeBoard();
  board.stamp(1);
  const card = board.card();
  card.contentId = "content-card";
  card.values.Status = initialStatus;
  card.values.Progress = null;
  const status = board.fields.find((field) => field.name === "Status")!;
  status.options.push(
    { id: "executing", name: "Executing", color: "GRAY", description: "" },
    { id: "owner-review", name: "Owner review", color: "GRAY", description: "" }
  );
  const writes: { query: string; variables: Record<string, unknown> }[] = [];
  const fetch = board.deps.fetch;
  board.deps.fetch = async (url, init) => {
    const payload = JSON.parse(String(init?.body));
    if (payload.query.startsWith("mutation ")) {
      writes.push(payload);
    }
    if (absent && payload.query.startsWith("query BoardContentItems(")) {
      absent = false;
      // Hide the card until BoardAdd, without changing the fake's mutation handlers.
      board.requests.push("BoardContentItems");
      return Response.json({
        data: { node: { projectItems: { nodes: [], pageInfo: { hasNextPage: false } } } },
      });
    }
    return fetch(url, init);
  };
  return { board, card, writes, service: board.service() };
}

test.each([false, true])(
  "issue initialization reuses membership without changing any mutation (add=%s)",
  async (absent) => {
    const results = [];
    for (const cached of [false, true]) {
      const f = scenario(absent);
      const entries = [
        { name: "Estimate", value: "3" },
        { name: "Status", value: "Executing", progressValue: "🤖🔨" },
        { name: "Status", value: "Owner review" },
      ];
      const membership = cached
        ? await f.service.ensureCard(f.card.contentId!)
        : (await f.service.ensure(f.card.contentId!), undefined);
      await f.service.setIssueFields(f.card.contentId!, entries, membership);
      f.board.done();
      results.push(f);
    }
    const [before, after] = results;
    expect(after.writes).toEqual(before.writes);
    expect(after.card).toEqual(before.card);
    const prefix = ["BoardProject", "BoardFields", "BoardContent", "BoardContentItems"];
    if (absent) {
      prefix.push("BoardAdd");
    }
    expect(before.board.requests.slice(0, prefix.length + 3)).toEqual([
      ...prefix,
      "BoardProject",
      "BoardFields",
      "BoardContentItems",
    ]);
    expect(after.board.requests).toEqual([
      ...prefix,
      ...(absent ? ["BoardContentItems"] : []),
      ...before.board.requests.slice(prefix.length + 3),
    ]);
    const batch = after.writes.find((write) => write.query.startsWith("mutation BoardSetCards"))!;
    expect(
      Object.values(batch.variables).map((input) => (input as { fieldId: string }).fieldId)
    ).toEqual(
      ["Estimate", "Progress", "Status", "Progress", "Status"].map(
        (name) => after.board.fields.find((field) => field.name === name)!.id
      )
    );
  }
);

test.each(["Status", "Progress"] as const)(
  "task card %s and separate Model batches are identical with an operation cache",
  async (field) => {
    const results = [];
    for (const cached of [false, true]) {
      const f = scenario();
      f.card.kind = "PullRequest";
      const operation: BoardOperation | undefined = cached ? {} : undefined;
      const itemId = await f.service.ensure(f.card.contentId!, operation);
      await f.service.set(
        {
          itemId,
          field,
          value: field === "Status" ? "Executing" : "🤖🔨",
          ...(field === "Status" ? { progress: "🤖🔨" } : {}),
        },
        operation
      );
      await f.service.set({ itemId, field: "Model", value: "glm" }, operation);
      f.board.done();
      results.push(f);
    }
    const [before, after] = results;
    expect(after.writes).toEqual(before.writes);
    expect(after.card).toEqual(before.card);
    expect(after.board.requests).toEqual(
      before.board.requests.filter((name, index) =>
        index < 4 ? true : !["BoardProject", "BoardFields", "BoardItem"].includes(name)
      )
    );
    expect(
      after.writes.filter((write) => write.query.startsWith("mutation BoardSetCards"))
    ).toHaveLength(2);
  }
);

test("post-add defaults are read, so an unchanged Owner review does not gain a position mutation", async () => {
  const f = scenario(true, "Owner review");
  const membership = await f.service.ensureCard(f.card.contentId!);
  await f.service.setIssueFields(
    f.card.contentId!,
    [{ name: "Status", value: "Owner review" }],
    membership
  );
  expect(f.board.mutations).toEqual(["BoardAdd", "BoardSetCards"]);
  expect(f.board.requests.filter((name) => name === "BoardContentItems")).toHaveLength(2);
  f.board.done();
});

test.each([false, true])(
  "missing Progress keeps its error precedence (cached=%s)",
  async (cached) => {
    const f = scenario();
    f.board.fields = f.board.fields.filter((field) => field.name !== "Progress");
    const membership = cached ? await f.service.ensureCard(f.card.contentId!) : undefined;
    await expect(
      f.service.setIssueFields(
        f.card.contentId!,
        [
          { name: "Status", value: "Executing" },
          { name: "Estimate", value: "not-points" },
        ],
        membership
      )
    ).rejects.toThrow("Missing Progress field");
    expect(f.board.mutations).toEqual([]);
    f.board.done();
  }
);

test("a cached write keeps the writer's single card shape: the five operation fields", async () => {
  const f = scenario();
  f.card.kind = "PullRequest";
  const operation: BoardOperation = {};
  const itemId = await f.service.ensure(f.card.contentId!, operation);
  await f.service.set({ itemId, field: "Status", value: "Executing", progress: "🤖🔨" }, operation);
  expect(Object.keys(operation.card!.values).sort()).toEqual([
    "Cost",
    "Estimate",
    "Model",
    "Progress",
    "Status",
  ]);
  expect(operation.card!.values).toMatchObject({
    Status: "Executing",
    Progress: "🤖🔨",
  });
  f.board.done();
});
