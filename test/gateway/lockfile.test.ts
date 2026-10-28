import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
  assertLockfileInSync,
  lockfileCheckable,
  lockfilesOnly,
  lockfileOutOfSync,
  npmCiCheckArguments,
  npmCiEnvironment,
} from "../../src/gateway/lockfile.js";
import { ghConfig } from "../helpers.js";

const invalid = "npm error Invalid: lock file's yaml@2.9.1 does not satisfy yaml@2.9.0";

test.each<[string[], boolean]>([
  [[], false],
  [
    ["package-lock.json", "packages/app/npm-shrinkwrap.json", "yarn.lock", "nested/pnpm-lock.yaml"],
    true,
  ],
  [["package-lock.json", "source.ts"], false],
  [["not-package-lock.json"], false],
  [["package-lock.json/source.ts"], false],
])("lockfile-only classification for %j is %s", (files, expected) => {
  expect(lockfilesOnly(files)).toBe(expected);
});
const missing = "npm error Missing: yaml@2.9.1 from lock file";
const refusal = [
  "npm error code EUSAGE",
  "npm error",
  "npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with `npm install` before continuing.",
].join("\n");

function syncFailure(stderr: string): Error & { stderr: string } {
  const error = new Error(`Command failed: npm ci\n${stderr}`) as Error & { stderr: string };
  error.stderr = stderr;
  return error;
}

test("assertLockfileInSync runs the documented dry-run arguments in the given directory", async () => {
  const exec = vi.fn(async () => "");
  await expect(
    assertLockfileInSync({ exec }, "/worktree", { HUSKY: "0", PATH: "/bin" })
  ).resolves.toBeUndefined();
  expect(exec).toHaveBeenCalledOnce();
  expect(exec.mock.calls[0]).toEqual([
    "npm",
    npmCiCheckArguments,
    { cwd: "/worktree", env: { HUSKY: "0", PATH: "/bin" } },
  ]);
});

test("lockfile out of sync produces the one-line refusal plus npm's first Invalid line", async () => {
  const original = syncFailure([refusal, "", invalid, missing].join("\n"));
  const exec = vi.fn(async () => {
    throw original;
  });
  const thrown: unknown = await assertLockfileInSync({ exec }, "/worktree", {}).catch(
    (error: unknown) => error
  );
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toBe(`${lockfileOutOfSync}\n${invalid}`);
  expect((thrown as Error & { cause?: unknown }).cause).toBe(original);
});

test("a refusal naming only missing packages falls back to the first Missing line", async () => {
  const exec = vi.fn(async () => {
    throw syncFailure([refusal, "", missing].join("\n"));
  });
  await expect(assertLockfileInSync({ exec }, "/worktree", {})).rejects.toThrow(
    `${lockfileOutOfSync}\n${missing}`
  );
});

test.each([
  ["engines failure", "npm error code EBADENGINE\nnpm error Unsupported engine"],
  ["network failure", "npm error code ECONNREFUSED"],
  [
    "absent lockfile",
    "npm error The `npm ci` command can only install with an existing package-lock.json",
  ],
])("non-drift npm failures keep their original error: %s", async (_name, stderr) => {
  const original = syncFailure(stderr);
  const exec = vi.fn(async () => {
    throw original;
  });
  await expect(assertLockfileInSync({ exec }, "/worktree", {})).rejects.toBe(original);
});

test("npmCiEnvironment filters credentials and lifecycle hooks out of npm subprocesses", () => {
  const env = npmCiEnvironment({
    PATH: "/bin",
    HOME: "/home/agent",
    OPENCODE_SERVER_PASSWORD: "secret",
    GH_CONFIG_DIR: ghConfig("token"),
    GIT_AUTHOR_NAME: "A",
  });
  expect(env).toEqual({ HUSKY: "0", PATH: "/bin", HOME: "/home/agent" });
});

test("lockfileCheckable requires both manifests", () => {
  const directory = mkdtempSync(join(tmpdir(), "vmethod-lockfile-test-"));
  try {
    expect(lockfileCheckable(directory)).toBe(false);
    writeFileSync(join(directory, "package.json"), "{}");
    expect(lockfileCheckable(directory)).toBe(false);
    writeFileSync(join(directory, "package-lock.json"), "{}");
    expect(lockfileCheckable(directory)).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
