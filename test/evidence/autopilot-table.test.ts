import { expect, test } from "vitest";
import { autopilotStates } from "../../src/evidence/autopilot.js";
import { PeopleFilter, type ObjectData } from "../../src/gateway/people.js";
import { Digest } from "../../src/gateway/digest.js";
import { fixture } from "../helpers.js";
import { actor, people } from "../gateway/helpers.js";
import { scopeIssue } from "../gateway/scope-fixture.js";
import recording from "../fixtures/github/autopilot-wire.json" with { type: "json" };

// Same recorded label-event projection as autopilot.test.ts; only pins, IDs and times change.
function event(id: string, day: number, enabled = true, who = actor()): ObjectData {
  return {
    ...structuredClone(recording.data.repository.issue.timelineItems.nodes[enabled ? 0 : 1]),
    id,
    actor: who,
    label: { name: "autopilot" },
    createdAt: `2026-01-0${day}T00:00:00Z`,
  };
}
function record(id: string, events: ObjectData[], present = true, proof = false) {
  return {
    item: scopeIssue({
      id,
      number: id === "issue" ? 8 : 27,
      __typename: id === "issue" ? "Issue" : "PullRequest",
      labels: { nodes: present ? [{ name: "autopilot" }] : [], pageInfo: { hasNextPage: false } },
      body: `${proof ? '<!-- vmethod-autopilot-copy {"event":"copy","source":"grant"} -->\n\n' : ""}<!-- vmethod-task {"issues":[8]} -->`,
    }),
    events,
  };
}
const grant = event("grant", 1);
const copy = event("copy", 2, true, actor(2));
const stop = event("stop", 3, false);
const source = record("issue", [grant]);
const rows = [
  {
    name: "S7 #244 owner label grant",
    records: [source],
    id: "issue",
    active: true,
    unauthorized: false,
    unknown: false,
    grant: "grant",
    history: [true, true, true, true],
  },
  {
    name: "S7 #244 non-owner addition",
    records: [record("issue", [event("other", 1, true, actor(1))])],
    id: "issue",
    active: false,
    unauthorized: true,
    unknown: false,
    grant: undefined,
    history: [false, false, false, false],
  },
  {
    name: "S7 #249 copied label with exact recorded proof",
    records: [source, record("pr", [copy], true, true)],
    id: "pr",
    active: true,
    unauthorized: false,
    unknown: false,
    grant: "grant",
    history: [true, true, true, true],
  },
  {
    name: "S7 #249 copied label without proof grants nothing",
    records: [source, record("pr", [copy])],
    id: "pr",
    active: false,
    unauthorized: true,
    unknown: false,
    grant: undefined,
    history: [false, false, false, false],
  },
  {
    name: "S7 #249 watcher cleanup of unauthorized copy does not revoke source",
    records: [source, record("pr", [copy, event("cleanup", 3, false, actor(2))], false)],
    id: "pr",
    active: true,
    unauthorized: false,
    unknown: false,
    grant: "grant",
    history: [true, true, true, true],
  },
  {
    name: "S7 #244 owner removal revokes copied task",
    records: [record("issue", [grant, stop], false), record("pr", [copy], true, true)],
    id: "pr",
    active: false,
    unauthorized: false,
    unknown: false,
    grant: undefined,
    history: [true, true, false, false],
  },
  {
    name: "S7 #244 non-owner re-add needs new owner grant",
    records: [record("issue", [grant, stop, event("readd", 4, true, actor(2))])],
    id: "issue",
    active: false,
    unauthorized: true,
    unknown: false,
    grant: undefined,
    history: [false, false, false, false],
  },
  {
    name: "S7 #244 fresh owner re-grant restores authority",
    records: [record("issue", [grant, stop, event("new-grant", 4)])],
    id: "issue",
    active: true,
    unauthorized: false,
    unknown: false,
    grant: "new-grant",
    history: [true, true, false, true],
  },
  {
    name: "S7 #253 missing source grant is unknown not unauthorized",
    records: [record("pr", [copy], true, true)],
    id: "pr",
    active: false,
    unauthorized: false,
    unknown: true,
    grant: undefined,
    history: [false, false, false, false],
  },
];

test("delegation characterization table is non-empty", () =>
  expect(rows.length).toBeGreaterThan(0));
test.each(rows)("$name", (row) => {
  const filter = new PeopleFilter(
    people,
    "example",
    new Digest({ XDG_STATE_HOME: fixture() }, "autopilot-table", () => 0)
  );
  const state = autopilotStates(structuredClone(row.records), filter, "example/project").get(
    row.id
  );
  expect(state).toBeDefined();
  expect({
    active: state!.active,
    unauthorized: state!.unauthorized,
    unknown: state!.unknown,
    grant: state!.grant,
  }).toEqual({
    active: row.active,
    unauthorized: row.unauthorized,
    unknown: row.unknown,
    grant: row.grant,
  });
  expect([1, 2, 3, 4].map((day) => state!.at(Date.parse(`2026-01-0${day}T00:00:00Z`)))).toEqual(
    row.history
  );
});
