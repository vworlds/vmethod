import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Operations } from "../../src/gateway/transport.js";
import type { ObjectData } from "../../src/gateway/people.js";
import { fixtureServer, graph, item, sha, workerFixtureServer, type Request } from "./helpers.js";

// Wire shapes per the recorded fixtures: comment/review listings carry metadata
// only; one body-node read follows each accepted listing entry.
const at = "2026-10-27T09:12:00Z";
const stamp = "2026-10-27T09:12Z";
const worker = { role: "worker" } as const;
const ownerActor = { __typename: "User", login: "owner", databaseId: 101 } as const;

const metaOf = (node: ObjectData): ObjectData => {
  const meta = { ...node };
  delete meta.body;
  return meta;
};

const comment = (id: number, body: string, over: ObjectData = {}) =>
  item({ id: `IC${id}`, databaseId: id, createdAt: at, body, ...over });
const reviewItem = (id: number, body: string, over: ObjectData = {}) =>
  item({
    id: `PRR${id}`,
    databaseId: id,
    state: "COMMENTED",
    commit: { oid: sha },
    createdAt: at,
    submittedAt: at,
    ...over,
    body,
  });
const inline = (id: number, body: string, over: ObjectData = {}) =>
  item({ id: `PRRC${id}`, databaseId: id, createdAt: at, body, ...over });
const prItem = (over: ObjectData = {}) =>
  item({
    title: "Task",
    body: "Task body.",
    isDraft: false,
    state: "OPEN",
    createdAt: at,
    ...over,
  });

interface ThreadState {
  pr?: ObjectData;
  comments?: ObjectData[];
  reviews?: ObjectData[];
  threads?: ObjectData[][];
}

/** The exact request sequence of one per-item thread read over the scripted fake. */
function threadRequests(state: ThreadState): Request[] {
  const pr = state.pr ?? prItem();
  const comments = state.comments ?? [];
  const reviews = state.reviews ?? [];
  const threads = state.threads ?? [];
  const listing = (nodes: ObjectData[]) => ({
    nodes: nodes.map(metaOf),
    pageInfo: { hasNextPage: false },
  });
  return [
    graph({ repository: { pullRequest: item() } }),
    graph({ node: pr }),
    graph({ node: item({ comments: listing(comments) }) }),
    ...comments.map((node) => graph({ node })),
    graph({ node: item({ reviews: listing(reviews) }) }),
    ...reviews.map((node) => graph({ node })),
    graph({
      node: item({
        reviewThreads: {
          nodes: threads.map((page) => ({ comments: listing(page) })),
          pageInfo: { hasNextPage: false },
        },
      }),
    }),
    ...threads.flatMap((page) => page.map((node) => graph({ node }))),
  ];
}

type Fixture = ReturnType<typeof workerFixtureServer>;
async function read(
  f: Fixture,
  option: Operations["read"]["input"]["option"] = undefined
): Promise<string> {
  return String(await f.transport.call("read", { kind: "pr", ref: "291", option }, worker));
}

const fence = (body: string): string => `UNTRUSTED DATA\n\`\`\`text\n${body}\n\`\`\``;
const prSection = (head: string, draft = false, marker = ""): string =>
  `### pr 291, worker (worker), ${stamp}${marker}\n\nstate OPEN, draft ${draft}, head ${head}\n\n${fence(
    "Task\n\nTask body."
  )}`;
const commentSection = (id: number, body: string): string =>
  `### comment ${id}, worker (worker), ${stamp}\n\n${fence(body)}`;
const reviewSection = (id: number, body: string): string =>
  `### review ${id}, worker (worker), ${stamp}\n\n${fence(body)}`;
const inlineSection = (id: number, body: string): string =>
  `### review comment ${id}, worker (worker), ${stamp}\n\n${fence(body)}`;

const snapshotFiles = (root: string) => ({
  thread: join(root, ".tmp", "291-thread.md"),
  index: join(root, ".tmp", "291-thread-index.json"),
});
const records = (root: string): { kind: string; id: string }[] =>
  JSON.parse(readFileSync(snapshotFiles(root).index, "utf8"));
const keys = (rows: { kind: string; id: string }[]): string[] =>
  rows.map((record) => `${record.kind} ${record.id}`);

test("read pr prints one fenced section per item and saves the snapshot with its index", async () => {
  const first = comment(6437236013, "First reply.");
  const f = workerFixtureServer(threadRequests({ comments: [first] }));
  const output = await read(f);
  expect(output).toBe(`${prSection(sha)}\n\n${commentSection(6437236013, "First reply.")}`);
  expect(readFileSync(snapshotFiles(f.root).thread, "utf8")).toBe(output);
  const index = JSON.parse(readFileSync(snapshotFiles(f.root).index, "utf8")) as {
    kind: string;
    id: string;
    time: string;
    login: string;
    role: string;
    hash: string;
  }[];
  expect(keys(index)).toEqual(["pr 291", "comment 6437236013"]);
  expect(index[0]).toEqual({
    kind: "pr",
    id: "291",
    time: stamp,
    login: "worker",
    role: "worker",
    hash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
  });
  f.done();
}, 15000);

test("reviews and review comments render as their own sections in thread order", async () => {
  const priorReview = reviewItem(9001, "Approved review body.");
  const priorInline = inline(4363811103, "Fixture inline comment for the thread.");
  const first = comment(6437236013, "First reply.");
  const f = workerFixtureServer(
    threadRequests({ comments: [first], reviews: [priorReview], threads: [[priorInline]] })
  );
  const output = await read(f);
  expect(output).toBe(
    `${prSection(sha)}\n\n${commentSection(6437236013, "First reply.")}\n\n${reviewSection(
      9001,
      "Approved review body."
    )}\n\n${inlineSection(4363811103, "Fixture inline comment for the thread.")}`
  );
  expect(keys(records(f.root))).toEqual([
    "pr 291",
    "comment 6437236013",
    "review 9001",
    "review comment 4363811103",
  ]);
  f.done();
}, 15000);

test("a first --new with no snapshot prints the full thread under the no-earlier-read line", async () => {
  const f = workerFixtureServer(threadRequests({}));
  const output = await read(f, "--new");
  expect(output).toBe(`#291: no earlier read; full thread follows\n\n${prSection(sha)}`);
  expect(existsSync(snapshotFiles(f.root).thread)).toBe(true);
  expect(keys(records(f.root))).toEqual(["pr 291"]);
  f.done();
}, 15000);

test("nothing new prints the exact single line and keeps the snapshot bytes as they were", async () => {
  const f = workerFixtureServer([...threadRequests({}), ...threadRequests({})]);
  await read(f);
  const { thread, index } = snapshotFiles(f.root);
  const before = readFileSync(thread, "utf8");
  const beforeIndex = readFileSync(index, "utf8");
  const output = await read(f, "--new");
  expect(output).toBe("#291: nothing new since your last read (1 unchanged)");
  expect(readFileSync(thread, "utf8")).toBe(before);
  expect(readFileSync(index, "utf8")).toBe(beforeIndex);
  f.done();
}, 15000);

test("after one new comment --new prints only that comment under its header", async () => {
  const first = comment(6437236013, "First reply.");
  const second = comment(6437236021, "A brand new instruction.");
  const f = workerFixtureServer([
    ...threadRequests({ comments: [first] }),
    ...threadRequests({ comments: [first, second] }),
  ]);
  await read(f);
  const output = await read(f, "--new");
  expect(output).toBe(`${commentSection(6437236021, "A brand new instruction.")}\n\n2 unchanged`);
  expect(keys(records(f.root))).toEqual(["pr 291", "comment 6437236013", "comment 6437236021"]);
  f.done();
}, 15000);

test("an edited comment, a new review and a new review comment follow their headers", async () => {
  // The amended body's verified editor owns the header's attribution.
  const first = comment(6437236013, "First reply.");
  const amended = comment(6437236013, "Now amended.", {
    lastEditedAt: "2026-10-27T10:00:00Z",
    author: { __typename: "User", login: "worker", databaseId: 102 },
    editor: ownerActor,
  });
  const priorReview = reviewItem(9001, "Approved review body.");
  const newReview = reviewItem(9002, "Please check the new line.");
  const priorInline = inline(4363811103, "Fixture inline comment for the thread.");
  const newInline = inline(4363811500, "Fixture reply.");
  const editedSection = `### comment 6437236013, owner (owner), ${stamp} (edited)\n\n${fence(
    "Now amended."
  )}`;
  const f = workerFixtureServer([
    ...threadRequests({
      comments: [first],
      reviews: [priorReview],
      threads: [[priorInline]],
    }),
    ...threadRequests({
      comments: [amended],
      reviews: [priorReview, newReview],
      threads: [[priorInline], [newInline]],
    }),
  ]);
  await read(f);
  const output = await read(f, "--new");
  expect(output).toBe(
    `${editedSection}\n\n${reviewSection(9002, "Please check the new line.")}\n\n${inlineSection(
      4363811500,
      "Fixture reply."
    )}\n\n3 unchanged`
  );
  expect(keys(records(f.root))).toEqual([
    "pr 291",
    "comment 6437236013",
    "review 9001",
    "review 9002",
    "review comment 4363811103",
    "review comment 4363811500",
  ]);
  f.done();
}, 15000);

test("a deleted comment prints only its marked header and the unchanged count", async () => {
  const first = comment(6437236013, "First reply.");
  const second = comment(6437236021, "Gone from the thread.");
  const f = workerFixtureServer([
    ...threadRequests({ comments: [first, second] }),
    ...threadRequests({ comments: [first] }),
  ]);
  await read(f);
  const output = await read(f, "--new");
  expect(output).toBe(`### comment 6437236021, worker (worker), ${stamp} (deleted)\n\n2 unchanged`);
  expect(keys(records(f.root))).toEqual(["pr 291", "comment 6437236013"]);
  f.done();
}, 15000);

test("the pr item itself reports as edited when the head moves", async () => {
  const moved = "b".repeat(40);
  const f = workerFixtureServer([
    ...threadRequests({}),
    ...threadRequests({ pr: prItem({ headRefOid: moved }) }),
  ]);
  await read(f);
  expect(keys(records(f.root))).toEqual(["pr 291"]);
  const output = await read(f, "--new");
  expect(output).toBe(`${prSection(moved, false, " (edited)")}\n\n0 unchanged`);
  expect(output).toContain(`### pr 291, worker (worker), ${stamp} (edited)`);
  f.done();
}, 15000);

test.each([
  {
    case: "a corrupt index",
    corrupt(root: string) {
      writeFileSync(snapshotFiles(root).index, "not json at all");
    },
    reason: "index is not valid JSON",
  },
  {
    case: "an invalid index entry",
    corrupt(root: string) {
      writeFileSync(
        snapshotFiles(root).index,
        JSON.stringify([
          { kind: "comment", id: "1", time: "x", login: "who", role: "owner", hash: "0" },
        ])
      );
    },
    reason: "invalid index entry",
  },
  {
    case: "a deleted thread file",
    corrupt(root: string) {
      rmSync(snapshotFiles(root).thread);
    },
    reason: "thread file missing",
  },
])(
  "an unusable snapshot is never reported as nothing new: $case",
  async ({ corrupt, reason }) => {
    const first = comment(6437236013, "First reply.");
    const f = workerFixtureServer([
      ...threadRequests({ comments: [first] }),
      ...threadRequests({ comments: [first] }),
    ]);
    await read(f);
    corrupt(f.root);
    const output = await read(f, "--new");
    expect(output).toBe(
      `#291: snapshot unreadable (${reason}); full thread follows\n\n${prSection(
        sha
      )}\n\n${commentSection(6437236013, "First reply.")}`
    );
    expect(keys(records(f.root))).toEqual(["pr 291", "comment 6437236013"]);
    f.done();
  },
  15000
);

test("an untrusted author's item appears neither in the output nor in the snapshot", async () => {
  const accepted = comment(6437236013, "First reply.");
  const unknown = comment(6437236021, "NEVER DELIVER", {
    author: { __typename: "User", login: "who", databaseId: 999 },
  });
  const unknownReview = reviewItem(9002, "NEVER DELIVER", {
    author: { __typename: "User", login: "who", databaseId: 999 },
  });
  const f = fixtureServer([
    ...threadRequests({ comments: [accepted] }),
    ...threadRequests({ comments: [accepted, unknown], reviews: [unknownReview] }),
  ]);
  await f.transport.call("read", { kind: "pr", ref: "291" });
  const { thread, index } = snapshotFiles(f.root);
  const before = readFileSync(thread, "utf8");
  const output = await f.transport.call("read", { kind: "pr", ref: "291", option: "--new" });
  expect(output).toBe("#291: nothing new since your last read (2 unchanged)");
  expect(readFileSync(thread, "utf8")).toBe(before);
  expect(readFileSync(index, "utf8")).not.toContain("999");
  expect(readFileSync(thread, "utf8")).not.toContain("NEVER DELIVER");
  expect(await f.transport.call("dropped", {})).toBe(
    "Dropped: 2\n2 https://github.com/example/project/issues/291"
  );
  f.done();
}, 15000);
