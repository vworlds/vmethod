import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import { ConflictService, type ConflictHooks } from "../../src/gateway/conflicts.js";
import type { CiSnapshot } from "../../src/gateway/checks.js";
import { GitHubHttpError } from "../../src/gateway/client.js";
import type { EventDeps } from "../../src/gateway/events.js";
import { fixture, ghConfig } from "../helpers.js";
import { proc } from "./watch-fake.js";
import { conflictTransitions, type Effect, type TransitionRow } from "./conflict-table.js";

const exec = promisify(execFile);

test("conflict transition oracle is non-empty, plain data and covers all phases", () => {
  expect(conflictTransitions.length).toBeGreaterThan(0);
  expect(JSON.parse(JSON.stringify(conflictTransitions))).toEqual(conflictTransitions);
  expect(
    new Set(
      conflictTransitions
        .flatMap((row) => [row.prior?.phase, row.expected.record?.phase])
        .filter(Boolean)
    )
  ).toEqual(new Set(["starting", "waiting", "resolved", "blocked", "merged"]));
  expect(new Set(conflictTransitions.map((row) => row.name)).size).toBe(conflictTransitions.length);
});

test.each(conflictTransitions)(
  "$name",
  async (row) => {
    const f = await setup(row);
    const before = structuredClone(row);
    if (row.expected.error) {
      await expect(
        f.service.resolve(31, row.observation.retry, row.observation.waitMs)
      ).rejects.toThrow(row.expected.error);
    } else if (row.operation === "recover") {
      expect(await f.service.recover(31)).toBe(row.expected.active);
    } else {
      expect(await f.service.resolve(31, row.observation.retry, row.observation.waitMs)).toBe(
        row.expected.line
      );
    }
    const record = existsSync(f.record) ? JSON.parse(readFileSync(f.record, "utf8")) : null;
    expect(record).toEqual(f.materialize(row.expected.record));
    expect(f.effects).toEqual(f.materialize(row.expected.effects));
    expect(f.card()).toEqual(row.expected.card);
    expect(f.service.pending(31)).toBe(row.expected.pending);
    expect(f.service.fixing(31)).toBe(row.expected.fixing);
    expect(existsSync(f.lock)).toBe(row.expected.lock);
    if (row.observation.lock === "live") {
      expect(f.hooks.snapshot).not.toHaveBeenCalled();
      expect(readFileSync(f.lock, "utf8")).toBe(f.lockBody);
      expect(f.now()).toBe(row.observation.now + (row.observation.waitMs ?? 0));
    }
    if (row.prior && row.observation.lifecycle !== "open") {
      expect(f.hooks.snapshot).not.toHaveBeenCalled();
    }
    expect(row).toEqual(before);
  },
  15000
);

/** Same real-git / fake-fetch / hook / proc setup as conflicts.test.ts, kept
 * separate because that suite must remain unchanged. Only this adapter does I/O;
 * no source proof or service method is mocked. */
async function setup(row: TransitionRow) {
  const o = row.observation;
  const root = fixture();
  const env = {
    ...process.env,
    XDG_STATE_HOME: join(fixture(), "state"),
    GH_CONFIG_DIR: ghConfig("fake-token"),
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const git = async (...args: string[]) =>
    (await exec("git", args, { cwd: root, env, timeout: 5000 })).stdout;
  const commit = async (file: string, text: string) => {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), text);
    await git("add", "--", file);
    await git("commit", "-qm", "test");
    return (await git("rev-parse", "HEAD")).trim();
  };
  const paths = o.preview.length ? o.preview : ["conflict.txt"];
  await git("init", "-b", "dev");
  for (const path of paths) {
    await commit(path, "keep prefix\ninitial\nkeep suffix\n");
  }
  await git("checkout", "-b", "task");
  for (const path of paths) {
    await commit(path, "keep prefix\ntask\nkeep suffix\n");
  }
  const H = (await git("rev-parse", "HEAD")).trim();
  await git("checkout", "dev");
  for (const path of o.preview.length ? paths : ["base.txt"]) {
    await commit(path, "keep prefix\nbase\nkeep suffix\n");
  }
  const B = (await git("rev-parse", "HEAD")).trim();
  await git("checkout", "task");
  if (["foreign", "wrong-parents"].includes(o.proofs.merge)) {
    await commit("foreign.txt", "outside change\n");
  } else if (o.preview.length) {
    await expect(git("merge", "--no-edit", B)).rejects.toThrow();
    for (const path of paths) {
      writeFileSync(
        join(root, path),
        `${o.proofs.merge === "outside-hunk" ? "changed prefix" : "keep prefix"}\ntask\nbase\nkeep suffix\n`
      );
    }
    await git("add", ".");
    await git("commit", "-qm", "resolution");
  } else {
    await git("merge", "--no-edit", B);
  }
  const R = (await git("rev-parse", "HEAD")).trim();
  await git("checkout", "dev");
  const N = await commit("base-next.txt", "new base\n");
  await git("checkout", "task");
  await git("checkout", "--detach", H);
  const movedHead = await commit(paths[0], "keep prefix\nmoved task\nkeep suffix\n");
  await git("checkout", "task");
  const refs: Record<string, string> = { H, B, R, N };
  const materialize = <T>(value: T): T =>
    JSON.parse(JSON.stringify(value), (_key, item: unknown) =>
      typeof item === "string" ? (refs[item] ?? item) : item
    ) as T;
  const snapshot: CiSnapshot = {
    target: {
      owner: "example",
      name: "project",
      repo: "example/project",
      number: 31,
      link: "https://github.com/example/project/pull/31",
    },
    ...materialize(o.snapshot),
    base: "dev",
    runs: o.snapshot.red ? [{ status: "completed", conclusion: "failure" }] : [],
  };
  // Remote refs are owned explicitly by the fake fetch, as in conflicts.test.ts.
  const setRefs = async () => {
    await git("update-ref", "refs/remotes/origin/dev", snapshot.baseSha);
    await git("update-ref", `refs/remotes/origin/${snapshot.branch}`, snapshot.head);
  };
  await setRefs();
  if (!o.proofs.worktree) {
    await git("checkout", "--detach", H);
  }
  let now = o.now;
  let card = structuredClone(o.card);
  const effects: Effect[] = [];
  const hooks: ConflictHooks = {
    snapshot: vi.fn(async () => ({ ...snapshot })),
    approved: vi.fn(async (pr, head) => {
      expect(pr).toBe(31);
      expect(head).toBe(snapshot.head);
      return o.approved;
    }),
    update: vi.fn(async (pr, head) => {
      expect(pr).toBe(31);
      effects.push({ kind: "update-branch", head });
      if (o.update === "no-commits") {
        throw new GitHubHttpError(
          422,
          "PUT",
          "/update-branch",
          "There are no new commits on the base branch."
        );
      }
      if (o.update === "failure") {
        throw new Error("update failed");
      }
      if (o.update === "merge") {
        snapshot.head = R;
        snapshot.conflict = false;
        await setRefs();
      }
    }),
    wait: vi.fn(async (pr) => {
      expect(pr).toBe(31);
      effects.push({ kind: "wait" });
      return { code: o.waitCode, text: "checks" };
    }),
    fix: vi.fn(async (pr, base, files) => {
      expect(pr).toBe(31);
      // C2: the durable record is still starting inside the dispatch call.
      const stored = JSON.parse(readFileSync(record, "utf8"));
      expect(stored.phase).toBe("starting");
      expect(stored.dispatched).toBeUndefined();
      expect(stored.prior).toEqual(o.card);
      effects.push({ kind: "dispatch", base, files });
      if (o.dispatchFailure) {
        throw new Error("dispatch failed");
      }
      return o.dispatchStep;
    }),
    status: vi.fn(async () => o.workerStatus),
    stop: vi.fn(async () => {
      effects.push({ kind: "stop" });
    }),
    workerBlocked: vi.fn(async () => o.workerBlocked ?? false),
    directory: vi.fn(async () => root),
    verify: vi.fn(async (directory, head, notice) => {
      expect(directory).toBe(root);
      effects.push({ kind: "verify", head });
      if (o.verifyNotice) {
        notice();
      }
      switch (o.afterVerify) {
        case "head":
          snapshot.head = N;
          break;
        case "base":
          snapshot.baseSha = N;
          break;
        case "branch":
          snapshot.branch = "changed";
          break;
        case "conflict":
          snapshot.conflict = true;
          break;
        case "red":
          snapshot.green = false;
          break;
        case "stale":
          snapshot.stale = true;
          break;
      }
      return o.proofs.verify;
    }),
    blocked: vi.fn(async (pr, reason, files) => {
      expect(pr).toBe(31);
      effects.push({ kind: "block", reason, files });
      // Card behavior belongs to TaskFlow (characterised by step 2), not this fake.
    }),
    merge: vi.fn(async (pr, certification, head) => {
      expect(pr).toBe(31);
      effects.push({ kind: "merge", certification, head });
      if (o.mergeFailure) {
        throw new Error("merge refused");
      }
    }),
    cardPrior: vi.fn(async () => {
      effects.push({ kind: "card-prior" });
      if (o.beforeDispatch) {
        snapshot.head = o.beforeDispatch === "vanished" ? R : movedHead;
        snapshot.conflict = o.beforeDispatch === "moved";
        await setRefs();
      }
      return structuredClone(card);
    }),
    cardConflict: vi.fn(async () => {
      effects.push({ kind: "card-conflict" });
      card = { ...card, progress: "💥", assignees: ["worker"] };
    }),
    cardRestore: vi.fn(async (_pr, prior) => {
      effects.push({ kind: "restore", prior });
      if (o.restore === "failure") {
        throw new Error("board unavailable");
      }
      if (o.restore === "approval-kept") {
        return "approval-kept";
      }
      card = structuredClone(prior);
    }),
    lifecycle: vi.fn(async () => o.lifecycle),
  };
  const deps: EventDeps = {
    fetch: async () => {
      throw new Error("Unexpected network access");
    },
    exec: async (command, args, options) => {
      if (command === "git" && args.includes("fetch")) {
        expect(args).toContain("https://github.com/example/project.git");
        return "";
      }
      if (command === "npm") {
        expect(args).toEqual(["ci", "--dry-run", "--no-audit", "--no-fund", "--ignore-scripts"]);
        effects.push({ kind: "sync", directory: relative(root, options?.cwd ?? "") || "." });
        if (!o.proofs.sync) {
          throw new Error("lockfile out of sync");
        }
        return "";
      }
      if (command !== "git" && command !== "/bin/sh") {
        throw new Error(`Unexpected executable ${command}`);
      }
      return (await exec(command, [...args], { ...options, timeout: 5000 })).stdout;
    },
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    report: vi.fn(),
    pid: process.pid,
    readProc: (pid) =>
      pid === process.pid || (pid === 5432 && o.lock === "live") ? proc(42) : null,
  };
  const state = join(env.XDG_STATE_HOME, "vmethod/conflict-test/conflicts");
  mkdirSync(state, { recursive: true });
  const record = join(state, "31.json");
  const lock = join(state, "31.lock");
  const lockBody = JSON.stringify({
    pid: o.lock === "reused" ? process.pid : 5432,
    start: o.lock === "reused" ? 6 : 42,
  });
  if (row.prior) {
    writeFileSync(record, JSON.stringify(materialize(row.prior)));
  }
  if (o.lock) {
    writeFileSync(lock, lockBody);
  }
  const service = new ConflictService(
    root,
    {
      repo: "example/project",
      stateName: "conflict-test",
      ...(o.escalated ? { conflicts: { escalatePaths: ["**/*.txt"] } } : {}),
    },
    env,
    deps,
    hooks
  );
  return {
    service,
    record,
    lock,
    lockBody,
    hooks,
    effects,
    materialize,
    card: () => card,
    now: () => now,
  };
}
