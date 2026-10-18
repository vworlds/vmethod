import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { stringify } from "yaml";
import { getConfig } from "../../src/config.js";
import { OpencodeClient, type Dependencies } from "../../src/gateway/client.js";
import { WorkerService, type TaskMetadata, type WorkerHooks } from "../../src/gateway/workers.js";
import { workerAccess } from "../../src/gateway/access.js";
import { validProject } from "../helpers.js";
import captured from "../fixtures/usage/opencode-session.json" with { type: "json" };
import messageCapture from "../fixtures/usage/opencode-message.json" with { type: "json" };
import claudeResults from "../fixtures/usage/claude-results.json" with { type: "json" };

interface Request {
  path: string;
  method?: string;
  body?: unknown;
  data?: unknown;
  status?: number;
}
function fixture(requests: Request[] = [], priced = false) {
  const root = validProject();
  const directory = join(root, ".worktrees/9-task");
  mkdirSync(join(directory, "node_modules/.bin"), { recursive: true });
  mkdirSync(join(directory, ".tmp"));
  writeFileSync(join(directory, "node_modules/.bin/vmethod"), "fake", { mode: 0o755 });
  writeFileSync(
    join(root, "models.yaml"),
    stringify([
      {
        family: "glm",
        model: "fake/glm",
        kind: "opencode",
        gate: "none",
        tier: "cheap",
        fallback: ["sol"],
        ...(priced ? { price: { input: 2, output: 10, cached: 0.2 } } : {}),
      },
      {
        family: "sol",
        model: "fake/sol",
        kind: "opencode",
        gate: "owner",
        tier: "expensive",
        fallback: ["glm"],
        ...(priced ? { price: { input: 4, output: 20, cached: 0.4 } } : {}),
      },
      {
        family: "sonnet",
        model: "claude-test",
        kind: "claude",
        gate: "none",
        tier: "standard",
        ...(priced ? { price: { input: 3, output: 15, cached: 0.3 } } : {}),
      },
      { family: "other", model: "fake/other", kind: "opencode", gate: "owner", tier: "expensive" },
    ])
  );
  const env = {
    XDG_STATE_HOME: join(root, "state"),
    OPENCODE_BASE_URL: "https://opencode.invalid",
    OPENCODE_SERVER_USERNAME: "fake-user",
    OPENCODE_SERVER_PASSWORD: "secret-password",
  };
  const meta: TaskMetadata = {
    pr: 31,
    issue: 9,
    branch: "9-task",
    title: "Task $(hostile)",
    body: "PR description `data`",
    state: "OPEN",
    draft: true,
    blocked: false,
    estimate: 13,
    pointsOpen: 8,
    model: "glm",
    kind: "tooling",
    merged: false,
    comments: [],
  };
  let clock = 0,
    index = 0,
    running = true;
  const unexpected: string[] = [];
  const deps: Dependencies = {
    fetch: async (url, init) => {
      const expected = requests[index++];
      const target = new URL(String(url));
      if (!expected) {
        unexpected.push(target.pathname);
        throw new Error("Unexpected fake opencode request");
      }
      expect(target.origin).toBe("https://opencode.invalid");
      expect(target.pathname + target.search).toBe(expected.path);
      expect(init?.method).toBe(expected.method ?? "GET");
      expect(init?.headers).toMatchObject({
        authorization: `Basic ${Buffer.from("fake-user:secret-password").toString("base64")}`,
      });
      if (target.pathname === "/api/session" && init?.method === "POST") {
        expect(JSON.parse(String(init.body)).title).toBe(
          `${String(config.repo).split("/").at(-1)}#31`
        );
      }
      if (expected.body !== undefined) {
        expect(JSON.parse(String(init?.body))).toEqual(expected.body);
      }
      return new Response(JSON.stringify({ data: expected.data ?? {} }), {
        status: expected.status ?? 200,
      });
    },
    exec: async () => {
      throw new Error("Unexpected subprocess");
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    report: vi.fn(),
    processes: {
      launch: vi.fn(async () => ({ pid: 123, born: "fake-birth" })),
      alive: vi.fn(() => running),
      stop: vi.fn(() => {
        running = false;
      }),
    },
  };
  const hooks: WorkerHooks = {
    metadata: vi.fn(async () => meta),
    prepare: vi.fn(async () => directory),
    setModel: vi.fn(async () => {}),
    setEstimate: vi.fn(async () => {}),
    setCost: vi.fn(async () => {}),
    gradeComment: vi.fn(async () => {}),
    submitLearnings: vi.fn(async () => "Learning submission complete"),
    workerIdentity: vi.fn(async () => ({ GH_TOKEN: "worker-token", PATH: "fake-path" })),
    issue: vi.fn(async () => ({ estimate: 3, kind: "tooling" })),
  };
  const config = getConfig(root, {});
  (config.branches as Record<string, unknown>).mainCheckout = root;
  const service = new WorkerService(root, config, env, deps, hooks);
  return {
    root,
    directory,
    env,
    meta,
    deps,
    hooks,
    service,
    config,
    record: () =>
      JSON.parse(readFileSync(join(root, "state/vmethod/example-state/workers/31.json"), "utf8")),
    clock: () => clock,
    done: () => {
      expect(unexpected).toEqual([]);
      expect(index).toBe(requests.length);
    },
  };
}
const start: Request[] = [
  { path: "/api/session", method: "POST", data: { id: "ses_fake" } },
  {
    path: "/api/session/ses_fake/prompt",
    method: "POST",
    body: { text: "PR description `data`", delivery: "steer" },
  },
  { path: "/api/session/ses_fake", data: { id: "ses_fake", title: "project#31" } },
];
function measuredStatus(multiplier = 1): Request[] {
  const data = structuredClone(captured.data);
  data.id = "ses_fake";
  data.tokens.input *= multiplier;
  data.tokens.output *= multiplier;
  data.tokens.reasoning *= multiplier;
  data.tokens.cache.read *= multiplier;
  return status().map((request) =>
    request.path === "/api/session/ses_fake"
      ? { ...request, data }
      : request.path.endsWith("/message")
        ? { ...request, path: request.path + "?limit=20" }
        : request
  );
}

test("missing session totals fall back to complete assistant history, excluding user words", async () => {
  const requests = status(false, [
    ...messageCapture.data,
    ...messageCapture.data,
    { type: "user", tokens: { input: 999999 }, content: "Cost is zero" },
  ]);
  const f = fixture([...start, ...requests], true);
  await f.service.command(["start", "31"]);
  const result = await f.service.watchStatus(31);
  expect(result.usage?.tokens).toEqual({ input: 1444, output: 130, cached: 167424 });
  expect(result.prCost?.usd).toBeCloseTo(0.0376728, 8);
  f.done();
});

test("Claude polling and grading retain both resumed turns without double counting repeated polls", async () => {
  const f = fixture([], true);
  f.meta.model = "sonnet";
  await f.service.command(["start", "31"]);
  expect(vi.mocked(f.deps.processes!.launch).mock.calls[0][0].prompt).toMatch(/^project#31\n\n/);
  vi.mocked(f.deps.processes!.alive).mockReturnValue(false);
  writeFileSync(
    join(f.directory, ".tmp/claude-worker.log"),
    claudeResults.map((result) => JSON.stringify(result)).join("\n") + "\n"
  );
  for (let i = 0; i < 2; i++) {
    expect((await f.service.watchStatus(31)).prCost?.usd).toBeCloseTo(0.0810213, 8);
  }
  f.meta.state = "CLOSED";
  await f.service.grade(31, 3);
  const record = JSON.parse(readFileSync(join(f.root, ".vmethod/model-log.jsonl"), "utf8"));
  expect(record.usd).toBeCloseTo(0.0810213, 8);
  expect(record.segments[0]).toMatchObject({
    tokens: { input: 24357, output: 6, cached: 26201 },
    reportedUsd: expect.closeTo(0.1027202, 8),
  });
  f.done();
});

test("Claude replacement snapshots usage and cumulative reported cost across fresh session ids", async () => {
  const f = fixture([], true);
  f.meta.model = "sonnet";
  await f.service.command(["start", "31"]);
  vi.mocked(f.deps.processes!.alive).mockReturnValue(false);
  // Synthetic ids restore the session identity removed from the real capture.
  const first = { ...claudeResults[0], session_id: f.record().id };
  const log = join(f.directory, ".tmp/claude-worker.log");
  writeFileSync(log, JSON.stringify(first) + "\n");
  await f.service.command(["start", "31", "--replace"]);
  const second = { ...claudeResults[0], session_id: f.record().id };
  writeFileSync(log, [first, second].map((result) => JSON.stringify(result)).join("\n") + "\n");
  f.meta.state = "CLOSED";
  await f.service.grade(31, 3);
  const record = JSON.parse(readFileSync(join(f.root, ".vmethod/model-log.jsonl"), "utf8"));
  expect(record.usd).toBeCloseTo(0.0854058, 8);
  expect(record.segments).toHaveLength(2);
  for (const segment of record.segments) {
    expect(segment.tokens).toEqual({ input: 13132, output: 3, cached: 10873 });
    expect(segment.reportedUsd).toBeCloseTo(0.0547286, 8);
  }
  f.done();
});

test("status persists provider tokens and API dollars, grading uses only this PR even with another delivery on the same issue", async () => {
  const f = fixture(
    [...start, ...measuredStatus(), ...measuredStatus(2), ...measuredStatus(2)],
    true
  );
  await f.service.command(["start", "31"]);
  expect(await f.service.command(["status", "31"])).toContain("$1.193840");
  const other = f.record();
  other.pr = 32;
  writeFileSync(join(f.root, "state/vmethod/example-state/workers/32.json"), JSON.stringify(other));
  expect((await f.service.watchStatus(31)).prCost).toEqual({
    pr: 31,
    usd: expect.closeTo(2.3876792, 8),
  });
  f.meta.state = "MERGED";
  f.meta.merged = true;
  await f.service.grade(31, 5);
  expect(f.hooks.setCost).toHaveBeenCalledWith(31, "$2.39");
  expect(f.hooks.gradeComment).toHaveBeenCalledWith(9, expect.stringContaining("$2.387679"));
  const record = JSON.parse(readFileSync(join(f.root, ".vmethod/model-log.jsonl"), "utf8"));
  expect(record.usd).toBeCloseTo(2.3876792, 8);
  expect(record.segments[0].tokens).toEqual({ input: 237786, output: 34892, cached: 7815936 });
  expect(record.segments[0].reportedUsd).toBe(0);
  f.done();
});

test("watch poll computes PR cost without GitHub reads and unknown price propagates", async () => {
  const f = fixture([...start, ...measuredStatus()]);
  await f.service.command(["start", "31"]);
  vi.mocked(f.hooks.metadata).mockClear();
  const result = await f.service.watchStatus(31);
  expect(result.prCost).toEqual({ pr: 31, usd: null });
  expect(f.record().segments[0].usd).toBeNull();
  expect(f.hooks.metadata).not.toHaveBeenCalled();
  expect(f.hooks.setCost).not.toHaveBeenCalled();
  f.done();
});

test("model switch snapshots cumulative baseline and grades each family's delta", async () => {
  const f = fixture(
    [
      ...start,
      ...measuredStatus(),
      {
        path: "/api/session/ses_fake/model",
        method: "POST",
        body: { model: { providerID: "fake", id: "sol" } },
      },
      { path: "/api/session/ses_fake", method: "PATCH", body: { title: "project#31" } },
      ...measuredStatus(2),
    ],
    true
  );
  await f.service.command(["start", "31"]);
  await f.service.command(["model", "31", "sol", "--owner-approved"]);
  f.meta.state = "MERGED";
  await f.service.grade(31, 5);
  const record = JSON.parse(readFileSync(join(f.root, ".vmethod/model-log.jsonl"), "utf8"));
  expect(record.segments.map((segment: { usd: number }) => segment.usd)).toEqual([
    expect.closeTo(1.1938396, 8),
    expect.closeTo(2.3876792, 8),
  ]);
  expect(record.usd).toBeCloseTo(3.5815188, 8);
  f.done();
});

test("watch status uses the recorded task session and client update time without reading comments", async () => {
  const f = fixture([
    ...start,
    { path: "/api/session/active", data: { ses_fake: true } },
    { path: "/api/session/ses_fake", data: { id: "ses_fake", time: { updated: 123_456 } } },
    { path: "/api/session/ses_fake/permission", data: [] },
    { path: "/api/session/ses_fake/message", data: [] },
  ]);
  expect(await f.service.watchStatus(31)).toEqual({ reason: "session unknown", active: false });
  await f.service.command(["start", "31"]);
  vi.mocked(f.hooks.metadata).mockClear();
  expect(await f.service.watchStatus(31)).toMatchObject({
    reason: "running",
    active: true,
    updated: 123_456,
  });
  expect(f.hooks.metadata).not.toHaveBeenCalled();
  f.done();
});

test("adopt records an existing session without creating or prompting it", async () => {
  const f = fixture();
  // The session must belong to the prepared task worktree.
  f.deps.fetch = vi.fn(async (_url, init) =>
    Response.json({
      data:
        init?.method === "PATCH"
          ? {}
          : {
              id: "ses_existing",
              directory: f.directory,
              model: { providerID: "fake", id: "glm" },
              title: "old title",
            },
    })
  );
  expect(await f.service.command(["adopt", "31", "ses_existing"])).toContain("Adopted");
  expect(f.record()).toMatchObject({
    id: "ses_existing",
    directory: f.directory,
    points_open: 8,
    segments: [{ why: "adopt", model: "fake/glm" }],
  });
  expect(f.deps.fetch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(vi.mocked(f.deps.fetch).mock.calls[1][1]?.body))).toEqual({
    title: "project#31",
  });
  expect(f.hooks.setModel).toHaveBeenCalledWith(31, "glm");
  await expect(f.service.command(["adopt", "31", "ses_other"])).rejects.toThrow("already recorded");
});

test.each(["directory", "id", "model"])(
  "adopt refuses an unverified session %s without persisting",
  async (field) => {
    const f = fixture();
    const session = {
      id: "ses_existing",
      directory: f.directory,
      model: { providerID: "fake", id: "glm" },
    };
    const invalid = { ...session, [field]: field === "model" ? {} : "wrong" };
    f.deps.fetch = vi.fn(async () => Response.json({ data: invalid }));
    await expect(f.service.command(["adopt", "31", "ses_existing"])).rejects.toThrow();
    expect(() => f.record()).toThrow();
    expect(f.hooks.setModel).not.toHaveBeenCalled();
  }
);

test("consumer worker start accepts its installed bin without self-build", async () => {
  const f = fixture([...start]);
  writeFileSync(join(f.directory, "package.json"), JSON.stringify({ name: "consumer" }));
  f.deps.exec = vi.fn(async () => {
    throw new Error("unexpected consumer build");
  });
  await expect(f.service.command(["start", "31"])).resolves.toContain("Started");
  expect(f.deps.exec).not.toHaveBeenCalled();
  f.done();
});

test("self-hosted worker start installs and builds before accepting dist binary", async () => {
  const f = fixture([...start]);
  rmSync(join(f.directory, "node_modules/.bin/vmethod"));
  writeFileSync(join(f.directory, "package.json"), JSON.stringify({ name: "@vworlds/vmethod" }));
  f.deps.exec = vi.fn(async (file, args, options) => {
    expect(file).toBe("npm");
    expect(options?.cwd).toBe(f.directory);
    expect(options?.env).not.toHaveProperty("OPENCODE_SERVER_PASSWORD");
    if (args.join(" ") === "run build") {
      mkdirSync(join(f.directory, "dist"));
      writeFileSync(join(f.directory, "dist/vmethod.mjs"), "built");
    }
    return "";
  });
  await expect(f.service.command(["start", "31"])).resolves.toContain("Started");
  expect(vi.mocked(f.deps.exec).mock.calls.map(([file, args]) => [file, args])).toEqual([
    ["npm", ["ci"]],
    ["npm", ["run", "build"]],
  ]);
  f.done();
});

test("bulk adoption reads only configured legacy records and reports verified PRs", async () => {
  const f = fixture();
  f.config.legacyWorkers = ["old-workers"];
  const legacy = join(f.env.XDG_STATE_HOME, "old-workers");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "31.json"), JSON.stringify({ sessionId: "ses_existing" }));
  writeFileSync(join(legacy, "32.json"), JSON.stringify({ sessionId: "ses_wrong" }));
  f.deps.fetch = vi.fn(async (input) =>
    Response.json({
      data: {
        id: String(input).endsWith("ses_existing") ? "ses_existing" : "ses_wrong",
        directory: String(input).endsWith("ses_existing") ? f.directory : "/another/repo",
        model: { providerID: "fake", id: "glm" },
      },
    })
  );
  const output = await f.service.command(["adopt", "--from-legacy"]);
  expect(output).toContain("Adopted ses_existing for #31");
  expect(output).toContain("Skipped #32");
  expect(f.record().id).toBe("ses_existing");
});
const legacyFiles = JSON.parse(
  readFileSync(new URL("../fixtures/legacy-workers/records.json", import.meta.url), "utf8")
) as {
  spacerocks: { key: string; content: string }[];
  vecs: { key: string; content: string };
  claude: { key: string; content: string };
};

function legacyFixture(record = legacyFiles.vecs, prefix = "auto-") {
  const f = fixture();
  const recordedBasename = record.key.slice(
    record.key.lastIndexOf(".worktrees_") + ".worktrees_".length
  );
  const pr = Number(/^auto-([1-9]\d*)-/.exec(recordedBasename)?.[1]);
  const basename = prefix + recordedBasename.slice("auto-".length);
  const directory = join(f.root, ".worktrees", basename);
  renameSync(f.directory, directory);
  f.meta.pr = pr;
  f.meta.branch = basename.slice(prefix.length);
  (f.config.branches as Record<string, unknown>).worktreePrefix = prefix;
  vi.mocked(f.hooks.prepare).mockResolvedValue(directory);
  const legacy = join(f.env.XDG_STATE_HOME, "vecs-orchestrator/workers");
  mkdirSync(legacy, { recursive: true });
  f.config.legacyWorkers = ["vecs-orchestrator/workers"];
  const key = directory.replaceAll("/", "_");
  writeFileSync(join(legacy, key), record.content);
  const id = record.content.trim();
  return {
    ...f,
    directory,
    legacy,
    key,
    id,
    pr,
    session: { id, directory, model: { providerID: "fake", id: "glm" } },
    saved: () =>
      JSON.parse(
        readFileSync(join(f.env.XDG_STATE_HOME, `vmethod/example-state/workers/${pr}.json`), "utf8")
      ),
  };
}

test.each([legacyFiles.vecs, ...legacyFiles.spacerocks.slice(1)])(
  "imports captured/projected bare-id legacy record $key",
  async (record) => {
    const f = legacyFixture(record);
    f.deps.fetch = vi.fn(async (url, init) => {
      expect(new URL(String(url)).pathname).toBe(`/api/session/${f.id}`);
      if (init?.method === "PATCH") {
        expect(JSON.parse(String(init.body))).toEqual({ title: `project#${f.pr}` });
        return Response.json({ data: {} });
      }
      expect(init?.method).toBe("GET");
      return Response.json({ data: f.session });
    });
    expect(await f.service.command(["adopt", "--from-legacy"])).toContain(
      `Adopted ${f.id} for #${f.pr}`
    );
    expect(f.saved()).toMatchObject({
      id: f.id,
      pr: f.pr,
      directory: f.directory,
      model: { model: "fake/glm" },
    });
    expect(readFileSync(join(f.legacy, f.key), "utf8")).toBe(record.content);
    expect(f.deps.fetch).toHaveBeenCalledTimes(2);
    expect(await f.service.command(["adopt", "--from-legacy"])).toContain("already recorded");
    expect(f.deps.fetch).toHaveBeenCalledTimes(2);
  }
);

test.each(["", "task.+"])("legacy keys respect configured literal prefix %j", async (prefix) => {
  const f = legacyFixture(legacyFiles.vecs, prefix);
  f.deps.fetch = vi.fn(async () => Response.json({ data: f.session }));
  expect(await f.service.command(["adopt", "--from-legacy"])).toContain(`Adopted ${f.id}`);
});

test.each([
  "merged",
  "closed",
  "missing worktree",
  "unknown session",
  "wrong id",
  "wrong directory",
  "wrong model",
  "wrong key",
])("legacy adoption reports %s without saving or launching", async (reason) => {
  const f = legacyFixture();
  let requests = 0;
  if (reason === "merged") {
    f.meta.merged = true;
  }
  if (reason === "closed") {
    f.meta.state = "CLOSED";
  }
  if (reason === "missing worktree") {
    rmSync(f.directory, { recursive: true });
  }
  if (reason === "wrong directory") {
    f.session.directory = "/another/worktree";
  }
  if (reason === "wrong id") {
    f.session.id = "ses_another";
  }
  if (reason === "wrong model") {
    f.session.model = { providerID: "", id: "" };
  }
  if (reason === "wrong key") {
    renameSync(join(f.legacy, f.key), join(f.legacy, `_foreign_.worktrees_auto-${f.pr}-different`));
  }
  f.deps.fetch = vi.fn(async (url, init) => {
    requests++;
    expect(new URL(String(url)).pathname).toBe(`/api/session/${f.id}`);
    expect(init?.method).toBe("GET");
    return reason === "unknown session"
      ? new Response("{}", { status: 404 })
      : Response.json({ data: f.session });
  });
  const output = await f.service.command(["adopt", "--from-legacy"]);
  expect(output).toContain(`Skipped #${f.pr}`);
  expect(output).toMatch(
    reason === "merged"
      ? /merged/
      : reason === "closed"
        ? /closed/
        : reason === "missing worktree"
          ? /Missing.*worktree/
          : reason === "unknown session"
            ? /Unknown session/
            : reason === "wrong id"
              ? /id mismatch/
              : reason === "wrong model"
                ? /model/
                : /worktree/
  );
  expect(() => f.saved()).toThrow();
  expect(f.hooks.setModel).not.toHaveBeenCalled();
  expect(f.deps.processes!.launch).not.toHaveBeenCalled();
  expect(requests).toBe(
    ["unknown session", "wrong id", "wrong directory", "wrong model"].includes(reason) ? 1 : 0
  );
  if (reason === "missing worktree") {
    expect(f.hooks.prepare).not.toHaveBeenCalled();
  }
});

test("reports probe, malformed and non-file records instead of silently ignoring them", async () => {
  const f = fixture();
  f.config.legacyWorkers = ["spacerocks-orchestrator/workers"];
  const directory = join(f.env.XDG_STATE_HOME, "spacerocks-orchestrator/workers");
  mkdirSync(join(directory, "subdirectory"), { recursive: true });
  const probe = legacyFiles.spacerocks[0];
  writeFileSync(join(directory, probe.key), probe.content);
  writeFileSync(join(directory, "31.json"), "{bad json");
  writeFileSync(join(directory, "32.json"), JSON.stringify({ id: "bad id" }));
  const output = await f.service.command(["adopt", "--from-legacy"]);
  for (const key of [probe.key, "31.json", "32.json", "subdirectory"]) {
    expect(output).toContain(key);
  }
  expect(output.split("\n")).toHaveLength(4);
  expect(f.hooks.prepare).not.toHaveBeenCalled();
  f.done();
});

test("Claude key=value records report id, PR and relaunch transition without contacting opencode", async () => {
  const f = fixture();
  f.config.legacyWorkers = ["spacerocks-orchestrator/claude-workers"];
  const directory = join(f.env.XDG_STATE_HOME, "spacerocks-orchestrator/claude-workers");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, legacyFiles.claude.key), legacyFiles.claude.content);
  const output = await f.service.command(["adopt", "--from-legacy"]);
  expect(output).toContain("Skipped #290");
  expect(output).toContain(`claude worker record ${legacyFiles.claude.key}: not adoptable`);
  expect(output).toContain("00000000-0000-4000-8000-000000000001");
  expect(output).toContain("worker start 290 --model <claude-family>");
  expect(f.hooks.metadata).not.toHaveBeenCalled();
  expect(f.hooks.prepare).not.toHaveBeenCalled();
  f.done();
});

test.each(["../escape", "/absolute", "a/../escape", "a//workers", "a/", "a\\workers"])(
  "runtime rejects unsafe legacyWorkers path %s",
  async (path) => {
    const f = fixture();
    f.config.legacyWorkers = [path];
    await expect(f.service.command(["adopt", "--from-legacy"])).rejects.toThrow(
      "Invalid legacyWorkers"
    );
    f.done();
  }
);

test("refuses configured symlink escape and reports record symlink escape without reading it", async () => {
  const f = fixture();
  mkdirSync(f.env.XDG_STATE_HOME, { recursive: true });
  symlinkSync(f.root, join(f.env.XDG_STATE_HOME, "escape"));
  f.config.legacyWorkers = ["escape"];
  await expect(f.service.command(["adopt", "--from-legacy"])).rejects.toThrow(
    /escapes.*state root/
  );
  const directory = join(f.env.XDG_STATE_HOME, "workers");
  mkdirSync(directory);
  writeFileSync(join(f.root, "outside.json"), '{"id":"ses_outside"}');
  symlinkSync(join(f.root, "outside.json"), join(directory, "31.json"));
  f.config.legacyWorkers = ["workers"];
  const output = await f.service.command(["adopt", "--from-legacy"]);
  expect(output).toContain("Skipped #31");
  expect(output).toMatch(/escapes.*state root/);
  expect(f.hooks.metadata).not.toHaveBeenCalled();
  f.done();
});

test("nested legacy paths retain the track suffix and allow symlinks confined below the state root", async () => {
  const f = legacyFixture();
  f.config.track = "audit";
  renameSync(f.legacy, `${f.legacy}-audit`);
  symlinkSync(`${f.legacy}-audit`, join(f.env.XDG_STATE_HOME, "alias-audit"));
  f.config.legacyWorkers = ["alias"];
  f.deps.fetch = vi.fn(async () => Response.json({ data: f.session }));
  expect(await f.service.command(["adopt", "--from-legacy"])).toContain(`Adopted ${f.id}`);
  expect(f.saved().directory).toBe(f.directory);
});

test.each(["ses_one\nses_two\n", "not-a-session\n", "", "id=ses_untrusted\n"])(
  "rejects malformed bare-id records %j",
  async (content) => {
    const f = legacyFixture({ ...legacyFiles.vecs, content });
    expect(await f.service.command(["adopt", "--from-legacy"])).toContain("Invalid legacy record");
    expect(f.hooks.metadata).not.toHaveBeenCalled();
    f.done();
  }
);

test("JSON imports only the verified session model and rejects conflicting legacy PR/repo hints", async () => {
  const f = legacyFixture();
  rmSync(join(f.legacy, f.key));
  const path = join(f.legacy, `${f.pr}.json`);
  for (const hints of [{ pr: 999 }, { repo: "foreign/repo" }]) {
    writeFileSync(path, JSON.stringify({ id: f.id, ...hints }));
    expect(await f.service.command(["adopt", "--from-legacy"])).toContain("Invalid legacy record");
  }
  writeFileSync(
    path,
    JSON.stringify({
      id: f.id,
      pr: f.pr,
      repo: f.config.repo,
      model: "untrusted",
      directory: "/untrusted",
    })
  );
  f.deps.fetch = vi.fn(async () => Response.json({ data: f.session }));
  expect(await f.service.command(["adopt", "--from-legacy"])).toContain("Adopted");
  expect(f.saved()).toMatchObject({ directory: f.directory, model: { model: "fake/glm" } });
});

test.each([0, 0.5, 13])(
  "legacy-only Estimate fallback preserves the exact board value %s",
  async (estimate) => {
    const f = legacyFixture();
    f.meta.pointsOpen = undefined;
    f.meta.estimate = estimate;
    f.deps.fetch = vi.fn(async () => Response.json({ data: f.session }));
    expect(await f.service.command(["adopt", "--from-legacy"])).toContain(
      "legacy snapshot at adoption"
    );
    expect(f.saved()).toMatchObject({
      points_open: estimate,
      segments: [{ why: "legacy snapshot at adoption" }],
    });
  }
);

function status(active = false, messages: unknown[] = [], permissions: unknown[] = []): Request[] {
  return [
    { path: "/api/session/active", data: active ? { ses_fake: {} } : {} },
    { path: "/api/session/ses_fake", data: { id: "ses_fake" } },
    { path: "/api/session/ses_fake/permission", data: permissions },
    { path: "/api/session/ses_fake/message", data: messages },
  ];
}

test("status flags an OpenCode session title that differs from the project and PR", async () => {
  const f = fixture([
    ...start,
    ...status().map((request) =>
      request.path === "/api/session/ses_fake"
        ? { ...request, data: { id: "ses_fake", title: "generated title" } }
        : request
    ),
  ]);
  await f.service.command(["start", "31"]);
  const output = await f.service.command(["status", "31"]);
  expect(output).toContain('TITLE MISMATCH expected "project#31"');
  f.done();
});

const wake = "[orchestrator] ANSWER is on your PR; read it with vmethod read pr 31 and act.";
const wakeRequest: Request = {
  path: "/api/session/ses_fake/prompt",
  method: "POST",
  body: { text: wake, delivery: "queue" },
};

test("resume without a recorded session reports absence without sending", async () => {
  const f = fixture();
  expect(await f.service.resume(31, wake)).toBe("no worker session for #31; nothing sent");
  f.done();
});

test("resume wakes an idle session without steering", async () => {
  const f = fixture([...start, ...status(), wakeRequest]);
  await f.service.command(["start", "31"]);
  expect(await f.service.resume(31, wake)).toBe("sent to #31");
  f.done();
});

test("busy resume persists a queue, sends once after idle and never replays", async () => {
  const f = fixture([
    ...start,
    ...status(true),
    ...status(true),
    ...status(),
    wakeRequest,
    ...status(),
  ]);
  await f.service.command(["start", "31"]);
  expect(await f.service.resume(31, wake)).toBe("queued for #31");
  expect(f.record().pendingWake).toEqual([wake]);
  const restarted = new WorkerService(f.root, f.config, f.env, f.deps, f.hooks);
  await restarted.watchStatus(31);
  expect(f.record().pendingWake).toEqual([wake]);
  await restarted.watchStatus(31);
  expect(f.record().pendingWake).toBeUndefined();
  await restarted.watchStatus(31);
  f.done();
});

test("Claude busy resume waits for process exit and launches only once", async () => {
  const f = fixture();
  f.meta.model = "sonnet";
  await f.service.command(["start", "31"]);
  expect(await f.service.resume(31, wake)).toBe("queued for #31");
  await f.service.watchStatus(31);
  expect(f.deps.processes!.launch).toHaveBeenCalledTimes(1);
  vi.mocked(f.deps.processes!.alive).mockReturnValue(false);
  writeFileSync(
    join(f.directory, ".tmp/claude-worker.log"),
    JSON.stringify(claudeResults[0]) + "\n"
  );
  await f.service.watchStatus(31);
  expect(f.deps.processes!.launch).toHaveBeenCalledTimes(2);
  expect(f.deps.processes!.launch).toHaveBeenLastCalledWith(
    expect.objectContaining({ prompt: `project#31\n\n${wake}` })
  );
  await f.service.watchStatus(31);
  expect(f.deps.processes!.launch).toHaveBeenCalledTimes(2);
  f.done();
});

test("failed queued delivery preserves the notification for the next idle poll", async () => {
  const f = fixture([
    ...start,
    ...status(true),
    ...status(),
    { ...wakeRequest, status: 502 },
    ...status(),
    wakeRequest,
    ...status(),
  ]);
  await f.service.command(["start", "31"]);
  await f.service.resume(31, wake);
  await expect(f.service.watchStatus(31)).rejects.toThrow("502");
  expect(f.record().pendingWake).toEqual([wake]);
  await f.service.watchStatus(31);
  expect(f.record().pendingWake).toBeUndefined();
  await f.service.watchStatus(31);
  f.done();
});

test("start persists one session per PR, uses PR body and gateway model payload, and updates Model", async () => {
  const f = fixture([...start, ...status()]);
  expect(await f.service.command(["start", "31"])).toContain("ses_fake");
  expect(f.record()).toMatchObject({
    id: "ses_fake",
    issue: 9,
    points_open: 8,
    model: { family: "glm" },
    segments: [{ why: "start", rounds: [1] }],
  });
  expect(f.hooks.setModel).toHaveBeenCalledWith(31, "glm");
  await expect(f.service.command(["start", "31"])).rejects.toThrow("live session");
  f.done();
});

test("start restores the explicit title when OpenCode retitles after the first prompt", async () => {
  const f = fixture([
    { path: "/api/session", method: "POST", data: { id: "ses_fake" } },
    {
      path: "/api/session/ses_fake/prompt",
      method: "POST",
      body: { text: "PR description `data`", delivery: "steer" },
    },
    { path: "/api/session/ses_fake", data: { id: "ses_fake", title: "generated title" } },
    {
      path: "/api/session/ses_fake",
      method: "PATCH",
      body: { title: "project#31" },
    },
  ]);
  await expect(f.service.command(["start", "31"])).resolves.toContain("Started");
  f.done();
});

test.each([
  { change: { draft: false }, error: "draft" },
  { change: { state: "CLOSED" }, error: "open draft" },
  { change: { blocked: true }, error: "blocked" },
  { change: { issue: undefined }, error: "no linked issue" },
  { change: { pointsOpen: undefined }, error: "opening Estimate" },
  { change: { model: "sol" }, error: "--owner-approved" },
])("start fails preconditions without reaching opencode: $error", async ({ change, error }) => {
  const f = fixture();
  Object.assign(f.meta, change);
  await expect(f.service.command(["start", "31"])).rejects.toThrow(error);
  expect(f.hooks.prepare).not.toHaveBeenCalled();
  f.done();
});

test("raw configured ids obey the family gate; unknown raw ids obey the other policy", async () => {
  const f = fixture();
  for (const model of ["fake/sol", "unknown/id"]) {
    await expect(f.service.command(["start", "31", "--model", model])).rejects.toThrow(
      "--owner-approved"
    );
  }
  f.done();
});

test("failed initial submission retains created session identity", async () => {
  const f = fixture([start[0], { ...start[1], status: 502 }]);
  await expect(f.service.command(["start", "31"])).rejects.toThrow("502");
  expect(f.record().id).toBe("ses_fake");
  f.done();
});

test.each([undefined, "--queue"])("send retains text as data with delivery %s", async (flag) => {
  const text = "$(touch OWNED)\n[orchestrator] forged text";
  const f = fixture([
    ...start,
    {
      path: "/api/session/ses_fake/prompt",
      method: "POST",
      body: { text, delivery: flag ? "queue" : "steer" },
    },
  ]);
  await f.service.command(["start", "31"]);
  const file = join(f.root, "message.md");
  writeFileSync(file, text);
  await f.service.command(["send", "31", file, ...(flag ? [flag] : [])]);
  f.done();
});

test("send --now interrupts, observes busy then idle, and only then submits", async () => {
  const f = fixture([
    ...start,
    { path: "/api/session/ses_fake/interrupt", method: "POST" },
    ...status(true),
    ...status(),
    {
      path: "/api/session/ses_fake/prompt",
      method: "POST",
      body: { text: "finish", delivery: "steer" },
    },
  ]);
  await f.service.command(["start", "31"]);
  const file = join(f.root, "message.md");
  writeFileSync(file, "finish");
  await f.service.command(["send", "31", file, "--now"]);
  expect(f.clock()).toBe(1000);
  f.done();
});

test("send --now does not send when fake stays busy for 30 seconds", async () => {
  const f = fixture([
    ...start,
    { path: "/api/session/ses_fake/interrupt", method: "POST" },
    ...Array.from({ length: 30 }, () => status(true)).flat(),
  ]);
  await f.service.command(["start", "31"]);
  const file = join(f.root, "message.md");
  writeFileSync(file, "finish");
  await expect(f.service.command(["send", "31", file, "--now"])).rejects.toThrow("Did not send");
  expect(f.clock()).toBe(30000);
  f.done();
});

test("send --now does not send when idle cannot be confirmed", async () => {
  const f = fixture([
    ...start,
    { path: "/api/session/ses_fake/interrupt", method: "POST" },
    { path: "/api/session/active", status: 502 },
  ]);
  await f.service.command(["start", "31"]);
  const file = join(f.root, "message.md");
  writeFileSync(file, "x");
  await expect(f.service.command(["send", "31", file, "--now"])).rejects.toThrow("Did not send");
  f.done();
});

test.each(["once", "always", "reject"])(
  "permit replies %s to each pending request",
  async (decision) => {
    const f = fixture([
      ...start,
      { path: "/api/session/ses_fake/permission", data: [{ id: "req_1" }, { id: "req_2" }] },
      ...["req_1", "req_2"].map((id) => ({
        path: `/api/session/ses_fake/permission/${id}/reply`,
        method: "POST",
        body: { decision },
      })),
    ]);
    await f.service.command(["start", "31"]);
    await f.service.command(["permit", "31", decision]);
    f.done();
  }
);

test.each([
  {
    turn: {
      type: "idle",
      outcome: "failed",
      error: { status: 502, message: "provider unavailable" },
    },
    reason: "provider-error",
    text: "provider unavailable",
  },
  {
    turn: {
      type: "idle",
      outcome: "failed",
      error: { status: 429, message: "quota exhausted; remaining 0" },
    },
    reason: "quota",
    text: "remaining 0",
  },
])(
  "status reports $reason with turn error and fallback but never switches",
  async ({ turn, reason, text }) => {
    const f = fixture([...start, ...status(false, [turn])]);
    await f.service.command(["start", "31"]);
    const output = await f.service.command(["status", "31"]);
    expect(output).toContain(reason);
    expect(output).toContain(text);
    expect(output).toContain("QUOTA glm; fallback: sol");
    expect(f.record().model.family).toBe("glm");
    f.done();
  }
);

test("status distinguishes permission, running, unknown and idle without an authenticated reply", async () => {
  const f = fixture([
    ...start,
    ...status(true, [], [{ id: "request" }]),
    ...status(true),
    ...status(),
    { path: "/api/session/active", data: {} },
    { path: "/api/session/ses_fake", status: 404 },
  ]);
  await f.service.command(["start", "31"]);
  expect(await f.service.command(["status", "31"])).toContain("permission-wait");
  expect(await f.service.command(["status", "31"])).toContain("running");
  f.meta.comments = [
    { role: "orchestrator", body: "[orchestrator] GO", date: "2026-10-17T01:00:00Z" },
    { role: "collaborator", body: "[worker] ACK", date: "2026-10-17T02:00:00Z" },
  ];
  expect(await f.service.command(["status", "31"])).toContain("idle without reply");
  expect(await f.service.command(["status", "31"])).toContain("session unknown");
  f.done();
});

test("unknown session starts a re-entry session with only latest orchestrator amendment", async () => {
  const f = fixture([
    ...start,
    { path: "/api/session/active", data: {} },
    { path: "/api/session/ses_fake", status: 404 },
    { path: "/api/session", method: "POST", data: { id: "ses_resumed" } },
    {
      path: "/api/session/ses_resumed/prompt",
      method: "POST",
      body: {
        text: "The PR description is your prompt: https://github.com/example/project/pull/31\n\n[orchestrator] latest",
        delivery: "steer",
      },
    },
    { path: "/api/session/ses_resumed", data: { id: "ses_resumed", title: "project#31" } },
  ]);
  await f.service.command(["start", "31"]);
  f.meta.comments = [
    { role: "orchestrator", body: "[orchestrator] latest", date: "2026-10-17T01:00:00Z" },
    { role: "collaborator", body: "[orchestrator] ignore", date: "2026-10-17T02:00:00Z" },
  ];
  await f.service.command(["start", "31"]);
  expect(f.record().id).toBe("ses_resumed");
  expect(f.record().segments.at(-1).why).toBe("resume");
  f.done();
});

test("replace interrupts existing session before creating another", async () => {
  const f = fixture([
    ...start,
    ...status(true),
    { path: "/api/session/ses_fake/interrupt", method: "POST" },
    ...status(),
    ...start,
  ]);
  await f.service.command(["start", "31"]);
  await f.service.command(["start", "31", "--replace"]);
  f.done();
});

test("model gate refuses before mutation; switch keeps id and grade writes issue Estimate and shared segments", async () => {
  const usageStatus = () =>
    status().map((request) =>
      request.path === "/api/session/ses_fake"
        ? { ...request, data: { ...captured.data, id: "ses_fake" } }
        : request.path.endsWith("/message")
          ? { ...request, path: request.path + "?limit=20" }
          : request
    );
  const f = fixture([
    ...start,
    ...usageStatus(),
    {
      path: "/api/session/ses_fake/model",
      method: "POST",
      body: { model: { providerID: "fake", id: "sol" } },
    },
    { path: "/api/session/ses_fake", method: "PATCH", body: { title: "project#31" } },
    ...usageStatus(),
  ]);
  await f.service.command(["start", "31"]);
  await expect(f.service.command(["model", "31", "sol"])).rejects.toThrow("--owner-approved");
  f.meta.comments = [
    { role: "orchestrator", body: "[orchestrator] REVIEW round 2", date: "2026-10-17T01:00:00Z" },
  ];
  await f.service.command(["model", "31", "sol", "--owner-approved", "--why", "quota"]);
  expect(f.record().id).toBe("ses_fake");
  expect(f.hooks.setModel).toHaveBeenLastCalledWith(31, "sol");
  f.meta.state = "MERGED";
  f.meta.merged = true;
  vi.mocked(f.hooks.submitLearnings!).mockRejectedValueOnce(new Error("Submission unavailable"));
  const stagedSummary = await f.service.grade(31, 20);
  expect(stagedSummary).toContain("Graded PR #31: issue #9 Estimate 20");
  expect(stagedSummary).toContain(
    "\nlearnings submit failed: Submission unavailable; the record is staged locally, rerun vmethod learnings submit"
  );
  expect(f.record().finalized).toBe(true);
  expect(f.record().gradePosted).toBe(true);
  expect(f.hooks.setEstimate).toHaveBeenCalledWith(9, 20);
  const records = readFileSync(join(f.root, ".vmethod/model-log.jsonl"), "utf8").trim().split("\n");
  expect(records).toHaveLength(1);
  expect(JSON.parse(records[0])).toMatchObject({
    repo: "example/project",
    pr: 31,
    points_open: 8,
    points_final: 20,
    outcome: "merged",
    rounds: 2,
    segments: [
      { family: "glm", why: "start", rounds: [1] },
      { family: "sol", why: "quota", rounds: [2] },
    ],
  });
  const summary = await f.service.grade(31, 20);
  expect(summary).toContain("issue #9 Estimate 20");
  expect(summary).toContain("Learning submission complete");
  expect(f.hooks.submitLearnings).toHaveBeenCalledTimes(2);
  expect(f.hooks.gradeComment).toHaveBeenCalledTimes(1);
  expect(
    readFileSync(join(f.root, ".vmethod/model-log.jsonl"), "utf8").trim().split("\n")
  ).toHaveLength(1);
  await expect(f.service.grade(31, 13)).rejects.toThrow("already graded");
  f.done();
});

test("grade refuses missing issue and missing session history without Estimate writes", async () => {
  const f = fixture();
  f.meta.state = "CLOSED";
  f.meta.issue = undefined;
  await expect(f.service.grade(31, 5)).rejects.toThrow("no linked issue");
  f.meta.issue = 9;
  await expect(f.service.grade(31, 5)).rejects.toThrow("session history");
  expect(f.hooks.setEstimate).not.toHaveBeenCalled();
  f.done();
});

test("Claude requires worker identity, retains context on send and never uses an opencode endpoint", async () => {
  const f = fixture();
  f.meta.model = "sonnet";
  vi.mocked(f.hooks.workerIdentity).mockRejectedValueOnce(
    new Error("worker-scoped identity required")
  );
  await expect(f.service.command(["start", "31"])).rejects.toThrow("worker-scoped");
  await f.service.command(["start", "31"]);
  expect(f.deps.processes!.launch).toHaveBeenCalledWith(
    expect.objectContaining({
      args: expect.arrayContaining(["--session-id", "--permission-mode", "acceptEdits"]),
      env: { GH_TOKEN: "worker-token", PATH: "fake-path", VMETHOD_TASK_PR: "31" },
    })
  );
  await expect(f.service.command(["start", "31"])).rejects.toThrow("live session");
  const file = join(f.root, "message.md");
  writeFileSync(file, "next");
  await expect(f.service.command(["send", "31", file])).rejects.toThrow("running");
  // A result after interruption lets --now observe idle before resuming the same Claude id.
  writeFileSync(
    join(f.directory, ".tmp/claude-worker.log"),
    JSON.stringify({ type: "result", subtype: "success" }) + "\n"
  );
  await f.service.command(["send", "31", file, "--now"]);
  expect(f.deps.processes!.launch).toHaveBeenLastCalledWith(
    expect.objectContaining({ args: expect.arrayContaining(["--resume", f.record().id]) })
  );
  f.done();
});

test("status and log redact credentials in provider payloads", async () => {
  const f = fixture([
    ...start,
    ...status(false, [{ type: "idle", outcome: "failed", error: { message: "secret-password" } }]),
    { path: "/api/session/ses_fake/message?limit=2", data: [{ error: "secret-password" }] },
  ]);
  await f.service.command(["start", "31"]);
  for (const args of [
    ["status", "31"],
    ["log", "31", "2"],
  ]) {
    const output = await f.service.command(args);
    expect(output).not.toContain("secret-password");
    expect(output).toContain("[redacted]");
  }
  f.done();
});

test("suggest-model prints Estimate/kind, local learning and owner gate without starting sessions", async () => {
  const f = fixture();
  vi.mocked(f.hooks.issue).mockResolvedValue({ estimate: 13, kind: "architecture" });
  mkdirSync(join(f.root, "learnings/models"), { recursive: true });
  writeFileSync(
    join(f.root, "learnings/models/sol.md"),
    "# sol\n\nEvidence-based design guidance\n"
  );
  const output = await f.service.suggest(9);
  expect(output).toContain("sol: Estimate 13");
  expect(output).toContain("--owner-approved");
  expect(output).toContain("Evidence-based design guidance");
  f.done();
});

test("two-user access uses unprivileged shared-group modes with optional ACL fallback", async () => {
  const f = fixture();
  f.config.workerUser = "second-user";
  f.config.workerGroup = "workers";
  f.config.branches = { mainCheckout: f.root, worktreeRoot: ".worktrees" };
  const calls: { file: string; args: readonly string[] }[] = [];
  f.deps.exec = async (file, args) => {
    calls.push({ file, args });
    if (file === "id") {
      return args[0] === "-u" ? "1001" : "1001 2002";
    }
    if (file === "getent") {
      return "workers:x:2002:first-user,second-user";
    }
    if (file === "setfacl") {
      throw new Error("ACL unavailable");
    }
    throw new Error(`Unexpected command ${file}`);
  };
  const directories = [f.directory, join(f.directory, "node_modules"), join(f.directory, ".tmp")];
  const stats = new Map(
    directories.map((path) => [
      path,
      { uid: 2003, gid: 2002, mode: 0o2775, directory: true, symlink: false },
    ])
  );
  f.deps.workerFilesystem = {
    stat: (path) => {
      const stat = stats.get(path);
      if (!stat) {
        throw new Error(`Unknown fake path ${path}`);
      }
      return stat;
    },
    children: (path) => (path === f.directory ? directories.slice(1) : []),
    chmod: (path, mode) => {
      stats.get(path)!.mode = mode;
    },
    mkdir: () => {},
    realpath: (path) => path,
  };
  await workerAccess(f.root, f.directory, f.config, f.deps);
  expect(calls.map((call) => call.file)).toEqual([
    "getent",
    "id",
    "id",
    "id",
    "setfacl",
    "setfacl",
    "setfacl",
  ]);
  expect(JSON.stringify(calls)).not.toContain("secret-password");
  stats.get(f.directory)!.gid = 999;
  await expect(workerAccess(f.root, f.directory, f.config, f.deps)).rejects.toThrow(
    "must use group workers"
  );
  stats.get(f.directory)!.gid = 2002;
  stats.get(f.directory)!.mode = 0o775;
  await expect(workerAccess(f.root, f.directory, f.config, f.deps)).rejects.toThrow("setgid");
  await expect(workerAccess(f.root, f.root, f.config, f.deps)).rejects.toThrow("escapes");
  f.done();
});

test("OpencodeClient status(directory, id) preserves explicit worker session status", async () => {
  const f = fixture([
    { path: "/api/session/active", data: { ses_fake: { location: { directory: "/task" } } } },
    ...status(false, [{ type: "idle", outcome: "failed", error: { message: "502 outage" } }]).slice(
      1
    ),
  ]);
  const client = new OpencodeClient(f.env, f.deps.fetch);
  expect(await client.status("/task", "ses_fake")).toMatchObject({
    reason: "running",
    active: true,
  });
  f.done();
});

test("start refuses a missing executable before creating any session", async () => {
  const f = fixture();
  chmodSync(join(f.directory, "node_modules/.bin/vmethod"), 0o644);
  await expect(f.service.command(["start", "31"])).rejects.toThrow("node_modules/.bin/vmethod");
  f.done();
});

test("models, health, permission listing, log, stop, wait and all-session status use the gateway", async () => {
  const f = fixture([
    { path: "/api/model", data: [{ providerID: "fake", id: "glm" }] },
    { path: "/api/session/active", data: {} },
    ...start,
    { path: "/api/session/ses_fake/permission", data: [{ id: "req", tool: "shell" }] },
    {
      path: "/api/session/ses_fake/message?limit=3",
      data: [{ type: "assistant", content: [{ type: "text", text: "hello" }] }],
    },
    { path: "/api/session/ses_fake/interrupt", method: "POST" },
    ...status(true),
    ...status(),
    ...status(),
  ]);
  expect(await f.service.command(["models"])).toContain("fake/glm");
  expect(await f.service.command(["health"])).toContain("accepts our login");
  await f.service.command(["start", "31"]);
  expect(await f.service.command(["permit", "31"])).toContain("req");
  expect(await f.service.command(["log", "31", "3"])).toContain("hello");
  await f.service.command(["stop", "31"]);
  expect(await f.service.command(["wait", "31", "3"])).toContain("idle");
  expect(await f.service.command(["status"])).toContain("#31 ses_fake idle");
  f.done();
});

test("one deadline includes interrupt and all status reads, not just sleeps", async () => {
  const f = fixture([
    ...start,
    { path: "/api/session/ses_fake/interrupt", method: "POST" },
    { path: "/api/session/active", data: { ses_fake: {} } },
    { path: "/api/session/ses_fake", data: { id: "ses_fake" } },
  ]);
  await f.service.command(["start", "31"]);
  const fetcher = f.deps.fetch;
  f.deps.fetch = async (input, init) => {
    const response = await fetcher(input, init);
    await f.deps.sleep(10000);
    return response;
  };
  const file = join(f.root, "message.md");
  writeFileSync(file, "do not deliver");
  await expect(f.service.command(["send", "31", file, "--now"])).rejects.toThrow("Did not send");
  expect(f.clock()).toBe(30000);
  f.done();
});

test("simultaneous starts are serialized by an exclusive per-PR lock", async () => {
  const f = fixture([...start]);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const preparing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.mocked(f.hooks.prepare).mockImplementation(async () => {
    entered();
    await gate;
    return f.directory;
  });
  const first = f.service.command(["start", "31"]);
  await preparing;
  await expect(f.service.command(["start", "31"])).rejects.toThrow("locked");
  release();
  await first;
  f.done();
});

test("invalid CLI combinations and cross-backend switches never send or switch", async () => {
  const f = fixture([...start]);
  await f.service.command(["start", "31"]);
  await expect(f.service.command(["send", "31", "file", "--queue", "--now"])).rejects.toThrow(
    "Usage"
  );
  await expect(f.service.command(["model", "31", "sonnet"])).rejects.toThrow("backend");
  await expect(f.service.command(["permit", "31", "yes"])).rejects.toThrow("Usage");
  await expect(f.service.command(["wait", "31", "Infinity"])).rejects.toThrow("integer");
  await expect(f.service.command(["log", "31", "0"])).rejects.toThrow("integer");
  f.done();
});
