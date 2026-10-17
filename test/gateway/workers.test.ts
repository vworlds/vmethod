import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { stringify } from "yaml";
import { getConfig } from "../../src/config.js";
import { OpencodeClient, type Dependencies } from "../../src/gateway/client.js";
import { WorkerService, type TaskMetadata, type WorkerHooks } from "../../src/gateway/workers.js";
import { workerAccess } from "../../src/gateway/access.js";
import { validProject } from "../helpers.js";

interface Request {
  path: string;
  method?: string;
  body?: unknown;
  data?: unknown;
  status?: number;
}
function fixture(requests: Request[] = []) {
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
      },
      {
        family: "sol",
        model: "fake/sol",
        kind: "opencode",
        gate: "owner",
        tier: "expensive",
        fallback: ["glm"],
      },
      { family: "sonnet", model: "claude-test", kind: "claude", gate: "none", tier: "standard" },
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
    workerIdentity: vi.fn(async () => ({ GH_TOKEN: "worker-token", PATH: "fake-path" })),
    issue: vi.fn(async () => ({ estimate: 3, kind: "tooling" })),
  };
  const config = getConfig(root, {});
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
];
test("watch status uses the recorded task session and client update time without reading comments", async () => {
  const f = fixture([
    ...start,
    { path: "/api/session/active", data: { ses_fake: true } },
    { path: "/api/session/ses_fake", data: { id: "ses_fake", time: { updated: 123_456 } } },
    { path: "/api/session/ses_fake/permission", data: [] },
    { path: "/api/session/ses_fake/message?limit=20", data: [] },
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
  f.deps.fetch = vi.fn(async () =>
    Response.json({
      data: {
        id: "ses_existing",
        directory: f.directory,
        model: { providerID: "fake", id: "glm" },
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
  expect(f.deps.fetch).toHaveBeenCalledTimes(1);
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
function status(active = false, messages: unknown[] = [], permissions: unknown[] = []): Request[] {
  return [
    { path: "/api/session/active", data: active ? { ses_fake: {} } : {} },
    { path: "/api/session/ses_fake", data: { id: "ses_fake" } },
    { path: "/api/session/ses_fake/permission", data: permissions },
    { path: "/api/session/ses_fake/message?limit=20", data: messages },
  ];
}

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
  const f = fixture([
    ...start,
    {
      path: "/api/session/ses_fake/model",
      method: "POST",
      body: { model: { providerID: "fake", id: "sol" } },
    },
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
  expect(await f.service.grade(31, 20)).toContain("issue #9 Estimate 20");
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
  await f.service.grade(31, 20);
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
