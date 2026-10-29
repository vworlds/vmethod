import { expect, test } from "vitest";
import { isOwnerApproved, type ApprovalPR } from "../../src/gateway/approval.js";
import { PeopleFilter } from "../../src/gateway/people.js";
import { Digest } from "../../src/gateway/digest.js";
import { fixture } from "../helpers.js";
import { actor, people, sha } from "./helpers.js";
import { scopeComment, scopeMove } from "./scope-fixture.js";

const handover = scopeComment({ body: `[orchestrator] OWNER REVIEW\nHead: ${sha}` });
const move = scopeMove({ field: "Status", previousStatus: "Owner review", status: "Approved" });
const later = scopeMove({
  field: "Status",
  previousStatus: "Approved",
  status: "Executing",
  createdAt: "2026-01-04T00:00:00Z",
});
const review = { author: actor(), state: "APPROVED", commit: { oid: sha } };
const rows: { name: string; pr: Partial<ApprovalPR>; expected: boolean | "unknown" }[] = [
  { name: "S4 #17 exact-head owner review", pr: { reviews: [review] }, expected: true },
  {
    name: "S4 #19 wrong-head owner review",
    pr: { reviews: [{ ...review, commit: { oid: "b".repeat(40) } }] },
    expected: false,
  },
  { name: "S4 #88 owner handover then move", pr: { timeline: [move] }, expected: true },
  {
    name: "S4 #17 section 7.8 legacy In review",
    pr: { timeline: [{ ...move, previousStatus: "In review" }] },
    expected: true,
  },
  {
    name: "B4 #19 status presence alone is not approval",
    pr: { timeline: [] },
    expected: false,
  },
  {
    name: "B4 #19 non-owner move",
    pr: { timeline: [{ ...move, actor: actor(2) }] },
    expected: false,
  },
  {
    name: "S4 #17 section 7.8 Backlog drag",
    pr: { timeline: [{ ...move, previousStatus: "Backlog" }] },
    expected: false,
  },
  {
    name: "S4 #88 edited handover cannot backdate",
    pr: {
      timeline: [move],
      comments: [{ ...handover, lastEditedAt: later.createdAt, editor: actor(2) }],
    },
    expected: false,
  },
  {
    name: "S5 #88 historical approval survives non-owner move",
    pr: { historical: true, timeline: [move, { ...later, actor: actor(2) }] },
    expected: true,
  },
  {
    name: "S5 #88 current gate follows latest non-owner move",
    pr: { timeline: [move, { ...later, actor: actor(2) }] },
    expected: false,
  },
  {
    name: "S5 #88 historical owner bounce revokes",
    pr: { historical: true, timeline: [move, later] },
    expected: false,
  },
  {
    name: "S5 #88 historical owner move to Backlog revokes",
    pr: { historical: true, timeline: [move, { ...later, status: "Backlog" }] },
    expected: false,
  },
  {
    name: "S11 #19 missing actor stays unknown",
    pr: { timeline: [{ ...move, actor: null }] },
    expected: "unknown",
  },
  {
    name: "S11 #19 invalid ordering stays unknown",
    pr: { timeline: [{ ...move, createdAt: "invalid" }] },
    expected: "unknown",
  },
  { name: "S11 #19 invalid head stays unknown", pr: { headRefOid: "" }, expected: "unknown" },
  {
    name: "S11 #19 historical missing handover stays unknown",
    pr: { historical: true, timeline: [move], comments: [] },
    expected: "unknown",
  },
  {
    name: "S11 #19 historical missing actor stays unknown",
    pr: { historical: true, timeline: [move, { ...later, actor: null }] },
    expected: "unknown",
  },
];

test("approval characterization table is non-empty", () => expect(rows.length).toBeGreaterThan(0));
test.each(rows)("$name", ({ pr, expected }) => {
  const filter = new PeopleFilter(
    people,
    "example",
    new Digest({ XDG_STATE_HOME: fixture() }, "approval-table", () => 0)
  );
  expect(
    isOwnerApproved(
      { headRefOid: sha, boardNumber: 1, reviews: [], timeline: [], comments: [handover], ...pr },
      filter,
      "example/project"
    )
  ).toBe(expected);
});
