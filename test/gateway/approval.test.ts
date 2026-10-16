import { expect, test } from "vitest";
import { isOwnerApproved } from "../../src/gateway/approval.js";
import { PeopleFilter } from "../../src/gateway/people.js";
import { Digest } from "../../src/gateway/digest.js";
import { fixture } from "../helpers.js";
import { actor, people, sha } from "./helpers.js";

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
    actor: actor(),
    project: { number: 1 },
    createdAt: "2026-01-01T01:00:00Z",
  };
  expect(isOwnerApproved({ ...pr, reviews: [review] }, filter)).toBe(true);
  expect(
    isOwnerApproved({ ...pr, reviews: [{ ...review, commit: { oid: "old-head" } }] }, filter)
  ).toBe(false);
  expect(isOwnerApproved({ ...pr, reviews: [{ ...review, author: actor(2) }] }, filter)).toBe(
    false
  );
  expect(isOwnerApproved({ ...pr, timeline: [event] }, filter)).toBe(true);
  expect(isOwnerApproved({ ...pr, timeline: [{ ...event, actor: actor(2) }] }, filter)).toBe(false);
  expect(isOwnerApproved({ ...pr, timeline: [{ ...event, actor: null }] }, filter)).toBe("unknown");
  expect(isOwnerApproved({ ...pr, timeline: [{ status: "Approved" }] }, filter)).toBe(false);
  expect(
    isOwnerApproved({ ...pr, reviews: [review], timeline: [{ ...event, actor: null }] }, filter)
  ).toBe(true);
  expect(
    isOwnerApproved(
      {
        ...pr,
        reviews: [{ ...review, lastEditedAt: "now", editor: actor(2) }],
      },
      filter
    )
  ).toBe(false);
  expect(
    isOwnerApproved(
      {
        ...pr,
        timeline: [{ ...event, actor: { ...actor(), databaseId: 999 } }],
      },
      filter
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
  expect(isOwnerApproved(pr, filter)).toBe(true);
  // Approve, then push a new head: the old handover cannot authorize it.
  expect(isOwnerApproved({ ...pr, headRefOid: "b".repeat(40) }, filter)).toBe(false);
  // Deliberately reverse API order: timestamps, not array order, determine latest.
  const away = {
    ...event,
    status: "In progress",
    previousStatus: "Approved",
    createdAt: "2026-01-01T03:00:00Z",
  };
  expect(isOwnerApproved({ ...pr, timeline: [away, event] }, filter)).toBe(false);
  expect(isOwnerApproved({ ...pr, timeline: [{ ...event, project: { number: 2 } }] }, filter)).toBe(
    false
  );
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
      filter
    )
  ).toBe(false);
  expect(
    isOwnerApproved({ ...pr, timeline: [{ ...event, createdAt: "2026-01-01T00:00:00Z" }] }, filter)
  ).toBe(false);
  expect(
    isOwnerApproved({ ...pr, timeline: [{ ...event, createdAt: handover.createdAt }] }, filter)
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
      filter
    )
  ).toBe(false);
  for (const author of [actor(), actor(1), { ...actor(2), databaseId: 999 }]) {
    expect(isOwnerApproved({ ...pr, comments: [{ ...handover, author }] }, filter)).toBe(false);
  }
  expect(isOwnerApproved({ ...pr, comments: [] }, filter)).toBe(false);
  expect(
    isOwnerApproved(
      {
        ...pr,
        comments: [{ ...handover, body: `Data\n[orchestrator] OWNER REVIEW\n${sha}` }],
      },
      filter
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
      filter
    )
  ).toBe(false);
  expect(
    isOwnerApproved(
      {
        ...pr,
        comments: [{ ...handover, lastEditedAt: handover.createdAt, editor: actor(1) }],
      },
      filter
    )
  ).toBe(false);
  expect(
    isOwnerApproved(
      {
        ...pr,
        timeline: [event, { ...event, actor: null, createdAt: "2026-01-01T03:00:00Z" }],
      },
      filter
    )
  ).toBe("unknown");
  expect(isOwnerApproved({ ...pr, timeline: [{ ...event, createdAt: undefined }] }, filter)).toBe(
    "unknown"
  );
}, 15000);
