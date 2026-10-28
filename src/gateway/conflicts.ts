import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, matchesGlob } from "node:path";
import type { Config } from "../config.js";
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
import { assertLockfileInSync, lockfilesOnly, npmCiEnvironment } from "./lockfile.js";

export const conflictCertification =
  "conflict-only resolution; remerge diff limited to conflicted hunks; verify and CI green";

/** #373: how long a conflict dispatch or an at-once recovery waits for a live
 * conflict lock holder (a refresh-checks snapshot and push, or another
 * reconcile) before returning its quiet pending line. */
export const conflictLockWaitMs = 60_000;

const lockfileConflictCertification =
  "lockfile-only resolution; remerge diff limited to lockfiles; lockfile sync, verify and CI green";

interface Resolution {
  head: string;
  base: string;
  branch: string;
  approved: boolean;
  files: string[];
  step: 1 | 2 | 3;
  phase: "starting" | "waiting" | "resolved" | "blocked" | "merged";
  reason?: string;
  resolvedHead?: string;
  started: number;
  dispatched?: boolean;
  verifyNoticeReported?: boolean;
  /** Card turn (Status, Progress, assignees) captured before a step-2/3 dispatch. */
  prior?: ConflictPrior;
  /** Set once the stored prior card was restored after RESOLVED. */
  restored?: boolean;
  /** Set by the restore when an owner approval found on the live card was kept. */
  approvalKept?: boolean;
}

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
  /**
   * Return the card to the stored prior once the resolution resolves; "approval-kept"
   * reports a live owner approval the restore kept instead of overwriting.
   */
  cardRestore(pr: number, prior: ConflictPrior): Promise<void | "approval-kept">;
  /** Tolerant PR lifecycle read: a merged or closed PR closes its record instead of failing. */
  lifecycle(pr: number): Promise<"open" | "merged" | "closed">;
}

/** Durable, bounded conflict workflow. Agents propose; only server-side evidence can carry approval. */
export class ConflictService {
  private readonly directory: string;
  constructor(
    private root: string,
    private config: Config,
    private env: NodeJS.ProcessEnv,
    /** The watcher's deps: the lock reads the process identity and /proc for liveness. */
    private deps: EventDeps,
    private hooks: ConflictHooks
  ) {
    this.directory = join(
      stateRoot(env, String(config.stateName ?? String(config.repo).replace("/", "-"))),
      "conflicts"
    );
  }

  /** Start once per conflicting head, or reconcile a previously dispatched resolution.
   * Current heads are no-ops; reconciliation errors propagate without conflict escalation.
   * A record whose PR is no longer open, or that a not-dispatched resolution can no
   * longer attribute on a mergeable PR, closes quietly as resolved outside the fixer.
   * Stopped starting/blocked records also close on a proven mergeable PR, independently of CI.
   * retry re-proves and verifies a blocked verification failure instead of closing it.
   * Auto-merge errors retain resolved state and return actionable manual-merge guidance.
   * The per-pr lock is owned like the watcher's: a dead owner's lock is cleared and the
   * reconcile continues, while a live owner reads as a quiet in-progress pending —
   * or, with waitMs (#373), as a bounded wait that lets the watcher's dispatch
   * re-read the head and base after a refresh-checks push instead of racing it.
   */
  async resolve(pr: number, retry = false, waitMs = 0): Promise<string> {
    if (!Number.isSafeInteger(pr) || pr < 1) {
      throw new Error("Expected a positive PR number");
    }
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
      return await this.run(pr, retry);
    } finally {
      this.release(lock, start);
    }
  }

  /** Hold the per-PR conflict lock around fn (#373): refresh-checks shares the
   * watcher's lock, so its snapshot and push never interleave with a dispatch.
   * Returns the quiet busy line instead of the result while a live holder keeps it. */
  async guard<T>(pr: number, fn: () => Promise<T>): Promise<{ busy: string } | { value: T }> {
    if (!Number.isSafeInteger(pr) || pr < 1) {
      throw new Error("Expected a positive PR number");
    }
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

  /** #373: a blocked or starting record whose PR is mergeable at its current head,
   * with the fixer stopped, closes here at once — `resolve-conflicts` and
   * `review <pr> owner` no longer wait for the next watcher poll. Returns true
   * while an active record still blocks the handover. */
  async recover(pr: number): Promise<boolean> {
    if (!Number.isSafeInteger(pr) || pr < 1) {
      throw new Error("Expected a positive PR number");
    }
    const lock = join(this.directory, `${pr}.lock`);
    const start = this.lockStart();
    const busy = await this.acquire(pr, lock, start, conflictLockWaitMs);
    if (busy !== undefined) {
      return true;
    }
    try {
      return await this.recoverHeld(pr);
    } finally {
      this.release(lock, start);
    }
  }

  /** Watchers reconcile starting, waiting and blocked fixes even after the head advances. */
  pending(pr: number): boolean {
    const record = this.read(pr);
    return !!record && ["starting", "waiting", "blocked"].includes(record.phase);
  }

  /** True while a dispatched step-2/3 fixer episode owns the card, including escalation. */
  fixing(pr: number): boolean {
    const record = this.read(pr);
    return (
      !!record &&
      record.dispatched === true &&
      ["starting", "waiting", "blocked"].includes(record.phase)
    );
  }

  /** The recover() body under the lock: only starting/blocked records close, and
   * never a dispatched fixer's waiting turn — that resolution keeps its proof path. */
  private async recoverHeld(pr: number): Promise<boolean> {
    const record = this.read(pr);
    if (!record) {
      return false;
    }
    if (!["starting", "blocked"].includes(record.phase)) {
      return record.phase === "waiting";
    }
    // A PR that ended outside this workflow closes its record quietly, exactly
    // like a reconcile, before a snapshot read could fail on a not-open PR.
    if ((await this.hooks.lifecycle(pr)) !== "open") {
      this.closeOutsideFixer(pr);
      return false;
    }
    const snapshot = await this.hooks.snapshot(pr);
    const git = new GitTransport(this.config, this.env, this.deps, this.root);
    if (
      !(await git.transferOk("fetch", [
        `+refs/heads/${snapshot.base}:refs/remotes/origin/${snapshot.base}`,
        `+refs/heads/${snapshot.branch}:refs/remotes/origin/${snapshot.branch}`,
      ]))
    ) {
      throw new Error("Conflict recovery fetch failed");
    }
    if (
      (await liveBaseHead(snapshot.base, { git })) !== snapshot.baseSha ||
      (await git.run("rev-parse", `refs/remotes/origin/${snapshot.branch}`)).trim() !==
        snapshot.head
    ) {
      throw new Error("Head or base moved during conflict recovery; run again");
    }
    if (snapshot.conflict) {
      return true;
    }
    if ((await this.hooks.status(pr)) !== "stopped") {
      return true;
    }
    // GitHub can report a temporarily unknown mergeability as non-conflicting.
    // Prove the fetched head/base merge cleanly before discarding durable state.
    if ((await git.mergePreview(snapshot.head, snapshot.baseSha)).conflicts.length) {
      return true;
    }
    this.deps.report(`Conflict #${pr}: record closed at once instead of the next watcher poll`);
    this.closeOutsideFixer(pr);
    return false;
  }

  /** Create the lock directory and read this process's /proc start time. */
  private lockStart(): number {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const start = procStart(this.deps.readProc(this.deps.pid));
    if (start === null) {
      throw new Error("conflict lock requires /proc/<pid>/stat (Linux)");
    }
    return start;
  }

  /** Acquire the lock, waiting up to waitMs while a live holder keeps it (#373):
   * the watcher's dispatch waits out a refresh-checks push or a reconcile and
   * then re-reads the head and base. Every retry also clears dead holders. */
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

  /** Create the per-pr lock, or return a quiet in-progress line while a live owner keeps it. */
  private tryAcquire(pr: number, lock: string, start: number): string | undefined {
    for (let attempt = 0; ; attempt++) {
      try {
        writeFileSync(
          lock,
          `${JSON.stringify({ pid: this.deps.pid, start, at: new Date(this.deps.now()).toISOString() })}\n`,
          { flag: "wx", mode: 0o700 }
        );
        return undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        let holderText: string;
        try {
          holderText = readFileSync(lock, "utf8");
        } catch (readError) {
          const code = (readError as NodeJS.ErrnoException).code;
          if (code === "EISDIR") {
            // A lock left by versions before the owned lock is a directory: ownerless.
            try {
              rmdirSync(lock);
            } catch (rmdirError) {
              if ((rmdirError as NodeJS.ErrnoException).code !== "ENOENT") {
                throw new Error(
                  `Conflict #${pr}: cannot clear the legacy conflict lock directory`,
                  {
                    cause: rmdirError,
                  }
                );
              }
            }
            continue;
          }
          if (code === "ENOENT" && attempt < 2) {
            continue; // A contender cleared it; create again.
          }
          throw readError;
        }
        const holder = lockOwner(holderText);
        const holderStart = procStart(holder.pid === null ? null : this.deps.readProc(holder.pid));
        // The same pid with a different start time is a reused pid: stale, not alive.
        if (holder.pid !== null && holderStart !== null && holderStart === holder.start) {
          return `PENDING #${pr}: conflict resolution in progress (pid ${holder.pid})`;
        }
        // Unlike the watcher there is no freshness gate on an unreadable body: only a
        // crash between the exclusive create and the body write produces one, and
        // reading it as a dead owner recovers immediately.
        if (attempt >= 2) {
          throw new Error(`Conflict #${pr}: cannot clear the stale conflict lock`, {
            cause: error,
          });
        }
        // Another contender may already have replaced this stale file.
        if (readFileSync(lock, "utf8") !== holderText) {
          continue;
        }
        unlinkSync(lock);
      }
    }
  }

  /** Release only while we still own the lock; a takeover must not erase a later owner's claim. */
  private release(lock: string, start: number): void {
    try {
      const holder = lockOwner(readFileSync(lock, "utf8"));
      if (holder.pid === this.deps.pid && holder.start === start) {
        unlinkSync(lock);
      }
    } catch {
      /* releasing never masks the resolution's own outcome */
    }
  }

  private async run(pr: number, retry: boolean): Promise<string> {
    const old = this.read(pr);
    if (retry && (old?.phase !== "blocked" || old.reason !== "merge verify hook failed")) {
      throw new Error("Conflict retry requires a blocked merge verify hook failure");
    }
    if (old) {
      // A PR that ended outside this workflow closes its record quietly: reading its
      // CI snapshot would fail every later reconciliation with a not-open error.
      if ((await this.hooks.lifecycle(pr)) !== "open") {
        return this.closeOutsideFixer(pr);
      }
    }
    const snapshot = await this.hooks.snapshot(pr);
    const git = new GitTransport(this.config, this.env, this.deps, this.root);
    if (
      !(await git.transferOk("fetch", [
        `+refs/heads/${snapshot.base}:refs/remotes/origin/${snapshot.base}`,
        `+refs/heads/${snapshot.branch}:refs/remotes/origin/${snapshot.branch}`,
      ]))
    ) {
      throw new Error("Conflict preview fetch failed");
    }
    if (
      (await liveBaseHead(snapshot.base, { git })) !== snapshot.baseSha ||
      (await git.run("rev-parse", `refs/remotes/origin/${snapshot.branch}`)).trim() !==
        snapshot.head
    ) {
      throw new Error("Head or base moved during conflict preview; run again");
    }
    if (old && ["starting", "blocked"].includes(old.phase)) {
      if (retry || !snapshot.conflict) {
        const status = await this.hooks.status(pr);
        if (status !== "stopped") {
          return `PENDING #${pr}: conflict fixer ${status === "live" ? "running" : "status unknown; inspect session before recovery"}`;
        }
        if (retry) {
          return this.finish(pr, old, snapshot, true);
        }
        // GitHub can report a temporarily unknown mergeability as non-conflicting.
        // Prove the fetched head/base merge cleanly before discarding durable state.
        if (!(await git.mergePreview(snapshot.head, snapshot.baseSha)).conflicts.length) {
          return this.closeOutsideFixer(pr);
        }
      }
      if (old.phase === "blocked") {
        return this.event(pr, old);
      }
    }
    const active = old && ["starting", "waiting"].includes(old.phase);
    if (
      !snapshot.conflict &&
      (!active || (old.head === snapshot.head && old.files.length === 0)) &&
      (await git.run("merge-base", snapshot.baseSha, snapshot.head)).trim() === snapshot.baseSha
    ) {
      if (active) {
        old.phase = "resolved";
        old.resolvedHead = snapshot.head;
        this.save(pr, old);
      }
      return `nothing to resolve for #${pr}`;
    }
    if (old && (active || old.resolvedHead === snapshot.head || old.head === snapshot.head)) {
      if (old.phase === "starting") {
        throw new Error(
          `Conflict #${pr}: previous dispatch was interrupted; inspect worker/update state`
        );
      }
      if (old.phase === "waiting") {
        return this.finish(pr, old, snapshot);
      }
      await this.restore(pr, old);
      return this.event(pr, old);
    }
    const files = (await git.mergePreview(snapshot.head, snapshot.baseSha)).conflicts;
    const record: Resolution = {
      head: snapshot.head,
      base: snapshot.baseSha,
      branch: snapshot.branch,
      approved: (await this.hooks.approved(pr, snapshot.head)) === true,
      files,
      step: files.length ? 3 : 1,
      phase: "starting",
      started: this.deps.now(),
    };
    if (files.length) {
      // Capture before any dispatch so an interrupted run never loses the turn to restore.
      record.prior = await this.hooks.cardPrior(pr);
    }
    this.save(pr, record);
    if (!files.length) {
      try {
        await this.hooks.update(pr, snapshot.head);
      } catch (error) {
        if (
          !(error instanceof GitHubHttpError) ||
          error.status !== 422 ||
          !/\bthere are no new commits on the base branch\b/i.test(error.message)
        ) {
          throw error;
        }
        record.phase = "resolved";
        record.resolvedHead = snapshot.head;
        this.save(pr, record);
        return `nothing to resolve for #${pr}`;
      }
      record.phase = "waiting";
      this.save(pr, record);
      const verdict = await this.hooks.wait(pr);
      if (verdict.code === 1 || verdict.code === 3) {
        return this.block(pr, record, verdict.code === 1 ? "CI red" : "base conflicts again");
      }
      if (verdict.code === 2) {
        return `PENDING #${pr}: waiting for CI`;
      }
      return this.finish(pr, record, await this.hooks.snapshot(pr));
    }
    // #373: a push that landed while the card turn was captured (refresh-checks,
    // the worker, an owner) leaves the fixer stale. Re-read the current refs and
    // re-prove the conflict immediately before the fixer starts.
    const stale = await this.recheckBeforeDispatch(pr, git, snapshot);
    if (stale !== undefined) {
      return stale;
    }
    record.step = await this.hooks.fix(pr, snapshot.base, files);
    try {
      await this.hooks.cardConflict(pr);
    } catch (error) {
      this.deps.report(
        `Conflict #${pr}: card could not show the fixer turn: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    record.dispatched = true;
    record.phase = "waiting";
    this.save(pr, record);
    // The dispatch's own card read (prior.status) reports a live owner approval even
    // before it is verified on the exact head; both are kept on the card regardless.
    const cardApproved = record.approved || record.prior?.status === "Approved";
    return `PENDING #${pr}: conflict fixer dispatched (step ${record.step})${cardApproved ? "; owner approval kept" : ""}`;
  }

  /** #373: the pre-dispatch re-read. Returns undefined when the fixer may start;
   * any other outcome discards the not-yet-dispatched record and returns its
   * result line: a head/base that moved leaves this dispatch to the next poll,
   * a conflict that is gone closes as resolved outside the fixer. */
  private async recheckBeforeDispatch(
    pr: number,
    git: GitTransport,
    snapshot: CiSnapshot
  ): Promise<string | undefined> {
    try {
      const current = await this.hooks.snapshot(pr);
      if (
        !(await git.transferOk("fetch", [
          `+refs/heads/${current.base}:refs/remotes/origin/${current.base}`,
          `+refs/heads/${current.branch}:refs/remotes/origin/${current.branch}`,
        ]))
      ) {
        throw new Error("Conflict dispatch re-check fetch failed");
      }
      const head = (await git.run("rev-parse", `refs/remotes/origin/${current.branch}`)).trim();
      const base = await liveBaseHead(current.base, { git });
      if (
        head === snapshot.head &&
        base === snapshot.baseSha &&
        current.branch === snapshot.branch &&
        current.base === snapshot.base &&
        current.head === head &&
        current.baseSha === base
      ) {
        // The proven conflict still stands on these exact refs; the local
        // merge preview is a pure function of them, so it cannot have changed.
        return undefined;
      }
      // GitHub can report a temporarily unknown mergeability; the local re-merge
      // on the current refs decides whether the fixer still has work at all.
      if ((await git.mergePreview(head, base)).conflicts.length) {
        this.discard(pr);
        return `PENDING #${pr}: head or base moved before the conflict dispatch; run again`;
      }
      return this.closeOutsideFixer(pr);
    } catch (error) {
      // No dispatch started; a starting record would read as an interrupted dispatch.
      this.discard(pr);
      throw error;
    }
  }

  private async finish(
    pr: number,
    record: Resolution,
    snapshot: CiSnapshot,
    retry = false
  ): Promise<string> {
    // Step-1 records dispatch no fixer, so no fixer session explains a new head. A
    // healthy PR whose base moved, or whose head a clean-base proof cannot attribute,
    // was resolved outside the fixer: the record closes quietly instead of failing.
    // This covers a worker's review-round fix, a manual resolution and the stale
    // state of an interrupted process, and it runs before the resolution deadline.
    if (!record.dispatched && !snapshot.conflict && snapshot.branch === record.branch) {
      if (snapshot.baseSha !== record.base) {
        return this.closeOutsideFixer(pr);
      }
      if (
        snapshot.head !== record.head &&
        !(await cleanBaseMerges(
          (...args) => new GitTransport(this.config, this.env, this.deps, this.root).run(...args),
          record.head,
          snapshot.head,
          record.base
        ))
      ) {
        return this.closeOutsideFixer(pr);
      }
    }
    if (!retry && this.deps.now() - record.started > 60 * 60_000) {
      return this.block(pr, record, "conflict resolution exceeded the one-hour limit");
    }
    if ((await this.hooks.status(pr)) === "live") {
      return `PENDING #${pr}: conflict fixer running`;
    }
    if (!retry && (await this.hooks.workerBlocked(pr, record.started))) {
      return this.block(pr, record, "fixer reported BLOCKED or QUESTION");
    }
    if (snapshot.head === record.head) {
      if (this.deps.now() - record.started < 120_000) {
        return `PENDING #${pr}: waiting for conflict turn to start`;
      }
      if (record.step === 1) {
        return `PENDING #${pr}: waiting for updated head`;
      }
      return this.block(pr, record, "fixer stopped without a resolution");
    }
    if (
      snapshot.conflict ||
      snapshot.baseSha !== record.base ||
      snapshot.branch !== record.branch
    ) {
      return this.block(pr, record, "head/base changed or still conflicting");
    }
    const patterns =
      (this.config.conflicts as { escalatePaths?: string[] } | undefined)?.escalatePaths ?? [];
    if (record.files.some((file) => patterns.some((pattern) => matchesGlob(file, pattern)))) {
      return this.block(pr, record, "escalated path requires owner review");
    }
    const needsWorktree = record.step !== 1 || record.approved;
    const directory = needsWorktree ? await this.hooks.directory(pr) : this.root;
    const git = new GitTransport(this.config, this.env, this.deps, directory);
    if (
      !(await git.transferOk("fetch", [
        `+refs/heads/${snapshot.branch}:refs/remotes/origin/${snapshot.branch}`,
      ]))
    ) {
      throw new Error("Conflict proof fetch failed");
    }
    if (needsWorktree && (await git.run("rev-parse", "HEAD")).trim() !== snapshot.head) {
      if (record.step !== 1 || (await git.run("status", "--porcelain")).trim()) {
        return this.block(pr, record, "worktree does not contain the resolved head");
      }
      await git.run("merge", "--ff-only", snapshot.head);
    }
    if (
      record.step === 1 &&
      !(await cleanBaseMerges(
        (...args) => git.run(...args),
        record.head,
        snapshot.head,
        record.base
      ))
    ) {
      return this.block(pr, record, "update-branch produced more than a clean base merge");
    }
    const lockfileOnly = record.step !== 1 && lockfilesOnly(record.files);
    if (
      record.step !== 1 &&
      !(await proveConflictMerge(
        (...args) => git.run(...args),
        snapshot.head,
        record.head,
        record.base,
        record.files
      ))
    ) {
      return this.block(
        pr,
        record,
        lockfileOnly
          ? "lockfile-only merge proof failed (expected exact merge parents and remerge diff limited to lockfiles)"
          : "remerge diff is not limited to conflicted hunks"
      );
    }
    if (lockfileOnly) {
      const changed = (
        await git.run("show", "--remerge-diff", "--format=", "--name-only", "-z", snapshot.head)
      )
        .split("\0")
        .filter(Boolean);
      for (const path of new Set([...record.files, ...changed].map((file) => dirname(file)))) {
        try {
          await assertLockfileInSync(this.deps, join(directory, path), npmCiEnvironment(this.env));
        } catch (error) {
          return this.block(
            pr,
            record,
            `lockfile sync check failed at ${path}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
    if (!snapshot.green || snapshot.stale) {
      if (
        snapshot.runs.some(
          (run) =>
            run.status === "completed" &&
            !["success", "neutral", "skipped"].includes(String(run.conclusion))
        )
      ) {
        return this.block(pr, record, "CI red");
      }
      return `PENDING #${pr}: waiting for green CI on current base`;
    }
    if (
      (record.step === 3 || record.approved || lockfileOnly) &&
      !(await this.hooks.verify(directory, snapshot.head, () => {
        if (record.verifyNoticeReported) {
          return false;
        }
        record.verifyNoticeReported = true;
        this.save(pr, record);
        return true;
      }))
    ) {
      return this.block(pr, record, "merge verify hook failed");
    }
    const current = await this.hooks.snapshot(pr);
    if (
      current.head !== snapshot.head ||
      current.baseSha !== record.base ||
      current.branch !== record.branch ||
      current.conflict ||
      !current.green ||
      current.stale
    ) {
      return this.block(pr, record, "head/base/CI changed during verification");
    }
    record.resolvedHead = snapshot.head;
    record.phase = "resolved";
    delete record.reason;
    this.save(pr, record);
    if (record.approved) {
      try {
        await this.hooks.merge(
          pr,
          lockfileOnly ? lockfileConflictCertification : conflictCertification,
          snapshot.head
        );
        record.phase = "merged";
      } catch (error) {
        record.reason = `auto-merge refused (${error instanceof Error ? error.message : String(error)}); merge manually when ready`;
      }
    }
    this.save(pr, record);
    if (record.phase === "resolved") {
      await this.restore(pr, record);
    }
    return this.event(pr, record);
  }

  private async block(pr: number, record: Resolution, reason: string): Promise<string> {
    if (!record.files.length) {
      throw new Error(`Conflict resolution #${pr}: ${reason}`);
    }
    record.phase = "blocked";
    record.reason = reason;
    this.save(pr, record);
    if (record.dispatched) {
      try {
        await this.hooks.stop(pr);
      } catch {
        this.deps.report(
          `Conflict #${pr}: worker stop could not be confirmed; inspect the session before resuming`
        );
      }
    }
    await this.hooks.blocked(pr, reason, record.files);
    return this.event(pr, record);
  }

  /** Remove the record for an out-of-band resolution; the report stays quiet, no card write. */
  private closeOutsideFixer(pr: number): string {
    this.discard(pr);
    return `conflict on #${pr} resolved outside the fixer`;
  }

  /** Delete the record file; nothing dispatched may depend on it anymore. */
  private discard(pr: number): void {
    try {
      unlinkSync(join(this.directory, `${pr}.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  /** Return the stored pre-dispatch card exactly once after RESOLVED; retries on reconciliation. */
  private async restore(pr: number, record: Resolution): Promise<void> {
    if (record.phase !== "resolved" || !record.prior || !record.dispatched || record.restored) {
      return;
    }
    try {
      const outcome = await this.hooks.cardRestore(pr, record.prior);
      record.approvalKept = outcome === "approval-kept";
    } catch (error) {
      this.deps.report(
        `Conflict #${pr}: card could not return to its previous state: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    record.restored = true;
    this.save(pr, record);
  }

  private event(pr: number, record: Resolution): string {
    if (record.phase === "blocked") {
      return `BLOCKED #${pr}: conflict escalated (${record.reason})`;
    }
    if (record.phase === "merged") {
      return `MERGED #${pr} (conflict-only, approval carried)`;
    }
    if (record.phase === "resolved") {
      const kept = record.approvalKept ? "; owner approval kept" : "";
      if (record.reason) {
        return `RESOLVED #${pr}: ${record.reason}${kept}`;
      }
      return `RESOLVED #${pr} (step ${record.step})${kept}`;
    }
    return `PENDING #${pr}: conflict dispatch in progress; inspect gateway state before retrying`;
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

/** A conflict lock holder; PIDs are reused, so the recorded process start decides liveness. */
interface LockOwner {
  pid: number | null;
  start: number | null;
}

/** Anything unreadable reads as no owner, so a damaged lock is cleared instead of blocking. */
function lockOwner(text: string): LockOwner {
  try {
    const holder = JSON.parse(text) as unknown;
    const pid = Number((holder as { pid?: unknown }).pid);
    const start = Number((holder as { start?: unknown }).start);
    return {
      pid: Number.isSafeInteger(pid) && pid >= 1 ? pid : null,
      start: Number.isSafeInteger(start) && start >= 0 ? start : null,
    };
  } catch {
    return { pid: null, start: null };
  }
}
