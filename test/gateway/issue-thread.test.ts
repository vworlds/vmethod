import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Operations } from "../../src/gateway/transport.js";
import type { ObjectData } from "../../src/gateway/people.js";
import { gatewayVerb } from "../../src/cli/gateway.js";
import { bodyHash } from "../../src/gateway/scope.js";
import { fixtureServer, graph, item, workerFixtureServer, type Request } from "./helpers.js";

// #292: `read issue` reuses #284's thread machinery (the shared diff cases stay
// in thread.test.ts). These cover the issue-specific source: the issue item with
// its state line, an edited issue body, a state change alone, and dropped authors.

const at = "2026-10-27T09:12:00Z";
const stamp = "2026-10-27T09:12Z";
const worker = { role: "worker" } as const;

const issueItem = (over: ObjectData = {}) =>
  item({
    title: "Issue",
    body: "Issue body.",
    state: "OPEN",
    createdAt: at,
    ...over,
  });

const metaOf = (node: ObjectData): ObjectData => {
  const meta = { ...node };
  delete meta.body;
  return meta;
};

const comment = (id: number, body: string, over: ObjectData = {}) =>
  item({ id: `IC${id}`, databaseId: id, createdAt: at, body, ...over });

interface IssueState {
  issue?: ObjectData;
  comments?: ObjectData[];
}

/** The exact request sequence of one per-item issue thread read over the scripted fake. */
function issueRequests(state: IssueState): Request[] {
  const issue = state.issue ?? issueItem();
  const comments = state.comments ?? [];
  const listing = (nodes: ObjectData[]) => ({
    nodes: nodes.map(metaOf),
    pageInfo: { hasNextPage: false },
  });
  return [
    graph({ repository: { issue: item() } }),
    graph({ node: issue }),
    graph({ node: { ...issue, comments: listing(comments) } }),
    ...comments.map((node) => graph({ node })),
  ];
}

type Fixture = ReturnType<typeof workerFixtureServer>;
async function read(
  f: Fixture,
  option: Operations["read"]["input"]["option"] = undefined
): Promise<string> {
  return String(await f.transport.call("read", { kind: "issue", ref: "8", option }, worker));
}

const fence = (body: string): string => `UNTRUSTED DATA\n\`\`\`text\n${body}\n\`\`\``;
const issueSection = (state = "OPEN", marker = "", title = "Issue"): string =>
  `### issue 8, worker (worker), ${stamp}${marker}\n\nstate ${state}\n\n${fence(
    `${title}\n\nIssue body.`
  )}`;
const commentSection = (id: number, body: string): string =>
  `### comment ${id}, worker (worker), ${stamp}\n\n${fence(body)}`;

const snapshotFiles = (root: string) => ({
  thread: join(root, ".tmp", "8-thread.md"),
  index: join(root, ".tmp", "8-thread-index.json"),
  body: join(root, ".tmp", "issue-read-8.sha256"),
});
const records = (root: string): { kind: string; id: string }[] =>
  JSON.parse(readFileSync(snapshotFiles(root).index, "utf8"));
const keys = (rows: { kind: string; id: string }[]): string[] =>
  rows.map((record) => `${record.kind} ${record.id}`);

test("read issue prints one fenced section per item and saves the snapshot with its index", async () => {
  const first = comment(6437236013, "First reply.");
  const f = workerFixtureServer(issueRequests({ comments: [first] }));
  const output = await read(f);
  expect(output).toBe(`${issueSection()}\n\n${commentSection(6437236013, "First reply.")}`);
  expect(readFileSync(snapshotFiles(f.root).thread, "utf8")).toBe(output);
  const index = JSON.parse(readFileSync(snapshotFiles(f.root).index, "utf8")) as {
    kind: string;
    id: string;
    time: string;
    login: string;
    role: string;
    hash: string;
    meta?: string;
  }[];
  expect(keys(index)).toEqual(["issue 8", "comment 6437236013"]);
  expect(index[0]).toEqual({
    kind: "issue",
    id: "8",
    time: stamp,
    login: "worker",
    role: "worker",
    hash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
    meta: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
  });
  // The stale-read guard for `issue edit` keeps the read body's exact hash.
  expect(readFileSync(snapshotFiles(f.root).body, "utf8")).toBe(bodyHash("Issue body."));
  f.done();
}, 15000);

test("a first --new with no snapshot prints the full thread under the no-earlier-read line", async () => {
  const f = workerFixtureServer(issueRequests({}));
  const output = await read(f, "--new");
  expect(output).toBe(`#8: no earlier read; full thread follows\n\n${issueSection()}`);
  expect(existsSync(snapshotFiles(f.root).thread)).toBe(true);
  expect(keys(records(f.root))).toEqual(["issue 8"]);
  f.done();
}, 15000);

test("an edited issue body prints the full new body without the state line", async () => {
  const f = workerFixtureServer([
    ...issueRequests({}),
    ...issueRequests({ issue: issueItem({ body: "Issue body (amended)." }) }),
  ]);
  await read(f);
  const output = await read(f, "--new");
  expect(output).toBe(
    `### issue 8, worker (worker), ${stamp} (edited)\n\n${fence(
      "Issue\n\nIssue body (amended)."
    )}\n\n0 unchanged`
  );
  expect(output).not.toContain("state OPEN");
  // The edit guard's hash names the body this read delivered.
  expect(readFileSync(snapshotFiles(f.root).body, "utf8")).toBe(bodyHash("Issue body (amended)."));
  f.done();
}, 15000);

test("after one new comment --new prints only that comment", async () => {
  const first = comment(6437236013, "First reply.");
  const second = comment(6437236021, "A brand new instruction.");
  const f = workerFixtureServer([
    ...issueRequests({ comments: [first] }),
    ...issueRequests({ comments: [first, second] }),
  ]);
  await read(f);
  const output = await read(f, "--new");
  expect(output).toBe(`${commentSection(6437236021, "A brand new instruction.")}\n\n2 unchanged`);
  expect(keys(records(f.root))).toEqual(["issue 8", "comment 6437236013", "comment 6437236021"]);
  f.done();
}, 15000);

test("a state change alone prints exactly the edited header and the state line", async () => {
  const f = workerFixtureServer([
    ...issueRequests({}),
    ...issueRequests({ issue: issueItem({ state: "CLOSED" }) }),
  ]);
  await read(f);
  const output = await read(f, "--new");
  expect(output).toBe(
    `### issue 8, worker (worker), ${stamp} (edited)\n\nstate CLOSED\n\n0 unchanged`
  );
  expect(output).not.toContain("UNTRUSTED DATA");
  expect(output).not.toContain("Issue body");
  f.done();
}, 15000);

test("read issue --new passes the CLI validation; pr-only options still refuse an issue", async () => {
  const f = workerFixtureServer(issueRequests({}));
  const output = await gatewayVerb(f.transport, "read", ["issue", "8", "--new"]);
  expect(output).toBe(`#8: no earlier read; full thread follows\n\n${issueSection()}`);
  await expect(gatewayVerb(f.transport, "read", ["issue", "8", "--files"])).rejects.toThrow(
    "Usage: vmethod read pr"
  );
  f.done();
}, 15000);

test("an untrusted author's comment appears neither in the output nor in the snapshot", async () => {
  const accepted = comment(6437236013, "First reply.");
  const unknown = comment(6437236021, "NEVER DELIVER", {
    author: { __typename: "User", login: "who", databaseId: 999 },
  });
  const issue = issueItem();
  const f = fixtureServer([
    ...issueRequests({ comments: [accepted] }),
    graph({ repository: { issue: item() } }),
    graph({ node: issue }),
    graph({
      node: issueItem({
        comments: {
          nodes: [metaOf(accepted), metaOf(unknown)],
          pageInfo: { hasNextPage: false },
        },
      }),
    }),
    graph({ node: accepted }),
  ]);
  await read(f);
  const { thread, index } = snapshotFiles(f.root);
  const before = readFileSync(thread, "utf8");
  const output = await read(f, "--new");
  expect(output).toBe("#8: nothing new since your last read (2 unchanged)");
  expect(readFileSync(thread, "utf8")).toBe(before);
  expect(readFileSync(index, "utf8")).not.toContain("999");
  expect(readFileSync(thread, "utf8")).not.toContain("NEVER DELIVER");
  expect(await f.transport.call("dropped", {})).toBe(
    "Dropped: 1\n1 https://github.com/example/project/issues/8"
  );
  f.done();
}, 15000);
