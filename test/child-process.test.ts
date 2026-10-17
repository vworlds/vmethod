import { afterEach, expect, test, vi } from "vitest";
import { runChild } from "./child-process.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: spawn,
}));

afterEach(() => vi.unstubAllEnvs());

test("child runner preserves output and nonzero exits for assertions", () => {
  vi.stubEnv("VMETHOD_TEST_TIMINGS", "");
  const result = { status: 2, stdout: "out", stderr: "expected error" };
  spawn.mockReturnValue(result);
  expect(runChild("node", ["cli.mjs"], { encoding: "utf8", timeout: 2000 })).toBe(result);
  expect(spawn).toHaveBeenLastCalledWith("node", ["cli.mjs"], { encoding: "utf8", timeout: 2000 });
});

test.each(["ETIMEDOUT", "ENOENT"])(
  "child runner diagnoses %s without waiting on a real timer",
  (code) => {
    vi.stubEnv("VMETHOD_TEST_TIMINGS", "");
    const error = Object.assign(new Error(code), { code });
    spawn.mockReturnValue({ error, status: null, stderr: "child diagnostics" });
    expect(() =>
      runChild("node", ["cli.mjs", "check"], { encoding: "utf8", timeout: 2000 })
    ).toThrow(
      /Child process node cli.mjs check failed after \d+ ms \(budget 2000 ms\): E(TIMEDOUT|NOENT)\nchild diagnostics/
    );
  }
);
