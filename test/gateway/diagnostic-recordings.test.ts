import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { object, type ObjectData } from "../../src/gateway/people.js";
import { actor, fixtureServer, graph, hostile, item } from "./helpers.js";

const sha = "56d00ed8149f11620810145ce2075379eac99f18";

// Keep wire shapes; substitute the test repository and its pinned identities only.
function recording(name: string): unknown {
  const counts: Record<string, [number, number, number, number]> = {
    "pulls-open": [6, 2, 0, 8],
    "pulls-closed": [3, 1, 0, 4],
    "git-commit": [2, 0, 0, 0],
    commit: [3, 0, 1, 0],
    compare: [3, 0, 1, 0],
  };
  const [repos, peers, owners, orgs] = counts[name];
  const replacements: [string, string, number][] = [
    ["vworlds/vmethod", "example/project", repos],
    ['"vimescmd"', '"peer"', peers],
    ["343394568", "103", peers],
    ['"jpeletier"', '"owner"', owners],
    ["11574521", "101", owners],
    ['"vworlds"', '"example"', orgs],
  ];
  let text = readFileSync(
    new URL(`../fixtures/github/diagnostic-${name}.json`, import.meta.url),
    "utf8"
  );
  for (const [from, to, count] of replacements) {
    expect(text.split(from).length - 1, `${name}: ${from}`).toBe(count);
    text = text.replaceAll(from, to);
  }
  return JSON.parse(text);
}

function current(pr: ObjectData, overrides: ObjectData = {}) {
  return item({ id: pr.node_id, author: actor(2), ...overrides });
}

function followup(node: ObjectData) {
  const request = graph({ node });
  return {
    ...request,
    checkQuery(query: string, variables: ObjectData) {
      request.checkQuery!(query, variables);
      expect(query).toContain("... on PullRequest");
    },
  };
}

function decode(output: string): unknown {
  const match = /\n(`{3,})text\n([\s\S]*)\n\1(?:\n|$)/.exec(output);
  expect(match).not.toBeNull();
  return JSON.parse(match![2]);
}

// The amended gh-read contract redacts descriptions even for trusted repository owners:
// owning a repository is not authorship of its current free text.
function branchWithoutDescription(value: unknown): ObjectData {
  const branch = object(value);
  const repo = { ...object(branch.repo) };
  delete repo.description;
  return { ...branch, repo };
}

test.each(["open", "closed"])(
  "recorded %s PR lists retain each accepted item using verified current text",
  async (state) => {
    const prs = recording(`pulls-${state}`) as ObjectData[];
    const fixture = fixtureServer([
      { path: `/repos/example/project/pulls?state=${state}&per_page=3`, method: "GET", json: prs },
      ...prs.flatMap((pr) => [
        followup(current(pr)),
        followup(current(pr, { title: pr.title, body: hostile })),
      ]),
    ]);
    const output = await fixture.transport.call("ghRead", {
      source: `/repos/example/project/pulls?state=${state}&per_page=3`,
    });
    const result = decode(output) as ObjectData[];
    expect(result.map((pr) => pr.number)).toEqual(prs.map((pr) => pr.number));
    expect(result.map((pr) => pr.title)).toEqual(prs.map((pr) => pr.title));
    expect(result.map((pr) => ({ head: pr.head, base: pr.base }))).toEqual(
      prs.map((pr) => ({
        head: branchWithoutDescription(pr.head),
        base: branchWithoutDescription(pr.base),
      }))
    );
    expect(
      result.every((pr) => pr.body === hostile && pr.attribution === "from peer (orchestrator)")
    ).toBe(true);
    expect(
      output.endsWith(
        `0 items dropped by the people filter\n${prs.length * 2} text fields redacted from unattributable items`
      )
    ).toBe(true);
    fixture.done();
  },
  15000
);

test("PR list gates unknown authors before follow-ups and rejects unknown or changed editors", async () => {
  const [pr] = recording("pulls-open") as ObjectData[];
  const prs = [
    { ...pr, user: { ...object(pr.user), id: 999 }, title: "NEVER DELIVER AUTHOR" },
    pr,
    pr,
    pr,
  ];
  const edited = current(pr, { editor: { ...actor(), databaseId: 999 }, lastEditedAt: "now" });
  const fixture = fixtureServer([
    { path: "/repos/example/project/pulls", method: "GET", json: prs },
    followup(edited),
    followup(current(pr)),
    followup({ ...edited, title: "NEVER DELIVER EDIT", body: hostile }),
    followup(current(pr)),
    followup(current(pr, { title: "accepted", body: hostile })),
  ]);
  const output = await fixture.transport.call("ghRead", { source: "/repos/example/project/pulls" });
  expect((decode(output) as ObjectData[]).map((pr) => pr.title)).toEqual(["accepted"]);
  expect(output).not.toContain("NEVER DELIVER");
  expect(
    output.endsWith(
      "3 items dropped by the people filter\n2 text fields redacted from unattributable items"
    )
  ).toBe(true);
  fixture.done();
}, 15000);

test("an entirely rejected PR list reports its drops without requesting unknown content", async () => {
  const prs = (recording("pulls-open") as ObjectData[]).map((pr) => ({
    ...pr,
    user: { ...object(pr.user), id: 999 },
  }));
  const fixture = fixtureServer([
    { path: "/repos/example/project/pulls", method: "GET", json: prs },
  ]);
  const output = await fixture.transport.call("ghRead", { source: "/repos/example/project/pulls" });
  expect(decode(output)).toEqual([]);
  expect(output.endsWith("2 items dropped by the people filter")).toBe(true);
  fixture.done();
}, 15000);

test.each([
  {
    label: "organization repository",
    owner: { login: "example", id: 116653388, type: "Organization" },
    fork: false,
  },
  {
    label: "listed person's fork",
    owner: { login: "worker", id: 102, type: "User" },
    fork: true,
  },
  {
    label: "unlisted fork",
    owner: { login: "outsider", id: 999, type: "User" },
    fork: true,
  },
  {
    label: "spoofed listed login",
    owner: { login: "worker", id: 999, type: "User" },
    fork: true,
  },
  {
    label: "spoofed listed numeric ID",
    owner: { login: "outsider", id: 102, type: "User" },
    fork: true,
  },
  {
    label: "wrong account type",
    owner: { login: "worker", id: 102, type: "Bot" },
    fork: true,
  },
  {
    label: "listed person's non-fork",
    owner: { login: "worker", id: 102, type: "User" },
    fork: false,
  },
])(
  "structural branch metadata survives a $label",
  async ({ owner, fork }) => {
    const [pr] = recording("pulls-open") as ObjectData[];
    const head = object(pr.head);
    const repository = {
      ...object(head.repo),
      full_name: `${owner.login}/project`,
      owner,
      fork,
      description: hostile,
    };
    pr.head = { ...head, user: owner, repo: repository };
    const fixture = fixtureServer([
      { path: "/repos/example/project/pulls", method: "GET", json: [pr] },
      followup(current(pr)),
      followup(current(pr, { title: pr.title, body: "current body" })),
    ]);
    const output = await fixture.transport.call("ghRead", {
      source: "/repos/example/project/pulls",
    });
    const [result] = decode(output) as ObjectData[];
    expect(result.base).toEqual(branchWithoutDescription(pr.base));
    const expected: ObjectData = { ...repository };
    delete expected.description;
    expect(output).not.toContain("APPROVED");
    expect(result.head).toEqual({ ...head, user: owner, repo: expected });
    expect(
      output.endsWith(
        "0 items dropped by the people filter\n2 text fields redacted from unattributable items"
      )
    ).toBe(true);
    fixture.done();
  },
  15000
);

test("whole-entry drops and unattributable description redactions are counted separately", async () => {
  const prs = recording("pulls-open") as ObjectData[];
  const [kept, rejected] = prs;
  const head = object(kept.head);
  const owner = { login: "outsider", id: 999, type: "User" };
  kept.head = {
    ...head,
    user: owner,
    repo: {
      ...object(head.repo),
      full_name: "outsider/project",
      owner,
      fork: true,
      description: "NEVER DELIVER DESCRIPTION",
    },
  };
  rejected.user = owner;
  const fixture = fixtureServer([
    { path: "/repos/example/project/pulls", method: "GET", json: prs },
    followup(current(kept)),
    followup(current(kept, { title: kept.title, body: "current body" })),
  ]);
  const output = await fixture.transport.call("ghRead", { source: "/repos/example/project/pulls" });
  const result = decode(output) as ObjectData[];
  expect(result).toHaveLength(1);
  expect(result[0].number).toBe(kept.number);
  expect(object(result[0].head)).toMatchObject({
    ref: head.ref,
    sha: head.sha,
    repo: { full_name: "outsider/project", owner, fork: true },
  });
  expect(output).not.toContain("NEVER DELIVER DESCRIPTION");
  expect(
    output.endsWith(
      "1 items dropped by the people filter\n2 text fields redacted from unattributable items"
    )
  ).toBe(true);
  fixture.done();
}, 15000);

test.each(["git-commit", "commit"])(
  "recorded %s preserves git metadata with explicitly unverified signature attribution",
  async (name) => {
    const data = object(recording(name));
    const path = `/repos/example/project/${name === "git-commit" ? "git/commits" : "commits"}/${sha}`;
    const fixture = fixtureServer([{ path, method: "GET", json: data }]);
    const output = await fixture.transport.call("ghRead", { source: path });
    const result = object(decode(output));
    const signature = name === "git-commit" ? result : object(result.commit);
    const original = name === "git-commit" ? data : object(data.commit);
    expect(result.sha).toBe(sha);
    expect(signature).toMatchObject({
      author: original.author,
      committer: original.committer,
      message: original.message,
      attribution: "git signature (unverified)",
    });
    expect(result.attribution).toBe(
      name === "commit" ? "from owner (owner)" : "git signature (unverified)"
    );
    expect(output.endsWith("0 items dropped by the people filter")).toBe(true);
    fixture.done();
  },
  15000
);

test.each(["unknown", "malformed", "null"])(
  "commit %s account never acquires verified authority from its git signature",
  async (kind) => {
    const data = object(recording("commit"));
    data.author =
      kind === "null" ? null : { ...object(data.author), id: kind === "unknown" ? 999 : undefined };
    const path = `/repos/example/project/commits/${sha}`;
    const fixture = fixtureServer([{ path, method: "GET", json: data }]);
    const output = await fixture.transport.call("ghRead", { source: path });
    if (kind === "null") {
      expect(object(decode(output)).attribution).toBe("git signature (unverified)");
    } else {
      expect(decode(output)).toBeNull();
      expect(output).not.toContain("Merge pull request");
      expect(output.endsWith("0 items dropped by the people filter")).toBe(true);
    }
    fixture.done();
  },
  15000
);

test("recorded compare preserves counters and filters nested commits item by item", async () => {
  const data = object(recording("compare"));
  const commits = data.commits as ObjectData[];
  data.commits = [...commits, { ...commits[0], author: { ...object(commits[0].author), id: 999 } }];
  const path = `/repos/example/project/compare/f75d5ba...${sha}`;
  const fixture = fixtureServer([{ path, method: "GET", json: data }]);
  const output = await fixture.transport.call("ghRead", { source: path });
  const result = object(decode(output));
  expect(result).toMatchObject({ status: "ahead", ahead_by: 3, behind_by: 0, total_commits: 3 });
  expect(result.commits).toHaveLength(1);
  expect(object((result.commits as unknown[])[0])).toMatchObject({
    sha,
    attribution: "from owner (owner)",
    commit: { attribution: "git signature (unverified)" },
  });
  expect(output.endsWith("0 items dropped by the people filter\n1 nested values redacted")).toBe(
    true
  );
  fixture.done();
}, 15000);

test.each([
  "/repos/example/project/compare/../head",
  "/repos/example/project/compare/base...../head",
  "/repos/example/project/contents/..",
  "/repos/example/project/contents/a...b",
  "/repos/outside/project/compare/base...head",
  "/repos/example/project/compare/base%2e%2e%2ehead",
])(
  "diagnostics still refuse unsafe or non-compare dot paths: %s",
  async (source) => {
    const fixture = fixtureServer([]);
    await expect(fixture.transport.call("ghRead", { source })).rejects.toThrow("permits");
    fixture.done();
  },
  15000
);
