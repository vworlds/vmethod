import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { releaseVerb } from "../../src/cli/release.js";
import { fixtureServer, type Request } from "./helpers.js";

const prefix = "/repos/example/project";
const headSha = "a".repeat(40);
const otherSha = "d".repeat(40);
const version = "1.1.0-rc.3";
const staleVersion = "1.0.0-rc.9";
const tag = `v${version}`;
const runUrl = "https://github.com/example/project/actions/runs/7";
const packument = {
  "dist-tags": { latest: "1.0.0", next: version },
  versions: { [version]: { version, gitHead: headSha } },
};
// The 2026-10-27 rc.10 propagation shape: `next` still names the previous
// release and the new version is absent.
const stale = {
  "dist-tags": { latest: "1.0.0", next: "1.0.0-rc.9" },
  versions: { "1.0.0-rc.9": { version: "1.0.0-rc.9", gitHead: otherSha } },
};
const warning = `npm next not visible yet (registry propagation); check later with npm view @vworlds/vmethod dist-tags`;

const run = (overrides: Record<string, unknown> = {}) => ({
  id: 7,
  event: "workflow_dispatch",
  head_branch: "dev",
  head_sha: headSha,
  status: "completed",
  conclusion: "success",
  html_url: runUrl,
  ...overrides,
});
const runs = (values: Record<string, unknown>[]) => ({
  path: `${prefix}/actions/workflows/publish.yml/runs?event=workflow_dispatch&per_page=100&page=1`,
  method: "GET",
  json: { workflow_runs: values },
});
const branches = (sha: string = headSha) => ({
  path: `${prefix}/branches/dev`,
  method: "GET",
  json: { commit: { sha } },
});
const dispatch = {
  path: `${prefix}/actions/workflows/publish.yml/dispatches`,
  method: "POST",
  body: { ref: "dev" },
  status: 204,
};
const jobs = (values: Record<string, unknown>[]) => ({
  path: `${prefix}/actions/runs/7/jobs?per_page=100&page=1`,
  method: "GET",
  json: { jobs: values },
});
const tagRefs = (values: Record<string, unknown>[]) => ({
  path: `${prefix}/git/matching-refs/tags/v`,
  method: "GET",
  json: values,
});
const release = (json: unknown) => ({
  path: `${prefix}/releases/tags/${tag}`,
  method: "GET",
  json,
});
const releasedTagReference = [
  { ref: "refs/tags/v1.0.0", object: { sha: otherSha, type: "commit" } },
  { ref: `refs/tags/${tag}`, object: { sha: headSha, type: "commit" } },
  { ref: "refs/tags/v9.9.9", object: { sha: otherSha, type: "tag" } },
];
// The warn path's authoritative evidence: the pushed tag at the released
// commit (an older commit tag and an annotated tag must not match) and the
// GitHub release for it.
const releasedEvidence: () => Request[] = () => [
  tagRefs(releasedTagReference),
  release({ html_url: `https://github.com/example/project/releases/tag/${tag}` }),
];
const step = (name: string, conclusion: string | null) => ({ name, conclusion });

function releaseFixture(requests: Request[], registry?: unknown[]) {
  const f = fixtureServer(requests);
  writeFileSync(join(f.root, "package.json"), JSON.stringify({ name: "@vworlds/vmethod" }));
  const calls = { registry: 0 };
  const read = registry ?? [packument];
  const original = f.deps.fetch;
  f.deps.fetch = async (url, init) => {
    if (String(url).startsWith("https://registry.npmjs.org/")) {
      calls.registry++;
      if (read.length === 0) {
        return new Response("Not Found", { status: 404 });
      }
      const current = read.shift();
      return current === "fail"
        ? new Response("Not Found", { status: 404 })
        : Response.json(current ?? read.at(-1) ?? packument);
    }
    return original(url, init);
  };
  f.deps.exec = async (file, args) => {
    if (file === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
      return "dev\n";
    }
    if (file === "git" && args[0] === "rev-parse") {
      return `${headSha}\n`;
    }
    throw new Error(`Unexpected exec: ${file} ${args.join(" ")}`);
  };
  return {
    ...f,
    calls,
    invoke: (args: string[]) => releaseVerb(f.gateway, args, { VMETHOD_ROLE: "orchestrator" }),
  };
}

test("release next dispatches the publish run and reports version, dist-tag, tag and release", async () => {
  const f = releaseFixture([
    branches(),
    runs([]),
    dispatch,
    runs([run({ status: "queued", conclusion: null })]),
    runs([run()]),
    {
      path: `${prefix}/git/ref/tags/${tag}`,
      method: "GET",
      json: { ref: `refs/tags/${tag}`, object: { sha: headSha, type: "commit" } },
    },
    {
      path: `${prefix}/releases/tags/${tag}`,
      method: "GET",
      json: { html_url: `https://github.com/example/project/releases/tag/${tag}` },
    },
  ]);
  expect(await f.invoke(["next"])).toBe(
    [
      `Published @vworlds/vmethod@${version}`,
      `npm next: ${version}`,
      `git tag: ${tag}`,
      `release: https://github.com/example/project/releases/tag/${tag}`,
      `run: ${runUrl}`,
    ].join("\n")
  );
  expect(f.sleeps).toEqual([10000]);
  expect(f.calls.registry).toBe(1);
  f.done();
});

const bounded = (f: ReturnType<typeof releaseFixture>) => {
  // Each clock read advances 5 minutes (two reads per HTTP round trip), so the
  // registry poll bound expires deterministically without real waiting.
  let base = Date.UTC(2026, 0, 1);
  f.deps.now = () => (base += 300000);
};

test("registry propagation that appears after a few polls succeeds", async () => {
  const f = releaseFixture(
    [
      branches(),
      runs([]),
      dispatch,
      runs([run()]),
      {
        path: `${prefix}/git/ref/tags/${tag}`,
        method: "GET",
        json: { ref: `refs/tags/${tag}`, object: { sha: headSha, type: "commit" } },
      },
      release({ html_url: `https://github.com/example/project/releases/tag/${tag}` }),
    ],
    [stale, packument]
  );
  bounded(f);
  expect(await f.invoke(["next"])).toBe(
    [
      `Published @vworlds/vmethod@${version}`,
      `npm next: ${version}`,
      `git tag: ${tag}`,
      `release: https://github.com/example/project/releases/tag/${tag}`,
      `run: ${runUrl}`,
    ].join("\n")
  );
  expect(f.sleeps).toEqual([15000]);
  expect(f.calls.registry).toBe(2);
  f.done();
}, 15000);

test("registry propagation that never appears warns instead of failing on the incident lag shape", async () => {
  const f = releaseFixture(
    [branches(), runs([]), dispatch, runs([run()]), ...releasedEvidence()],
    [stale, stale]
  );
  bounded(f);
  expect(await f.invoke(["next"])).toBe(
    [
      `Published @vworlds/vmethod@${version}`,
      warning,
      `git tag: ${tag}`,
      `release: https://github.com/example/project/releases/tag/${tag}`,
      `run: ${runUrl}`,
    ].join("\n")
  );
  expect(f.sleeps).toEqual([15000]);
  expect(f.calls.registry).toBe(2);
  f.done();
}, 15000);

test("a registry read that keeps failing within the bound still warns on the tag and release", async () => {
  const f = releaseFixture(
    [branches(), runs([]), dispatch, runs([run()]), ...releasedEvidence()],
    ["fail", "fail"]
  );
  bounded(f);
  expect(await f.invoke(["next"])).toContain(warning);
  expect(f.calls.registry).toBe(2);
  f.done();
}, 15000);

test("a green run without a version tag at the released head asks for the repair rerun", async () => {
  const f = releaseFixture(
    [
      branches(),
      runs([]),
      dispatch,
      runs([run()]),
      tagRefs([releasedTagReference[0], releasedTagReference[2]]),
    ],
    [stale, stale]
  );
  bounded(f);
  await expect(f.invoke(["next"])).rejects.toThrow(
    `no version tag for ${headSha.slice(0, 8)} names the release; rerun the workflow`
  );
  f.done();
}, 15000);

test.each([
  { name: "no arguments", args: [] },
  { name: "bare verb", args: ["release"] },
  { name: "unknown action", args: ["release", "later"] },
  { name: "extra flag", args: ["release", "next", "--bounded"] },
])("release CLI parses strictly: $name", async ({ args }) => {
  const f = releaseFixture([]);
  await expect(f.invoke(args)).rejects.toThrow("Usage: vmethod release next");
  f.done();
});

test("release next refuses a checkout that is not on the base branch", async () => {
  const f = releaseFixture([]);
  f.deps.exec = async () => "308-no-vmethod-verbs\n";
  await expect(f.invoke(["next"])).rejects.toThrow(
    "release next requires the checkout on dev; it is on 308-no-vmethod-verbs"
  );
  expect(f.calls.registry).toBe(0);
  f.done();
});

test("release next refuses a diverged checkout before any write", async () => {
  const f = releaseFixture([branches(otherSha)]);
  await expect(f.invoke(["next"])).rejects.toThrow(
    `local dev head ${headSha.slice(0, 8)} differs from remote ${otherSha.slice(0, 8)}`
  );
  f.done();
});

test("release next refuses a dispatched run on a racing newer head", async () => {
  const f = releaseFixture([branches(), runs([]), dispatch, runs([run({ head_sha: otherSha })])]);
  await expect(f.invoke(["next"])).rejects.toThrow(
    `was created on head ${otherSha.slice(0, 8)}, not ${headSha.slice(0, 8)}`
  );
  f.done();
});

test("release next waits with a bound and reports the run URL", async () => {
  const pending = run({ status: "in_progress", conclusion: null });
  const f = releaseFixture([branches(), runs([]), dispatch, runs([pending]), runs([pending])]);
  // Each clock read advances 5 minutes (two reads per HTTP round trip), so the
  // run stays pending until the 30-minute bound expires after one sleep.
  let base = Date.UTC(2026, 0, 1);
  f.deps.now = () => (base += 300000);
  await expect(f.invoke(["next"])).rejects.toThrow(
    `did not complete within 30 minutes (the dispatched run is still publishing); run: ${runUrl}`
  );
  f.done();
});

test("release next reports a red publish run's failed step and run URL", async () => {
  const f = releaseFixture([
    branches(),
    runs([]),
    dispatch,
    runs([run({ conclusion: "failure" })]),
    jobs([
      {
        id: 5,
        name: "publish",
        conclusion: "failure",
        steps: [
          step("npm ci", "success"),
          step("npm test", "failure"),
          step("aftermath", null),
          step("teardown", "skipped"),
        ],
      },
    ]),
  ]);
  await expect(f.invoke(["next"])).rejects.toThrow(
    `release next: RED: publish / npm test; run: ${runUrl}`
  );
  expect(f.calls.registry).toBe(0);
  f.done();
});

test("release next names a red job without a reported step", async () => {
  const f = releaseFixture([
    branches(),
    runs([]),
    dispatch,
    runs([run({ conclusion: "cancelled" })]),
    jobs([{ id: 5, name: "publish", conclusion: "startup_failure", steps: [] }]),
  ]);
  await expect(f.invoke(["next"])).rejects.toThrow("no failed step reported");
  f.done();
});

test("release next asks for the retry-safe publish rerun when the git tag is missing", async () => {
  const f = releaseFixture([
    branches(),
    runs([]),
    dispatch,
    runs([run()]),
    { path: `${prefix}/git/ref/tags/${tag}`, method: "GET", status: 404 },
  ]);
  await expect(f.invoke(["next"])).rejects.toThrow(
    `the publish run was green but the git tag ${tag} is missing; rerun the workflow`
  );
  expect(f.calls.registry).toBe(1);
  f.done();
});

test("release next asks for the retry-safe publish rerun when the release is missing", async () => {
  const f = releaseFixture([
    branches(),
    runs([]),
    dispatch,
    runs([run()]),
    {
      path: `${prefix}/git/ref/tags/${tag}`,
      method: "GET",
      json: { ref: `refs/tags/${tag}`, object: { sha: headSha, type: "commit" } },
    },
    { path: `${prefix}/releases/tags/${tag}`, method: "GET", status: 404 },
  ]);
  await expect(f.invoke(["next"])).rejects.toThrow(
    `the publish run was green but the GitHub release for ${tag} is missing; rerun the workflow`
  );
  f.done();
});

test.each([
  {
    name: "a version-shaped dist-tag at a different head",
    npm: {
      "dist-tags": { latest: "1.0.0", next: staleVersion },
      versions: {
        [staleVersion]: { version: staleVersion, gitHead: otherSha },
        [version]: { version, gitHead: headSha },
      },
    },
    message: `the npm next dist-tag publishes ${staleVersion} from ${otherSha.slice(0, 8)}, not ${headSha.slice(0, 8)}`,
  },
  {
    name: "a dist-tag that names no release version",
    npm: {
      "dist-tags": { latest: "1.0.0", next: "oops" },
      versions: { [version]: { version, gitHead: headSha } },
    },
    message: `the npm next dist-tag does not name ${version}`,
  },
])(
  "a registry gitHead that contradicts the released version while it is visible is an error: $name",
  async ({ npm, message }) => {
    const f = releaseFixture([branches(), runs([]), dispatch, runs([run()])], [npm]);
    await expect(f.invoke(["next"])).rejects.toThrow(message);
    expect(f.calls.registry).toBe(1);
    f.done();
  }
);

test("a registry naming multiple versions from the released head is ambiguous", async () => {
  const npm = {
    "dist-tags": { latest: "1.0.0", next: version },
    versions: {
      [version]: { version, gitHead: headSha },
      [staleVersion]: { version: staleVersion, gitHead: headSha },
    },
  };
  const f = releaseFixture([branches(), runs([]), dispatch, runs([run()])], [npm]);
  await expect(f.invoke(["next"])).rejects.toThrow(
    `the registry names multiple published versions for ${headSha.slice(0, 8)}`
  );
  f.done();
});

test("release next is orchestrator-only", async () => {
  const f = releaseFixture([]);
  await expect(f.gateway.call("releaseNext", {}, { role: "worker" })).rejects.toThrow(
    "Gateway operation denied for client role"
  );
  f.done();
});
