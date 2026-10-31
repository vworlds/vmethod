import { expect, test, vi } from "vitest";
import { watchClient } from "../src/cli/watch.js";
import { gatewayVerb } from "../src/cli/gateway.js";
import type { Transport } from "../src/gateway/transport.js";
import { actor, fixtureServer } from "./gateway/helpers.js";
import { WatchFake } from "./gateway/watch-fake.js";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { stringify } from "yaml";
import { loadMigrations } from "../src/board/migrations.js";
import { isWatchCmdline } from "../src/gateway/watch-stop.js";

test("--once writes the batch completely before a zero-timeout ack", async () => {
  const call = vi.fn<Transport["call"]>();
  const events = [
    { id: "c-1", kind: "question", line: "QUESTION #1", quiet: ["NOTE #1"] },
    { id: "c-2", kind: "comment", line: "COMMENT #2" },
  ];
  call.mockResolvedValueOnce({ events }).mockResolvedValueOnce({ events: [] });
  const writes: string[] = [];
  await watchClient(
    { call },
    ["--once", "--only", "1,2"],
    { VMETHOD_ROLE: "orchestrator" },
    async (text) => {
      expect(call).toHaveBeenCalledTimes(1);
      writes.push(text);
    }
  );
  expect(writes).toEqual([
    "quiet since the last wake-up:\n  NOTE #1\nQUESTION #1\n",
    "COMMENT #2\n",
  ]);
  expect(call.mock.calls[1]).toEqual([
    "nextEvents",
    { only: [1, 2], timeoutSeconds: 0, ack: ["c-1", "c-2"] },
    { role: "orchestrator" },
  ]);
  expect(call.mock.calls[0][1]).toEqual({
    only: [1, 2],
    timeoutSeconds: 0,
    pollOnce: true,
    ack: [],
    watchStart: true,
  });
});

test("stdout failure never acknowledges a batch; timeouts re-arm instead of exiting", async () => {
  const call = vi.fn<Transport["call"]>();
  call.mockResolvedValueOnce({ events: [] }).mockResolvedValueOnce({
    events: [{ id: "1", kind: "comment", line: "COMMENT" }],
    debounceSeconds: 0,
  });
  await expect(
    watchClient({ call }, [], {}, async () => {
      throw new Error("closed stdout");
    })
  ).rejects.toThrow("closed stdout");
  expect(call).toHaveBeenCalledTimes(2);
  expect(call.mock.calls.every(([, input]) => !("ack" in input) || !input.ack?.length)).toBe(true);
});

test("watch --stop calls the gateway stop operation, prints its verdict and exits by code", async () => {
  const call = vi.fn<Transport["call"]>().mockResolvedValue({
    text: "watcher stopped (pid 7)",
    code: 0,
  });
  const writes: string[] = [];
  const code = await watchClient(
    { call },
    ["--stop", "--only", "3"],
    { VMETHOD_ROLE: "orchestrator" },
    async (text) => {
      writes.push(text);
    }
  );
  expect(call).toHaveBeenCalledTimes(1);
  expect(call.mock.calls[0]).toEqual([
    "watchStop",
    { only: [3], force: false },
    { role: "orchestrator" },
  ]);
  expect(writes).toEqual(["watcher stopped (pid 7)\n"]);
  expect(code).toBeUndefined();

  const refusal = vi.fn<Transport["call"]>().mockResolvedValue({
    text: "stale watcher lock (pid 5 not running); remove with --stop --force",
    code: 1,
  });
  const reported: string[] = [];
  expect(
    await watchClient(
      { call: refusal },
      ["--stop"],
      { WATCH_SKIP: "9", VMETHOD_ROLE: "orchestrator" },
      async (text) => {
        reported.push(text);
      }
    )
  ).toBe(1);
  expect(refusal.mock.calls[0][1]).toEqual({ skip: [9], force: false });
  expect(reported).toEqual([
    "stale watcher lock (pid 5 not running); remove with --stop --force\n",
  ]);
});

test("watch --stop --force passes the force flag; malformed combinations refuse", async () => {
  const call = vi
    .fn<Transport["call"]>()
    .mockResolvedValue({ text: "no watcher running", code: 0 });
  await watchClient(
    { call },
    ["--stop", "--force", "--track", "alpha"],
    { VMETHOD_ROLE: "orchestrator" },
    async () => {}
  );
  expect(call.mock.calls[0][1]).toEqual({ track: "alpha", force: true });
  await expect(watchClient({ call }, ["--force"], {}, async () => {})).rejects.toThrow(
    "--force needs --stop"
  );
  await expect(watchClient({ call }, ["--stop", "--once"], {}, async () => {})).rejects.toThrow(
    "--stop cannot be combined with --once or --replay"
  );
  await expect(
    watchClient({ call }, ["--stop", "--replay", "previous"], {}, async () => {})
  ).rejects.toThrow("--stop cannot be combined with --once or --replay");
});

test("a second --once on existing state with nothing new polls once and exits without a timeout wait", async () => {
  const f = new WatchFake();
  try {
    let loop = f.loop();
    const call = vi.fn<Transport["call"]>().mockImplementation(async (operation, input) => {
      expect(operation).toBe("nextEvents");
      return loop.nextEvents(
        input as { timeoutSeconds: number; pollOnce?: boolean; ack?: string[] }
      );
    });
    const write = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    await watchClient({ call }, ["--once"], { VMETHOD_ROLE: "orchestrator" }, write);
    loop.close();
    loop = f.loop();
    const requestsBefore = f.requests.length;
    await watchClient({ call }, ["--once"], { VMETHOD_ROLE: "orchestrator" }, write);
    expect(call).toHaveBeenCalledTimes(3);
    expect(f.requests.length).toBeGreaterThan(requestsBefore);
    expect(
      f.requests.slice(requestsBefore).filter((request) => request.includes("/graphql"))
    ).toHaveLength(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toContain("in use: read");
    expect(f.sleeps).toEqual([]);
  } finally {
    f.done();
  }
}, 2000);

test("empty --once does not re-arm, including the legacy ONESHOT setting", async () => {
  const call = vi.fn<Transport["call"]>().mockResolvedValue({ events: [] });
  await watchClient({ call }, [], { ONESHOT: "1" }, async () => {
    throw new Error("unexpected stdout");
  });
  expect(call).toHaveBeenCalledTimes(1);
  expect(call.mock.calls[0][1]).toMatchObject({ timeoutSeconds: 0, pollOnce: true });
});

test("guide notice is acknowledged only after successful stdout, even without events", async () => {
  const call = vi
    .fn<Transport["call"]>()
    .mockResolvedValue({ events: [], notice: "vmethod test in use: read guide" });
  await expect(
    watchClient({ call }, ["--once"], {}, async () => {
      throw new Error("closed");
    })
  ).rejects.toThrow("closed");
  expect(call).toHaveBeenCalledTimes(1);
  call.mockClear();
  await watchClient({ call }, ["--once"], {}, async () => {});
  expect(call.mock.calls[1][1]).toEqual({ timeoutSeconds: 0, ack: [], guideSeen: true });
});

test("replay prints complete digests and wake lines once without starting or acknowledging", async () => {
  const call = vi.fn<Transport["call"]>().mockResolvedValue({
    events: [
      { id: "lost", kind: "ready", line: "READY #24", quiet: ["NOTE #24"] },
      { id: "next", kind: "comment", line: "COMMENT #25" },
    ],
  });
  const writes: string[] = [];
  await watchClient({ call }, ["--replay", "previous", "--track", "alpha"], {}, async (text) => {
    writes.push(text);
  });
  expect(writes).toEqual([
    "quiet since the last wake-up:\n  NOTE #24\nREADY #24\n",
    "COMMENT #25\n",
  ]);
  expect(call.mock.calls).toEqual([
    ["nextEvents", { track: "alpha", replay: "previous", timeoutSeconds: 0 }, { role: "worker" }],
  ]);
});

test("built CLI --once exits promptly on two successive empty runs against the same state", async () => {
  const f = fixtureServer([]);
  mkdirSync(join(f.root, "dist"));
  mkdirSync(join(f.root, "docs"));
  writeFileSync(join(f.root, "docs/orchestrator-guide.md"), "# Guide\n");
  const cli = join(f.root, "dist/watch-cli.mjs");
  const preload = join(f.root, "offline-fetch.mjs");
  writeFileSync(
    join(f.root, "vmethod.yaml"),
    stringify({
      repo: "example/project",
      org: "example",
      baseBranch: "dev",
      stateName: "watch-cli",
      board: { enabled: false, owner: "example", number: 5, repos: ["example/project"] },
      vmethod: { repo: "off" },
      gateway: { maxRetries: 0 },
    })
  );
  // Strict offline wire responses: any unexpected request is reported by the CLI
  // and makes the stderr assertion fail, even if the watcher catches the error.
  writeFileSync(
    preload,
    `globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (String(url) === 'https://api.github.com/graphql' && init.method === 'POST' && JSON.parse(init.body).query === 'query GatewayIdentity { viewer { databaseId login __typename } }') return Response.json({data:{viewer:${JSON.stringify(actor(2))}}});
    if (url.origin !== 'https://api.github.com' || init.method !== 'GET') throw new Error('Unexpected request ' + url);
    let data;
    if (url.pathname === '/user') data = {login:'me',id:999};
    else if (['/repos/example/project/issues','/repos/example/project/pulls','/repos/example/project/issues/comments'].includes(url.pathname)) data = [];
    else throw new Error('Unexpected request ' + url);
    return new Response(JSON.stringify(data));
  };`
  );
  await build({
    entryPoints: ["src/cli/main.ts"],
    outfile: cli,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
    },
    define: {
      __VERSION__: '"test"',
      __BOARD_VERSION__: "2",
      __MIGRATIONS__: JSON.stringify(loadMigrations()),
    },
  });
  for (let run = 0; run < 2; run++) {
    const result = spawnSync(process.execPath, ["--import", preload, cli, "watch", "--once"], {
      cwd: f.root,
      env: { ...f.env, VMETHOD_ROOT: f.root, VMETHOD_ROLE: "orchestrator" },
      encoding: "utf8",
      timeout: 3000,
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    if (run === 0) {
      expect(result.stdout).toContain("vmethod test in use: read");
      expect(result.stdout).toContain("docs/orchestrator-guide.md");
      expect(result.stdout).toContain(
        "changes: https://github.com/vworlds/vmethod/releases/tag/vtest"
      );
    } else {
      expect(result.stdout).toBe("");
    }
  }
  f.done();
}, 15000);

test("built CLI stop flushes a pending bundle; SIGKILL instead leaves events for restart and replay", async () => {
  const f = fixtureServer([]);
  mkdirSync(join(f.root, "dist"));
  mkdirSync(join(f.root, "docs"));
  writeFileSync(join(f.root, "docs/orchestrator-guide.md"), "# Guide\n");
  const cli = join(f.root, "dist/vmethod.mjs");
  const preload = join(f.root, "offline-fetch.mjs");
  writeFileSync(
    join(f.root, "vmethod.yaml"),
    stringify({
      repo: "example/project",
      org: "example",
      baseBranch: "dev",
      stateName: "watch-stop",
      watch: { debounceSeconds: 60, debounceMaxSeconds: 60 },
      board: { enabled: false, owner: "example", number: 5, repos: ["example/project"] },
      vmethod: { repo: "off" },
      gateway: { maxRetries: 0 },
    })
  );
  writeFileSync(
    preload,
    `globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (String(url) === 'https://api.github.com/graphql' && init.method === 'POST' && JSON.parse(init.body).query === 'query GatewayIdentity { viewer { databaseId login __typename } }') return Response.json({data:{viewer:${JSON.stringify(actor(2))}}});
    if (url.origin !== 'https://api.github.com' || init.method !== 'GET') throw new Error('Unexpected request ' + url);
    let data;
    if (url.pathname === '/user') data = {login:'me',id:999};
    else if (['/repos/example/project/issues','/repos/example/project/pulls','/repos/example/project/issues/comments'].includes(url.pathname)) data = [];
    else throw new Error('Unexpected request ' + url);
    return new Response(JSON.stringify(data));
  };`
  );
  await build({
    entryPoints: ["src/cli/main.ts"],
    outfile: cli,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
    },
    define: {
      __VERSION__: '"test"',
      __BOARD_VERSION__: "2",
      __MIGRATIONS__: JSON.stringify(loadMigrations()),
    },
  });
  const env = { ...f.env, VMETHOD_ROOT: f.root, VMETHOD_ROLE: "orchestrator" };
  const watcherErrors: string[] = [];
  const watcherOutput: string[] = [];
  const state = join(f.env.XDG_STATE_HOME as string, "vmethod", "watch-stop-alpha");
  mkdirSync(state, { recursive: true });
  const seeded = [{ id: "buffered", kind: "comment", line: "COMMENT #6", once: true }];
  writeFileSync(join(state, "pending.json"), JSON.stringify(seeded));
  const watcher = spawn(process.execPath, ["--import", preload, cli, "watch", "--track", "alpha"], {
    cwd: f.root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  watcher.stderr?.on("data", (chunk: Buffer) => watcherErrors.push(String(chunk)));
  watcher.stdout?.on("data", (chunk: Buffer) => watcherOutput.push(String(chunk)));
  const exited = new Promise<number>((resolve) =>
    watcher.once("exit", (code: number | null) => resolve(code ?? -1))
  );
  try {
    const lock = join(f.env.XDG_STATE_HOME as string, "vmethod", "watch-stop-alpha", "lock");
    for (let i = 0; i < 100 && !existsSync(join(state, "delivered.jsonl")); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(existsSync(lock)).toBe(true);
    const holder = JSON.parse(readFileSync(lock, "utf8")) as { pid: number };
    expect(holder.pid).toBe(watcher.pid as number);
    expect(existsSync(join(state, "delivered.jsonl"))).toBe(true);
    expect(watcherOutput).toEqual([]);
    expect(isWatchCmdline(readFileSync(`/proc/${watcher.pid}/cmdline`, "utf8"))).toBe(true);

    const result = spawnSync(
      process.execPath,
      ["--import", preload, cli, "watch", "--stop", "--track", "alpha"],
      { cwd: f.root, env, encoding: "utf8", timeout: 30000 }
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`watcher stopped (pid ${watcher.pid as number})\n`);
    expect(existsSync(lock)).toBe(false);
    expect(watcherErrors.join("")).toBe("");
    const exit = await exited;
    expect(exit).toBe(0);
    expect(watcherOutput.join("")).toContain("\tCOMMENT #6\t");
    expect(watcherOutput.join("").split("\n").filter(Boolean)).toHaveLength(1);
  } finally {
    // Ours only; a healthy stop above has already left it exited.
    watcher.kill();
  }
  const killedState = join(f.env.XDG_STATE_HOME as string, "vmethod", "watch-stop-beta");
  mkdirSync(killedState, { recursive: true });
  writeFileSync(join(killedState, "pending.json"), JSON.stringify(seeded));
  const killedOutput: string[] = [];
  const killed = spawn(process.execPath, ["--import", preload, cli, "watch", "--track", "beta"], {
    cwd: f.root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  killed.stdout?.on("data", (chunk: Buffer) => killedOutput.push(String(chunk)));
  killed.stderr?.on("data", (chunk: Buffer) => watcherErrors.push(String(chunk)));
  const killedExit = new Promise((resolve) => killed.once("exit", resolve));
  try {
    for (let i = 0; i < 100 && !existsSync(join(killedState, "delivered.jsonl")); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(existsSync(join(killedState, "delivered.jsonl"))).toBe(true);
    expect(killedOutput).toEqual([]);
    killed.kill("SIGKILL");
    await killedExit;
    for (const flags of [["--replay", "previous"], ["--once"]]) {
      const restarted = spawnSync(
        process.execPath,
        ["--import", preload, cli, "watch", "--track", "beta", ...flags],
        {
          cwd: f.root,
          env,
          encoding: "utf8",
          timeout: 10000,
        }
      );
      expect(restarted.error).toBeUndefined();
      expect(restarted.status).toBe(0);
      expect(restarted.stderr).toBe("");
      expect(restarted.stdout).toContain("COMMENT #6\n");
    }
    expect(JSON.parse(readFileSync(join(killedState, "pending.json"), "utf8"))).toEqual([]);
    expect(watcherErrors).toEqual([]);
  } finally {
    killed.kill("SIGKILL");
  }
  f.done();
}, 60000);

test("watch, stop and mute operations are orchestrator-only, local mute commands need no network", async () => {
  const f = fixtureServer([]);
  for (const operation of [
    "nextEvents",
    "watchMute",
    "watchUnmute",
    "watchMutes",
    "watchStop",
  ] as const) {
    await expect(
      f.gateway.call(operation, { ref: "6", timeoutSeconds: 0 } as never, { role: "worker" })
    ).rejects.toThrow("denied");
  }
  expect(
    await gatewayVerb(f.transport, "mute", ["vworlds/vmethod#6"], { VMETHOD_ROLE: "orchestrator" })
  ).toContain("muted");
  expect(await gatewayVerb(f.transport, "mutes", [], { VMETHOD_ROLE: "orchestrator" })).toContain(
    "vworlds/vmethod#6"
  );
  expect(
    await gatewayVerb(f.transport, "unmute", ["vworlds/vmethod#6"], {
      VMETHOD_ROLE: "orchestrator",
    })
  ).toContain("unmuted");
  f.done();
});
