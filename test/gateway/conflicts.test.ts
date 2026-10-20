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
      await expect(git("merge", "--no-edit", snapshot.baseSha)).rejects.toThrow();
      snapshot.head = await commit(
        "conflict.txt",
        `${bad ? "changed prefix" : "keep prefix"}\ntask\nbase\nkeep suffix\n`
      );
    } else {
      await git("merge", "--no-edit", snapshot.baseSha);
      snapshot.head = (await git("rev-parse", "HEAD")).trim();
    }
    await git("update-ref", "refs/remotes/origin/task", snapshot.head);
    snapshot.conflict = false;
  };
  let card: { status: string | null; progress: string | null; assignees: string[] } = {
    status: "In progress",
    progress: "🤖🔨",
    assignees: ["worker"],
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
    cardPrior: vi.fn(async () => ({ ...card, assignees: [...card.assignees] })),
    cardConflict: vi.fn(async () => {
      card = { status: card.status, progress: "💥", assignees: ["worker"] };
    }),
    cardRestore: vi.fn(async (_pr, prior) => {
      card = { status: prior.status, progress: prior.progress, assignees: [...prior.assignees] };
    }),
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
  const createService = () =>
    new ConflictService(
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
  const service = createService();
  return {
    service,
    createService,
    hooks,
    deps,
    snapshot,
    card: () => card,
    setCard: (
      value: Partial<{ status: string | null; progress: string | null; assignees: string[] }>
    ) => {
      card = {
        status: value.status !== undefined ? value.status : card.status,
        progress: value.progress !== undefined ? value.progress : card.progress,
        assignees: value.assignees ?? card.assignees,
      };
    },
    makeUpToDate: resolve,
    nextConflict: async () => {
      await git("checkout", "dev");
      snapshot.baseSha = await commit("conflict.txt", "keep prefix\nnew base\nkeep suffix\n");
      await git("checkout", "task");
      snapshot.head = await commit("conflict.txt", "keep prefix\nnew task\nkeep suffix\n");
      snapshot.conflict = true;
      await git("update-ref", "refs/remotes/origin/dev", snapshot.baseSha);
      await git("update-ref", "refs/remotes/origin/task", snapshot.head);
    },
    moveBase: async () => {
      await git("checkout", "dev");
      snapshot.baseSha = await commit("base.txt", "base move\n");
      await git("checkout", "task");
      snapshot.conflict = false;
      await git("update-ref", "refs/remotes/origin/dev", snapshot.baseSha);
      await git("update-ref", "refs/remotes/origin/task", snapshot.head);
    },
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
    verifyWithoutHook: (directory: string, head: string, reportNotice?: () => boolean) =>
      verifyConflictHead(directory, head, { repo: "example/project" }, env, deps, reportNotice),
  };
}

test("auto-merge refusal retains the resolution without repeating verification or merge", async () => {
  const f = await setup(true, true);
  await f.service.resolve(31);
  vi.mocked(f.hooks.verify).mockImplementation(f.verifyWithoutHook);
  vi.mocked(f.hooks.merge).mockRejectedValue(
    new Error("scope not approved: post SCOPE REVIEW first")
  );
  const expected =
    "RESOLVED #31: auto-merge refused (scope not approved: post SCOPE REVIEW first); merge manually when ready";
  expect(await f.service.resolve(31)).toBe(expected);
  expect(f.service.pending(31)).toBe(false);
  await f.createService().resolve(31);
  expect(f.hooks.verify).toHaveBeenCalledOnce();
  expect(f.hooks.merge).toHaveBeenCalledOnce();
  expect(f.deps.report).toHaveBeenCalledExactlyOnceWith(
    "conflict resolution: no verify hook; local verify skipped, green CI still required"
  );
  await f.nextConflict();
  expect(await f.service.resolve(31)).toMatch(/^PENDING/);
  expect(await f.service.resolve(31)).toBe(expected);
  expect(f.deps.report).toHaveBeenCalledTimes(2);
  expect(f.hooks.merge).toHaveBeenCalledTimes(2);
}, 15000);

test("no-hook notice is durable across retries within a resolution", async () => {
  const f = await setup(true, true);
  await f.service.resolve(31);
  vi.mocked(f.hooks.verify).mockImplementation(f.verifyWithoutHook);
  vi.mocked(f.hooks.snapshot)
    .mockImplementationOnce(async () => ({ ...f.snapshot }))
    .mockRejectedValueOnce(new Error("snapshot unavailable"));
  await expect(f.service.resolve(31)).rejects.toThrow("snapshot unavailable");
  expect(await f.createService().resolve(31)).toMatch(/^MERGED/);
  expect(f.hooks.verify).toHaveBeenCalledTimes(2);
  expect(f.deps.report).toHaveBeenCalledOnce();
}, 15000);

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
      f.hooks.cardPrior,
      f.hooks.cardConflict,
      f.hooks.cardRestore,
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

test.each(["update", "wait", "fix", "verify", "snapshot"])(
  "unexpected %s API failure reports an error, never BLOCKED or a card change",
  async (stage) => {
    const f = await setup(!["update", "wait"].includes(stage), true);
    const error = new GitHubHttpError(500, "POST", "/unexpected", "temporary outage");
    if (["verify", "snapshot"].includes(stage)) {
      await f.service.resolve(31);
    }
    vi.mocked(
      f.hooks[stage as "update" | "wait" | "fix" | "verify" | "snapshot"]
    ).mockRejectedValue(error);
    await expect(f.service.resolve(31)).rejects.toThrow("temporary outage");
    expect(f.hooks.blocked).not.toHaveBeenCalled();
    expect(f.hooks.stop).not.toHaveBeenCalled();
    expect(f.hooks.merge).not.toHaveBeenCalled();
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
  expect(f.hooks.cardPrior).not.toHaveBeenCalled();
  expect(f.hooks.cardConflict).not.toHaveBeenCalled();
  expect(f.hooks.cardRestore).not.toHaveBeenCalled();
}, 15000);

test("a step-2 dispatch on an owner-turn card shows the fixer and RESOLVED restores it", async () => {
  const f = await setup(true, false);
  f.setCard({ status: "In review", progress: "👤🔍", assignees: ["owner"] });
  vi.mocked(f.hooks.fix).mockImplementation(async () => 2);
  expect(await f.service.resolve(31)).toBe("PENDING #31: conflict fixer dispatched (step 2)");
  expect(f.hooks.cardPrior).toHaveBeenCalledTimes(1);
  expect(f.hooks.cardConflict).toHaveBeenCalledTimes(1);
  expect(f.card()).toMatchObject({ status: "In review", progress: "💥", assignees: ["worker"] });
  await f.makeUpToDate();
  expect(await f.service.resolve(31)).toBe("RESOLVED #31 (step 2)");
  expect(f.hooks.cardRestore).toHaveBeenCalledTimes(1);
  expect(f.hooks.cardRestore).toHaveBeenCalledWith(31, {
    status: "In review",
    progress: "👤🔍",
    assignees: ["owner"],
  });
  expect(f.card()).toMatchObject({ status: "In review", progress: "👤🔍", assignees: ["owner"] });
  expect(f.service.pending(31)).toBe(false);
  await f.service.resolve(31);
  expect(f.hooks.cardRestore).toHaveBeenCalledTimes(1);
}, 15000);

test("a blocked resolution never restores the prior card and leaves the turn with the orchestrator", async () => {
  const f = await setup(true, false, true);
  f.setCard({ status: "In review", progress: "👤🔍", assignees: ["owner"] });
  vi.mocked(f.hooks.fix).mockImplementation(async () => 2);
  expect(await f.service.resolve(31)).toMatch(/^PENDING/);
  await f.makeUpToDate();
  expect(await f.service.resolve(31)).toMatch(/^BLOCKED #31: conflict escalated/);
  expect(f.hooks.blocked).toHaveBeenCalledOnce();
  expect(f.hooks.cardRestore).not.toHaveBeenCalled();
  expect(f.card()).toMatchObject({ status: "In review", progress: "💥", assignees: ["worker"] });
  expect(f.service.pending(31)).toBe(false);
}, 15000);

test("a lost card restore is retried by reconciliation without repeating the resolution", async () => {
  const f = await setup(true, false);
  f.setCard({ status: "In review", progress: "👤🔍", assignees: ["owner"] });
  vi.mocked(f.hooks.fix).mockImplementation(async () => 2);
  await f.service.resolve(31);
  await f.makeUpToDate();
  vi.mocked(f.hooks.cardRestore)
    .mockImplementationOnce(async () => {
      throw new Error("board unavailable");
    })
    .mockImplementation(async (_pr, prior) => {
      f.setCard({ status: prior.status, progress: prior.progress, assignees: prior.assignees });
    });
  expect(await f.service.resolve(31)).toBe("RESOLVED #31 (step 2)");
  expect(f.deps.report).toHaveBeenCalledWith(
    expect.stringContaining("card could not return to its previous state")
  );
  expect(f.card()).toMatchObject({ status: "In review", progress: "💥", assignees: ["worker"] });
  await f.moveBase();
  expect(await f.service.resolve(31)).toBe("RESOLVED #31 (step 2)");
  expect(f.hooks.cardRestore).toHaveBeenCalledTimes(2);
  expect(f.card()).toMatchObject({ status: "In review", progress: "👤🔍", assignees: ["owner"] });
  await f.service.resolve(31);
  expect(f.hooks.cardRestore).toHaveBeenCalledTimes(2);
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
