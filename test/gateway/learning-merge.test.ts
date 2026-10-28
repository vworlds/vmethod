import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { stringify } from "yaml";
import { getConfig } from "../../src/config.js";
import { createGateway } from "../../src/gateway/server.js";
import { learningsVerb } from "../../src/cli/learnings.js";
import { fixtureServer, type Request } from "./helpers.js";

const central = "vworlds/vmethod";
const prefix = `/repos/${central}`;
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const mergeSha = "c".repeat(40);
const author = { login: "vimescmd", id: 303, type: "User" };
const person = { ...author, role: "orchestrator", repos: [central] };
const viewer = { login: author.login, databaseId: author.id, __typename: author.type };
const actionsBot = {
  login: "github-actions[bot]",
  id: 41898282,
  type: "Bot",
  role: "system",
  appIds: [909],
  events: ["check_run"],
};

const pull = (overrides: Record<string, unknown> = {}) => ({
  state: "open",
  title: "docs: share project learnings",
  user: author,
  changed_files: 1,
  labels: [{ name: "learning" }],
  head: {
    sha: headSha,
    ref: "learnings/vworlds-vmethod-x",
    repo: { full_name: "vimescmd/vmethod" },
  },
  base: { ref: "dev", sha: baseSha, repo: { full_name: central } },
  ...overrides,
});
const metadata = (value: Record<string, unknown> = pull()) => ({
  path: `${prefix}/pulls/47`,
  method: "GET",
  json: value,
});
const registry = (peopleList = [person]) => ({
  path: `${prefix}/contents/people.yaml?ref=${baseSha}`,
  method: "GET",
  json: {
    type: "file",
    path: "people.yaml",
    encoding: "base64",
    content: Buffer.from(stringify(peopleList)).toString("base64"),
  },
});
const files = (
  values = [
    { filename: "learnings/models/vworlds-vmethod/14-36-abcdef012345.jsonl", status: "added" },
  ]
) => ({
  path: `${prefix}/pulls/47/files?per_page=100&page=1`,
  method: "GET",
  json: values,
});
const runs = (values: Record<string, unknown>[]) => ({
  path: `${prefix}/commits/${headSha}/check-runs?filter=all&per_page=100&page=1`,
  method: "GET",
  json: { check_runs: values },
});
const run = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  name: "check",
  head_sha: headSha,
  app: { id: 909 },
  status: "completed",
  conclusion: "success",
  ...overrides,
});
const merge = (json: Record<string, unknown>) => ({
  path: `${prefix}/pulls/47/merge`,
  method: "PUT",
  body: { sha: headSha, merge_method: "squash", commit_title: `${pull().title} (#47)` },
  json,
});
const orchestratorEnv = () => ({ VMETHOD_ROLE: "orchestrator" }) as NodeJS.ProcessEnv;

function centralFixture(requests: Request[], patches: Record<string, unknown> = {}) {
  const f = fixtureServer(requests, viewer);
  writeFileSync(
    join(f.root, "vmethod.yaml"),
    stringify({ ...getConfig(f.root, {}), repo: central, org: "vworlds", ...patches })
  );
  writeFileSync(join(f.root, "people.yaml"), stringify([person, actionsBot]));
  return { ...f, gateway: createGateway(f.root, f.env, f.deps) };
}

test("merge squashes an authorized, labeled, green learning PR and reports the commit", async () => {
  const f = centralFixture([
    metadata(),
    registry(),
    files(),
    metadata(),
    runs([run()]),
    metadata(),
    merge({
      merged: true,
      sha: mergeSha,
      message: "Pull Request successfully merged and squashed",
    }),
  ]);
  expect(await learningsVerb(f.gateway, ["merge", "47"], orchestratorEnv())).toBe(
    `Merged learning PR #47 at ${mergeSha}`
  );
  f.done();
});

test("merge refuses a closed learning PR before any other read or write", async () => {
  const f = centralFixture([metadata(pull({ state: "closed" }))]);
  await expect(learningsVerb(f.gateway, ["merge", "47"], orchestratorEnv())).rejects.toThrow(
    "not an open PR with valid head/base metadata"
  );
  f.done();
});

test.each([
  { name: "no labels", labels: [] as unknown[] },
  { name: "only autopilot", labels: [{ name: "autopilot" }] },
])("merge refuses a learning PR without the learning label: $name", async ({ labels }) => {
  const f = centralFixture([metadata(pull({ labels }))]);
  await expect(learningsVerb(f.gateway, ["merge", "47"], orchestratorEnv())).rejects.toThrow(
    "carries no learning label"
  );
  f.done();
});

test("merge refuses a submission whose registry binding authorizes another project", async () => {
  const f = centralFixture([
    metadata(),
    registry([{ ...person, repos: ["vworlds/vecs"] }]),
    files(),
    metadata(),
  ]);
  await expect(learningsVerb(f.gateway, ["merge", "47"], orchestratorEnv())).rejects.toThrow(
    "Learning PR denied: author/project binding or changed paths do not match"
  );
  f.done();
});

test("merge refuses a submission touching paths outside authorized project directories", async () => {
  const f = centralFixture([
    metadata(),
    registry(),
    files([{ filename: "src/hostile.ts", status: "added" }]),
    metadata(),
  ]);
  await expect(learningsVerb(f.gateway, ["merge", "47"], orchestratorEnv())).rejects.toThrow(
    "Learning PR denied: author/project binding or changed paths do not match"
  );
  f.done();
});

test("merge refuses a red check job", async () => {
  const f = centralFixture([
    metadata(),
    registry(),
    files(),
    metadata(),
    runs([run({ conclusion: "failure" })]),
  ]);
  await expect(learningsVerb(f.gateway, ["merge", "47"], orchestratorEnv())).rejects.toThrow(
    `check job is not green on ${headSha.slice(0, 8)}: failure`
  );
  f.done();
});

test("merge refuses when no trusted application reports the check job", async () => {
  const f = centralFixture([
    metadata(),
    registry(),
    files(),
    metadata(),
    runs([run({ app: { id: 666 } })]),
  ]);
  await expect(learningsVerb(f.gateway, ["merge", "47"], orchestratorEnv())).rejects.toThrow(
    `has no trusted check verdict on ${headSha.slice(0, 8)}`
  );
  f.done();
});

test("merge refuses when the PR moves during validation", async () => {
  const f = centralFixture([metadata(), registry(), files(), metadata(pull({ state: "closed" }))]);
  await expect(learningsVerb(f.gateway, ["merge", "47"], orchestratorEnv())).rejects.toThrow(
    "moved during validation"
  );
  f.done();
});

test("merge refuses when the PR moves between validation and the merge pin", async () => {
  const moved = "d".repeat(40);
  const f = centralFixture([
    metadata(),
    registry(),
    files(),
    metadata(),
    runs([run()]),
    metadata(pull({ head: { ...pull().head, sha: moved } })),
  ]);
  await expect(learningsVerb(f.gateway, ["merge", "47"], orchestratorEnv())).rejects.toThrow(
    "moved during validation; retry"
  );
  f.done();
});

test("merge reports a refused merge and reconciles on retry", async () => {
  const f = centralFixture([
    metadata(),
    registry(),
    files(),
    metadata(),
    runs([run()]),
    metadata(),
    merge({ merged: false, sha: null, message: "Pull Request is not mergeable" }),
  ]);
  await expect(learningsVerb(f.gateway, ["merge", "47"], orchestratorEnv())).rejects.toThrow(
    "Learning merge was refused; re-run to reconcile state"
  );
  f.done();
});

test("merge is orchestrator-only for a worker session", async () => {
  const f = centralFixture([]);
  await expect(
    learningsVerb(f.gateway, ["merge", "47"], { ...f.env, VMETHOD_ROLE: "worker" })
  ).rejects.toThrow("Learning writes require orchestrator role");
  f.done();
});

test("merge runs only in the central repository", async () => {
  const f = fixtureServer([]);
  await expect(learningsVerb(f.gateway, ["merge", "47"], orchestratorEnv())).rejects.toThrow(
    "Learning PR merges run only in the central repository"
  );
  f.done();
});

test.each([
  [["merge"], "Usage: learnings merge <pr> (central repository)"],
  [["merge", "0"], "Usage: learnings merge <pr> (central repository)"],
  [["merge", "47", "--extra"], "Usage: learnings merge <pr> (central repository)"],
])("merge CLI parses %j strictly", async (args, message) => {
  const f = centralFixture([]);
  await expect(learningsVerb(f.gateway, args, orchestratorEnv())).rejects.toThrow(message);
  f.done();
});

test("merge validates the PR number at the gateway", async () => {
  const f = centralFixture([]);
  await expect(
    f.gateway.call("learnings", { action: "merge", pr: 0 }, { role: "orchestrator" })
  ).rejects.toThrow("Invalid learning PR number");
  f.done();
});

test("merge succeeds when the registry pins several project bindings", async () => {
  const f = centralFixture([
    metadata(),
    registry(),
    files([{ filename: "learnings/notes/vmethod/2026-10-28-abcdef012345.md", status: "added" }]),
    metadata(),
    runs([run()]),
    metadata(),
    merge({ merged: true, sha: mergeSha }),
  ]);
  expect(await learningsVerb(f.gateway, ["merge", "47"], orchestratorEnv())).toBe(
    `Merged learning PR #47 at ${mergeSha}`
  );
  f.done();
});
