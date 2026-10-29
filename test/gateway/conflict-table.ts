import type { ConflictPrior } from "../../src/gateway/task-flow-types.js";

/** Symbolic refs are substituted by the service adapter, not by the oracle. */
interface ResolutionRecord {
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
  prior?: ConflictPrior;
  restored?: boolean;
  approvalKept?: boolean;
}

interface Observation {
  snapshot: {
    head: string;
    baseSha: string;
    branch: string;
    conflict: boolean;
    green: boolean;
    stale: boolean;
    red?: boolean;
  };
  lifecycle: "open" | "merged" | "closed";
  workerStatus: "live" | "stopped" | "unknown";
  preview: string[];
  proofs: {
    merge: "hunks" | "outside-hunk" | "wrong-parents" | "foreign" | "clean";
    worktree: boolean;
    sync: boolean;
    verify: boolean;
  };
  now: number;
  retry: boolean;
  approved: boolean | "unknown";
  card: ConflictPrior;
  lock?: "live" | "dead" | "reused";
  waitMs?: number;
  waitCode: 0 | 1 | 2 | 3;
  dispatchStep: 2 | 3;
  dispatchFailure?: boolean;
  beforeDispatch?: "moved" | "vanished";
  afterVerify?: "head" | "base" | "branch" | "conflict" | "red" | "stale";
  workerBlocked?: boolean;
  escalated?: boolean;
  restore?: "failure" | "approval-kept";
  mergeFailure?: boolean;
  update?: "no-commits" | "failure" | "merge";
  verifyNotice?: boolean;
}

export type Effect =
  | { kind: "dispatch"; base: string; files: string[] }
  | { kind: "update-branch"; head: string }
  | { kind: "wait" }
  | { kind: "stop" }
  | { kind: "card-prior" }
  | { kind: "card-conflict" }
  | { kind: "verify"; head: string }
  | { kind: "sync"; directory: string }
  | { kind: "block"; reason: string; files: string[] }
  | { kind: "restore"; prior: ConflictPrior }
  | { kind: "merge"; head: string; certification: string };

export interface TransitionRow {
  name: string;
  operation: "resolve" | "recover";
  prior: ResolutionRecord | null;
  observation: Observation;
  expected: {
    record: ResolutionRecord | null;
    effects: Effect[];
    line?: string;
    error?: string;
    active?: boolean;
    pending: boolean;
    fixing: boolean;
    card: ConflictPrior;
    lock: boolean;
  };
}

const card: ConflictPrior = { status: "In review", progress: "👤🔍", assignees: ["owner"] };
const approvedCard: ConflictPrior = { ...card, status: "Approved" };
const files = ["conflict.txt"];
const waiting: ResolutionRecord = {
  head: "H",
  base: "B",
  branch: "task",
  approved: false,
  files,
  step: 3,
  phase: "waiting",
  started: 0,
  dispatched: true,
  prior: card,
};
const observation: Observation = {
  snapshot: { head: "R", baseSha: "B", branch: "task", conflict: false, green: true, stale: false },
  lifecycle: "open",
  workerStatus: "stopped",
  preview: files,
  proofs: { merge: "hunks", worktree: true, sync: true, verify: true },
  now: 1000,
  retry: false,
  approved: false,
  card,
  waitCode: 2,
  dispatchStep: 3,
};
const certification =
  "conflict-only resolution; remerge diff limited to conflicted hunks; verify and CI green";
const lockCertification =
  "lockfile-only resolution; remerge diff limited to lockfiles; lockfile sync, verify and CI green";
const verify: Effect = { kind: "verify", head: "R" };
const restore: Effect = { kind: "restore", prior: card };
const resolved: ResolutionRecord = {
  ...waiting,
  phase: "resolved",
  resolvedHead: "R",
  restored: true,
  approvalKept: false,
};

function row(
  name: string,
  prior: ResolutionRecord | null,
  changes: Partial<Observation>,
  record: ResolutionRecord | null,
  effects: Effect[],
  result: { line: string } | { error: string } | { active: boolean },
  extra: Partial<TransitionRow["expected"]> = {}
): TransitionRow {
  return {
    name,
    operation: "active" in result ? "recover" : "resolve",
    prior,
    observation: { ...observation, ...changes },
    expected: {
      record,
      effects,
      ...result,
      pending: !!record && ["starting", "waiting", "blocked"].includes(record.phase),
      fixing: !!record?.dispatched && ["starting", "waiting", "blocked"].includes(record.phase),
      card: changes.card ?? card,
      lock: false,
      ...extra,
    },
  };
}
function blocked(
  name: string,
  reason: string,
  changes: Partial<Observation> = {},
  prefix: Effect[] = []
): TransitionRow {
  return row(
    name,
    waiting,
    changes,
    { ...waiting, phase: "blocked", reason },
    [...prefix, { kind: "stop" }, { kind: "block", reason, files }],
    { line: `BLOCKED #31: conflict escalated (${reason})` }
  );
}
const outside = { line: "conflict on #31 resolved outside the fixer" };
const starting: ResolutionRecord = {
  head: "H",
  base: "B",
  branch: "task",
  approved: false,
  files,
  step: 3,
  phase: "starting",
  started: 0,
  prior: card,
};
const clean: ResolutionRecord = {
  head: "H",
  base: "B",
  branch: "task",
  approved: false,
  files: [],
  step: 1,
  phase: "waiting",
  started: 0,
};
const dispatchEffects: Effect[] = [
  { kind: "card-prior" },
  { kind: "dispatch", base: "dev", files },
  { kind: "card-conflict" },
];
const initialSnapshot = { ...observation.snapshot, head: "H", conflict: true };
const verifyFailure = { ...waiting, phase: "blocked" as const, reason: "merge verify hook failed" };

/** Plain data only: reusable by the step-9 pure machine without fixture callbacks. */
export const conflictTransitions: TransitionRow[] = [
  row("C5/#148: verified step 3 restores prior turn", waiting, {}, resolved, [verify, restore], {
    line: "RESOLVED #31 (step 3)",
  }),
  row(
    "C5/#148: exact-head approval carries into merge",
    { ...waiting, approved: true },
    {},
    { ...waiting, approved: true, phase: "merged", resolvedHead: "R" },
    [verify, { kind: "merge", head: "R", certification }],
    { line: "MERGED #31 (conflict-only, approval carried)" }
  ),
  row(
    "C5/#274: refused auto-merge retains resolved proof",
    { ...waiting, approved: true },
    { mergeFailure: true },
    {
      ...resolved,
      approved: true,
      reason: "auto-merge refused (merge refused); merge manually when ready",
    },
    [verify, { kind: "merge", head: "R", certification }, restore],
    { line: "RESOLVED #31: auto-merge refused (merge refused); merge manually when ready" }
  ),
  row(
    "C4/#278: restore preserves live Approved card",
    waiting,
    { card: approvedCard, restore: "approval-kept" },
    { ...resolved, approvalKept: true },
    [verify, restore],
    { line: "RESOLVED #31 (step 3); owner approval kept" }
  ),
  row(
    "C4/#278: failed restore remains retryable",
    waiting,
    { restore: "failure" },
    { ...waiting, phase: "resolved", resolvedHead: "R" },
    [verify, restore],
    { line: "RESOLVED #31 (step 3)" }
  ),
  row(
    "C4/#278: resolved record retries only restore",
    { ...waiting, phase: "resolved", resolvedHead: "R" },
    { snapshot: { ...observation.snapshot, baseSha: "N" } },
    resolved,
    [restore],
    { line: "RESOLVED #31 (step 3)" }
  ),
  row("C4/#278: restored record is idempotent", resolved, {}, resolved, [], {
    line: "nothing to resolve for #31",
  }),
  row(
    "C4/#278: up-to-date no-op currently skips a pending restore",
    { ...waiting, phase: "resolved", resolvedHead: "R" },
    {},
    { ...waiting, phase: "resolved", resolvedHead: "R" },
    [],
    { line: "nothing to resolve for #31" }
  ),
  row(
    "C5/#148: merged record is idempotent while lifecycle lags",
    { ...waiting, phase: "merged", resolvedHead: "R" },
    { snapshot: { ...observation.snapshot, baseSha: "N" } },
    { ...waiting, phase: "merged", resolvedHead: "R" },
    [],
    { line: "MERGED #31 (conflict-only, approval carried)" }
  ),
  row(
    "C6/7.17/#295: up-to-date red CI has no event",
    null,
    { snapshot: { ...observation.snapshot, green: false, stale: true } },
    null,
    [],
    { line: "nothing to resolve for #31" }
  ),
  row(
    "C6/7.17/#295: empty waiting record resolves without news",
    { ...clean, head: "R" },
    {},
    { ...clean, head: "R", phase: "resolved", resolvedHead: "R" },
    [],
    { line: "nothing to resolve for #31" }
  ),
  ...(["merged", "closed"] as const).map((lifecycle) =>
    row(`C6/#245: PR ${lifecycle} outside fixer`, waiting, { lifecycle }, null, [], { line: "" })
  ),
  ...(["starting", "blocked"] as const).map((phase) =>
    row(
      `C6/#373: stopped ${phase} closes despite red CI`,
      { ...waiting, phase },
      { snapshot: { ...observation.snapshot, green: false, red: true } },
      null,
      [],
      outside
    )
  ),
  ...(["live", "unknown"] as const).map((workerStatus) =>
    row(
      `C6/#373: blocked healthy head with ${workerStatus} worker stays held`,
      verifyFailure,
      { workerStatus },
      verifyFailure,
      [],
      {
        line: `PENDING #31: conflict fixer ${workerStatus === "live" ? "running" : "status unknown; inspect session before recovery"}`,
      }
    )
  ),
  row(
    "C6/#274: non-dispatched foreign head closes before deadline",
    clean,
    { proofs: { ...observation.proofs, merge: "foreign" }, now: 3600001 },
    null,
    [],
    outside
  ),
  row(
    "C6/#274: non-dispatched base moved closes quietly",
    clean,
    { snapshot: { ...observation.snapshot, baseSha: "N" } },
    null,
    [],
    outside
  ),
  row(
    "C8/#148: step 1 accepts clean base merge",
    clean,
    { preview: [], proofs: { ...observation.proofs, merge: "clean" } },
    { ...clean, phase: "resolved", resolvedHead: "R" },
    [],
    { line: "RESOLVED #31 (step 1)" }
  ),
  row(
    "C8/#148: forged step 1 is not a clean base merge",
    { ...clean, dispatched: true },
    { proofs: { ...observation.proofs, merge: "foreign" } },
    { ...clean, dispatched: true },
    [],
    { error: "Conflict resolution #31: update-branch produced more than a clean base merge" }
  ),
  row(
    "C2/7.3/#373: successful dispatch records pending only after return",
    null,
    { snapshot: initialSnapshot },
    { ...waiting, started: 1000 },
    dispatchEffects,
    { line: "PENDING #31: conflict fixer dispatched (step 3)" },
    { card: { ...card, progress: "💥", assignees: ["worker"] } }
  ),
  row(
    "C4/#251: dispatch never moves Approved",
    null,
    { snapshot: initialSnapshot, card: approvedCard },
    { ...waiting, prior: approvedCard, started: 1000 },
    dispatchEffects,
    { line: "PENDING #31: conflict fixer dispatched (step 3); owner approval kept" },
    { card: { ...approvedCard, progress: "💥", assignees: ["worker"] } }
  ),
  row(
    "C8/#148: step 2 dispatch is recorded",
    null,
    { snapshot: initialSnapshot, dispatchStep: 2 },
    { ...waiting, step: 2, started: 1000 },
    dispatchEffects,
    { line: "PENDING #31: conflict fixer dispatched (step 2)" },
    { card: { ...card, progress: "💥", assignees: ["worker"] } }
  ),
  row(
    "C2/7.3/#373: failed dispatch never marks dispatched",
    null,
    { snapshot: initialSnapshot, dispatchFailure: true },
    { ...starting, started: 1000 },
    dispatchEffects.slice(0, 2),
    { error: "dispatch failed" }
  ),
  row(
    "C2/#373: interrupted starting record requires inspection",
    starting,
    { snapshot: initialSnapshot },
    starting,
    [],
    { error: "Conflict #31: previous dispatch was interrupted; inspect worker/update state" }
  ),
  ...(["moved", "vanished"] as const).map((beforeDispatch) =>
    row(
      `C3/#373: head ${beforeDispatch} before dispatch`,
      null,
      { snapshot: initialSnapshot, beforeDispatch },
      null,
      [{ kind: "card-prior" }],
      beforeDispatch === "moved"
        ? { line: "PENDING #31: head or base moved before the conflict dispatch; run again" }
        : outside
    )
  ),
  row(
    "C1/#377: live holder is quiet pending without observation",
    waiting,
    { lock: "live", waitMs: 2000 },
    waiting,
    [],
    { line: "PENDING #31: conflict resolution in progress (pid 5432)" },
    { lock: true }
  ),
  ...(["dead", "reused"] as const).map((lock) =>
    row(
      `C1/#237: ${lock} holder clears immediately`,
      waiting,
      { lock },
      resolved,
      [verify, restore],
      { line: "RESOLVED #31 (step 3)" }
    )
  ),
  row("C5/#148: live worker remains pending", waiting, { workerStatus: "live" }, waiting, [], {
    line: "PENDING #31: conflict fixer running",
  }),
  row(
    "C5/#148: unknown waiting worker currently proceeds to proofs",
    waiting,
    { workerStatus: "unknown" },
    resolved,
    [verify, restore],
    { line: "RESOLVED #31 (step 3)" }
  ),
  row(
    "C9/#148: unchanged head inside startup grace",
    waiting,
    { snapshot: initialSnapshot },
    waiting,
    [],
    { line: "PENDING #31: waiting for conflict turn to start" }
  ),
  row(
    "C8/#148: unchanged step-1 head after grace waits",
    clean,
    { snapshot: { ...initialSnapshot, conflict: false }, now: 120000 },
    clean,
    [],
    { line: "PENDING #31: waiting for updated head" }
  ),
  blocked("C9/#148: unchanged fixer head at grace boundary", "fixer stopped without a resolution", {
    snapshot: initialSnapshot,
    now: 120000,
  }),
  row(
    "C9/#148: exactly one hour still proves",
    waiting,
    { now: 3600000 },
    resolved,
    [verify, restore],
    { line: "RESOLVED #31 (step 3)" }
  ),
  blocked(
    "C9/#148: one hour plus one millisecond blocks",
    "conflict resolution exceeded the one-hour limit",
    { now: 3600001 }
  ),
  blocked("C7/#193: fixer QUESTION retains ownership", "fixer reported BLOCKED or QUESTION", {
    workerBlocked: true,
  }),
  blocked("C5/#148: still conflicting", "head/base changed or still conflicting", {
    snapshot: { ...observation.snapshot, conflict: true },
  }),
  blocked("C5/#148: base changed", "head/base changed or still conflicting", {
    snapshot: { ...observation.snapshot, baseSha: "N" },
  }),
  blocked("C5/#148: branch changed", "head/base changed or still conflicting", {
    snapshot: { ...observation.snapshot, branch: "other" },
  }),
  blocked("C5/#148: escalated path", "escalated path requires owner review", { escalated: true }),
  blocked("C5/#148: outside hunk edit", "remerge diff is not limited to conflicted hunks", {
    proofs: { ...observation.proofs, merge: "outside-hunk" },
  }),
  blocked("C5/#148: wrong merge parents", "remerge diff is not limited to conflicted hunks", {
    proofs: { ...observation.proofs, merge: "wrong-parents" },
  }),
  blocked("C5/#148: worktree mismatch", "worktree does not contain the resolved head", {
    proofs: { ...observation.proofs, worktree: false },
  }),
  blocked("C5/#148: CI red", "CI red", {
    snapshot: { ...observation.snapshot, green: false, red: true },
  }),
  ...(["pending", "stale"] as const).map((ci) =>
    row(
      `C5/#148: CI ${ci} waits without escalation`,
      waiting,
      { snapshot: { ...observation.snapshot, green: ci === "stale", stale: ci === "stale" } },
      waiting,
      [],
      { line: "PENDING #31: waiting for green CI on current base" }
    )
  ),
  blocked(
    "C5/#148: verify hook false",
    "merge verify hook failed",
    { proofs: { ...observation.proofs, verify: false } },
    [verify]
  ),
  ...(["head", "base", "branch", "conflict", "red", "stale"] as const).map((afterVerify) =>
    blocked(
      `C5/#368: final snapshot ${afterVerify} changed`,
      "head/base/CI changed during verification",
      { afterVerify },
      [verify]
    )
  ),
  row(
    "C9/#274: retry bypasses deadline but re-proves",
    verifyFailure,
    { retry: true, now: 3600001, workerBlocked: true },
    resolved,
    [verify, restore],
    { line: "RESOLVED #31 (step 3)" }
  ),
  row("C9/#274: retry rejects no record", null, { retry: true }, null, [], {
    error: "Conflict retry requires a blocked merge verify hook failure",
  }),
  row("C9/#274: retry rejects waiting record", waiting, { retry: true }, waiting, [], {
    error: "Conflict retry requires a blocked merge verify hook failure",
  }),
  row(
    "C9/#274: retry rejects other blocked reason",
    { ...verifyFailure, reason: "CI red" },
    { retry: true },
    { ...verifyFailure, reason: "CI red" },
    [],
    { error: "Conflict retry requires a blocked merge verify hook failure" }
  ),
  ...(["live", "unknown"] as const).map((workerStatus) =>
    row(
      `C9/#274: retry with ${workerStatus} worker cannot prove`,
      verifyFailure,
      { retry: true, workerStatus },
      verifyFailure,
      [],
      {
        line: `PENDING #31: conflict fixer ${workerStatus === "live" ? "running" : "status unknown; inspect session before recovery"}`,
      }
    )
  ),
  row(
    "C9/#274: retry rechecks merge proof",
    verifyFailure,
    { retry: true, proofs: { ...observation.proofs, merge: "wrong-parents" } },
    { ...verifyFailure, reason: "remerge diff is not limited to conflicted hunks" },
    [
      { kind: "stop" },
      { kind: "block", reason: "remerge diff is not limited to conflicted hunks", files },
    ],
    { line: "BLOCKED #31: conflict escalated (remerge diff is not limited to conflicted hunks)" }
  ),
  row(
    "C9/#274: retry can fail verify again",
    verifyFailure,
    { retry: true, proofs: { ...observation.proofs, verify: false } },
    verifyFailure,
    [verify, { kind: "stop" }, { kind: "block", reason: "merge verify hook failed", files }],
    { line: "BLOCKED #31: conflict escalated (merge verify hook failed)" }
  ),
  ...(["starting", "blocked"] as const).map((phase) =>
    row(`C6/7.18/#373: recover ${phase} releases handover`, { ...waiting, phase }, {}, null, [], {
      active: false,
    })
  ),
  row("C6/7.18/#373: recover never steals dispatched waiting turn", waiting, {}, waiting, [], {
    active: true,
  }),
  row("C6/7.18/#373: recover no record permits handover", null, {}, null, [], { active: false }),
  row("C6/7.18/#373: recover resolved permits handover", resolved, {}, resolved, [], {
    active: false,
  }),
  ...(["live", "unknown"] as const).map((workerStatus) =>
    row(
      `C6/7.18/#373: recover ${workerStatus} remains active`,
      starting,
      { workerStatus },
      starting,
      [],
      { active: true }
    )
  ),
  row(
    "C6/7.18/#373: recover proves local conflicts despite snapshot",
    starting,
    { snapshot: { ...initialSnapshot, conflict: false } },
    starting,
    [],
    { active: true }
  ),
  ...(["merged", "closed"] as const).map((lifecycle) =>
    row(
      `C6/7.18/#373: recover ${lifecycle} closes before snapshot`,
      starting,
      { lifecycle },
      null,
      [],
      { active: false }
    )
  ),
];

// Step-1 update/wait and lockfile-specific proof observations use the same schema.
const updateEffects: Effect[] = [{ kind: "update-branch", head: "H" }, { kind: "wait" }];
conflictTransitions.push(
  row(
    "C8/#148: update-branch completes with a proved clean base merge",
    null,
    {
      preview: [],
      snapshot: { ...initialSnapshot, conflict: false },
      update: "merge",
      waitCode: 0,
      proofs: { ...observation.proofs, merge: "clean" },
    },
    { ...clean, started: 1000, phase: "resolved", resolvedHead: "R" },
    updateEffects,
    { line: "RESOLVED #31 (step 1)" }
  ),
  row(
    "C8/#148: update API failure preserves starting without escalation",
    null,
    { preview: [], snapshot: { ...initialSnapshot, conflict: false }, update: "failure" },
    { ...clean, phase: "starting", started: 1000 },
    updateEffects.slice(0, 1),
    { error: "update failed" }
  ),
  row(
    "C4/#251: escalation leaves Approved untouched at service boundary",
    { ...waiting, prior: approvedCard },
    { card: approvedCard, escalated: true },
    {
      ...waiting,
      prior: approvedCard,
      phase: "blocked",
      reason: "escalated path requires owner review",
    },
    [{ kind: "stop" }, { kind: "block", reason: "escalated path requires owner review", files }],
    { line: "BLOCKED #31: conflict escalated (escalated path requires owner review)" }
  ),
  row(
    "C5/#274: absent verify hook notice flag persists",
    waiting,
    { verifyNotice: true },
    { ...resolved, verifyNoticeReported: true },
    [verify, restore],
    { line: "RESOLVED #31 (step 3)" }
  ),
  row(
    "C9/#274: retry rechecks moved base",
    verifyFailure,
    { retry: true, snapshot: { ...observation.snapshot, baseSha: "N" } },
    { ...verifyFailure, reason: "head/base changed or still conflicting" },
    [{ kind: "stop" }, { kind: "block", reason: "head/base changed or still conflicting", files }],
    { line: "BLOCKED #31: conflict escalated (head/base changed or still conflicting)" }
  ),
  row(
    "C8/#148: clean base update waits without fixer",
    null,
    {
      preview: [],
      snapshot: { ...initialSnapshot, conflict: false },
      proofs: { ...observation.proofs, merge: "clean" },
    },
    { ...clean, started: 1000 },
    updateEffects,
    { line: "PENDING #31: waiting for CI" }
  ),
  row(
    "C6/#295: no-new-commits 422 is quiet",
    null,
    { preview: [], snapshot: { ...initialSnapshot, conflict: false }, update: "no-commits" },
    { ...clean, started: 1000, phase: "resolved", resolvedHead: "H" },
    updateEffects.slice(0, 1),
    { line: "nothing to resolve for #31" }
  ),
  ...([1, 3] as const).map((waitCode) =>
    row(
      `C8/#148: step-1 wait code ${waitCode} errors without escalation`,
      null,
      { preview: [], snapshot: { ...initialSnapshot, conflict: false }, waitCode },
      { ...clean, started: 1000 },
      updateEffects,
      { error: `Conflict resolution #31: ${waitCode === 1 ? "CI red" : "base conflicts again"}` }
    )
  )
);
const lockfiles = ["package-lock.json"];
const lockRecord = { ...waiting, files: lockfiles, step: 2 as const };
const sync: Effect = { kind: "sync", directory: "." };
conflictTransitions.push(
  row(
    "C5/#368: step-2 lockfile regeneration requires sync and verify",
    lockRecord,
    { preview: lockfiles, proofs: { ...observation.proofs, merge: "outside-hunk" } },
    { ...resolved, files: lockfiles, step: 2 },
    [sync, verify, restore],
    { line: "RESOLVED #31 (step 2)" }
  ),
  row(
    "C5/#368: approved lockfile certification",
    { ...lockRecord, approved: true },
    { preview: lockfiles },
    { ...lockRecord, approved: true, phase: "merged", resolvedHead: "R" },
    [sync, verify, { kind: "merge", head: "R", certification: lockCertification }],
    { line: "MERGED #31 (conflict-only, approval carried)" }
  ),
  row(
    "C5/#368: wrong lockfile merge parents",
    lockRecord,
    { preview: lockfiles, proofs: { ...observation.proofs, merge: "wrong-parents" } },
    {
      ...lockRecord,
      phase: "blocked",
      reason:
        "lockfile-only merge proof failed (expected exact merge parents and remerge diff limited to lockfiles)",
    },
    [
      { kind: "stop" },
      {
        kind: "block",
        files: lockfiles,
        reason:
          "lockfile-only merge proof failed (expected exact merge parents and remerge diff limited to lockfiles)",
      },
    ],
    {
      line: "BLOCKED #31: conflict escalated (lockfile-only merge proof failed (expected exact merge parents and remerge diff limited to lockfiles))",
    }
  ),
  row(
    "C5/#368: lockfile sync failure",
    lockRecord,
    { preview: lockfiles, proofs: { ...observation.proofs, sync: false } },
    {
      ...lockRecord,
      phase: "blocked",
      reason: "lockfile sync check failed at .: lockfile out of sync",
    },
    [
      sync,
      { kind: "stop" },
      {
        kind: "block",
        files: lockfiles,
        reason: "lockfile sync check failed at .: lockfile out of sync",
      },
    ],
    {
      line: "BLOCKED #31: conflict escalated (lockfile sync check failed at .: lockfile out of sync)",
    }
  )
);
