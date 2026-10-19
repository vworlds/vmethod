import { expect, test } from "vitest";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { bodyHash, scopeApproved, ScopeReader } from "../../src/gateway/scope.js";
import { PeopleFilter, type ObjectData } from "../../src/gateway/people.js";
import { Digest } from "../../src/gateway/digest.js";
import { GitHubClient } from "../../src/gateway/client.js";
import { getConfig } from "../../src/config.js";
import { actor, fixtureServer, graph, people } from "./helpers.js";
import {
  scopeIssue,
  scopeComment,
  scopeMove,
  scopeConnection,
  scopeGraph,
} from "./scope-fixture.js";
import { fixture } from "../helpers.js";
import { WatchFake } from "./watch-fake.js";
import recordedScope from "../fixtures/github/issue-scope.json" with { type: "json" };

const filter = () =>
  new PeopleFilter(people, "example", new Digest({ XDG_STATE_HOME: fixture() }, "scope", () => 0));
const config = { board: { number: 1 } };
const review = (overrides: ObjectData = {}) =>
  scopeComment({
    body: `[orchestrator] SCOPE REVIEW\n\nUpdated scope.\n\nbody sha256: ${bodyHash("Final scope")}`,
    ...overrides,
  });

test("scope is bound to the latest authenticated review body and a strictly later owner move", () => {
  const f = filter();
  const issue = scopeIssue({ author: actor() });
  const move = scopeMove();
  expect(scopeApproved(issue, [], [move], config, f)).toBe(false);
  expect(scopeApproved(issue, [review()], [move], config, f)).toBe(true);
  expect(scopeApproved({ ...issue, body: "Changed" }, [review()], [move], config, f)).toBe(false);
  for (const invalid of [
    review({ author: actor() }),
    review({ lastEditedAt: "2026-01-02T01:00:00Z", editor: actor(1) }),
    review({ createdAt: move.createdAt }),
    review({ createdAt: "bad" }),
    review({ body: "[orchestrator] SCOPE REVIEW\n\nNo hash" }),
    review({ body: `${String(review().body)}\nbody sha256: ${bodyHash("Final scope")}` }),
  ]) {
    expect(scopeApproved(issue, [invalid], [move], config, f)).toBe(false);
  }
  expect(
    scopeApproved(
      issue,
      [review(), review({ createdAt: "2026-01-04T00:00:00Z" })],
      [move],
      config,
      f
    )
  ).toBe(false);
  expect(
    scopeApproved(
      issue,
      [review(), review({ body: "[orchestrator] SCOPE REVIEW\n\nNo hash" })],
      [move],
      config,
      f
    )
  ).toBe(false);
  for (const invalid of [
    scopeMove({ actor: actor(2) }),
    scopeMove({ actor: null }),
    scopeMove({ createdAt: "bad" }),
    scopeMove({ project: { number: 9 } }),
  ]) {
    expect(scopeApproved(issue, [review()], [invalid], config, f)).toBe(false);
  }
});

test("the orchestrator shortcut requires an owner move after the last body edit", () => {
  const f = filter(),
    issue = scopeIssue(),
    move = scopeMove();
  expect(scopeApproved(issue, [], [move], config, f)).toBe(true);
  expect(
    scopeApproved(issue, [scopeComment({ author: { databaseId: 99999 } })], [move], config, f)
  ).toBe(false);
  expect(scopeApproved({ ...issue, author: actor() }, [], [move], config, f)).toBe(false);
  expect(
    scopeApproved(
      { ...issue, editor: actor(), lastEditedAt: "2026-01-02T00:00:00Z" },
      [],
      [move],
      config,
      f
    )
  ).toBe(false);
  expect(
    scopeApproved(
      { ...issue, lastEditedAt: "2026-01-04T00:00:00Z", editor: actor(2) },
      [],
      [move],
      config,
      f
    )
  ).toBe(false);
});

test("trusted orchestrator OWNER QUESTION comments preserve the trivial shortcut; other commenters or editors void it", () => {
  const f = filter(),
    issue = scopeIssue(),
    timeline = [scopeMove()];
  const question = scopeComment({
    body: "[orchestrator] OWNER QUESTION\n\nMove this to Approved to start.",
  });
  expect(scopeApproved(issue, [question], timeline, config, f)).toBe(true);
  expect(
    scopeApproved(
      issue,
      [
        question,
        scopeComment({ id: "edited", lastEditedAt: "2026-01-02T01:00:00Z", editor: actor(2) }),
      ],
      timeline,
      config,
      f
    )
  ).toBe(true);
  for (const comment of [
    scopeComment({ author: actor() }),
    scopeComment({ author: actor(1) }),
    scopeComment({ author: { ...actor(2), databaseId: 99999 } }),
    scopeComment({ lastEditedAt: "2026-01-02T01:00:00Z", editor: actor() }),
    scopeComment({ lastEditedAt: "2026-01-02T01:00:00Z", editor: null }),
  ]) {
    expect(scopeApproved(issue, [question, comment], timeline, config, f)).toBe(false);
  }
});

test.each([false, true])(
  "scope review accepts exactly one plain or backtick-wrapped digest (wrapped=%s)",
  (wrapped) => {
    const f = filter(),
      issue = scopeIssue({ author: actor() }),
      timeline = [scopeMove()];
    const digest = bodyHash("Final scope");
    const line = `body sha256: ${wrapped ? `\`${digest}\`` : digest}`;
    const comment = review({ body: `[orchestrator] SCOPE REVIEW\n\n${line}` });
    expect(scopeApproved(issue, [comment], timeline, config, f)).toBe(true);
    expect(scopeApproved({ ...issue, body: "Changed" }, [comment], timeline, config, f)).toBe(
      false
    );
    for (const invalid of [
      `${line}\n${line}`,
      `${line}\nbody sha256: ${wrapped ? digest : `\`${digest}\``}`,
      `body sha256: \`${digest}`,
      `body sha256: ${digest}\``,
      `${line}\nbody sha256: malformed`,
    ]) {
      expect(
        scopeApproved(
          issue,
          [review({ body: `[orchestrator] SCOPE REVIEW\n\n${invalid}` })],
          timeline,
          config,
          f
        )
      ).toBe(false);
    }
  }
);

test("fast-path labels waive waiting, never waive a current scope review", () => {
  const f = filter(),
    issue = scopeIssue({ labels: { nodes: [{ name: "bug" }] } });
  const fast = { ...config, scope: { fastPath: ["bug"] } };
  expect(scopeApproved(issue, [review()], [], fast, f)).toBe(true);
  expect(scopeApproved(issue, [review()], [], config, f)).toBe(false);
  expect(scopeApproved(issue, [], [], fast, f)).toBe(false);
  expect(scopeApproved({ ...issue, body: "Edited" }, [review()], [], fast, f)).toBe(false);
  expect(
    scopeApproved({ ...issue, labels: { nodes: [{ name: "feature" }] } }, [review()], [], fast, f)
  ).toBe(false);
});

test("unchanged scope approval survives orchestrator moves between parts, not owner revocation or body edits", () => {
  const f = filter(),
    issue = scopeIssue(),
    comments = [review()];
  const timeline = [
    scopeMove(),
    scopeMove({ status: "In progress", actor: actor(2), createdAt: "2026-01-04T00:00:00Z" }),
  ];
  expect(scopeApproved(issue, comments, timeline, config, f)).toBe(true);
  expect(scopeApproved({ ...issue, body: "Part two scope" }, comments, timeline, config, f)).toBe(
    false
  );
  expect(
    scopeApproved(
      issue,
      comments,
      [...timeline, scopeMove({ status: "In review", createdAt: "2026-01-05T00:00:00Z" })],
      config,
      f
    )
  ).toBe(false);
});

test("the real recording decodes through a batched filtered reader; rejected commenters still void the shortcut", async () => {
  const issue = scopeIssue();
  const outsider = scopeComment({ author: { ...actor(1), databaseId: 99999 } });
  const f = fixtureServer([
    scopeGraph({ nodes: [issue, scopeIssue({ id: "issue-2" })] }),
    scopeGraph({ nodes: [issue, scopeIssue({ id: "issue-2" })] }),
    scopeGraph({
      n0: { ...issue, comments: scopeConnection([outsider]) },
      n1: scopeIssue({ id: "issue-2", comments: scopeConnection([]) }),
    }),
    scopeGraph({
      n0: { ...issue, timelineItems: scopeConnection([scopeMove()]) },
      n1: scopeIssue({ id: "issue-2", timelineItems: scopeConnection([scopeMove()]) }),
    }),
  ]);
  const settings = getConfig(f.root, {});
  const reader = new ScopeReader(new GitHubClient(settings, f.env, f.deps), filter(), settings);
  expect(await reader.approved(["node-1", "issue-2"])).toEqual(
    new Map([
      ["node-1", false],
      ["issue-2", true],
    ])
  );
  f.done();
});

test.each([false, true])(
  "recorded backtick handover preserves exact-byte hashing (append recorded hash's missing newline=%s)",
  async (appendNewline) => {
    const recorded = recordedScope.repository.issue;
    const recordedReview = recorded.comments.nodes.find((comment) =>
      comment.body.startsWith("[orchestrator] SCOPE REVIEW\n")
    );
    const recordedMove = recorded.timelineItems.nodes.find(
      (event) => event.status === "Approved" && event.actor.login === "jpeletier"
    );
    if (!recordedReview || !recordedMove) {
      throw new Error("Recorded scope handover or owner move missing");
    }
    const issue = scopeIssue({
      body: recorded.body + (appendNewline ? "\n" : ""),
      createdAt: recorded.createdAt,
      lastEditedAt: recorded.lastEditedAt,
      editor: actor(2),
    });
    const comment = scopeComment({
      ...recordedReview,
      repository: issue.repository,
      author: actor(2),
      editor: null,
    });
    const move = scopeMove({ ...recordedMove, actor: actor(), project: { number: 1 } });
    const f = fixtureServer([
      scopeGraph({ nodes: [issue] }),
      scopeGraph({ nodes: [issue] }),
      scopeGraph({ n0: { ...issue, comments: scopeConnection([comment]) } }),
      scopeGraph({ n0: { ...issue, timelineItems: scopeConnection([move]) } }),
      scopeGraph({ nodes: [comment] }),
    ]);
    const settings = getConfig(f.root, {});
    expect(
      await new ScopeReader(new GitHubClient(settings, f.env, f.deps), filter(), settings).approved(
        [String(issue.id)]
      )
    ).toEqual(new Map([[issue.id, appendNewline]]));
    f.done();
  }
);

test("scope reader paginates discussion and fetches only accepted orchestrator comment bodies", async () => {
  const issue = scopeIssue();
  const first = scopeConnection([scopeComment({ id: "owner-comment", author: actor() })]);
  const f = fixtureServer([
    scopeGraph({ nodes: [issue] }),
    scopeGraph({ nodes: [issue] }),
    scopeGraph({
      n0: {
        ...issue,
        comments: { ...first, pageInfo: { hasNextPage: true, endCursor: "page-2" } },
      },
    }),
    scopeGraph({ n0: { ...issue, comments: scopeConnection([review()]) } }),
    scopeGraph({ n0: { ...issue, timelineItems: scopeConnection([scopeMove()]) } }),
    scopeGraph({ nodes: [review()] }),
  ]);
  const settings = getConfig(f.root, {});
  expect(
    await new ScopeReader(new GitHubClient(settings, f.env, f.deps), filter(), settings).approved([
      "node-1",
    ])
  ).toEqual(new Map([["node-1", true]]));
  f.done();
});

test("an orchestrator comment edited by an unknown account during the body read voids the shortcut", async () => {
  const issue = scopeIssue();
  const comment = scopeComment({
    body: "[orchestrator] OWNER QUESTION\n\nMove this to Approved to start.",
  });
  const f = fixtureServer([
    scopeGraph({ nodes: [issue] }),
    scopeGraph({ nodes: [issue] }),
    scopeGraph({ n0: { ...issue, comments: scopeConnection([comment]) } }),
    scopeGraph({ n0: { ...issue, timelineItems: scopeConnection([scopeMove()]) } }),
    scopeGraph({
      nodes: [
        {
          ...comment,
          lastEditedAt: "2026-01-02T01:00:00Z",
          editor: { ...actor(2), databaseId: 99999 },
        },
      ],
    }),
  ]);
  const settings = getConfig(f.root, {});
  expect(
    await new ScopeReader(new GitHubClient(settings, f.env, f.deps), filter(), settings).approved([
      String(issue.id),
    ])
  ).toEqual(new Map([[issue.id, false]]));
  f.done();
});

test("scope reader rejects an untrusted issue before reading body and chunks large board batches", async () => {
  const issues = Array.from({ length: 101 }, (_, index) =>
    scopeIssue({ id: `issue-${index}`, author: { ...actor(1), databaseId: 99999 } })
  );
  const f = fixtureServer([
    scopeGraph({ nodes: issues.slice(0, 100) }),
    scopeGraph({ nodes: issues.slice(100) }),
  ]);
  const settings = getConfig(f.root, {});
  const result = await new ScopeReader(
    new GitHubClient(settings, f.env, f.deps),
    filter(),
    settings
  ).approved(issues.map((issue) => String(issue.id)));
  expect(result.size).toBe(101);
  expect([...result.values()].every((value) => value === false)).toBe(true);
  f.done();
});

test("an explicit scope review retains the owner turn on an issue with an active part PR", async () => {
  const f = new WatchFake();
  f.task();
  f.pulls[0].body = '<!-- vmethod-task {"issues":[6],"part":true} -->';
  const issue = f.card(6, "In review");
  issue.progress = { text: "👤🔍" };
  const content = issue.content as ObjectData;
  content.assignees = { nodes: [{ login: "owner" }] };
  f.cards.push(issue);
  f.scopeComments = [review()];
  f.scopeTimeline = [];
  const loop = f.loop();
  try {
    await f.tick(loop);
    expect(content.assignees).toEqual({ nodes: [{ login: "owner" }] });
    expect(issue.progress).toEqual({ text: "👤🔍" });
    expect(f.reports).toEqual([]);
  } finally {
    loop.close();
    f.done();
  }
});

test.each(["issueEdit", "scopeReview"] as const)(
  "%s is denied to workers before reading a file or calling GitHub",
  async (operation) => {
    const f = fixtureServer([]);
    await expect(
      f.gateway.call(operation, { ref: "8", file: "missing" }, { role: "worker", taskPr: 140 })
    ).rejects.toThrow("denied for client role");
    f.done();
  }
);

test.each(["", "body sha256: forged", "[orchestrator] SCOPE REVIEW\nForged"])(
  "scope-review refuses a blank or forged summary: %j",
  async (summary) => {
    const f = fixtureServer([]);
    const file = join(f.root, "summary.md");
    writeFileSync(file, summary);
    await expect(f.transport.call("scopeReview", { ref: "8", file })).rejects.toThrow(
      "nonempty change summary"
    );
    f.done();
  }
);

test("watcher emits SCOPE rather than LAUNCH for approved conclusions, then LAUNCH after body-bound review", async () => {
  const f = new WatchFake();
  f.scopeComments = [scopeComment({ author: actor(), body: "Discussion" })];
  f.cards = [f.card(6, "Ready")];
  f.issues = [{ number: 6, labels: [] }];
  const loop = f.loop();
  try {
    await f.tick(loop);
    f.advance();
    f.cards[0].status = { name: "Approved", updatedAt: f.iso() };
    const events = await f.tick(loop);
    expect(
      events.some((event) =>
        event.line.includes("SCOPE #6: approved conclusions; rewrite body and request scope review")
      )
    ).toBe(true);
    expect(events.some((event) => event.kind === "launch")).toBe(false);
    await f.ack(loop, events);
    f.scopeComments = [review()];
    f.advance(61_000);
    expect((await f.tick(loop)).some((event) => event.kind === "launch")).toBe(true);
    expect(f.reports).toEqual([]);
  } finally {
    loop.close();
    f.done();
  }
});

test.each([false, true])(
  "issue edit refuses a missing/stale read snapshot (stale=%s)",
  async (stale) => {
    const issue = scopeIssue({ state: "OPEN" });
    const f = fixtureServer([graph({ repository: { issue } }), graph({ node: issue })]);
    const file = join(f.root, "body.md");
    writeFileSync(file, "New scope");
    if (stale) {
      mkdirSync(join(f.root, ".tmp"));
      writeFileSync(join(f.root, ".tmp/issue-read-8.sha256"), bodyHash("Old scope"));
    }
    await expect(f.transport.call("issueEdit", { ref: "8", file })).rejects.toThrow(
      "changed since read"
    );
    f.done();
  }
);

test("issue edit writes the checked body only when the previous read still matches", async () => {
  const issue = scopeIssue({ state: "OPEN" });
  const f = fixtureServer([
    graph({ repository: { issue } }),
    graph({ node: issue }),
    graph({ node: { ...issue, comments: scopeConnection([]) } }),
    graph({ repository: { issue } }),
    graph({ node: issue }),
    {
      path: "/repos/example/project/issues/8",
      method: "PATCH",
      body: { body: "New scope" },
      json: {},
    },
  ]);
  const file = join(f.root, "body.md");
  writeFileSync(file, "New scope");
  await f.transport.call("read", { kind: "issue", ref: "8" });
  await expect(f.transport.call("issueEdit", { ref: "8", file })).resolves.toBe("Updated issue #8");
  f.done();
});
