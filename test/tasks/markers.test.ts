import { expect, test } from "vitest";
import type { ObjectData } from "../../src/gateway/people.js";
import {
  autopilotCopyProof,
  closingIssueNumbers,
  holdBanner,
  isTaskPrompt,
  legacyIssueHeaders,
  setHeaderPart,
  taskHeader,
  taskHeld,
  taskIssues,
  taskIssueNumbers,
  taskModelOverride,
  taskRelation,
  trailingTaskMarker,
  updateTaskMarker,
  withAutopilotCopyProof,
  withoutHold,
} from "../../src/tasks/markers.js";

// The body table characterizes every former reader of the task markers: the
// relation decoder (taskRelation), the issue-number decoder (taskIssueNumbers),
// isTaskPrompt, the model-override decoder, the metadata reader's own header read
// (taskHeader with server's options), the legacy headers, the merge relation
// (taskIssues with the watcher's report) and the native closing references
// (closingIssueNumbers), plus the hold test (taskHeld).
const repo = "example/project";
const relation = { issues: [8], part: false };

interface Row {
  name: string;
  title?: string;
  body: string;
  references?: ObjectData;
  relation?: { issues: number[]; part: boolean } | "throws";
  issueNumbers?: number[] | undefined;
  prompt?: boolean;
  override?: { from: string; to: string; reason: string } | undefined | "throws";
  metadata?: number | undefined;
  legacy?: number[] | "throws";
  issues?: number[] | "throws";
  reports?: string[];
  closing?: number[] | "throws";
  held?: boolean;
}

const rows: Row[] = [
  {
    name: "open-task template body: header, marker, no native links",
    body: '# Task: feat: markers (issue #8)\n\nvmethod 0.0.0-dev\n\n## Task specification\n\nRefactor the readers.\n\n<!-- vmethod-task {"issues":[8]} -->',
    relation,
    issueNumbers: [8],
    prompt: true,
    metadata: 8,
    legacy: [],
    issues: [8],
    reports: [],
    closing: [],
    held: false,
  },
  {
    name: "part-of header and part marker complete nothing",
    body: '# Task: feat: markers (part of issue #8)\n\n<!-- vmethod-task {"issues":[8],"part":true} -->',
    relation: { issues: [8], part: true },
    issueNumbers: [8],
    prompt: true,
    metadata: 8,
    legacy: [],
    issues: [],
    reports: [],
    closing: [],
    held: false,
  },
  {
    name: "direct task: marker only, no issues",
    body: 'Task text\n\n<!-- vmethod-task {"issues":[]} -->',
    relation: { issues: [], part: false },
    issueNumbers: [],
    prompt: true,
    metadata: undefined,
    legacy: [],
    issues: [],
    reports: [],
    closing: [],
    held: false,
  },
  {
    name: "header only, no marker",
    body: "# Task: fix: widgets (issue #9)\n",
    relation: { issues: [9], part: false },
    issueNumbers: [9],
    prompt: true,
    metadata: 9,
    legacy: [],
    issues: [9],
    reports: [],
    closing: [],
    held: false,
  },
  {
    name: "text after the reference: only the metadata reader accepts",
    body: "# Task: fix: widgets (issue #9) and trailing text\n",
    relation: undefined,
    issueNumbers: undefined,
    prompt: false,
    metadata: 9,
    legacy: [],
    issues: [],
    reports: ["no linked issue"],
    closing: [],
    held: false,
  },
  {
    name: "empty title: the relation reader accepts, the issue-number reader refuses",
    body: "# Task:  (issue #8)\n",
    relation,
    issueNumbers: undefined,
    prompt: false,
    metadata: 8,
    legacy: [],
    issues: [8],
    reports: [],
    closing: [],
    held: false,
  },
  {
    name: "header below the first line: the any-line readers accept",
    body: "Introduction prose.\n\n# Task: fix: widgets (issue #9)\n",
    relation: undefined,
    issueNumbers: [9],
    prompt: true,
    metadata: 9,
    legacy: [],
    issues: [],
    reports: ["no linked issue"],
    closing: [],
    held: false,
  },
  {
    name: "two references on one line: greedy readers take the last, metadata the first",
    body: "# Task: delivery (issue #9) (issue #8)\n",
    relation: { issues: [8], part: false },
    issueNumbers: [8],
    prompt: true,
    metadata: 9,
    legacy: [],
    issues: [8],
    reports: [],
    closing: [],
    held: false,
  },
  {
    name: "no separator space: only the metadata reader accepts",
    body: "# Task:(issue #8)\n",
    relation: undefined,
    issueNumbers: undefined,
    prompt: false,
    metadata: 8,
    legacy: [],
    issues: [],
    reports: ["no linked issue"],
    closing: [],
    held: false,
  },
  {
    name: "legacy headers",
    body: "Pre-adoption PR.\n\nCloses #12\n\nAgent task for #13\n",
    relation: undefined,
    issueNumbers: undefined,
    prompt: false,
    metadata: undefined,
    legacy: [12, 13],
    issues: [12, 13],
    reports: ["legacy link: using pre-adoption issue relation"],
    closing: [],
    held: false,
  },
  {
    name: "legacy headers: quoted, bold and lowercase all match",
    body: "> Closes #3\n\n**Agent task for #4**\n\ncloses #5\n",
    relation: undefined,
    issueNumbers: undefined,
    prompt: false,
    metadata: undefined,
    legacy: [3, 4, 5],
    issues: [3, 4, 5],
    reports: ["legacy link: using pre-adoption issue relation"],
    closing: [],
    held: false,
  },
  {
    name: "a prose dependency line completes nothing (D2)",
    body: "Some prose.\n\nPart of #8\n",
    relation: undefined,
    issueNumbers: undefined,
    prompt: false,
    metadata: undefined,
    legacy: [],
    issues: [],
    reports: [],
    closing: [],
    held: false,
  },
  {
    name: "the structured marker wins over prose and native links",
    body: '# Task: feat: markers (issue #8)\n\nPart of #9\n\nCloses #10\n\n<!-- vmethod-task {"issues":[8]} -->',
    relation,
    issueNumbers: [8],
    prompt: true,
    metadata: 8,
    legacy: [10],
    issues: [8],
    reports: [],
    closing: [],
    held: false,
  },
  {
    name: "malformed marker JSON: strict readers reject, lenient readers ignore",
    body: "<!-- vmethod-task {issues:[8]} -->",
    relation: "throws",
    issueNumbers: undefined,
    prompt: false,
    override: undefined,
    metadata: undefined,
    legacy: [],
    issues: "throws",
    closing: [],
    held: false,
  },
  {
    name: "marker issue below one: the relation rejects, lenient readers ignore",
    body: '<!-- vmethod-task {"issues":[0]} -->',
    relation: "throws",
    issueNumbers: undefined,
    prompt: false,
    metadata: undefined,
    legacy: [],
    issues: "throws",
    closing: [],
    held: false,
  },
  {
    name: "non-boolean part flag: the relation rejects, lenient readers ignore",
    body: '<!-- vmethod-task {"issues":[8],"part":"yes"} -->',
    relation: "throws",
    issueNumbers: undefined,
    prompt: false,
    metadata: undefined,
    legacy: [],
    issues: "throws",
    closing: [],
    held: false,
  },
  {
    name: "carriage return inside the marker payload: only the relation reader tolerates it",
    body: '<!-- vmethod-task {"issues":[8]\r} -->',
    relation,
    issueNumbers: undefined,
    prompt: false,
    override: undefined,
    metadata: undefined,
    legacy: [],
    issues: [8],
    reports: [],
    closing: [],
    held: false,
  },
  {
    name: "model override in the marker",
    body: '<!-- vmethod-task {"issues":[8],"modelOverride":{"from":"glm","to":"sol","reason":"tier"}} -->',
    relation,
    issueNumbers: [8],
    prompt: true,
    override: { from: "glm", to: "sol", reason: "tier" },
    metadata: undefined,
    legacy: [],
    issues: [8],
    reports: [],
    closing: [],
    held: false,
  },
  {
    name: "invalid model override: the override reader rejects, the relation still decodes",
    body: '<!-- vmethod-task {"issues":[8],"modelOverride":{"from":"glm","to":"sol"}} -->',
    relation,
    issueNumbers: [8],
    prompt: true,
    override: "throws",
    metadata: undefined,
    legacy: [],
    issues: [8],
    reports: [],
    closing: [],
    held: false,
  },
  {
    name: "two markers: the relation reads the first",
    body: '<!-- vmethod-task {"issues":[7]} -->\n\nprompt text\n\n<!-- vmethod-task {"issues":[8]} -->',
    relation: { issues: [7], part: false },
    issueNumbers: [7],
    prompt: true,
    metadata: undefined,
    legacy: [],
    issues: [7],
    reports: [],
    closing: [],
    held: false,
  },
  {
    name: "hold banner: held, and the relation still decodes",
    body: `${holdBanner}\n\n<!-- vmethod-task {"issues":[8]} -->`,
    relation,
    issueNumbers: [8],
    prompt: true,
    metadata: undefined,
    legacy: [],
    issues: [8],
    reports: [],
    closing: [],
    held: true,
  },
  {
    name: "hold title prefix with only prose mentions of the banner",
    title: "[HOLD: waiting for #24] feat: follow-up",
    body: 'Prose about ON HOLD and [HOLD: examples].\n\n<!-- vmethod-task {"issues":[]} -->',
    relation: { issues: [], part: false },
    issueNumbers: [],
    prompt: true,
    metadata: undefined,
    legacy: [],
    issues: [],
    reports: [],
    closing: [],
    held: true,
  },
  {
    name: "quoted prose is not a hold",
    body: 'Prose about ON HOLD and [HOLD: examples].\n\n<!-- vmethod-task {"issues":[]} -->',
    relation: { issues: [], part: false },
    issueNumbers: [],
    prompt: true,
    metadata: undefined,
    legacy: [],
    issues: [],
    reports: [],
    closing: [],
    held: false,
  },
  {
    name: "native closing references beat legacy headers",
    body: "Closes #12\n",
    references: {
      nodes: [{ number: 7, repository: { nameWithOwner: repo } }],
      pageInfo: { hasNextPage: false },
    },
    relation: undefined,
    issueNumbers: undefined,
    prompt: false,
    metadata: undefined,
    legacy: [12],
    issues: [7],
    reports: ["legacy link: using pre-adoption issue relation"],
    closing: [7],
    held: false,
  },
  {
    name: "foreign-repository nodes are excluded, not errors",
    body: "",
    references: {
      nodes: [
        { number: 7, repository: { nameWithOwner: "other/repo" } },
        { number: 6, repository: { nameWithOwner: repo } },
      ],
      pageInfo: { hasNextPage: false },
    },
    relation: undefined,
    issueNumbers: undefined,
    prompt: false,
    metadata: undefined,
    legacy: [],
    issues: [6],
    reports: ["legacy link: using pre-adoption issue relation"],
    closing: [6],
    held: false,
  },
  {
    name: "incomplete native connection: the two native readers disagree",
    body: "Closes #12\n",
    references: {
      nodes: [{ number: 12, repository: { nameWithOwner: repo } }],
      pageInfo: { hasNextPage: true },
    },
    relation: undefined,
    issueNumbers: undefined,
    prompt: false,
    metadata: undefined,
    legacy: [12],
    issues: "throws",
    closing: "throws",
    held: false,
  },
];

const outcome = (decode: () => unknown, expected: unknown) => {
  if (expected === "throws") {
    expect(decode).toThrow();
  } else {
    expect(decode()).toEqual(expected);
  }
};

test.each(rows)("$name", (row) => {
  outcome(() => taskRelation(row.body), row.relation);
  outcome(() => taskIssueNumbers(row.body), row.issueNumbers);
  expect(isTaskPrompt(row.body)).toBe(row.prompt);
  outcome(() => taskModelOverride(row.body), row.override);
  outcome(
    () => taskHeader(row.body, { anchor: "any line", title: "any text", end: "anywhere" })?.issue,
    row.metadata
  );
  outcome(() => legacyIssueHeaders(row.body), row.legacy);
  const item: ObjectData = {
    body: row.body,
    closingIssuesReferences: row.references ?? { nodes: [], pageInfo: { hasNextPage: false } },
  };
  const reports: string[] = [];
  outcome(() => taskIssues(item, repo, (line) => reports.push(line)), row.issues);
  if (row.issues !== "throws") {
    expect(reports).toEqual(row.reports ?? []);
  }
  outcome(() => [...closingIssueNumbers(item, repo)], row.closing);
  expect(taskHeld(row.title ?? "feat: delivery", row.body)).toBe(row.held);
});

test.each([
  ["Invalid task header issue", () => taskRelation("# Task: t (issue #99999999999999999999)\n")],
  [
    "Invalid partial task relation",
    () => taskRelation('<!-- vmethod-task {"issues":[8],"part":"yes"} -->'),
  ],
  ["Invalid task issue relation", () => taskRelation('<!-- vmethod-task {"issues":[0]} -->')],
  [
    "Invalid task model override",
    () => taskModelOverride('<!-- vmethod-task {"issues":[8],"modelOverride":{}} -->'),
  ],
  ["Invalid legacy issue link", () => legacyIssueHeaders("Closes #99999999999999999999")],
  [
    "Invalid legacy issue link",
    () =>
      taskIssues(
        {
          body: "",
          closingIssuesReferences: {
            nodes: [{ repository: { nameWithOwner: repo } }],
            pageInfo: { hasNextPage: false },
          },
        },
        repo,
        () => {}
      ),
  ],
  [
    "Too many legacy issue links",
    () =>
      taskIssues(
        { body: "", closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: true } } },
        repo,
        () => {}
      ),
  ],
  [
    "Missing or incomplete closing issue references",
    () => closingIssueNumbers({ closingIssuesReferences: {} }, repo),
  ],
  [
    "Invalid closing issue reference",
    () =>
      closingIssueNumbers(
        {
          closingIssuesReferences: {
            nodes: [{ number: 0, repository: { nameWithOwner: repo } }],
            pageInfo: { hasNextPage: false },
          },
        },
        repo
      ),
  ],
])("the wrapped refusals keep their exact text: %s", (message, decode) => {
  expect(decode).toThrow(message);
});

test("malformed marker JSON fails the strict reads loudly and is ignored by the lenient ones", () => {
  const body = "<!-- vmethod-task {issues:[8]} -->";
  expect(() => taskRelation(body)).toThrow();
  expect(() => trailingTaskMarker(body)).toThrow();
  expect(taskIssueNumbers(body)).toBeUndefined();
  expect(taskModelOverride(body)).toBeUndefined();
});

test("the structured marker must end the body for merge's scope-exception read", () => {
  const body =
    'Task text\n\n<!-- vmethod-task {"issues":[8],"scopeException":"pre-approved"} -->\n';
  expect(trailingTaskMarker(body)).toEqual({ issues: [8], scopeException: "pre-approved" });
  expect(trailingTaskMarker(body)?.scopeException).toBe("pre-approved");
  expect(trailingTaskMarker('<!-- vmethod-task {"issues":[8]} --> middle')).toBeUndefined();
  expect(trailingTaskMarker("no marker")).toBeUndefined();
  expect(
    trailingTaskMarker(
      '<!-- vmethod-task {"scopeException":"x"} -->\ntext\n<!-- vmethod-task {"issues":[8]} -->'
    )?.scopeException
  ).toBeUndefined();
});

test("setHeaderPart rewrites only the first-line header's part-of prefix", () => {
  const body = "# Task: feat: task (part of issue #8)\n\nprompt\n";
  expect(setHeaderPart(body, false)).toBe("# Task: feat: task (issue #8)\n\nprompt\n");
  expect(setHeaderPart(setHeaderPart(body, false), true)).toBe(body);
  // The header must be the body's first line; elsewhere it stays untouched.
  expect(setHeaderPart("Intro\n# Task: feat: task (issue #8)\n", true)).toBe(
    "Intro\n# Task: feat: task (issue #8)\n"
  );
  expect(setHeaderPart("# Task: t (issue #8) trailing\n", true)).toBe(
    "# Task: t (part of issue #8) trailing\n"
  );
});

test("updateTaskMarker rewrites the last marker, preserving its other fields", () => {
  const body =
    'Example: <!-- vmethod-task {"issues":[999],"part":true} -->\n\nprompt\n<!-- vmethod-task {"issues":[8]} -->';
  const updated = updateTaskMarker(body, [8], true);
  expect(updated).toContain('Example: <!-- vmethod-task {"issues":[999],"part":true} -->');
  expect(updated).toContain('<!-- vmethod-task {"issues":[8],"part":true} -->');
  expect(updateTaskMarker("no markers", [8], true)).toBe("no markers");
});

test("the autopilot copy proof decodes only immediately before the trailing marker", () => {
  const body =
    '<!-- vmethod-autopilot-copy {"event":"copy","source":"grant"} -->\n<!-- vmethod-task {"issues":[8]} -->';
  expect(autopilotCopyProof(body)).toEqual({ event: "copy", source: "grant" });
  expect(
    autopilotCopyProof('<!-- vmethod-autopilot-copy {"event":"copy","source":"grant"} -->\n')
  ).toBeUndefined();
  expect(autopilotCopyProof('Task\n\n<!-- vmethod-task {"issues":[8]} -->')).toBeUndefined();
  expect(
    autopilotCopyProof(
      '<!-- vmethod-autopilot-copy {"event":8,"source":"grant"} -->\n<!-- vmethod-task {"issues":[8]} -->'
    )
  ).toBeUndefined();
  expect(
    autopilotCopyProof(
      '<!-- vmethod-autopilot-copy {broken} -->\n<!-- vmethod-task {"issues":[8]} -->'
    )
  ).toBeUndefined();
});

test("withAutopilotCopyProof anchors the proof on the trailing marker only", () => {
  const body = 'Task text\n\n<!-- vmethod-task {"issues":[8]} -->\n';
  expect(withAutopilotCopyProof(body, { event: "copy", source: "grant" })).toBe(
    'Task text\n\n<!-- vmethod-autopilot-copy {"event":"copy","source":"grant"} -->\n\n<!-- vmethod-task {"issues":[8]} -->\n'
  );
  expect(
    withAutopilotCopyProof("no trailing marker <!-- vmethod-task -->", {
      event: "event",
      source: "grant",
    })
  ).toBe("no trailing marker <!-- vmethod-task -->");
});

test("a hold is exactly the banner or the title prefix, never quoted prose (D9)", () => {
  expect(taskHeld("feat: t", `${holdBanner}\nbody`)).toBe(true);
  expect(taskHeld("[HOLD] feat: t", "body")).toBe(true);
  expect(taskHeld("[hold: x] feat: t", "body")).toBe(true);
  expect(taskHeld("feat: t", `Prose about ON HOLD and [HOLD: examples].\nbody`)).toBe(false);
  expect(taskHeld("feat: t", `quoted ${holdBanner}`)).toBe(false);
  expect(withoutHold("[HOLD: x] feat: t", `${holdBanner}\nbody`)).toEqual({
    title: "feat: t",
    body: "body",
  });
  expect(withoutHold("feat: t", `Prose mentioning ${holdBanner} in prose`)).toEqual({
    title: "feat: t",
    body: `Prose mentioning ${holdBanner} in prose`,
  });
});
