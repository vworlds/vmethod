import { expect, test } from "vitest";
import { testConfig } from "../config.js";
import { bodyHash, scopeApproved } from "../../src/evidence/scope.js";
import { autopilotStates } from "../../src/evidence/autopilot.js";
import { PeopleFilter, type ObjectData } from "../../src/gateway/people.js";
import { Digest } from "../../src/gateway/digest.js";
import { fixture } from "../helpers.js";
import { actor, people } from "../gateway/helpers.js";
import { scopeComment, scopeIssue, scopeMove } from "../gateway/scope-fixture.js";

const review = scopeComment({
  body: `[orchestrator] SCOPE REVIEW\n\nbody sha256: ${bodyHash("Final scope")}`,
});
const move = scopeMove({ previousStatus: "Spec review", status: "Executing" });
const peer = {
  login: "foreign-peer",
  id: 105,
  type: "User",
  role: "orchestrator",
  repos: ["example/other"],
} as const;
const rows: {
  name: string;
  issue?: ObjectData;
  comments?: ObjectData[];
  timeline?: ObjectData[];
  fast?: string[];
  delegated?: boolean;
  expected: boolean;
}[] = [
  { name: "S1 #138 matching review then owner move", expected: true },
  {
    name: "S2 #359 body edit voids hash",
    issue: scopeIssue({ body: "Changed scope" }),
    expected: false,
  },
  {
    name: "S1 #138 non-owner move fails",
    timeline: [{ ...move, actor: actor(2) }],
    expected: false,
  },
  {
    name: "S1 #138 move before review fails",
    timeline: [{ ...move, createdAt: "2026-01-01T00:00:00Z" }],
    expected: false,
  },
  {
    name: "S1 #138 trivial trusted discussion",
    comments: [scopeComment({ body: "A small change" })],
    timeline: [{ ...move, previousStatus: "Scoping" }],
    expected: true,
  },
  {
    name: "S3 #186 peer orchestrator voids shortcut",
    comments: [
      scopeComment({ author: { login: peer.login, databaseId: peer.id, __typename: peer.type } }),
    ],
    timeline: [{ ...move, previousStatus: "Scoping" }],
    expected: false,
  },
  {
    name: "S3 #138 unknown comment voids shortcut",
    comments: [scopeComment({ author: null })],
    timeline: [{ ...move, previousStatus: "Scoping" }],
    expected: false,
  },
  {
    name: "S1 #138 fastPath label with matching hash",
    issue: scopeIssue({ labels: { nodes: [{ name: "trivial" }] } }),
    fast: ["trivial"],
    timeline: [],
    expected: true,
  },
  {
    name: "S2 #359 fastPath cannot bypass changed body",
    issue: scopeIssue({ body: "changed", labels: { nodes: [{ name: "trivial" }] } }),
    fast: ["trivial"],
    timeline: [],
    expected: false,
  },
  {
    name: "S1 #244 delegated matching review",
    comments: [{ ...review, body: `${review.body}\nAutopilot: scope approved.` }],
    timeline: [],
    delegated: true,
    expected: true,
  },
  {
    name: "S1 #244 delegated review without grant fails",
    comments: [{ ...review, body: `${review.body}\nAutopilot: scope approved.` }],
    timeline: [],
    delegated: false,
    expected: false,
  },
];

test("scope characterization table is non-empty", () => expect(rows.length).toBeGreaterThan(0));

test("historical Approved moves never grant scope approval", () => {
  const filter = new PeopleFilter(
    people,
    "example",
    new Digest({ XDG_STATE_HOME: fixture() }, "scope-no-grandfather", () => 0)
  );
  expect(
    scopeApproved(
      scopeIssue(),
      [review],
      [scopeMove({ previousStatus: "Backlog", status: "Approved" })],
      testConfig({ board: { number: 1 } }),
      filter
    )
  ).toBe(false);
});
test.each(rows)("$name", (row) => {
  const filter = new PeopleFilter(
    [...people, { ...peer, repos: [...peer.repos] }],
    "example",
    new Digest({ XDG_STATE_HOME: fixture() }, "scope-table", () => 0)
  );
  const issue = row.issue ?? scopeIssue();
  const delegation = autopilotStates(
    [
      {
        item: scopeIssue({
          id: "delegated",
          number: 8,
          labels: {
            nodes: row.delegated ? [{ name: "autopilot" }] : [],
            pageInfo: { hasNextPage: false },
          },
        }),
        events: row.delegated
          ? [
              {
                __typename: "LabeledEvent",
                id: "grant",
                label: { name: "autopilot" },
                actor: actor(),
                createdAt: "2026-01-01T00:00:00Z",
              },
            ]
          : [],
      },
    ],
    filter,
    "example/project"
  ).get("delegated");
  expect(
    scopeApproved(
      issue,
      row.comments ?? [review],
      row.timeline ?? [move],
      testConfig({ board: { number: 1 }, scope: { fastPath: row.fast ?? [] } }),
      filter,
      delegation
    )
  ).toBe(row.expected);
});
