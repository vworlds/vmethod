import { expect, test } from "vitest";
import { isOwnerApproved, isIssueOwnerApproved } from "../../src/gateway/approval.js";
import { PeopleFilter } from "../../src/gateway/people.js";
import { Digest } from "../../src/gateway/digest.js";
import { fixture } from "../helpers.js";
import { actor, people, sha } from "./helpers.js";

test("a second pinned owner can approve by board move or exact-head review", () => {
  const second = { ...people[0], login: "second-owner", id: 105 };
  const owner = { login: second.login, databaseId: second.id, __typename: second.type };
  const filter = new PeopleFilter(
    [...people, second],
    "example",
    new Digest({ XDG_STATE_HOME: fixture() }, "multi-owner", () => 0)
  );
  const event = {
    __typename: "ProjectV2ItemStatusChangedEvent",
    field: "Status",
    status: "Executing",
    previousStatus: "Spec review",
    actor: owner,
    project: { number: 1 },
    createdAt: "2026-01-02T00:00:00Z",
  };
  expect(isIssueOwnerApproved([event], 1, filter)).toBe(true);
  const pr = {
    headRefOid: sha,
    boardNumber: 1,
    timeline: [],
    comments: [
      {
        author: actor(2),
        body: `[orchestrator] OWNER REVIEW\nHead: ${sha}`,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
    reviews: [],
  };
  expect(
    isOwnerApproved(
      { ...pr, timeline: [{ ...event, status: "Approved", previousStatus: "Owner review" }] },
      filter,
      "example/project"
    )
  ).toBe(true);
  const review = { author: owner, state: "APPROVED", commit: { oid: sha } };
  expect(isOwnerApproved({ ...pr, reviews: [review] }, filter, "example/project")).toBe(true);
  expect(
    isOwnerApproved(
      { ...pr, reviews: [{ ...review, author: { ...owner, databaseId: 999 } }] },
      filter,
      "example/project"
    )
  ).toBe(false);
});

test("issue approval follows latest configured-board event by verified owner id only", () => {
  const filter = new PeopleFilter(
    people,
    "example",
    new Digest({ XDG_STATE_HOME: fixture() }, "issue", () => 0)
  );
  const event = {
    __typename: "ProjectV2ItemStatusChangedEvent",
    status: "Executing",
    previousStatus: "Spec review",
    actor: actor(),
    project: { number: 1 },
    createdAt: "2026-01-01T00:00:00Z",
  };
  expect(isIssueOwnerApproved([event], 1, filter)).toBe(true);
  expect(
    isIssueOwnerApproved([{ ...event, actor: { ...actor(), databaseId: 999 } }], 1, filter)
  ).toBe(false);
  expect(isIssueOwnerApproved([{ ...event, actor: actor(2) }], 1, filter)).toBe(false);
  expect(isIssueOwnerApproved([{ ...event, actor: null }], 1, filter)).toBe("unknown");
  expect(isIssueOwnerApproved([event], 2, filter)).toBe(false);
  expect(
    isIssueOwnerApproved(
      [event, { ...event, status: "Scoping", createdAt: "2026-01-02T00:00:00Z" }],
      1,
      filter
    )
  ).toBe(false);
});

test("only owner reviews on the head or owner status-change actors approve; card status and peers cannot", () => {
  const filter = new PeopleFilter(
    people,
    "example",
    new Digest({ XDG_STATE_HOME: fixture() }, "state", () => 0)
  );
  const pr = {
    headRefOid: sha,
    reviews: [],
    timeline: [],
    boardNumber: 1,
    comments: [
      {
        author: actor(2),
        body: `[orchestrator] OWNER REVIEW\nHead: ${sha}`,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
  };
  const review = { author: actor(), state: "APPROVED", commit: { oid: sha } };
  const event = {
    __typename: "ProjectV2ItemStatusChangedEvent",
    field: "Status",
    status: "Approved",
    previousStatus: "Owner review",
    actor: actor(),
    project: { number: 1 },
    createdAt: "2026-01-01T01:00:00Z",
  };
  expect(isOwnerApproved({ ...pr, reviews: [review] }, filter, "example/project")).toBe(true);
  expect(
    isOwnerApproved(
      { ...pr, reviews: [{ ...review, commit: { oid: "old-head" } }] },
      filter,
      "example/project"
    )
  ).toBe(false);
  expect(
    isOwnerApproved(
      { ...pr, reviews: [{ ...review, author: actor(2) }] },
      filter,
      "example/project"
    )
  ).toBe(false);
  expect(isOwnerApproved({ ...pr, timeline: [event] }, filter, "example/project")).toBe(true);
  expect(
    isOwnerApproved({ ...pr, timeline: [{ ...event, actor: actor(2) }] }, filter, "example/project")
  ).toBe(false);
  expect(
    isOwnerApproved({ ...pr, timeline: [{ ...event, actor: null }] }, filter, "example/project")
  ).toBe("unknown");
  expect(
    isOwnerApproved({ ...pr, timeline: [{ status: "Approved" }] }, filter, "example/project")
  ).toBe(false);
  expect(
    isOwnerApproved(
      { ...pr, reviews: [review], timeline: [{ ...event, actor: null }] },
      filter,
      "example/project"
    )
  ).toBe(true);
  expect(
    isOwnerApproved(
      {
        ...pr,
        reviews: [{ ...review, lastEditedAt: "now", editor: actor(2) }],
      },
      filter,
      "example/project"
    )
  ).toBe(false);
  expect(
    isOwnerApproved(
      {
        ...pr,
        timeline: [{ ...event, actor: { ...actor(), databaseId: 999 } }],
      },
      filter,
      "example/project"
    )
  ).toBe(false);
}, 15000);

test("board approval is bound to the configured project, latest status event, and a preceding current-head orchestrator handover", () => {
  const filter = new PeopleFilter(
    people,
    "example",
    new Digest({ XDG_STATE_HOME: fixture() }, "state", () => 0)
  );
  const handover = {
    author: actor(2),
    body: `[orchestrator] OWNER REVIEW\nHead: ${sha}`,
    createdAt: "2026-01-01T01:00:00Z",
  };
  const event = {
    __typename: "ProjectV2ItemStatusChangedEvent",
    field: "Status",
    status: "Approved",
    previousStatus: "In review",
    actor: actor(),
    project: { number: 1 },
    createdAt: "2026-01-01T02:00:00Z",
  };
  const pr = {
    headRefOid: sha,
    reviews: [],
    comments: [handover],
    timeline: [event],
    boardNumber: 1,
  };
  expect(isOwnerApproved(pr, filter, "example/project")).toBe(true);
  // Approve, then push a new head: the old handover cannot authorize it.
  expect(isOwnerApproved({ ...pr, headRefOid: "b".repeat(40) }, filter, "example/project")).toBe(
    false
  );
  // Deliberately reverse API order: timestamps, not array order, determine latest.
  const away = {
    ...event,
    status: "In progress",
    previousStatus: "Approved",
    createdAt: "2026-01-01T03:00:00Z",
  };
  expect(isOwnerApproved({ ...pr, timeline: [away, event] }, filter, "example/project")).toBe(
    false
  );
  expect(
    isOwnerApproved(
      { ...pr, timeline: [{ ...event, project: { number: 2 } }] },
      filter,
      "example/project"
    )
  ).toBe(false);
  expect(
    isOwnerApproved(
      {
        ...pr,
        timeline: [
          away,
          {
            ...event,
            project: { number: 2 },
            createdAt: "2026-01-01T04:00:00Z",
          },
        ],
      },
      filter,
      "example/project"
    )
  ).toBe(false);
  expect(
    isOwnerApproved(
      { ...pr, timeline: [{ ...event, createdAt: "2026-01-01T00:00:00Z" }] },
      filter,
      "example/project"
    )
  ).toBe(false);
  expect(
    isOwnerApproved(
      { ...pr, timeline: [{ ...event, createdAt: handover.createdAt }] },
      filter,
      "example/project"
    )
  ).toBe(false);
  expect(
    isOwnerApproved(
      {
        ...pr,
        comments: [
          {
            ...handover,
            body: `[orchestrator] OWNER REVIEW\nHead: ${"b".repeat(40)}`,
          },
        ],
      },
      filter,
      "example/project"
    )
  ).toBe(false);
  for (const author of [actor(), actor(1), { ...actor(2), databaseId: 999 }]) {
    expect(
      isOwnerApproved({ ...pr, comments: [{ ...handover, author }] }, filter, "example/project")
    ).toBe(false);
  }
  expect(isOwnerApproved({ ...pr, comments: [] }, filter, "example/project")).toBe(false);
  expect(
    isOwnerApproved(
      {
        ...pr,
        comments: [{ ...handover, body: `Data\n[orchestrator] OWNER REVIEW\n${sha}` }],
      },
      filter,
      "example/project"
    )
  ).toBe(false);
  expect(
    isOwnerApproved(
      {
        ...pr,
        comments: [
          {
            ...handover,
            lastEditedAt: "2026-01-01T03:00:00Z",
            editor: actor(2),
          },
        ],
      },
      filter,
      "example/project"
    )
  ).toBe(false);
  expect(
    isOwnerApproved(
      {
        ...pr,
        comments: [{ ...handover, lastEditedAt: handover.createdAt, editor: actor(1) }],
      },
      filter,
      "example/project"
    )
  ).toBe(false);
  expect(
    isOwnerApproved(
      {
        ...pr,
        timeline: [event, { ...event, actor: null, createdAt: "2026-01-01T03:00:00Z" }],
      },
      filter,
      "example/project"
    )
  ).toBe("unknown");
  expect(
    isOwnerApproved(
      { ...pr, timeline: [{ ...event, createdAt: undefined }] },
      filter,
      "example/project"
    )
  ).toBe("unknown");
}, 15000);

test("historical board approval survives a later non-owner move and is revoked by owner", () => {
  const filter = new PeopleFilter(
    people,
    "example",
    new Digest({ XDG_STATE_HOME: fixture() }, "state", () => 0)
  );
  const handover = {
    author: actor(2),
    body: `[orchestrator] OWNER REVIEW\nHead: ${sha}`,
    createdAt: "2026-01-01T01:00:00Z",
  };
  const approved = {
    __typename: "ProjectV2ItemStatusChangedEvent",
    field: "Status",
    status: "Approved",
    previousStatus: "Owner review",
    actor: actor(),
    project: { number: 1 },
    createdAt: "2026-01-01T02:00:00Z",
  };
  const movedAway = {
    ...approved,
    status: "In review",
    actor: actor(2),
    createdAt: "2026-01-01T03:00:00Z",
  };
  const pr = {
    headRefOid: sha,
    reviews: [],
    comments: [handover],
    timeline: [approved, movedAway],
    boardNumber: 1,
    historical: true,
  };
  expect(isOwnerApproved(pr, filter, "example/project")).toBe(true);
  expect(
    isOwnerApproved(
      { ...pr, timeline: [approved, { ...movedAway, actor: actor() }] },
      filter,
      "example/project"
    )
  ).toBe(false);
  expect(
    isOwnerApproved(
      { ...pr, reviews: [{ state: "APPROVED", author: actor(), commit: { oid: sha } }] },
      filter,
      "example/project"
    )
  ).toBe(true);
  expect(
    isOwnerApproved(
      { ...pr, timeline: [approved, { ...movedAway, createdAt: "invalid" }] },
      filter,
      "example/project"
    )
  ).toBe("unknown");
  expect(
    isOwnerApproved({ ...pr, timeline: [{ ...approved, actor: null }] }, filter, "example/project")
  ).toBe("unknown");
  expect(
    isOwnerApproved(
      { ...pr, timeline: [approved, { ...movedAway, actor: null }] },
      filter,
      "example/project"
    )
  ).toBe("unknown");
});
