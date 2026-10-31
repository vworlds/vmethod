import { expect, test } from "vitest";
import { testConfig } from "../config.js";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { bodyHash, scopeApproved, ScopeReader } from "../../src/evidence/scope.js";
import { PeopleFilter, type ObjectData } from "../../src/gateway/people.js";
import { Digest } from "../../src/gateway/digest.js";
import { GitHubClient } from "../../src/gateway/client.js";
import { getConfig } from "../../src/config.js";
import { actor, fixtureServer, graph, item, people, type Request } from "./helpers.js";
import {
  scopeIssue,
  scopeComment,
  scopeMove,
  scopeConnection,
  scopeGraph,
} from "./scope-fixture.js";
import { fixture } from "../helpers.js";
import { WatchFake } from "./watch-fake.js";
import { gatewayVerb } from "../../src/cli/gateway.js";
import type { Transport } from "../../src/gateway/transport.js";
import boardRecording from "../fixtures/github/board-write-inputs.json" with { type: "json" };
import recordedScope from "../fixtures/github/issue-scope.json" with { type: "json" };

const filter = () =>
  new PeopleFilter(people, "example", new Digest({ XDG_STATE_HOME: fixture() }, "scope", () => 0));
const config = testConfig({ board: { number: 1 } });
const review = (overrides: ObjectData = {}) =>
  scopeComment({
    body: `[orchestrator] SCOPE REVIEW\n\nUpdated scope.\n\nbody sha256: ${bodyHash("Final scope")}`,
    ...overrides,
  });

/** The board's project and field snapshot reads, as `issueEdit`'s scope evidence begins.
 * Only repository scope is renamed to the offline test project's configured repository. */
function boardReads(recording = boardRecording) {
  for (const card of recording.items.nodes) {
    card.content.repository.nameWithOwner = "example/project";
  }
  return [
    {
      path: "/graphql",
      json: {
        data: {
          organization: { projectV2: { id: recording.id, readme: recording.readme } },
        },
      },
    },
    { path: "/graphql", json: { data: { node: { fields: recording.fields } } } },
  ];
}

/** The batched scope read for one issue: metadata, body, comments, then timeline. */
function scopeReads(
  issue: ObjectData,
  comments: ObjectData[],
  timeline: ObjectData[] = []
): Request[] {
  return [
    scopeGraph({ nodes: [issue] }),
    scopeGraph({ nodes: [issue] }),
    scopeGraph({ n0: { ...issue, comments: scopeConnection(comments) } }),
    scopeGraph({ n0: { ...issue, timelineItems: scopeConnection(timeline) } }),
  ];
}

test.each([
  ["Spec review", true, true],
  ["Scoping", false, true],
  ["Backlog", true, false],
  ["Scoping", true, false],
  ["Spec review", false, false],
  ["Owner review", true, false],
] as const)(
  "Executing scope gate requires %s with review=%s",
  (previousStatus, reviewed, valid) => {
    const f = filter();
    const issue = scopeIssue();
    const timeline = [scopeMove({ status: "Executing", previousStatus })];
    expect(scopeApproved(issue, reviewed ? [review()] : [], timeline, config, f)).toBe(valid);
    expect(scopeApproved({ ...issue, body: "changed" }, [review()], timeline, config, f)).toBe(
      false
    );
    expect(
      scopeApproved(
        issue,
        reviewed ? [review()] : [],
        [scopeMove({ status: "Executing", previousStatus, actor: actor(2) })],
        config,
        f
      )
    ).toBe(false);
  }
);

test("a later owner move away revokes current scope approval", () => {
  const f = filter();
  expect(
    scopeApproved(
      scopeIssue(),
      [review()],
      [
        scopeMove({ status: "Executing", previousStatus: "Spec review" }),
        scopeMove({
          status: "Scoping",
          previousStatus: "Spec review",
          createdAt: "2026-01-05T00:00:00Z",
        }),
      ],
      config,
      f
    )
  ).toBe(false);
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
    move = scopeMove({ previousStatus: "Scoping" });
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
    timeline = [scopeMove({ previousStatus: "Scoping" })];
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

test("the role is per repository: the bound orchestrator keeps the shortcut and a peer orchestrator's comments void it", () => {
  // issue #186: a peer project's orchestrator is a collaborator here.
  const foreign = () =>
    new PeopleFilter(
      people.map((person) =>
        person.login === "peer" ? { ...person, repos: ["example/other"] } : person
      ),
      "example",
      new Digest({ XDG_STATE_HOME: fixture() }, "scope-foreign", () => 0)
    );
  const move = [scopeMove({ previousStatus: "Scoping" })];
  const question = scopeComment({
    body: "[orchestrator] OWNER QUESTION\n\nMove this to Approved to start.",
  });
  const peerVotes = [
    scopeComment(),
    scopeComment({
      body: `[orchestrator] SCOPE REVIEW\n\nPeer review.\n\nbody sha256: ${bodyHash("Final scope")}`,
    }),
    scopeComment({ lastEditedAt: "2026-01-02T01:00:00Z", editor: actor(2) }),
  ];
  // This repository's bound orchestrator keeps full shortcut authority.
  expect(scopeApproved(scopeIssue(), [question], move, config, filter())).toBe(true);
  expect(scopeApproved(scopeIssue(), [], move, config, filter())).toBe(true);
  for (const comment of peerVotes) {
    const issue = scopeIssue();
    const timeline = [
      scopeMove({
        previousStatus: String(comment.body).startsWith("[orchestrator] SCOPE REVIEW")
          ? "Spec review"
          : "Scoping",
      }),
    ];
    expect(scopeApproved(issue, [question, comment], timeline, config, filter())).toBe(true);
    expect(scopeApproved(issue, [question, comment], timeline, config, foreign())).toBe(false);
  }
  // An issue written by a peer orchestrator (a collaborator here) has no shortcut.
  expect(scopeApproved(scopeIssue(), [], move, config, foreign())).toBe(false);
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
      n1: scopeIssue({
        id: "issue-2",
        timelineItems: scopeConnection([scopeMove({ previousStatus: "Scoping" })]),
      }),
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
    const move = scopeMove({
      ...recordedMove,
      status: "Executing",
      previousStatus: "Spec review",
      actor: actor(),
      project: { number: 1 },
    });
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
  const issue = f.card(6, "Spec review");
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

test.each([
  {
    summary: "[worker] QUESTION\n\nWhich case?",
    message:
      'First non-blank line is the protocol header "[worker] QUESTION"; scope-review adds the header itself',
  },
  {
    summary: "\n\n[orchestrator] ANSWER \n\nbody",
    message:
      'First non-blank line is the protocol header "[orchestrator] ANSWER"; scope-review adds the header itself',
  },
])(
  "scope-review refuses a summary opening with a protocol header: %j",
  async ({ summary, message }) => {
    const f = fixtureServer([]);
    const file = join(f.root, "summary.md");
    writeFileSync(file, summary);
    await expect(f.transport.call("scopeReview", { ref: "8", file })).rejects.toThrow(message);
    f.done();
  }
);

test("watcher emits SCOPE in Spec review, then LAUNCH after body-bound approval into Executing", async () => {
  const f = new WatchFake();
  f.scopeComments = [scopeComment({ author: actor(), body: "Discussion" })];
  f.cards = [f.card(6, "Scoping")];
  f.issues = [{ number: 6, labels: [] }];
  const loop = f.loop();
  try {
    await f.tick(loop);
    f.advance();
    f.cards[0].status = { name: "Spec review", updatedAt: f.iso() };
    const events = await f.tick(loop);
    expect(
      events.some((event) =>
        event.line.includes(
          "SCOPE #6: agreed conclusions; rewrite body, revise Estimate and request scope review"
        )
      )
    ).toBe(true);
    expect(events.some((event) => event.kind === "launch")).toBe(false);
    await f.ack(loop, events);
    f.scopeComments = [review()];
    f.advance(61_000);
    f.cards[0].status = { name: "Executing", updatedAt: f.iso() };
    f.scopeTimeline = [
      scopeMove({
        status: "Executing",
        previousStatus: "Spec review",
        project: { number: 5 },
        createdAt: f.iso(),
      }),
    ];
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
    ...boardReads(),
    ...scopeReads(issue, []),
    {
      path: "/repos/example/project/pulls?state=open&per_page=100&page=1",
      method: "GET",
      json: [],
    },
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

test("a title-only issue edit leaves approved scope approved", async () => {
  const issue = scopeIssue({ state: "OPEN" });
  const comments = [review()];
  const timeline = [scopeMove({ status: "Executing", previousStatus: "Spec review" })];
  const f = fixtureServer([
    graph({ repository: { issue } }),
    graph({ node: issue }),
    {
      path: "/repos/example/project/issues/8",
      method: "PATCH",
      body: { title: "New title" },
      json: {},
    },
  ]);
  expect(scopeApproved(issue, comments, timeline, config, filter())).toBe(true);
  await expect(f.transport.call("issueEdit", { ref: "8", title: "New title" })).resolves.toBe(
    "Updated issue #8"
  );
  expect(
    scopeApproved({ ...issue, title: "New title" }, comments, timeline, config, filter())
  ).toBe(true);
  f.done();
});

test.each([undefined, "New title"])(
  "issue body edit on an approved scope warns (title=%s)",
  async (title) => {
    const issue = scopeIssue({ state: "OPEN" });
    const comment = review();
    const f = fixtureServer([
      graph({ repository: { issue } }),
      graph({ node: issue }),
      ...boardReads(),
      ...scopeReads(
        issue,
        [comment],
        [scopeMove({ status: "Executing", previousStatus: "Spec review" })]
      ),
      scopeGraph({ nodes: [comment] }),
      {
        path: "/repos/example/project/issues/8",
        method: "PATCH",
        body: { body: "New scope", ...(title === undefined ? {} : { title }) },
        json: {},
      },
    ]);
    const file = join(f.root, "body.md");
    writeFileSync(file, "New scope");
    mkdirSync(join(f.root, ".tmp"));
    writeFileSync(join(f.root, ".tmp/issue-read-8.sha256"), bodyHash("Final scope"));
    await expect(f.transport.call("issueEdit", { ref: "8", file, title })).resolves.toBe(
      `Updated issue #8\nscope approval for #8 is now stale; run scope-review 8 <summary-file> before merging`
    );
    f.done();
  }
);

test.each([
  {
    label: "an open task PR warns",
    pulls: [{ number: 24, body: '<!-- vmethod-task {"issues":[8]} -->' }],
    warned: true,
  },
  {
    label: "no task PR stays quiet",
    pulls: [],
    warned: false,
  },
])("issue edit without an approved scope ($label)", async ({ pulls, warned }) => {
  const issue = scopeIssue({ state: "OPEN" });
  const f = fixtureServer([
    graph({ repository: { issue } }),
    graph({ node: issue }),
    ...boardReads(),
    ...scopeReads(issue, []),
    {
      path: "/repos/example/project/pulls?state=open&per_page=100&page=1",
      method: "GET",
      json: pulls,
    },
    {
      path: "/repos/example/project/issues/8",
      method: "PATCH",
      body: { body: "New scope" },
      json: {},
    },
  ]);
  const file = join(f.root, "body.md");
  writeFileSync(file, "New scope");
  mkdirSync(join(f.root, ".tmp"));
  writeFileSync(join(f.root, ".tmp/issue-read-8.sha256"), bodyHash("Final scope"));
  await expect(f.transport.call("issueEdit", { ref: "8", file })).resolves.toBe(
    warned
      ? `Updated issue #8\nscope approval for #8 is now stale; run scope-review 8 <summary-file> before merging`
      : "Updated issue #8"
  );
  f.done();
});

test("issue edit --scope-review binds the new body's hash and requests the owner turn (#359)", async () => {
  const recording = structuredClone(boardRecording);
  const card = recording.items.nodes[0];
  const status = recording.fields.nodes.find((field) => field.name === "Status")!;
  status.options![0].name = "Spec review";
  const option = status.options![0];
  const issue = item({
    id: card.content.id,
    number: 8,
    state: "OPEN",
    title: "Issue",
    body: "Final scope",
    labels: { nodes: [], pageInfo: { hasNextPage: false } },
  });
  const summary =
    "- Folded the agreed acceptance cases into the body. Estimate unchanged: the shape did not.";
  const postedBody = `[orchestrator] SCOPE REVIEW\n\nI have updated the main body to the final scope.\n\nEstimate: 5\n\n${summary}\n\nbody sha256: ${bodyHash("New scope")}`;
  const f = fixtureServer([
    graph({ repository: { issue: item({ id: issue.id }) } }),
    graph({ node: issue }),
    {
      path: "/repos/example/project/issues/8",
      method: "PATCH",
      body: { body: "New scope" },
      json: {},
    },
    graph({ repository: { issue: item({ id: issue.id }) } }),
    graph({ node: { ...issue, body: "New scope" } }),
    ...boardReads(recording),
    { path: "/graphql", json: { data: { node: { items: recording.items } } } },
    graph({
      node: item({
        id: issue.id,
        assignees: { nodes: [], pageInfo: { hasNextPage: false } },
      }),
    }),
    {
      path: "/repos/example/project/issues/8/assignees",
      method: "POST",
      body: { assignees: ["owner"] },
      json: {},
    },
    {
      path: "/repos/example/project/issues/8/comments",
      body: { body: postedBody },
      json: {},
    },
    ...boardReads(recording),
    {
      path: "/graphql",
      json: {
        data: {
          node: {
            projectItems: {
              nodes: [{ ...card, project: { id: recording.id } }],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    },
    {
      path: "/graphql",
      json: {
        data: { m0: { projectV2Item: { id: card.id } }, m1: { projectV2Item: { id: card.id } } },
      },
      checkQuery(_query, variables) {
        expect(
          Object.values(variables).map((value) => (value as { value: unknown }).value)
        ).toEqual([{ text: "👤🔍" }, { singleSelectOptionId: option.id }]);
      },
    },
  ]);
  const file = join(f.root, "body.md");
  writeFileSync(file, "New scope");
  const summaryFile = join(f.root, "scope-summary.md");
  writeFileSync(summaryFile, summary);
  mkdirSync(join(f.root, ".tmp"));
  writeFileSync(join(f.root, ".tmp/issue-read-8.sha256"), bodyHash("Final scope"));
  await expect(
    f.transport.call("issueEdit", { ref: "8", file, scopeReview: summaryFile })
  ).resolves.toBe("Updated issue #8; Scope review requested for #8");
  // The one journaled flow: the edit's operation, the paired review's operation, then
  // the shared writes. The PATCH itself is the edit's only card write.
  expect(
    readFileSync(join(f.env.XDG_STATE_HOME, "vmethod", "example-state", "writes.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .map((entry) => entry.kind)
  ).toEqual(["operation", "PATCH issues/8", "operation", "assigned", "comment", "board", "board"]);
  // The posted review binds the edited body, so the approval gate accepts the new body.
  expect(
    scopeApproved(
      { ...issue, body: "New scope" },
      [scopeComment({ body: postedBody })],
      [scopeMove({ status: "Executing", previousStatus: "Spec review" })],
      config,
      filter()
    )
  ).toBe(true);
  f.done();
});

test("issue edit --scope-review forwards the summary and refuses malformed flags", async () => {
  const calls: unknown[] = [];
  const transport: Transport = {
    call: async (operation, input, ctx) => {
      calls.push({ operation, input, ctx });
      return "ok" as never;
    },
  };
  const env = { VMETHOD_ROLE: "orchestrator" };
  await gatewayVerb(transport, "issue", ["edit", "8", "body.md"], env);
  await gatewayVerb(
    transport,
    "issue",
    ["edit", "8", "body.md", "--scope-review", "summary.md"],
    env
  );
  await gatewayVerb(
    transport,
    "issue",
    ["edit", "8", "--title", "New title", "body.md", "--scope-review", "summary.md"],
    env
  );
  expect(calls).toEqual([
    { operation: "issueEdit", input: { ref: "8", file: "body.md" }, ctx: { role: "orchestrator" } },
    {
      operation: "issueEdit",
      input: { ref: "8", file: "body.md", scopeReview: "summary.md" },
      ctx: { role: "orchestrator" },
    },
    {
      operation: "issueEdit",
      input: { ref: "8", file: "body.md", title: "New title", scopeReview: "summary.md" },
      ctx: { role: "orchestrator" },
    },
  ]);
  calls.length = 0;
  await expect(
    gatewayVerb(transport, "issue", ["edit", "8", "body.md", "--scope-review"], env)
  ).rejects.toThrow("Missing value for --scope-review");
  expect(calls).toEqual([]);
});
