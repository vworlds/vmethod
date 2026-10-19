import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { fixture } from "../helpers.js";
import {
  ConflictService,
  conflictCertification,
  type ConflictHooks,
} from "../../src/gateway/conflicts.js";
import type { CiSnapshot } from "../../src/gateway/checks.js";
import { GitHubHttpError, type Dependencies } from "../../src/gateway/client.js";
import { verifyConflictHead } from "../../src/gateway/verify-hook.js";

const exec = promisify(execFile);

async function setup(conflict: boolean, approved: boolean, bad = false, escalated = false) {
  const root = fixture();
  const env = {
    ...process.env,
    XDG_STATE_HOME: join(fixture(), "state"),
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
    makeUpToDate: resolve,
    seedCleanFailure: () => {
      const directory = join(env.XDG_STATE_HOME, "vmethod/conflict-test/conflicts");
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "31.json"),
        JSON.stringify({
          head: snapshot.head,
          base: snapshot.baseSha,
          branch: snapshot.branch,
          approved: false,
          files: [],
          step: 1,
          phase: "blocked",
          started: 0,
          reason: "conflict dispatch failed; see gateway diagnostics",
        })
      );
    },
    advance: () => {
      now += 61 * 60_000;
    },
    verifyWithoutHook: (directory: string, head: string) =>
      verifyConflictHead(directory, head, { repo: "example/project" }, env, deps),
  };
}

test.each([false, true])(
  "an up-to-date PR is a read-only no-op even with stale failed state=%s and red CI",
  async (previousFailure) => {
    const f = await setup(false, true);
    await f.makeUpToDate();
    if (previousFailure) {
      f.seedCleanFailure();
    }
    f.snapshot.green = false;
    f.snapshot.stale = true;
    expect(await f.service.resolve(31)).toBe("nothing to resolve for #31");
    for (const hook of [
      f.hooks.approved,
      f.hooks.update,
      f.hooks.wait,
      f.hooks.fix,
      f.hooks.stop,
      f.hooks.status,
      f.hooks.workerBlocked,
      f.hooks.directory,
      f.hooks.verify,
      f.hooks.blocked,
      f.hooks.merge,
    ]) {
      expect(hook).not.toHaveBeenCalled();
    }
    expect(f.service.pending(31)).toBe(false);
  },
  15000
);

test.each([
  "There are no new commits on the base branch.",
  "there are no new commits on the base branch",
])(
  "update-branch 422 with no new base commits succeeds without escalation: %s",
  async (detail) => {
    const f = await setup(false, false);
    vi.mocked(f.hooks.update).mockRejectedValue(
      new GitHubHttpError(422, "PUT", "/repos/example/project/pulls/31/update-branch", detail)
    );
    expect(await f.service.resolve(31)).toBe("nothing to resolve for #31");
    expect(f.hooks.blocked).not.toHaveBeenCalled();
    expect(f.hooks.wait).not.toHaveBeenCalled();
    expect(f.hooks.fix).not.toHaveBeenCalled();
  },
  15000
);

test.each(["update", "wait", "fix", "verify", "snapshot", "merge"])(
  "unexpected %s API failure reports an error, never BLOCKED or a card change",
  async (stage) => {
    const f = await setup(!["update", "wait"].includes(stage), true);
    const error = new GitHubHttpError(500, "POST", "/unexpected", "temporary outage");
    if (["verify", "snapshot", "merge"].includes(stage)) {
      await f.service.resolve(31);
    }
    vi.mocked(
      f.hooks[stage as "update" | "wait" | "fix" | "verify" | "snapshot" | "merge"]
    ).mockRejectedValue(error);
    await expect(f.service.resolve(31)).rejects.toThrow("temporary outage");
    expect(f.hooks.blocked).not.toHaveBeenCalled();
    expect(f.hooks.stop).not.toHaveBeenCalled();
    if (stage !== "merge") {
      expect(f.hooks.merge).not.toHaveBeenCalled();
    }
  },
  15000
);

test("other update-branch validation failures remain errors, not an up-to-date success", async () => {
  const f = await setup(false, false);
  vi.mocked(f.hooks.update).mockRejectedValue(
    new GitHubHttpError(
      422,
      "PUT",
      "/repos/example/project/pulls/31/update-branch",
      "Validation Failed: expected_head_sha mismatch"
    )
  );
  await expect(f.service.resolve(31)).rejects.toThrow("expected_head_sha mismatch");
  expect(f.hooks.blocked).not.toHaveBeenCalled();
  expect(f.hooks.wait).not.toHaveBeenCalled();
}, 15000);

test("CI failure after a clean base update reports an error without conflict escalation", async () => {
  const f = await setup(false, false);
  vi.mocked(f.hooks.wait).mockResolvedValue({ code: 1, text: "checks: red" });
  await expect(f.service.resolve(31)).rejects.toThrow("CI red");
  expect(f.hooks.blocked).not.toHaveBeenCalled();
  expect(f.hooks.stop).not.toHaveBeenCalled();
  expect(f.hooks.merge).not.toHaveBeenCalled();
}, 15000);

test.each(["green", "red", "pending"])(
  "no project verify hook: CI %s remains the conflict gate",
  async (ci) => {
    const f = await setup(true, true);
    await f.service.resolve(31);
    vi.mocked(f.hooks.verify).mockImplementation(f.verifyWithoutHook);
    if (ci !== "green") {
      f.snapshot.green = false;
      f.snapshot.runs = ci === "red" ? [{ status: "completed", conclusion: "failure" }] : [];
    }
    const result = await f.service.resolve(31);
    if (ci === "green") {
      expect(result).toBe("MERGED #31 (conflict-only, approval carried)");
      expect(f.hooks.merge).toHaveBeenCalledOnce();
      expect(f.hooks.verify).toHaveBeenCalledOnce();
    } else {
      expect(result).toMatch(ci === "red" ? /^BLOCKED/ : /^PENDING/);
      expect(f.hooks.merge).not.toHaveBeenCalled();
    }
  },
  15000
);

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
