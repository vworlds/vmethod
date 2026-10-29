import { matchesGlob } from "node:path";
import { CONFLICT_RESOLUTION_MS, CONFLICT_START_GRACE_MS } from "../core/time.js";
import type { CiSnapshot } from "../gateway/checks.js";
import type { ConflictPrior } from "../gateway/task-flow-types.js";
import { lockfilesOnly } from "../gateway/lockfile.js";

export const conflictCertification =
  "conflict-only resolution; remerge diff limited to conflicted hunks; verify and CI green";
const lockfileCertification =
  "lockfile-only resolution; remerge diff limited to lockfiles; lockfile sync, verify and CI green";

/** Durable phases; the on-disk schema is deliberately unchanged. */
export type Phase = "starting" | "waiting" | "resolved" | "blocked" | "merged";
export interface Resolution {
  head: string;
  base: string;
  branch: string;
  approved: boolean;
  files: string[];
  step: 1 | 2 | 3;
  phase: Phase;
  reason?: string;
  resolvedHead?: string;
  started: number;
  dispatched?: boolean;
  verifyNoticeReported?: boolean;
  prior?: ConflictPrior;
  restored?: boolean;
  approvalKept?: boolean;
}

/** Ephemeral continuations are not persisted. Each names a fresh observation,
 * including reads that must happen after a preceding write. */
type Stage =
  | "start"
  | "lifecycle"
  | "snapshot"
  | "held-status"
  | "held-preview"
  | "current"
  | "ancestor"
  | "existing"
  | "preview"
  | "approved"
  | "started"
  | "prior"
  | "recheck"
  | "recheck-preview"
  | "dispatched"
  | "dispatch-card"
  | "updated"
  | "waited"
  | "finish"
  | "outside-proof"
  | "deadline"
  | "status"
  | "worker-blocked"
  | "grace"
  | "constraints"
  | "directory"
  | "worktree"
  | "dirty"
  | "proof"
  | "clean-proof"
  | "merge-proof"
  | "synced"
  | "ci"
  | "verified"
  | "final"
  | "merged"
  | "restore"
  | "restored"
  | "event"
  | "verify-notice";

/** All external readings are supplied by the runner, never read by step itself.
 * `snapshot` stays fixed through a proof; `current` is a separate re-snapshot.
 * Error outcomes are data so dispatch/merge/restore failure boundaries stay exact. */
export interface Observation {
  pr: number;
  operation: "resolve" | "recover";
  at: Stage;
  retry: boolean;
  root: string;
  escalatePaths: string[];
  lifecycle?: "open" | "merged" | "closed";
  snapshot?: CiSnapshot;
  current?: CiSnapshot;
  refs?: { head: string; base: string };
  status?: "live" | "stopped" | "unknown";
  preview?: string[];
  ancestor?: string;
  approved?: boolean | "unknown";
  now?: number;
  prior?: ConflictPrior;
  dispatchStep?: 2 | 3;
  update?: "updated" | "no-commits";
  waitCode?: number;
  clean?: boolean;
  workerBlocked?: boolean;
  directory?: string;
  worktreeHead?: string;
  dirty?: boolean;
  proof?: boolean;
  syncError?: string;
  verified?: boolean;
  mergeError?: string;
  restoreError?: boolean;
  approvalKept?: boolean;
  /** A failed pre-dispatch observation must delete the not-yet-dispatched record
   * before propagating the original failure (including non-Error throws). */
  readError?: { error: unknown };
  /** Lock acquisition stays in the runner, which reports a held lock here and
   * supplies no other reads: resolve answers the holder's PENDING line, recover
   * reports the resolution as active. */
  busy?: string;
}

/** Ordered I/O requests. `next` is the continuation after the whole batch.
 * Save/close are explicit to preserve crash boundaries and the durable schema. */
export type Effect =
  | { kind: "lifecycle" }
  | { kind: "snapshot"; fetch?: "preview" | "recovery" | "dispatch"; current?: boolean }
  | { kind: "status" }
  | { kind: "preview"; head: string; base: string }
  | { kind: "ancestor"; head: string; base: string }
  | { kind: "approved"; head: string }
  | { kind: "clock" }
  | { kind: "card-prior" }
  | { kind: "dispatch"; base: string; files: string[] }
  | { kind: "card-conflict" }
  | { kind: "update-branch"; head: string }
  | { kind: "wait" }
  | { kind: "clean"; head: string; resolved: string; base: string; worktree: boolean }
  | { kind: "worker-blocked"; since: number }
  | { kind: "directory" }
  | { kind: "worktree"; directory: string; branch: string; readHead: boolean }
  | { kind: "dirty" }
  | { kind: "fast-forward"; head: string }
  | { kind: "proof"; head: string; original: string; base: string; files: string[] }
  | { kind: "sync"; directory: string; head: string; files: string[] }
  | { kind: "verify"; directory: string; head: string }
  | { kind: "merge"; head: string; certification: string }
  | { kind: "restore"; prior: ConflictPrior }
  | { kind: "stop" }
  | { kind: "block"; reason: string; files: string[] }
  | { kind: "report"; line: string }
  | { kind: "save" }
  | { kind: "close"; cleanupOnError?: boolean }
  | { kind: "raise"; error: unknown }
  | { kind: "throw"; message: string };

interface Transition {
  record: Resolution | undefined;
  effects: Effect[];
  line: string;
  next?: Stage;
  active?: boolean;
}

/** Decide one transition without I/O or mutation of either input. Apply effects in
 * order, then call again at `next` with fresh readings. A terminal result has no
 * `next`; recover reports its boolean through `active`, not a synthetic wake line. */
export function step(record: Resolution | undefined, o: Observation): Transition {
  const r = record ? structuredClone(record) : undefined;
  const s = o.snapshot!;
  const pr = o.pr;
  const go = (next: Stage, ...effects: Effect[]): Transition => ({
    record: r,
    effects,
    line: "",
    next,
  });
  const done = (line: string, effects: Effect[] = []): Transition => ({ record: r, effects, line });
  const active = (value: boolean): Transition => ({ ...done(""), active: value });
  const fail = (message: string): Transition => done("", [{ kind: "throw", message }]);
  const outside = (report = false): Transition => ({
    record: undefined,
    effects: [
      ...(report
        ? [
            {
              kind: "report" as const,
              line: `Conflict #${pr}: record closed at once instead of the next watcher poll`,
            },
          ]
        : []),
      { kind: "close", ...(o.at === "recheck-preview" ? { cleanupOnError: true } : {}) },
    ],
    line: o.operation === "recover" ? "" : `conflict on #${pr} resolved outside the fixer`,
    ...(o.operation === "recover" ? { active: false } : {}),
  });
  const block = (reason: string): Transition => {
    if (!r!.files.length) {
      return fail(`Conflict resolution #${pr}: ${reason}`);
    }
    r!.phase = "blocked";
    r!.reason = reason;
    return done(event(pr, r!), [
      { kind: "save" },
      ...(r!.dispatched ? [{ kind: "stop" as const }] : []),
      { kind: "block", reason, files: r!.files },
    ]);
  };
  const finish = (): Transition => go("finish");
  const current = (): Transition => go("current");
  const held = r && ["starting", "blocked"].includes(r.phase);
  if (o.busy) {
    return o.operation === "recover" ? active(true) : done(o.busy);
  }
  switch (o.at) {
    case "start":
      if (o.operation === "recover") {
        if (!r) {
          return active(false);
        }
        if (!held) {
          return active(r.phase === "waiting");
        }
      } else if (o.retry && (r?.phase !== "blocked" || r.reason !== "merge verify hook failed")) {
        return fail("Conflict retry requires a blocked merge verify hook failure");
      }
      return r
        ? go("lifecycle", { kind: "lifecycle" })
        : go("snapshot", { kind: "snapshot", fetch: "preview" });
    case "lifecycle":
      return o.lifecycle !== "open"
        ? outside()
        : go("snapshot", {
            kind: "snapshot",
            fetch: o.operation === "recover" ? "recovery" : "preview",
          });
    case "snapshot":
      if (o.operation === "recover") {
        return s.conflict ? active(true) : go("held-status", { kind: "status" });
      }
      return held && (o.retry || !s.conflict) ? go("held-status", { kind: "status" }) : current();
    case "held-status":
      if (o.operation === "recover") {
        return o.status !== "stopped"
          ? active(true)
          : go("held-preview", { kind: "preview", head: s.head, base: s.baseSha });
      }
      if (o.status !== "stopped") {
        return done(
          `PENDING #${pr}: conflict fixer ${o.status === "live" ? "running" : "status unknown; inspect session before recovery"}`
        );
      }
      return o.retry
        ? finish()
        : go("held-preview", { kind: "preview", head: s.head, base: s.baseSha });
    case "held-preview":
      if (!o.preview!.length) {
        return outside(o.operation === "recover");
      }
      return o.operation === "recover" ? active(true) : current();
    case "current": {
      if (r?.phase === "blocked") {
        return done(event(pr, r));
      }
      const pending = r && ["starting", "waiting"].includes(r.phase);
      if (!s.conflict && (!pending || (r.head === s.head && !r.files.length))) {
        return go("ancestor", { kind: "ancestor", head: s.head, base: s.baseSha });
      }
      return go("existing");
    }
    case "ancestor":
      if (o.ancestor === s.baseSha) {
        if (r && ["starting", "waiting"].includes(r.phase)) {
          r.phase = "resolved";
          r.resolvedHead = s.head;
          return done(`nothing to resolve for #${pr}`, [{ kind: "save" }]);
        }
        return done(`nothing to resolve for #${pr}`);
      }
      return go("existing");
    case "existing":
      if (
        r &&
        (["starting", "waiting"].includes(r.phase) ||
          r.resolvedHead === s.head ||
          r.head === s.head)
      ) {
        if (r.phase === "starting") {
          return fail(
            `Conflict #${pr}: previous dispatch was interrupted; inspect worker/update state`
          );
        }
        return r.phase === "waiting" ? finish() : go("restore");
      }
      return go("preview", { kind: "preview", head: s.head, base: s.baseSha });
    case "preview":
      return go("approved", { kind: "approved", head: s.head });
    case "approved":
      return go("started", { kind: "clock" });
    case "started": {
      const created: Resolution = {
        head: s.head,
        base: s.baseSha,
        branch: s.branch,
        approved: o.approved === true,
        files: [...o.preview!],
        step: o.preview!.length ? 3 : 1,
        phase: "starting",
        started: o.now!,
      };
      return {
        ...go(
          o.preview!.length ? "prior" : "updated",
          ...(o.preview!.length
            ? [{ kind: "card-prior" as const }]
            : [{ kind: "save" as const }, { kind: "update-branch" as const, head: s.head }])
        ),
        record: created,
      };
    }
    case "prior":
      r!.prior = structuredClone(o.prior);
      return go(
        "recheck",
        { kind: "save" },
        { kind: "snapshot", fetch: "dispatch", current: true }
      );
    case "recheck": {
      if (o.readError) {
        return {
          ...done("", [{ kind: "close" }, { kind: "raise", error: o.readError.error }]),
          record: undefined,
        };
      }
      const c = o.current!;
      const refs = o.refs!;
      if (
        refs.head === s.head &&
        refs.base === s.baseSha &&
        c.branch === s.branch &&
        c.base === s.base &&
        c.head === refs.head &&
        c.baseSha === refs.base
      ) {
        return go("dispatched", { kind: "dispatch", base: s.base, files: r!.files });
      }
      return go("recheck-preview", { kind: "preview", head: refs.head, base: refs.base });
    }
    case "recheck-preview":
      if (o.readError) {
        return {
          ...done("", [{ kind: "close" }, { kind: "raise", error: o.readError.error }]),
          record: undefined,
        };
      }
      return o.preview!.length
        ? {
            ...done(`PENDING #${pr}: head or base moved before the conflict dispatch; run again`, [
              { kind: "close", cleanupOnError: true },
            ]),
            record: undefined,
          }
        : outside();
    case "dispatched":
      r!.step = o.dispatchStep!;
      return go("dispatch-card", { kind: "card-conflict" });
    case "dispatch-card":
      r!.dispatched = true;
      r!.phase = "waiting";
      return done(
        `PENDING #${pr}: conflict fixer dispatched (step ${r!.step})${r!.approved || r!.prior?.status === "Approved" ? "; owner approval kept" : ""}`,
        [{ kind: "save" }]
      );
    case "updated":
      if (o.update === "no-commits") {
        r!.phase = "resolved";
        r!.resolvedHead = s.head;
        return done(`nothing to resolve for #${pr}`, [{ kind: "save" }]);
      }
      r!.phase = "waiting";
      return go("waited", { kind: "save" }, { kind: "wait" });
    case "waited":
      if (o.waitCode === 1 || o.waitCode === 3) {
        return block(o.waitCode === 1 ? "CI red" : "base conflicts again");
      }
      return o.waitCode === 2
        ? done(`PENDING #${pr}: waiting for CI`)
        : go("finish", { kind: "snapshot" });
    case "finish":
      if (!r!.dispatched && !s.conflict && s.branch === r!.branch) {
        if (s.baseSha !== r!.base) {
          return outside();
        }
        if (s.head !== r!.head) {
          return go("outside-proof", {
            kind: "clean",
            head: r!.head,
            resolved: s.head,
            base: r!.base,
            worktree: false,
          });
        }
      }
      return o.retry ? go("deadline") : go("deadline", { kind: "clock" });
    case "outside-proof":
      return o.clean ? (o.retry ? go("deadline") : go("deadline", { kind: "clock" })) : outside();
    case "deadline":
      if (!o.retry && o.now! - r!.started > CONFLICT_RESOLUTION_MS) {
        return block("conflict resolution exceeded the one-hour limit");
      }
      return go("status", { kind: "status" });
    case "status":
      if (o.status === "live") {
        return done(`PENDING #${pr}: conflict fixer running`);
      }
      return o.retry
        ? go("worker-blocked")
        : go("worker-blocked", { kind: "worker-blocked", since: r!.started });
    case "worker-blocked":
      if (!o.retry && o.workerBlocked) {
        return block("fixer reported BLOCKED or QUESTION");
      }
      return s.head === r!.head ? go("grace", { kind: "clock" }) : go("constraints");
    case "grace":
      if (o.now! - r!.started < CONFLICT_START_GRACE_MS) {
        return done(`PENDING #${pr}: waiting for conflict turn to start`);
      }
      return r!.step === 1
        ? done(`PENDING #${pr}: waiting for updated head`)
        : block("fixer stopped without a resolution");
    case "constraints":
      if (s.conflict || s.baseSha !== r!.base || s.branch !== r!.branch) {
        return block("head/base changed or still conflicting");
      }
      if (r!.files.some((file) => o.escalatePaths.some((pattern) => matchesGlob(file, pattern)))) {
        return block("escalated path requires owner review");
      }
      return r!.step !== 1 || r!.approved
        ? go("directory", { kind: "directory" })
        : go("directory");
    case "directory":
      return go("worktree", {
        kind: "worktree",
        directory: r!.step !== 1 || r!.approved ? o.directory! : o.root,
        branch: s.branch,
        readHead: r!.step !== 1 || r!.approved,
      });
    case "worktree":
      if ((r!.step !== 1 || r!.approved) && o.worktreeHead !== s.head) {
        return r!.step !== 1
          ? block("worktree does not contain the resolved head")
          : go("dirty", { kind: "dirty" });
      }
      return go("proof");
    case "dirty":
      return o.dirty
        ? block("worktree does not contain the resolved head")
        : go("proof", { kind: "fast-forward", head: s.head });
    case "proof":
      return r!.step === 1
        ? go("clean-proof", {
            kind: "clean",
            head: r!.head,
            resolved: s.head,
            base: r!.base,
            worktree: true,
          })
        : go("merge-proof", {
            kind: "proof",
            head: s.head,
            original: r!.head,
            base: r!.base,
            files: r!.files,
          });
    case "clean-proof":
      return o.clean ? go("ci") : block("update-branch produced more than a clean base merge");
    case "merge-proof":
      if (!o.proof) {
        return block(
          lockfilesOnly(r!.files)
            ? "lockfile-only merge proof failed (expected exact merge parents and remerge diff limited to lockfiles)"
            : "remerge diff is not limited to conflicted hunks"
        );
      }
      return lockfilesOnly(r!.files)
        ? go("synced", { kind: "sync", directory: o.directory!, head: s.head, files: r!.files })
        : go("ci");
    case "synced":
      return o.syncError ? block(o.syncError) : go("ci");
    case "ci":
      if (!s.green || s.stale) {
        return s.runs.some(
          (run) =>
            run.status === "completed" &&
            !["success", "neutral", "skipped"].includes(String(run.conclusion))
        )
          ? block("CI red")
          : done(`PENDING #${pr}: waiting for green CI on current base`);
      }
      return r!.step === 3 || r!.approved || (r!.step !== 1 && lockfilesOnly(r!.files))
        ? go("verified", { kind: "verify", directory: o.directory!, head: s.head })
        : go("final", { kind: "snapshot", current: true });
    case "verify-notice":
      if (r!.verifyNoticeReported) {
        return done("");
      }
      r!.verifyNoticeReported = true;
      return done("", [{ kind: "save" }]);
    case "verified":
      return o.verified
        ? go("final", { kind: "snapshot", current: true })
        : block("merge verify hook failed");
    case "final": {
      const c = o.current!;
      if (
        c.head !== s.head ||
        c.baseSha !== r!.base ||
        c.branch !== r!.branch ||
        c.conflict ||
        !c.green ||
        c.stale
      ) {
        return block("head/base/CI changed during verification");
      }
      r!.resolvedHead = s.head;
      r!.phase = "resolved";
      delete r!.reason;
      return r!.approved
        ? go(
            "merged",
            { kind: "save" },
            {
              kind: "merge",
              head: s.head,
              certification:
                r!.step !== 1 && lockfilesOnly(r!.files)
                  ? lockfileCertification
                  : conflictCertification,
            }
          )
        : go("restore", { kind: "save" }, { kind: "save" });
    }
    case "merged":
      if (o.mergeError !== undefined) {
        r!.reason = `auto-merge refused (${o.mergeError}); merge manually when ready`;
      } else {
        r!.phase = "merged";
      }
      return go("restore", { kind: "save" });
    case "restore":
      return r!.phase === "resolved" && r!.prior && r!.dispatched && !r!.restored
        ? go("restored", { kind: "restore", prior: r!.prior })
        : go("event");
    case "restored":
      if (o.restoreError) {
        return go("event");
      }
      r!.approvalKept = o.approvalKept === true;
      r!.restored = true;
      return go("event", { kind: "save" });
    case "event":
      return done(event(pr, r!));
  }
}

function event(pr: number, r: Resolution): string {
  if (r.phase === "blocked") {
    return `BLOCKED #${pr}: conflict escalated (${r.reason})`;
  }
  if (r.phase === "merged") {
    return `MERGED #${pr} (conflict-only, approval carried)`;
  }
  if (r.phase === "resolved") {
    const kept = r.approvalKept ? "; owner approval kept" : "";
    return r.reason
      ? `RESOLVED #${pr}: ${r.reason}${kept}`
      : `RESOLVED #${pr} (step ${r.step})${kept}`;
  }
  return `PENDING #${pr}: conflict dispatch in progress; inspect gateway state before retrying`;
}
