import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { fixture } from "../helpers.js";
import {
  ConflictService,
  conflictCertification,
  type ConflictHooks,
} from "../../src/gateway/conflicts.js";
import type { CiSnapshot } from "../../src/gateway/checks.js";
import type { Dependencies } from "../../src/gateway/client.js";

const exec = promisify(execFile);

async function setup(conflict: boolean, approved: boolean, bad = false, escalated = false) {
  const root = fixture();
  const env = {
    ...process.env,
    XDG_STATE_HOME: join(root, "state"),
    TOKEN: "fake-token",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const git = async (...args: string[]) =>
    (await exec("git", args, { cwd: root, env, timeout: 5000 })).stdout;
  const commit = async (file: string, text: string) => {
    writeFileSync(join(root, file), text);
    await git("add", "--", file);
    await git("commit", "-qm", "test");
    return (await git("rev-parse", "HEAD")).trim();
  };
  await git("init", "-b", "dev");
  await commit("conflict.txt", "keep prefix\ninitial\nkeep suffix\n");
  await git("checkout", "-b", "task");
  const head = await commit("conflict.txt", "keep prefix\ntask\nkeep suffix\n");
  await git("checkout", "dev");
  const baseSha = await commit(
    conflict ? "conflict.txt" : "base.txt",
    conflict ? "keep prefix\nbase\nkeep suffix\n" : "base addition\n"
  );
  await git("checkout", "task");
  await git("update-ref", "refs/remotes/origin/dev", baseSha);
  await git("update-ref", "refs/remotes/origin/task", head);
  let now = 0;
  const snapshot: CiSnapshot = {
    target: {
      owner: "example",
      name: "project",
      repo: "example/project",
      number: 31,
      link: "https://github.com/example/project/pull/31",
    },
    head,
    branch: "task",
    base: "dev",
    baseSha,
    conflict,
    runs: [],
    green: true,
    stale: false,
  };
  const resolve = async () => {
    if (conflict) {
      await expect(git("merge", "--no-edit", baseSha)).rejects.toThrow();
      snapshot.head = await commit(
        "conflict.txt",
        `${bad ? "changed prefix" : "keep prefix"}\ntask\nbase\nkeep suffix\n`
      );
    } else {
      await git("merge", "--no-edit", baseSha);
      snapshot.head = (await git("rev-parse", "HEAD")).trim();
    }
    await git("update-ref", "refs/remotes/origin/task", snapshot.head);
    snapshot.conflict = false;
  };
  const hooks: ConflictHooks = {
    snapshot: vi.fn(async () => ({ ...snapshot })),
    approved: vi.fn(async () => approved),
    update: vi.fn(async (pr, expected) => {
      expect(pr).toBe(31);
      expect(expected).toBe(head);
      await resolve();
    }),
    wait: vi.fn(async () => ({ code: 0 as const, text: "checks: green" })),
    fix: vi.fn(async () => {
      await resolve();
      return 3 as const;
    }),
    status: vi.fn(async () => "stopped" as const),
    stop: vi.fn(async () => {}),
    workerBlocked: vi.fn(async () => false),
    directory: vi.fn(async () => root),
    verify: vi.fn(async () => true),
    blocked: vi.fn(async () => {}),
    merge: vi.fn(async () => {}),
  };
  const deps: Dependencies = {
    fetch: async () => {
      throw new Error("Unexpected network access");
    },
    exec: async (file, args, options) => {
      if (file === "git" && args.includes("fetch")) {
        expect(args).toContain("https://github.com/example/project.git");
        return ""; // Local remote refs were explicitly updated by the fixture.
      }
      if (file !== "git" && file !== "/bin/sh") {
        throw new Error(`Unexpected executable ${file}`);
      }
      return (await exec(file, [...args], { ...options, timeout: 5000 })).stdout;
    },
    now: () => now,
    sleep: async () => {
      throw new Error("Unexpected polling sleep");
    },
    report: vi.fn(),
  };
  const service = new ConflictService(
    root,
    {
      repo: "example/project",
      stateName: "conflict-test",
      credentials: { githubToken: "TOKEN" },
      ...(escalated ? { conflicts: { escalatePaths: ["**/*.txt"] } } : {}),
    },
    env,
    deps,
    hooks
  );
  return {
    service,
    hooks,
    snapshot,
    advance: () => {
      now += 61 * 60_000;
    },
  };
}

test("base moved without textual conflicts updates the branch and waits for CI without any agent", async () => {
  const f = await setup(false, false);
  expect(await f.service.resolve(31)).toBe("RESOLVED #31 (step 1)");
  expect(f.hooks.update).toHaveBeenCalledOnce();
  expect(f.hooks.wait).toHaveBeenCalledOnce();
  expect(f.hooks.fix).not.toHaveBeenCalled();
  expect(f.hooks.directory).not.toHaveBeenCalled();
  expect(f.hooks.verify).not.toHaveBeenCalled();
  expect(f.hooks.merge).not.toHaveBeenCalled();
}, 15000);

test.each([true, false])(
  "real conflict, approved=%s: bounded fixer and verified completion",
  async (approved) => {
    const f = await setup(true, approved);
    expect(await f.service.resolve(31)).toBe("PENDING #31: conflict fixer dispatched (step 3)");
    expect(f.hooks.fix).toHaveBeenCalledWith(31, "dev", ["conflict.txt"]);
    expect(await f.service.resolve(31)).toBe(
      approved ? "MERGED #31 (conflict-only, approval carried)" : "RESOLVED #31 (step 3)"
    );
    expect(f.hooks.verify).toHaveBeenCalledOnce();
    if (approved) {
      expect(f.hooks.merge).toHaveBeenCalledWith(31, conflictCertification, f.snapshot.head);
    } else {
      expect(f.hooks.merge).not.toHaveBeenCalled();
    }
    await f.service.resolve(31);
    expect(f.hooks.fix).toHaveBeenCalledOnce();
  },
  15000
);

test.each([
  "outside hunk",
  "escalated path",
  "verify failure",
  "CI red",
  "deadline",
  "worker BLOCKED",
  "head moved",
])(
  "refuses approval carry and escalates: %s",
  async (reason) => {
    const f = await setup(true, true, reason === "outside hunk", reason === "escalated path");
    await f.service.resolve(31);
    if (reason === "verify failure") {
      vi.mocked(f.hooks.verify).mockResolvedValue(false);
    }
    if (reason === "CI red") {
      f.snapshot.green = false;
      f.snapshot.runs = [{ status: "completed", conclusion: "failure" }];
    }
    if (reason === "deadline") {
      f.advance();
    }
    if (reason === "worker BLOCKED") {
      vi.mocked(f.hooks.workerBlocked).mockResolvedValue(true);
    }
    if (reason === "head moved") {
      vi.mocked(f.hooks.verify).mockImplementation(async () => {
        f.snapshot.head = "d".repeat(40);
        return true;
      });
    }
    expect(await f.service.resolve(31)).toMatch(/^BLOCKED #31: conflict escalated/);
    expect(f.hooks.blocked).toHaveBeenCalledWith(31, expect.any(String), ["conflict.txt"]);
    expect(f.hooks.merge).not.toHaveBeenCalled();
    expect(f.hooks.stop).toHaveBeenCalledOnce();
  },
  15000
);
