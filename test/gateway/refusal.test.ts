import { expect, test } from "vitest";
import { approvalRefusal, isOwnerApproved, type ApprovalPR } from "../../src/evidence/approval.js";
import { scopeApproved, scopeRefusal, bodyHash } from "../../src/evidence/scope.js";
import { guardClosingKeywords } from "../../src/gateway/markdown.js";
import { PeopleFilter } from "../../src/gateway/people.js";
import { Digest } from "../../src/gateway/digest.js";
import { fixture } from "../helpers.js";
import { actor, people, sha } from "./helpers.js";
import { scopeIssue, scopeComment, scopeMove } from "./scope-fixture.js";

const filter = () =>
  new PeopleFilter(
    people,
    "example",
    new Digest({ XDG_STATE_HOME: fixture() }, "refusals", () => 0)
  );
const config = { board: { number: 1 } };
const old = "b".repeat(40);
const move = (overrides = {}) => ({
  ...scopeMove({ status: "Approved", previousStatus: "Owner review" }),
  field: "Status",
  ...overrides,
});
const pr = (overrides: Partial<ApprovalPR> = {}): ApprovalPR => ({
  headRefOid: sha,
  boardNumber: 1,
  reviews: [],
  timeline: [],
  comments: [scopeComment({ body: `[orchestrator] OWNER REVIEW\nHead: ${old}` })],
  ...overrides,
});

test("refusal names a non-owner Approved move and next step", () => {
  const evidence = pr({ timeline: [move({ actor: actor(2) })] });
  expect(isOwnerApproved(evidence, filter(), "example/project")).toBe(false);
  expect(approvalRefusal(evidence, filter(), "example/project", "27")).toBe(
    `approval by ${actor(2).login} does not count (not an owner in people.yaml); ask an owner to approve after review 27 owner`
  );
});

test("refusal names a later bounce instead of an older head mismatch", () => {
  const evidence = pr({
    timeline: [
      move(),
      move({ status: "Executing", previousStatus: "Approved", createdAt: "2026-01-04T00:00:00Z" }),
    ],
  });
  expect(isOwnerApproved(evidence, filter(), "example/project")).toBe(false);
  expect(approvalRefusal(evidence, filter(), "example/project", "27")).toBe(
    "approval at 2026-01-03T00:00:00Z precedes a bounce to Executing; hand over again with review 27 owner"
  );
});

test.each(["board", "review", "autopilot"])(
  "refusal names old and current heads for %s approval",
  (kind) => {
    const evidence = pr(
      kind === "board"
        ? { timeline: [move()] }
        : kind === "review"
          ? {
              reviews: [
                {
                  author: actor(),
                  state: "APPROVED",
                  commit: { oid: old },
                  submittedAt: "2026-01-03T00:00:00Z",
                },
              ],
            }
          : {
              comments: [
                scopeComment({
                  body: `[orchestrator] AUTOPILOT APPROVED\n\nCurrent head: ${old}\n`,
                }),
              ],
            }
    );
    expect(isOwnerApproved(evidence, filter(), "example/project")).toBe(false);
    expect(approvalRefusal(evidence, filter(), "example/project", "27")).toBe(
      `head moved from ${old} to ${sha} since approval; use --carry-approval if only base merges`
    );
  }
);

test("scope refusal explains Backlog to Executing", () => {
  const timeline = [scopeMove({ status: "Executing", previousStatus: "Backlog" })];
  expect(scopeApproved(scopeIssue(), [], timeline, config, filter(), 0)).toBe(false);
  expect(scopeRefusal(scopeIssue(), [], timeline, config, filter())).toBe(
    "Backlog → Executing is not a scope approval; move it Scoping → Executing, or run scope-review"
  );
});

test("scope refusal names the latest shortcut-voiding comment over an older Backlog move", () => {
  const timeline = [scopeMove({ status: "Executing", previousStatus: "Backlog" })];
  const comments = [
    scopeComment({
      author: actor(),
      url: "https://github.com/example/project/issues/9#issuecomment-1",
      createdAt: "2026-01-04T00:00:00Z",
    }),
  ];
  expect(scopeApproved(scopeIssue(), comments, timeline, config, filter(), 0)).toBe(false);
  expect(scopeRefusal(scopeIssue(), comments, timeline, config, filter())).toBe(
    `the trivial shortcut is void: comment ${String(comments[0].url)} by ${actor().login}; run scope-review ${String(scopeIssue().number)} <file>`
  );
});

test("scope refusal names the body editor and time after approval", () => {
  const issue = scopeIssue({
    body: "Changed",
    editor: actor(2),
    lastEditedAt: "2026-01-04T00:00:00Z",
  });
  const comments = [
    scopeComment({
      body: `[orchestrator] SCOPE REVIEW\n\nbody sha256: ${bodyHash("Final scope")}`,
    }),
  ];
  const timeline = [scopeMove({ status: "Executing", previousStatus: "Spec review" })];
  expect(scopeApproved(issue, comments, timeline, config, filter(), 0)).toBe(false);
  expect(scopeRefusal(issue, comments, timeline, config, filter())).toBe(
    `scope approval is stale: issue body edited by ${actor(2).login} at 2026-01-04T00:00:00Z after approval; run scope-review ${String(issue.number)} <file>`
  );
});

test("keyword refusal quotes phrase and reference with a remedy", () => {
  expect(() => guardClosingKeywords("This is part of #9")).toThrow(
    'forbidden closing keyword: "part of" + #9; rephrase without a closing or association keyword before the reference'
  );
});

test("newer non-owner approval takes precedence over a bounce; unpinned login is not authority", () => {
  const evidence = pr({
    timeline: [
      move(),
      move({ status: "Executing", previousStatus: "Approved", createdAt: "2026-01-04T00:00:00Z" }),
      move({ actor: { ...actor(), databaseId: 99999 }, createdAt: "2026-01-05T00:00:00Z" }),
    ],
  });
  expect(isOwnerApproved(evidence, filter(), "example/project")).toBe(false);
  expect(approvalRefusal(evidence, filter(), "example/project", "27")).toContain(
    `approval by ${actor().login} does not count (not an owner in people.yaml)`
  );
});

test("missing actors and dates do not fabricate a specific approval diagnosis", () => {
  const evidence = pr({ timeline: [move({ actor: null, createdAt: "invalid" })] });
  expect(isOwnerApproved(evidence, filter(), "example/project")).toBe("unknown");
  expect(approvalRefusal(evidence, filter(), "example/project", "27")).toBe(
    "Owner approval is missing or cannot be verified for current head; hand over with review 27 owner"
  );
});

test("shortcut refusal identifies the effective editor without reading their body", () => {
  const comment = scopeComment({
    url: "https://github.com/example/project/issues/8#issuecomment-2",
    lastEditedAt: "2026-01-05T00:00:00Z",
    editor: actor(),
    body: undefined,
  });
  expect(scopeRefusal(scopeIssue(), [comment], [], config, filter())).toContain(
    `comment ${String(comment.url)} by ${actor().login}`
  );
});
