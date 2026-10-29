import { afterEach, expect, test } from "vitest";
import { WatchFake } from "../gateway/watch-fake.js";
import { actor, hostile } from "../gateway/helpers.js";
import { object, type ObjectData } from "../../src/gateway/people.js";
import recorded from "../fixtures/github/review-threads.json" with { type: "json" };
import { WriteJournal } from "../../src/gateway/write-journal.js";

const fakes: WatchFake[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) {
    f.done();
  }
});

async function setup(self = false) {
  const f = new WatchFake();
  if (self) {
    f.viewer = { login: "peer", id: 103 };
  }
  fakes.push(f);
  f.task();
  const loop = f.loop();
  await f.tick(loop);
  f.advance();
  const thread: ObjectData = structuredClone(recorded.nodes[0]);
  const comments = object(thread.comments).nodes as ObjectData[];
  for (const comment of comments) {
    comment.createdAt = f.iso();
  }
  f.reviewThreads = [thread];
  return { f, loop, thread, comments };
}

test("owner inline comments report path and line within one poll, move the turn, and stay deduplicated after restart", async () => {
  const { f, loop, thread, comments } = await setup();
  const events = (await f.once(loop)).filter((event) => event.kind === "comment");
  expect(events.map((event) => event.line)).toEqual(
    comments.map(
      (comment) => `COMMENT #24 ${String(thread.path)}:1 from owner (owner) ${String(comment.url)}`
    )
  );
  expect(object(f.cards[0].progress).text).toBe("🧭🔍 🔁2️⃣");
  await f.ack(loop, events);
  expect((await f.once(loop)).filter((event) => event.kind === "comment")).toEqual([]);
  loop.close();
  f.advance(20 * 60_000);
  expect((await f.once(f.loop())).filter((event) => event.kind === "comment")).toEqual([]);
  expect(f.reports).toEqual([]);
});

test("initially resolved comments stay suppressed; a later new comment on a known thread reports", async () => {
  const { f, loop, thread, comments } = await setup();
  thread.isResolved = true;
  expect((await f.once(loop)).filter((event) => event.kind === "comment")).toEqual([]);
  thread.isResolved = false;
  expect((await f.once(loop)).filter((event) => event.kind === "comment")).toEqual([]);
  f.advance();
  const added = {
    ...comments[0],
    databaseId: 4363811500,
    url: "https://github.com/example/project/pull/24#discussion_r4363811500",
    createdAt: f.iso(),
  };
  comments.push(added);
  thread.isResolved = true;
  expect((await f.once(loop)).filter((event) => event.kind === "comment")).toHaveLength(1);
});

test("unknown authors and editors never report; verified editor controls attribution and turn", async () => {
  const { f, loop, thread, comments } = await setup();
  comments[0].author = { ...actor(), databaseId: 9999 };
  comments[0].body = hostile;
  comments[1].lastEditedAt = f.iso(1000);
  comments[1].editor = { ...actor(), databaseId: 9999 };
  expect((await f.once(loop)).filter((event) => event.kind === "comment")).toEqual([]);
  comments[1].editor = actor(1);
  thread.line = null;
  expect(
    (await f.once(loop)).filter((event) => event.kind === "comment").map((event) => event.line)
  ).toEqual([
    `COMMENT #24 ${String(thread.path)}:null from worker (worker) (edited) ${String(comments[1].url)}`,
  ]);
  expect(object(f.cards[0].progress).text).toBe("🤖🔨 🔁2️⃣");
});

test("thread and comment pagination report every comment, failures remain retryable", async () => {
  const { f, loop, thread, comments } = await setup();
  const first = comments[0];
  const second = comments[1];
  thread.comments = { nodes: [first], pageInfo: { hasNextPage: true, endCursor: "1" } };
  f.reviewThreadPages = [[], [thread]];
  f.reviewCommentPages = [[], [second]];
  f.failReviewThreads = true;
  expect((await f.once(loop)).filter((event) => event.kind === "comment")).toEqual([]);
  f.failReviewThreads = false;
  const events = (await f.once(loop)).filter((event) => event.kind === "comment");
  expect(events).toHaveLength(2);
  expect(f.requests.filter((request) => request.includes("/graphql")).length).toBeGreaterThan(0);
  expect(events.map((event) => event.line)).toEqual(
    expect.arrayContaining([
      expect.stringContaining("discussion_r4363811103"),
      expect.stringContaining("discussion_r4363811370"),
    ])
  );
});

test.each([
  "missing connection",
  "missing cursor",
  "repeated cursor",
  "page limit",
  "partial errors",
])(
  "invalid review-thread pagination fails visibly and recovers without losing comments: %s",
  async (failure) => {
    const { f, loop } = await setup();
    const fetch = f.deps.fetch;
    let reads = 0;
    f.deps.fetch = async (input, init) => {
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      if (String(payload.query).startsWith("query WatchReviewThreads(")) {
        reads++;
        const connection =
          failure === "missing connection"
            ? null
            : {
                nodes: [],
                pageInfo: {
                  hasNextPage: true,
                  endCursor:
                    failure === "missing cursor"
                      ? null
                      : failure === "page limit"
                        ? String(reads)
                        : "same",
                },
              };
        return Response.json({
          data: { repository: { pullRequest: { reviewThreads: connection } } },
          ...(failure === "partial errors"
            ? { errors: [{ message: "scripted incomplete result" }] }
            : {}),
        });
      }
      return fetch(input, init);
    };
    expect((await f.once(loop)).filter((event) => event.kind === "comment")).toEqual([]);
    expect(f.reports.some((report) => report.startsWith("watcher: pull requests failed:"))).toBe(
      true
    );
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThanOrEqual(20);
    f.deps.fetch = fetch;
    expect((await f.once(loop)).filter((event) => event.kind === "comment")).toHaveLength(2);
  }
);

test("inline worker protocol turns match conversation turns but still emit COMMENT", async () => {
  const { f, loop, comments } = await setup();
  comments.splice(1);
  comments[0].author = actor(1);
  comments[0].body = "[worker] READY FOR REVIEW (round 3)";
  const events = (await f.once(loop)).filter((event) => event.kind === "comment");
  expect(events).toHaveLength(1);
  expect(events[0].line).toContain("from worker (worker)");
  expect(object(f.cards[0].progress).text).toBe("🤖👍 🔁3️⃣");
  expect(object(f.cards[0].status).name).toBe("Executing");
});

test.each(["another inline thread", "conversation"])(
  "newer inline owner replies win over older worker activity from %s",
  async (source) => {
    const { f, loop, thread, comments } = await setup();
    comments.splice(1);
    comments[0].createdAt = f.iso(1000);
    if (source === "conversation") {
      f.comment("[worker] ACK");
    } else {
      const other = structuredClone(thread);
      other.id = "another-thread";
      object(other.comments).nodes = [
        {
          ...comments[0],
          databaseId: 4363811500,
          author: actor(1),
          createdAt: f.iso(),
          body: "[worker] ACK",
        },
      ];
      f.reviewThreads.push(other);
    }
    await f.once(loop);
    expect(object(f.cards[0].progress).text).toBe("🧭🔍 🔁2️⃣");
  }
);

test("inline polling respects PR scope, excludes foreign repositories, and preserves full safe path metadata", async () => {
  const { f, loop, thread } = await setup();
  thread.path = `${"long/".repeat(40)}file.ts\n\u001b[31m`;
  const events = (await f.once(loop)).filter((event) => event.kind === "comment");
  expect(events[0].line).toContain(`${"long/".repeat(40)}file.ts:1`);
  expect(events[0].line).not.toContain("\n");
  expect(events[0].line).not.toContain("\u001b");
  loop.close();
  f.reviewThreadReads = [];
  await f.once(f.loop({ only: [6] }));
  // No scoped task PR remains to trigger a review-thread query. In particular,
  // subscriptions to vworlds/vmethod do not add foreign review-thread polling.
  expect(f.reviewThreadReads).toEqual([]);
});

test("same-account inline replies distinguish siblings, journal exact IDs and suppress pending echoes", async () => {
  const { f, loop, comments } = await setup(true);
  comments.splice(1);
  comments[0].author = actor(2);
  const events = await loop.nextEvents({ timeoutSeconds: 0, pollOnce: true });
  expect(
    events.events.filter((event) => event.kind === "comment").map((event) => event.line)
  ).toEqual([expect.stringContaining("from peer (orchestrator) (this account, another session)")]);
  const journal = new WriteJournal(f.config, f.env, f.deps.now);
  journal.record(
    "/repos/example/project/pulls/24/comments/4363811103/replies",
    "POST",
    {},
    { id: 4363811103, node_id: comments[0].id },
    f.iso()
  );
  expect(
    journal.matches(
      { kind: "review-comment", repo: "example/project", number: 24, commentId: 4363811103 },
      ""
    )
  ).toBe(true);
  expect(
    journal.matches(
      { kind: "review-comment", repo: "example/project", number: 24, commentId: 4363811370 },
      f.iso()
    )
  ).toBe(false);
  expect(
    (await loop.nextEvents({ timeoutSeconds: 0 })).events.filter(
      (event) => event.kind === "comment"
    )
  ).toEqual([]);
  expect((await f.once(loop)).filter((event) => event.kind === "comment")).toEqual([]);
});
