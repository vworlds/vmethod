import { expect, test, vi } from "vitest";
import { watchClient } from "../src/cli/watch.js";
import { gatewayVerb } from "../src/cli/gateway.js";
import type { Transport } from "../src/gateway/transport.js";
import { fixtureServer } from "./gateway/helpers.js";
import { WatchFake } from "./gateway/watch-fake.js";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { stringify } from "yaml";
import { loadMigrations } from "../src/board/migrations.js";

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
  });
});

test("stdout failure never acknowledges a batch; timeouts re-arm instead of exiting", async () => {
  const call = vi.fn<Transport["call"]>();
  call
    .mockResolvedValueOnce({ events: [] })
    .mockResolvedValueOnce({ events: [{ id: "1", kind: "comment", line: "COMMENT" }] });
  await expect(
    watchClient({ call }, [], {}, async () => {
      throw new Error("closed stdout");
    })
  ).rejects.toThrow("closed stdout");
  expect(call).toHaveBeenCalledTimes(2);
  expect(call.mock.calls.every(([, input]) => !("ack" in input) || !input.ack?.length)).toBe(true);
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
    const write = vi.fn(async () => {});
    await watchClient({ call }, ["--once"], { VMETHOD_ROLE: "orchestrator" }, write);
    loop.close();
    loop = f.loop();
    const requestsBefore = f.requests.length;
    await watchClient({ call }, ["--once"], { VMETHOD_ROLE: "orchestrator" }, write);
    expect(call).toHaveBeenCalledTimes(2);
    expect(f.requests.length).toBeGreaterThan(requestsBefore);
    expect(
      f.requests.slice(requestsBefore).filter((request) => request.includes("/graphql"))
    ).toHaveLength(1);
    expect(write).not.toHaveBeenCalled();
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

test("built CLI --once exits promptly on two successive empty runs against the same state", async () => {
  const f = fixtureServer([]);
  const cli = join(f.root, "watch-cli.mjs");
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
      credentials: { githubToken: "EXAMPLE_GITHUB_TOKEN" },
      gateway: { maxRetries: 0 },
    })
  );
  // Strict offline wire responses: any unexpected request is reported by the CLI
  // and makes the stderr assertion fail, even if the watcher catches the error.
  writeFileSync(
    preload,
    `globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
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
    expect(result.stdout).toBe("");
  }
  f.done();
}, 15000);

test("watch and mute operations are orchestrator-only, local mute commands need no network", async () => {
  const f = fixtureServer([]);
  for (const operation of ["nextEvents", "watchMute", "watchUnmute", "watchMutes"] as const) {
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
