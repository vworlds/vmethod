import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { stringify } from "yaml";
import { getConfig } from "../../src/config.js";
import { GitHubClient } from "../../src/gateway/client.js";
import { createGateway } from "../../src/gateway/server.js";
import { checkLearningPr } from "../../src/gateway/learning-check.js";
import { actor, fixtureServer } from "./helpers.js";
import { learningsVerb } from "../../src/cli/learnings.js";
import recorded from "../fixtures/github/learning-47.json" with { type: "json" };
import envelopes from "../fixtures/github/learnings-recorded.json" with { type: "json" };
import actionsViewer from "../fixtures/github/actions-viewer.json" with { type: "json" };

const prefix = "/repos/vworlds/vmethod";
const baseSha = "b".repeat(40);
const pull = {
  ...recorded.pull,
  head: { ...recorded.pull.head, repo: { full_name: "vimescmd/vmethod" } },
  base: { ref: "dev", sha: baseSha, repo: { full_name: "vworlds/vmethod" } },
};
const person = { ...pull.user, role: "orchestrator", repos: ["vworlds/vmethod"] };
const metadata = (value = pull) => ({ path: `${prefix}/pulls/47`, method: "GET", json: value });
const registry = {
  path: `${prefix}/contents/people.yaml?ref=${baseSha}`,
  method: "GET",
  json: { ...envelopes.people, content: Buffer.from(stringify([person])).toString("base64") },
};
// Keep PR 47's captured legacy modification unchanged; derive the add-only layout
// for successful policy/CI scenarios under the authenticated review on PR 52.
const submissionFiles = recorded.files.map((file) => ({
  ...file,
  filename: "learnings/models/vworlds-vmethod/14-36-abcdef012345.jsonl",
  status: "added",
}));
const files = (values = submissionFiles) => ({
  path: `${prefix}/pulls/47/files?per_page=100&page=1`,
  method: "GET",
  json: values,
});

test.each([403, 200])(
  "recorded label response %s with derived add-only path preserves diagnostic context",
  async (status) => {
    const endpoint = `${prefix}/issues/47/labels`;
    const f = fixtureServer([
      metadata(),
      registry,
      files(),
      metadata(),
      { path: endpoint, method: "POST", body: { labels: ["learning"] }, status },
    ]);
    const github = new GitHubClient(getConfig(f.root, {}), f.env, f.deps);
    if (status === 403) {
      await expect(checkLearningPr(github, 47, true)).rejects.toThrow(
        `GitHub HTTP 403 on POST ${endpoint}`
      );
    } else {
      expect(await checkLearningPr(github, 47, true)).toBe(
        "Learning PR #47: authorized; learning label applied"
      );
    }
    f.done();
  }
);

test("unmodified PR 47 recording is now denied because it modifies the legacy seed", async () => {
  const f = fixtureServer([metadata(), registry, files(recorded.files), metadata()]);
  const github = new GitHubClient(getConfig(f.root, {}), f.env, f.deps);
  await expect(checkLearningPr(github, 47)).rejects.toThrow("denied");
  f.done();
});

test.each([false, true])(
  "Actions system credential may validate learning submissions (label=%s)",
  async (label) => {
    const f = fixtureServer(
      [
        metadata(),
        registry,
        files(),
        metadata(),
        ...(label
          ? [
              {
                path: `${prefix}/issues/47/labels`,
                method: "POST",
                body: { labels: ["learning"] },
                status: 200,
              },
            ]
          : []),
      ],
      actor(3)
    );
    writeFileSync(
      join(f.root, "vmethod.yaml"),
      stringify({ ...getConfig(f.root, {}), repo: "vworlds/vmethod", org: "vworlds" })
    );
    const env = { ...f.env, GITHUB_ACTIONS: "true" };
    const gateway = createGateway(f.root, env, f.deps);
    expect(
      await learningsVerb(gateway, ["check-pr", "47", ...(label ? ["--label"] : [])], env)
    ).toBe(`Learning PR #47: authorized${label ? "; learning label applied" : ""}`);
    f.done();
  },
  15000
);

test("Actions system label writes still require a fully validated submission", async () => {
  const f = fixtureServer([metadata(), registry, files(recorded.files), metadata()], actor(3));
  writeFileSync(
    join(f.root, "vmethod.yaml"),
    stringify({ ...getConfig(f.root, {}), repo: "vworlds/vmethod", org: "vworlds" })
  );
  const env = { ...f.env, GITHUB_ACTIONS: "true" };
  const gateway = createGateway(f.root, env, f.deps);
  await expect(learningsVerb(gateway, ["check-pr", "47", "--label"], env)).rejects.toThrow(
    "denied"
  );
  f.done();
}, 15000);

test("recorded GraphQL Actions viewer authorizes CI using the REST-form registry pin", async () => {
  const f = fixtureServer([metadata(), registry, files(), metadata()], actionsViewer);
  const config = { ...getConfig(f.root, {}), repo: "vworlds/vmethod", org: "vworlds" };
  writeFileSync(join(f.root, "vmethod.yaml"), stringify(config));
  writeFileSync(
    join(f.root, "people.yaml"),
    stringify([
      {
        login: "github-actions[bot]",
        id: actionsViewer.databaseId,
        type: "Bot",
        role: "system",
        appIds: [15368],
        events: ["check_run"],
      },
    ])
  );
  const env = { ...f.env, GITHUB_ACTIONS: "true" };
  const gateway = createGateway(f.root, env, f.deps);
  await expect(
    gateway.call(
      "boardSetIssue",
      { ref: "3", field: "Status", value: "Done" },
      { role: "orchestrator" }
    )
  ).rejects.toThrow("Gateway token refused");
  expect(await learningsVerb(gateway, ["check-pr", "47"], env)).toBe("Learning PR #47: authorized");
  await expect(
    gateway.call(
      "issueCreate",
      { title: "Title", file: "nonexistent.md" },
      { role: "orchestrator" }
    )
  ).rejects.toThrow("Gateway token refused");
  f.done();
}, 15000);

test.each([
  "green",
  "red",
  "unauthorized",
  "ordinary",
  "mixed",
  "moved",
  "foreign-base",
  "snapshot",
])("fork learning waiting boundary: %s", async (scenario) => {
  let value =
    scenario === "foreign-base"
      ? { ...pull, base: { ...pull.base, repo: { full_name: "elsewhere/repo" } } }
      : pull;
  const changed =
    scenario === "ordinary" || scenario === "mixed"
      ? [{ ...recorded.files[0], filename: "src/hostile.ts" }]
      : submissionFiles.map((file) => ({ ...file }));
  if (scenario === "mixed") {
    changed.push(recorded.files[0]);
    value = { ...value, changed_files: 2 };
  }
  const runs = recorded.checks.map((check, i) => ({
    id: i + 1,
    name: `job-${i}`,
    app: { id: check.appId },
    head_sha: check.headSha,
    status: check.status,
    conclusion: scenario === "red" ? check.conclusion : "success",
  }));
  const allowed = scenario === "green" || scenario === "red";
  const validate = !["foreign-base", "snapshot"].includes(scenario);
  const f = fixtureServer(
    [
      metadata(value),
      ...(validate
        ? [
            scenario === "unauthorized"
              ? {
                  ...registry,
                  json: {
                    ...registry.json,
                    content: Buffer.from(
                      stringify([{ ...person, repos: ["vworlds/vecs"] }])
                    ).toString("base64"),
                  },
                }
              : registry,
            files(changed),
          ]
        : []),
      ...(validate && scenario !== "ordinary"
        ? [
            metadata(
              scenario === "moved"
                ? { ...pull, head: { ...pull.head, sha: "c".repeat(40) } }
                : value
            ),
          ]
        : []),
      ...(allowed
        ? [
            {
              path: `${prefix}/commits/${pull.head.sha}/check-runs?filter=all&per_page=100&page=1`,
              method: "GET",
              json: { check_runs: runs },
            },
            metadata(),
            registry,
            files(),
            metadata(),
          ]
        : []),
    ],
    { login: person.login, databaseId: person.id, __typename: person.type }
  );
  const config = { ...getConfig(f.root, {}), repo: "vworlds/vmethod", org: "vworlds" };
  writeFileSync(join(f.root, "vmethod.yaml"), stringify(config));
  writeFileSync(
    join(f.root, "people.yaml"),
    stringify([
      person,
      {
        login: "github-actions[bot]",
        id: 41898282,
        type: "Bot",
        role: "system",
        appIds: [15368],
        events: ["check_run"],
      },
    ])
  );
  const gateway = createGateway(f.root, f.env, f.deps);
  const operation = scenario === "snapshot" ? "checkTaskCi" : "waitChecks";
  const result = gateway.call(operation, { ref: "47" }, { role: "orchestrator" });
  if (allowed) {
    const verdict = await result;
    if (scenario === "green") {
      expect(verdict).toEqual({ code: 0, text: `checks: green (head ${pull.head.sha})` });
    } else {
      expect(verdict.code).toBe(1);
      expect(verdict.text.split("\n").at(-1)).toBe(
        `checks: RED: job-0, job-1 (head ${pull.head.sha})`
      );
    }
  } else {
    await expect(result).rejects.toThrow();
  }
  f.done();
});
