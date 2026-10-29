import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../config.js";
import { step, type Effect, type Observation, type Resolution } from "../conflicts/machine.js";
import { GitHubHttpError } from "./client.js";
import { stateRoot } from "./digest.js";
import { GitTransport } from "./git.js";
import { proveConflictMerge } from "./conflict-proof.js";
import type { CiSnapshot } from "./checks.js";
import type { Verdict } from "./transport.js";
import type { ConflictPrior } from "./task-flow-types.js";
import { cleanBaseMerges } from "./clean-base.js";
import { liveBaseHead } from "./base-head.js";
import { procStart, type EventDeps } from "./events.js";
import { OwnedLock } from "../journal/locks.js";
import { assertLockfileInSync, npmCiEnvironment } from "./lockfile.js";

export { conflictCertification } from "../conflicts/machine.js";

/** Bounded wait for the conflict/refresh-checks lock before a fresh observation. */
export const conflictLockWaitMs = 60_000;

export interface ConflictHooks {
  snapshot(pr: number): Promise<CiSnapshot>;
  approved(pr: number, head: string): Promise<boolean | "unknown">;
  update(pr: number, head: string): Promise<void>;
  wait(pr: number): Promise<Verdict>;
  fix(pr: number, base: string, files: string[]): Promise<2 | 3>;
  status(pr: number): Promise<"live" | "stopped" | "unknown">;
  stop(pr: number): Promise<void>;
  workerBlocked(pr: number, since: number): Promise<boolean>;
  directory(pr: number): Promise<string>;
  /** Claim reportNotice before emitting an absent-hook notice; false means it was already emitted. */
  verify(directory: string, head: string, reportNotice: () => boolean): Promise<boolean>;
  blocked(pr: number, reason: string, files: string[]): Promise<void>;
  merge(pr: number, reason: string, head: string): Promise<void>;
  /** Capture the card turn a step-2/3 dispatch will interrupt; stored in the record. */
  cardPrior(pr: number): Promise<ConflictPrior>;
  /** Show the dispatched fixer: 💥 Progress and the worker holding the turn. */
  cardConflict(pr: number): Promise<void>;
  /** Restore the prior card, preserving a live owner approval. */
  cardRestore(pr: number, prior: ConflictPrior): Promise<void | "approval-kept">;
  /** Read lifecycle before a snapshot that might fail on a not-open PR. */
  lifecycle(pr: number): Promise<"open" | "merged" | "closed">;
}

interface Run {
  record: Resolution | undefined;
  observation: Observation;
  git: GitTransport;
}

/** Lock and I/O runner for the pure conflict machine. Durable writes and hooks
 * execute in machine order; observation continuations never release the lock. */
export class ConflictService {
  private readonly directory: string;
  constructor(
    private root: string,
    private config: Config,
    private env: NodeJS.ProcessEnv,
    private deps: EventDeps,
    private hooks: ConflictHooks
  ) {
    this.directory = join(
      stateRoot(env, String(config.stateName ?? String(config.repo).replace("/", "-"))),
      "conflicts"
    );
  }

  /** Start or reconcile under the per-PR lock. retry re-proves only a recorded
   * verify failure. Live lock holders return a quiet pending line. */
  async resolve(pr: number, retry = false, waitMs = 0): Promise<string> {
    this.validate(pr);
    if (typeof retry !== "boolean") {
      throw new Error("Invalid conflict retry flag");
    }
    if (!Number.isSafeInteger(waitMs) || waitMs < 0) {
      throw new Error("Invalid conflict lock wait");
    }
    const lock = join(this.directory, `${pr}.lock`);
    const start = this.lockStart();
    const busy = await this.acquire(pr, lock, start, waitMs);
    if (busy !== undefined) {
      return busy;
    }
    try {
      return (await this.run(pr, "resolve", retry)).line;
    } finally {
      this.release(lock, start);
    }
  }

  /** Hold the same lock around refresh-checks' snapshot and push. */
  async guard<T>(pr: number, fn: () => Promise<T>): Promise<{ busy: string } | { value: T }> {
    this.validate(pr);
    const lock = join(this.directory, `${pr}.lock`);
    const start = this.lockStart();
    const busy = this.tryAcquire(pr, lock, start);
    if (busy !== undefined) {
      return { busy };
    }
    try {
      return { value: await fn() };
    } finally {
      this.release(lock, start);
    }
  }

  /** Recover stopped starting/blocked records at once; never steal a waiting fixer. */
  async recover(pr: number): Promise<boolean> {
    this.validate(pr);
    const lock = join(this.directory, `${pr}.lock`);
    const start = this.lockStart();
    const busy = await this.acquire(pr, lock, start, conflictLockWaitMs);
    if (busy !== undefined) {
      return true;
    }
    try {
      return (await this.run(pr, "recover", false)).active!;
    } finally {
      this.release(lock, start);
    }
  }

  /** Watchers reconcile these durable phases even after the head advances. */
  pending(pr: number): boolean {
    const record = this.read(pr);
    return !!record && ["starting", "waiting", "blocked"].includes(record.phase);
  }

  /** True while a dispatched fixer episode owns the card, including escalation. */
  fixing(pr: number): boolean {
    const record = this.read(pr);
    return (
      !!record &&
      record.dispatched === true &&
      ["starting", "waiting", "blocked"].includes(record.phase)
    );
  }

  private async run(pr: number, operation: Observation["operation"], retry: boolean) {
    const run: Run = {
      record: this.read(pr),
      observation: {
        pr,
        operation,
        retry,
        at: "start",
        root: this.root,
        escalatePaths:
          (this.config.conflicts as { escalatePaths?: string[] } | undefined)?.escalatePaths ?? [],
      },
      git: new GitTransport(this.config, this.env, this.deps, this.root),
    };
    for (;;) {
      const result = step(run.record, run.observation);
      run.record = result.record;
      for (const effect of result.effects) {
        await this.apply(run, effect);
      }
      if (!result.next) {
        return result;
      }
      run.observation.at = result.next;
    }
  }

  private async apply(run: Run, effect: Effect): Promise<void> {
    const o = run.observation;
    const pr = o.pr;
    switch (effect.kind) {
      case "lifecycle":
        o.lifecycle = await this.hooks.lifecycle(pr);
        break;
      case "snapshot":
        await this.snapshot(run, effect);
        break;
      case "status":
        o.status = await this.hooks.status(pr);
        break;
      case "preview":
        try {
          o.preview = (await run.git.mergePreview(effect.head, effect.base)).conflicts;
        } catch (error) {
          if (o.at !== "recheck") {
            throw error;
          }
          o.readError = { error };
        }
        break;
      case "ancestor":
        o.ancestor = (await run.git.run("merge-base", effect.base, effect.head)).trim();
        break;
      case "approved":
        o.approved = await this.hooks.approved(pr, effect.head);
        break;
      case "clock":
        o.now = this.deps.now();
        break;
      case "card-prior":
        o.prior = await this.hooks.cardPrior(pr);
        break;
      case "dispatch":
        o.dispatchStep = await this.hooks.fix(pr, effect.base, effect.files);
        break;
      case "card-conflict":
        try {
          await this.hooks.cardConflict(pr);
        } catch (error) {
          this.deps.report(
            `Conflict #${pr}: card could not show the fixer turn: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        break;
      case "update-branch":
        try {
          await this.hooks.update(pr, effect.head);
          o.update = "updated";
        } catch (error) {
          if (
            !(error instanceof GitHubHttpError) ||
            error.status !== 422 ||
            !/\bthere are no new commits on the base branch\b/i.test(error.message)
          ) {
            throw error;
          }
          o.update = "no-commits";
        }
        break;
      case "wait":
        o.waitCode = (await this.hooks.wait(pr)).code;
        break;
      case "clean": {
        const git = effect.worktree
          ? run.git
          : new GitTransport(this.config, this.env, this.deps, this.root);
        o.clean = await cleanBaseMerges(
          (...args) => git.run(...args),
          effect.head,
          effect.resolved,
          effect.base
        );
        break;
      }
      case "worker-blocked":
        o.workerBlocked = await this.hooks.workerBlocked(pr, effect.since);
        break;
      case "directory":
        o.directory = await this.hooks.directory(pr);
        break;
      case "worktree":
        o.directory = effect.directory;
        run.git = new GitTransport(this.config, this.env, this.deps, effect.directory);
        if (
          !(await run.git.transferOk("fetch", [
            `+refs/heads/${effect.branch}:refs/remotes/origin/${effect.branch}`,
          ]))
        ) {
          throw new Error("Conflict proof fetch failed");
        }
        if (effect.readHead) {
          o.worktreeHead = (await run.git.run("rev-parse", "HEAD")).trim();
        }
        break;
      case "dirty":
        o.dirty = !!(await run.git.run("status", "--porcelain")).trim();
        break;
      case "fast-forward":
        await run.git.run("merge", "--ff-only", effect.head);
        break;
      case "proof":
        o.proof = await proveConflictMerge(
          (...args) => run.git.run(...args),
          effect.head,
          effect.original,
          effect.base,
          effect.files
        );
        break;
      case "sync":
        await this.sync(run, effect);
        break;
      case "verify":
        o.verified = await this.hooks.verify(effect.directory, effect.head, () => {
          const notice = step(run.record, { ...o, at: "verify-notice" });
          run.record = notice.record;
          if (!notice.effects.length) {
            return false;
          }
          this.save(pr, run.record!);
          return true;
        });
        break;
      case "merge":
        try {
          await this.hooks.merge(pr, effect.certification, effect.head);
        } catch (error) {
          o.mergeError = error instanceof Error ? error.message : String(error);
        }
        break;
      case "restore":
        try {
          o.approvalKept = (await this.hooks.cardRestore(pr, effect.prior)) === "approval-kept";
        } catch (error) {
          o.restoreError = true;
          this.deps.report(
            `Conflict #${pr}: card could not return to its previous state: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        break;
      case "stop":
        try {
          await this.hooks.stop(pr);
        } catch {
          this.deps.report(
            `Conflict #${pr}: worker stop could not be confirmed; inspect the session before resuming`
          );
        }
        break;
      case "block":
        await this.hooks.blocked(pr, effect.reason, effect.files);
        break;
      case "report":
        this.deps.report(effect.line);
        break;
      case "save":
        this.save(pr, run.record!);
        break;
      case "close":
        try {
          this.discard(pr);
        } catch (error) {
          // The old pre-dispatch try/catch retried cleanup before propagating
          // an unlink failure; keep that failure boundary, too.
          if (effect.cleanupOnError) {
            this.discard(pr);
          }
          throw error;
        }
        break;
      case "throw":
        throw new Error(effect.message);
      case "raise":
        throw effect.error;
    }
  }

  private async snapshot(run: Run, effect: Extract<Effect, { kind: "snapshot" }>): Promise<void> {
    const o = run.observation;
    try {
      const snapshot = await this.hooks.snapshot(o.pr);
      if (effect.fetch) {
        const label = effect.fetch === "dispatch" ? "dispatch re-check" : effect.fetch;
        if (
          !(await run.git.transferOk("fetch", [
            `+refs/heads/${snapshot.base}:refs/remotes/origin/${snapshot.base}`,
            `+refs/heads/${snapshot.branch}:refs/remotes/origin/${snapshot.branch}`,
          ]))
        ) {
          throw new Error(`Conflict ${label} fetch failed`);
        }
        if (effect.fetch === "dispatch") {
          const head = (
            await run.git.run("rev-parse", `refs/remotes/origin/${snapshot.branch}`)
          ).trim();
          o.refs = { head, base: await liveBaseHead(snapshot.base, { git: run.git }) };
        } else if (
          (await liveBaseHead(snapshot.base, { git: run.git })) !== snapshot.baseSha ||
          (await run.git.run("rev-parse", `refs/remotes/origin/${snapshot.branch}`)).trim() !==
            snapshot.head
        ) {
          throw new Error(`Head or base moved during conflict ${effect.fetch}; run again`);
        }
      }
      if (effect.current) {
        o.current = snapshot;
      } else {
        o.snapshot = snapshot;
      }
    } catch (error) {
      if (effect.fetch !== "dispatch") {
        throw error;
      }
      o.readError = { error };
    }
  }

  private async sync(run: Run, effect: Extract<Effect, { kind: "sync" }>): Promise<void> {
    const changed = (
      await run.git.run("show", "--remerge-diff", "--format=", "--name-only", "-z", effect.head)
    )
      .split("\0")
      .filter(Boolean);
    for (const path of new Set([...effect.files, ...changed].map((file) => dirname(file)))) {
      try {
        await assertLockfileInSync(
          this.deps,
          join(effect.directory, path),
          npmCiEnvironment(this.env)
        );
      } catch (error) {
        run.observation.syncError = `lockfile sync check failed at ${path}: ${error instanceof Error ? error.message : String(error)}`;
        return;
      }
    }
  }

  private validate(pr: number): void {
    if (!Number.isSafeInteger(pr) || pr < 1) {
      throw new Error("Expected a positive PR number");
    }
  }

  private lockStart(): number {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const start = procStart(this.deps.readProc(this.deps.pid));
    if (start === null) {
      throw new Error("conflict lock requires /proc/<pid>/stat (Linux)");
    }
    return start;
  }

  private async acquire(
    pr: number,
    lock: string,
    start: number,
    waitMs: number
  ): Promise<string | undefined> {
    const deadline = this.deps.now() + waitMs;
    for (;;) {
      const busy = this.tryAcquire(pr, lock, start);
      if (busy === undefined) {
        return undefined;
      }
      if (this.deps.now() >= deadline) {
        return busy;
      }
      await this.deps.sleep(Math.min(1000, deadline - this.deps.now()));
    }
  }

  private tryAcquire(pr: number, lock: string, start: number): string | undefined {
    return new OwnedLock(lock, this.deps).conflict(pr, start);
  }

  private release(lock: string, start: number): void {
    new OwnedLock(lock, this.deps).releaseConflict(start);
  }

  private discard(pr: number): void {
    try {
      unlinkSync(join(this.directory, `${pr}.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  private read(pr: number): Resolution | undefined {
    const file = join(this.directory, `${pr}.json`);
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Resolution) : undefined;
  }

  private save(pr: number, record: Resolution): void {
    const file = join(this.directory, `${pr}.json`);
    writeFileSync(`${file}.new`, JSON.stringify(record) + "\n", { mode: 0o600 });
    renameSync(`${file}.new`, file);
  }
}
