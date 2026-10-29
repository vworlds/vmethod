import { expect, test } from "vitest";
import {
  plan,
  staleWakes,
  type DrainPlan,
  type LifecycleEffect,
  type LifecycleOptions,
  type SessionState,
} from "../../src/sessions/lifecycle.js";
import type { Model, Session, TaskMetadata } from "../../src/gateway/workers.js";
import type { WorkerSessionStatus } from "../../src/gateway/client.js";
import type { ProviderLimits } from "../../src/gateway/limits.js";

// Restate the step-1 oracle here, leaving wake-seam.test.ts byte-for-byte unchanged.
const time = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
const now = Date.parse(time(3));
const wake = (heading: string) =>
  `[orchestrator] ${heading} is on your PR; read it with vmethod read pr 31 --new and act.`;
const answer = wake("ANSWER");
const review = wake("REVIEW round 2");
const checkin = "[orchestrator] CHECK-IN: your turn ended without a status comment on the PR.";
const conflict =
  "CONFLICT: merge origin/dev, resolve keeping both sides' behaviour, push, wait-checks, READY. If every conflicted file is package-lock.json, npm-shrinkwrap.json, yarn.lock or pnpm-lock.yaml (at any path), do not hand-merge: keep package.json manifests as merged by git and regenerate the lockfiles with npm install --package-lock-only or the configured equivalent in postMerge.install. Commit the regeneration as the merge resolution; the remerge diff may touch only lockfiles, lockfile sync must pass and configured checks must be green. Mixed conflicts retain the conflicted-hunk rule.";
const comment = (role: string, body: string, minute: number) => ({
  role,
  body,
  date: time(minute),
});
const trigger = (minute = 1) => comment("orchestrator", "[orchestrator] ANSWER", minute);
const reply = (minute = 2, heading = "READY FOR REVIEW (round 1)") =>
  comment("worker", `[worker] ${heading}`, minute);
const staleMessage = (heading: string, triggered: number, replied: number, tag: string) =>
  `stale wake dropped for #31: ${heading} (${time(triggered)}) superseded by [worker] ${tag} at ${time(replied)}`;
const model: Model = {
  family: "glm",
  model: "fake/glm",
  kind: "opencode",
  gate: "none",
  tier: "cheap",
};
const fallback: Model = { ...model, family: "sol", model: "fake/sol" };
function record(patch: Partial<Session> = {}): Session {
  return {
    version: 1,
    repo: "example/project",
    pr: 31,
    issue: 9,
    directory: "/not/a/real/worktree",
    id: "ses_fake",
    model,
    segments: [],
    points_open: 3,
    ...patch,
  };
}
function metadata(patch: Partial<TaskMetadata> = {}): TaskMetadata {
  return {
    pr: 31,
    issue: 9,
    base: "dev",
    branch: "9-task",
    title: "Task $(hostile)",
    body: "PR description `data`",
    state: "OPEN",
    draft: true,
    blocked: false,
    model: "glm",
    kind: "tooling",
    merged: false,
    comments: [],
    ...patch,
  };
}

interface FilterRow {
  name: string;
  queued?: string[];
  conflictSentAt?: string;
  comments: TaskMetadata["comments"];
  merged?: boolean;
  ownerPaused?: boolean;
  kept: string[];
  dropped: string[];
  reports?: string[];
}
const filterRows: FilterRow[] = [
  { name: "absent queue", comments: [], kept: [], dropped: [] },
  { name: "empty queue", queued: [], comments: [], kept: [], dropped: [] },
  { name: "no reply", queued: [answer], comments: [trigger()], kept: [answer], dropped: [] },
  {
    name: "earlier reply",
    queued: [answer],
    comments: [reply(0), trigger()],
    kept: [answer],
    dropped: [],
  },
  {
    name: "same-time reply",
    queued: [answer],
    comments: [trigger(), reply(1)],
    kept: [answer],
    dropped: [],
  },
  ...["READY FOR REVIEW (round 1)", "QUESTION", "BLOCKED", "DESIGN", "HANDOFF"].map((tag) => ({
    name: `later ${tag}`,
    queued: [answer],
    comments: [trigger(), reply(2, tag)],
    kept: [],
    dropped: [answer],
    reports: [staleMessage("ANSWER", 1, 2, tag)],
  })),
  ...["ACK", "READYISH", "plain text\n[worker] READY", " READY"].map((tag) => ({
    name: `not a reply: ${tag}`,
    queued: [answer],
    comments: [trigger(), reply(2, tag)],
    kept: [answer],
    dropped: [],
  })),
  {
    name: "collaborator reply",
    queued: [answer],
    comments: [trigger(), comment("collaborator", "[worker] READY", 2)],
    kept: [answer],
    dropped: [],
  },
  {
    name: "collaborator trigger",
    queued: [answer],
    comments: [comment("collaborator", "[orchestrator] ANSWER", 1), reply()],
    kept: [answer],
    dropped: [],
  },
  {
    name: "latest trigger unsorted",
    queued: [answer],
    comments: [trigger(3), reply(), trigger()],
    kept: [answer],
    dropped: [],
  },
  {
    name: "latest reply unsorted",
    queued: [answer],
    comments: [reply(3), trigger(), reply(0)],
    kept: [],
    dropped: [answer],
    reports: [staleMessage("ANSWER", 1, 3, "READY FOR REVIEW (round 1)")],
  },
  {
    name: "unmatched and checkin",
    queued: [checkin, review, "Read the new review"],
    comments: [trigger(), reply()],
    kept: [checkin, review, "Read the new review"],
    dropped: [],
  },
  {
    name: "reply before conflict",
    queued: [answer],
    conflictSentAt: time(3),
    comments: [trigger(), reply()],
    kept: [],
    dropped: [answer],
    reports: [staleMessage("ANSWER", 1, 2, "READY FOR REVIEW (round 1)")],
  },
  {
    name: "reply at conflict",
    queued: [answer],
    conflictSentAt: time(3),
    comments: [trigger(), reply(3)],
    kept: [answer],
    dropped: [],
  },
  {
    name: "reply after conflict",
    queued: [answer],
    conflictSentAt: time(3),
    comments: [trigger(), reply(4)],
    kept: [answer],
    dropped: [],
  },
  {
    name: "trigger at conflict",
    queued: [answer],
    conflictSentAt: time(3),
    comments: [trigger(3), reply(4)],
    kept: [answer],
    dropped: [],
  },
  {
    name: "trigger after conflict",
    queued: [answer],
    conflictSentAt: time(3),
    comments: [trigger(4), reply(5)],
    kept: [answer],
    dropped: [],
  },
  {
    name: "earlier genuine reply remains visible",
    queued: [answer],
    conflictSentAt: time(3),
    comments: [reply(4), trigger(), reply()],
    kept: [],
    dropped: [answer],
    reports: [staleMessage("ANSWER", 1, 2, "READY FOR REVIEW (round 1)")],
  },
  {
    name: "partial drops in queue order",
    queued: [review, checkin, answer],
    comments: [
      reply(4, "QUESTION\r\nDetails"),
      trigger(),
      comment("orchestrator", "[orchestrator] REVIEW round 2\r\nDetails", 3),
    ],
    kept: [checkin],
    dropped: [review, answer],
    reports: [
      staleMessage("REVIEW round 2", 3, 4, "QUESTION"),
      staleMessage("ANSWER", 1, 4, "QUESTION"),
    ],
  },
  {
    name: "owner summons",
    queued: [answer, checkin],
    ownerPaused: true,
    comments: [trigger(), reply()],
    kept: [],
    dropped: [answer, checkin],
  },
  {
    name: "merged",
    queued: [answer, review],
    merged: true,
    comments: [],
    kept: [],
    dropped: [answer, review],
  },
];

/** In-memory effect runner: no transport, filesystem, clock or usage-accounting mock. */
function run(
  saved: Session,
  status: WorkerSessionStatus,
  task: TaskMetadata,
  options: LifecycleOptions = {},
  settings: {
    limits?: ProviderLimits[];
    failed?: string[];
    approved?: string[];
    prompt?: string;
    failSend?: boolean;
    onRead?: (kind: string, saved: Session) => void;
  } = {}
) {
  const original = structuredClone({ saved, status, task });
  let planned = plan(saved, status, undefined, undefined, now, { comments: false, ...options });
  expect({ saved, status, task }).toEqual(original);
  const effects: LifecycleEffect[] = [];
  const reads: string[] = [];
  const sent: { text: string; delivery: string }[] = [];
  const reports: string[] = [];
  const snapshots: Session[] = [];
  const changes: Model[] = [];
  let error: Error | undefined;
  try {
    for (let bound = 0; ; bound++) {
      if (bound > 100) {
        throw new Error("Planner did not terminate");
      }
      for (const effect of planned.effects) {
        effects.push(effect);
        switch (effect.kind) {
          case "record":
            Object.assign(saved, effect.set);
            for (const field of effect.clear ?? []) {
              delete saved[field];
            }
            break;
          case "save":
            snapshots.push(structuredClone(saved));
            break;
          case "report":
            reports.push(effect.text);
            break;
          case "stamp-conflict":
            saved.conflictSentAt = time(3);
            break;
          case "send":
            if (settings.failSend) {
              throw new Error("send failed");
            }
            sent.push({ text: effect.text, delivery: effect.delivery });
            saved.lastPrompt = effect.text;
            break;
          case "mark-quota":
            saved.quotaStop = {
              family: saved.model.family,
              error: status.error ?? "",
              turn: status.turnId,
            };
            snapshots.push(structuredClone(saved));
            break;
          case "change-model":
            changes.push(effect.model);
            saved.model = effect.model;
            break;
          case "switch-conflict":
            saved.model = effect.model;
            break;
          case "restore-conflict":
            if (saved.conflictModel) {
              saved.model = saved.conflictModel;
              delete saved.conflictModel;
            }
            break;
          case "resume-model":
            break;
          case "card-model":
            task.model = effect.model.family;
            break;
          case "model-comment":
            break;
          case "throw":
            throw effect.error;
          default:
            throw new Error(`Unexpected effect ${effect.kind}`);
        }
      }
      if (!planned.next) {
        break;
      }
      const read = planned.next.read;
      reads.push(read.kind);
      settings.onRead?.(read.kind, saved);
      const before = structuredClone({ saved, status, task });
      const next = planned.next.then;
      switch (read.kind) {
        case "metadata":
          planned = next(task);
          break;
        case "limits":
          planned = next(settings.limits ?? []);
          break;
        case "quota-failed":
          planned = next(settings.failed?.includes(read.model.family) ?? false);
          break;
        case "approval":
          planned = next(settings.approved?.includes(read.model.family) ?? false);
          break;
        case "interrupted-prompt":
          planned = next(settings.prompt ?? status.interruptedPrompt ?? saved.lastPrompt);
          break;
        case "conflict-choice":
          planned = next(model);
          break;
        default:
          throw new Error("Unexpected observation");
      }
      expect({ saved, status, task }).toEqual(before);
    }
  } catch (caught) {
    error = caught as Error;
  }
  return { planned, saved, effects, reads, sent, reports, snapshots, changes, error };
}

test.each(filterRows)("oracle filter and idle plan: $name", (row) => {
  const saved = record({ pendingWake: row.queued, conflictSentAt: row.conflictSentAt });
  const task = metadata({
    comments: row.comments,
    merged: row.merged ?? false,
    ownerPaused: row.ownerPaused,
  });
  const original = structuredClone({ saved, task });
  const filtered = staleWakes(saved, task);
  expect(filtered).toEqual({ keep: row.kept, dropped: row.dropped, reports: row.reports ?? [] });
  expect({ saved, task }).toEqual(original);
  if (row.queued?.length && !row.dropped.length) {
    expect(filtered.keep).toBe(row.queued);
  }
  const result = run(saved, { reason: "idle", active: false }, task);
  expect(result.error).toBeUndefined();
  expect(result.sent).toEqual(
    row.kept.length ? [{ text: row.kept.join("\n"), delivery: "queue" }] : []
  );
  expect(result.reports).toEqual(row.reports ?? []);
  expect(saved.pendingWake).toEqual(row.queued?.length ? undefined : row.queued);
  expect(saved.conflictSentAt).toBeUndefined();
});

interface Poll {
  busy: boolean;
  send?: string;
  pending?: string[];
  conflictPending?: boolean;
  sentAt?: string;
  reason: "idle" | "running";
}
interface DrainRow {
  name: string;
  queued: string[];
  pendingConflict?: boolean;
  conflictSentAt?: string;
  merged?: boolean;
  ownerPaused?: boolean;
  comments?: TaskMetadata["comments"];
  polls: Poll[];
  dropped: string[];
  reports?: string[];
}
const drainRows: DrainRow[] = [
  {
    name: "busy then idle then no replay",
    queued: [answer, review],
    dropped: [],
    polls: [
      { busy: true, pending: [answer, review], reason: "running" },
      { busy: false, send: `${answer}\n${review}`, reason: "running" },
      { busy: false, reason: "idle" },
    ],
  },
  {
    name: "persisted lock wake after ingest",
    queued: [answer],
    dropped: [],
    polls: [
      { busy: true, pending: [answer], reason: "running" },
      { busy: false, send: answer, reason: "running" },
      { busy: false, reason: "idle" },
    ],
  },
  {
    name: "conflict before wakes",
    queued: [answer, review],
    pendingConflict: true,
    dropped: [],
    polls: [
      { busy: true, pending: [answer, review], conflictPending: true, reason: "running" },
      {
        busy: false,
        send: conflict,
        pending: [answer, review],
        sentAt: time(3),
        reason: "running",
      },
      { busy: false, send: `${answer}\n${review}`, reason: "running" },
    ],
  },
  {
    name: "conflict with no wakes retains send boundary",
    queued: [],
    pendingConflict: true,
    dropped: [],
    polls: [
      { busy: false, send: conflict, sentAt: time(3), reason: "running" },
      { busy: false, sentAt: time(3), reason: "idle" },
    ],
  },
  {
    name: "answered wake clears boundary",
    queued: [answer],
    conflictSentAt: time(3),
    comments: [trigger(), reply()],
    dropped: [answer],
    reports: [staleMessage("ANSWER", 1, 2, "READY FOR REVIEW (round 1)")],
    polls: [{ busy: false, reason: "idle" }],
  },
  {
    name: "partial stale drain",
    queued: [answer, review],
    comments: [trigger(), reply(), comment("orchestrator", "[orchestrator] REVIEW round 2", 3)],
    dropped: [answer],
    reports: [staleMessage("ANSWER", 1, 2, "READY FOR REVIEW (round 1)")],
    polls: [{ busy: false, send: review, reason: "running" }],
  },
  {
    name: "wake during conflict",
    queued: [review],
    conflictSentAt: time(3),
    comments: [comment("orchestrator", "[orchestrator] REVIEW round 2", 4), reply(5)],
    dropped: [],
    polls: [{ busy: false, send: review, reason: "running" }],
  },
  {
    name: "merged drops wake",
    queued: [answer],
    merged: true,
    conflictSentAt: time(3),
    dropped: [answer],
    polls: [{ busy: false, reason: "idle" }],
  },
  {
    name: "merged drops conflict and wake",
    queued: [answer],
    pendingConflict: true,
    merged: true,
    conflictSentAt: time(3),
    dropped: [answer],
    polls: [{ busy: false, reason: "idle" }],
  },
  {
    name: "merged persisted lock wake after ingest",
    queued: [answer],
    merged: true,
    dropped: [answer],
    polls: [{ busy: false, reason: "idle" }],
  },
  {
    name: "owner drops wake silently",
    queued: [answer],
    ownerPaused: true,
    conflictSentAt: time(3),
    dropped: [answer],
    polls: [{ busy: false, reason: "idle" }],
  },
  {
    name: "owner holds conflict and wake",
    queued: [answer],
    pendingConflict: true,
    ownerPaused: true,
    conflictSentAt: time(2),
    dropped: [],
    polls: [
      { busy: false, pending: [answer], conflictPending: true, sentAt: time(2), reason: "idle" },
    ],
  },
  {
    name: "busy merged defers drop",
    queued: [answer],
    merged: true,
    dropped: [answer],
    polls: [
      { busy: true, pending: [answer], reason: "running" },
      { busy: false, reason: "idle" },
    ],
  },
];

test.each(drainRows)("oracle drains: $name", (row) => {
  const saved = record({
    ...(row.queued.length ? { pendingWake: row.queued } : {}),
    ...(row.pendingConflict ? { pendingConflict: { model, base: "dev" } } : {}),
    conflictSentAt: row.conflictSentAt,
  });
  const task = metadata({
    merged: row.merged ?? false,
    ownerPaused: row.ownerPaused,
    comments: row.comments ?? [],
  });
  const sent: { text: string; delivery: string }[] = [];
  const reports: string[] = [];
  for (const poll of row.polls) {
    const result = run(saved, { reason: poll.busy ? "running" : "idle", active: poll.busy }, task);
    expect(result.error).toBeUndefined();
    expect(result.planned.status).toMatchObject({
      reason: poll.reason,
      active: poll.reason === "running",
    });
    expect(result.sent).toEqual(poll.send ? [{ text: poll.send, delivery: "queue" }] : []);
    sent.push(...result.sent);
    reports.push(...result.reports);
    expect(saved.pendingWake).toEqual(poll.pending);
    expect(saved.pendingConflict).toEqual(
      poll.conflictPending ? { model, base: "dev" } : undefined
    );
    expect(saved.conflictSentAt).toBe(poll.sentAt);
  }
  const delivered = sent.flatMap(({ text }) => (text === conflict ? [] : text.split("\n")));
  expect(
    row.queued.filter((text) => !delivered.includes(text) && !saved.pendingWake?.includes(text))
  ).toEqual(row.dropped);
  expect(reports).toEqual(row.reports ?? []);
});

test.each([
  ["session unknown", "unknown"],
  ["worktree gone", "gone"],
  ["permission-wait", "permission"],
] as const satisfies readonly (readonly [WorkerSessionStatus["reason"], SessionState])[])(
  "%s does not drain",
  (reason, state) => {
    const saved = record({ pendingWake: [answer], pendingConflict: { model, base: "dev" } });
    const result = run(saved, { reason, active: false }, metadata());
    expect(result.error).toBeUndefined();
    expect(result.planned.state).toBe(state);
    expect(result.effects).toEqual([]);
    expect(result.reads).toEqual([]);
    expect(saved.pendingWake).toEqual([answer]);
  }
);

test("drainWake=false preserves queues but clears recovered quota bookkeeping", () => {
  const saved = record({
    pendingWake: [answer],
    pendingConflict: { model, base: "dev" },
    quotaStop: { family: "glm", error: "quota" },
    quotaResume: { model: fallback, text: answer, why: "quota", reason: "quota", synced: true },
  });
  const result = run(saved, { reason: "running", active: true }, metadata(), { drainWake: false });
  expect(result.error).toBeUndefined();
  expect(result.reads).toEqual([]);
  expect(saved.pendingWake).toBeUndefined();
  expect(saved.quotaResume).toBeUndefined();
  expect(saved.quotaStop).toBeUndefined();
  expect(saved.pendingConflict).toEqual({ model, base: "dev" });
});

const quotaStatus: WorkerSessionStatus = {
  reason: "quota",
  active: false,
  quotaStopped: true,
  turnId: "turn",
  error: "structured quota failure",
  interruptedPrompt: "finish the task",
};
const quotaOptions: LifecycleOptions = {
  quotaEnabled: true,
  models: [{ ...model, fallback: ["sol"] }, fallback],
};
test.each(["interrupted", "queued", "conflict"])("quota recovery resends %s work", (kind) => {
  const text = kind === "queued" ? answer : kind === "conflict" ? conflict : "finish the task";
  const saved = record({
    ...(kind === "queued" ? { pendingWake: [answer] } : {}),
    ...(kind === "conflict" ? { conflictModel: model } : {}),
  });
  const task = metadata();
  const result = run(saved, { ...quotaStatus, interruptedPrompt: text }, task, quotaOptions);
  expect(result.error).toBeUndefined();
  expect(result.planned.status).toMatchObject({
    active: true,
    reason: "running",
    errorFamily: "glm",
    quotaEvent: "QUOTA #31: glm quota-stopped; switched to sol and resumed",
  });
  expect(result.changes).toEqual([fallback]);
  expect(result.sent).toEqual([{ text, delivery: "queue" }]);
  expect(saved.quotaResume).toBeUndefined();
  expect(saved.pendingWake).toBeUndefined();
  expect(task.model).toBe(kind === "conflict" ? "glm" : "sol");
  expect(saved.conflictModel).toEqual(kind === "conflict" ? model : undefined);
});

test("quota retries save before send and do not repeat the switch or audit", () => {
  const saved = record();
  const task = metadata();
  const failed = run(saved, quotaStatus, task, quotaOptions, { failSend: true });
  expect(failed.error?.message).toBe("send failed");
  expect(saved.quotaResume).toMatchObject({ synced: true, text: "finish the task" });
  expect(failed.snapshots.at(-1)?.quotaResume?.synced).toBe(true);
  const resumed = run(saved, quotaStatus, task, quotaOptions);
  expect(resumed.error).toBeUndefined();
  expect(resumed.changes).toEqual([]);
  expect(
    resumed.effects.filter(
      (effect) => effect.kind === "model-comment" || effect.kind === "card-model"
    )
  ).toEqual([]);
  expect(resumed.sent).toEqual([{ text: "finish the task", delivery: "queue" }]);
});

test.each(["merged", "closed", "owner", "blocked", "held", "disabled", "active", "unstructured"])(
  "quota %s stays untouched",
  (condition) => {
    const saved = record();
    const result = run(
      saved,
      {
        ...quotaStatus,
        ...(condition === "active" ? { active: true } : {}),
        ...(condition === "unstructured" ? { quotaStopped: false } : {}),
      },
      metadata({
        merged: condition === "merged",
        state: condition === "closed" ? "CLOSED" : "OPEN",
        ownerPaused: condition === "owner",
        blocked: condition === "blocked",
        title: condition === "held" ? "[HOLD] task" : "task",
      }),
      { ...quotaOptions, quotaEnabled: condition !== "disabled" }
    );
    expect(result.error).toBeUndefined();
    expect(result.sent).toEqual([]);
    expect(result.changes).toEqual([]);
    expect(saved.quotaStop).toBeUndefined();
  }
);

test("no eligible fallback is reported once per failed turn", () => {
  const saved = record();
  const first = run(saved, quotaStatus, metadata(), quotaOptions, { failed: ["sol"] });
  expect(first.error).toBeUndefined();
  expect(first.reports).toEqual(["QUOTA #31: glm quota-stopped; no eligible fallback"]);
  const second = run(saved, quotaStatus, metadata(), quotaOptions);
  expect(second.error).toBeUndefined();
  expect(second.reads).toEqual([]);
  expect(second.reports).toEqual([]);
  expect(second.planned.status.errorFamily).toBe("glm");
});

test("quota choice skips incompatible, risky, failed and unapproved families in order", () => {
  const models: Model[] = [
    { ...model, fallback: ["old", "risky", "failed", "gated", "sol"] },
    { ...fallback, family: "old", kind: "claude" },
    { ...fallback, family: "risky", provider: "risky" },
    { ...fallback, family: "failed" },
    { ...fallback, family: "gated", gate: "owner" },
    fallback,
  ];
  const result = run(
    record(),
    quotaStatus,
    metadata(),
    { ...quotaOptions, models },
    { failed: ["failed"], limits: [{ provider: "risky", atRisk: true, windows: [] }] }
  );
  expect(result.error).toBeUndefined();
  expect(result.changes).toEqual([fallback]);
  expect(result.reads).toEqual([
    "metadata",
    "limits",
    "quota-failed",
    "quota-failed",
    "approval",
    "quota-failed",
    "interrupted-prompt",
    "metadata",
  ]);
});

test("a missing interrupted prompt refuses after persisting quota failure", () => {
  const result = run(
    record(),
    { ...quotaStatus, interruptedPrompt: undefined },
    metadata(),
    quotaOptions
  );
  expect(result.error?.message).toBe(
    "Cannot resume #31: interrupted prompt is unavailable; send a prompt explicitly"
  );
  expect(result.saved.quotaStop?.family).toBe("glm");
  expect(result.sent).toEqual([]);
});

test("comments classification and usage accounting precede drain reads", () => {
  const initial: DrainPlan = plan(
    record(),
    { reason: "idle", active: false },
    metadata({ comments: [trigger()] }),
    [],
    now,
    { comments: true, accountUsage: true }
  );
  expect(initial.status.reason).toBe("idle without reply");
  expect(initial.effects).toEqual([{ kind: "account-usage" }]);
  expect(initial.observedAt).toBe(now);
});

test("failed conflict send keeps both queues and the old boundary for retry", () => {
  const saved = record({
    pendingWake: [answer],
    pendingConflict: { model, base: "dev" },
    conflictSentAt: time(1),
  });
  const result = run(saved, { reason: "idle", active: false }, metadata(), {}, { failSend: true });
  expect(result.error?.message).toBe("send failed");
  expect(saved.pendingConflict).toEqual({ model, base: "dev" });
  expect(saved.pendingWake).toEqual([answer]);
  expect(saved.conflictSentAt).toBe(time(1));
  expect(result.effects.map((effect) => effect.kind)).toEqual(["switch-conflict", "send"]);
});

test.each([true, false])(
  "CHECK-IN-only=%s determines conflict restoration before normal model resolution",
  (onlyCheckin) => {
    const saved = record({
      pendingWake: onlyCheckin ? [checkin] : [checkin, answer],
      conflictModel: model,
    });
    const result = run(saved, { reason: "idle", active: false }, metadata());
    expect(result.error).toBeUndefined();
    expect(
      result.effects
        .filter((effect) => ["restore-conflict", "resume-model", "send"].includes(effect.kind))
        .map((effect) => effect.kind)
    ).toEqual(
      onlyCheckin ? ["resume-model", "send"] : ["restore-conflict", "resume-model", "send"]
    );
    expect(saved.conflictModel).toEqual(onlyCheckin ? model : undefined);
  }
);

test("quota recovery rechecks owner pause after saving the pending resume", () => {
  const saved = record();
  const task = metadata();
  let metadataReads = 0;
  const result = run(saved, quotaStatus, task, quotaOptions, {
    onRead: (kind, latest) => {
      if (kind === "metadata" && ++metadataReads === 2) {
        expect(latest.quotaResume?.text).toBe("finish the task");
        task.ownerPaused = true;
      }
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.sent).toEqual([]);
  expect(result.saved.quotaResume?.model).toEqual(fallback);
  expect(result.changes).toEqual([]);
});

test("pending gated quota recovery rechecks approval even after a synced failed send", () => {
  const gated = { ...fallback, gate: "owner" as const };
  const saved = record({
    model: gated,
    quotaStop: { family: "glm", error: quotaStatus.error!, turn: quotaStatus.turnId },
    quotaResume: {
      model: gated,
      text: answer,
      why: "automatic quota recovery",
      reason: "quota",
      synced: true,
    },
  });
  const result = run(saved, quotaStatus, metadata(), quotaOptions);
  expect(result.error?.message).toContain("sol");
  expect(result.sent).toEqual([]);
  expect(saved.quotaResume?.synced).toBe(true);
});

test.each([true, false])(
  "normal quota recovery with pendingConflict=%s updates temporary conflict state",
  (pendingConflict) => {
    const saved = record({
      conflictModel: model,
      conflictSentAt: time(1),
      ...(pendingConflict ? { pendingConflict: { model, base: "dev" } } : {}),
    });
    const result = run(saved, quotaStatus, metadata(), quotaOptions);
    expect(result.error).toBeUndefined();
    expect(saved.conflictModel).toEqual(pendingConflict ? fallback : undefined);
    expect(saved.conflictSentAt).toBe(pendingConflict ? time(1) : undefined);
  }
);
