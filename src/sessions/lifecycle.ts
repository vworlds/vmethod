import { heading, parseFirstLine, wakeHeading } from "../core/protocol.js";
import type { WorkerSessionStatus } from "../gateway/client.js";
import { taskHeld } from "../tasks/markers.js";
import { modelGateError } from "../evidence/model-gate.js";
import { modelProvider, type ProviderLimits } from "../gateway/limits.js";
import type { Model, Session, TaskMetadata } from "../gateway/workers.js";

/** Observed transport state; unknown must never be treated as a stopped session. */
export type SessionState = "running" | "idle" | "permission" | "quota-stopped" | "unknown" | "gone";

type Field =
  | "pendingWake"
  | "pendingConflict"
  | "conflictSentAt"
  | "quotaResume"
  | "quotaStop"
  | "conflictModel";
export type LifecycleEffect =
  | { kind: "account-usage" }
  | { kind: "record"; set?: Partial<Session>; clear?: Field[] }
  | { kind: "save" }
  | { kind: "report"; text: string }
  | { kind: "send"; text: string; delivery: "queue" }
  | { kind: "stamp-conflict" }
  | { kind: "mark-quota"; readings: ProviderLimits[] }
  | { kind: "switch-conflict"; model: Model }
  | { kind: "restore-conflict" }
  | { kind: "resume-model" }
  | {
      kind: "change-model";
      model: Model;
      meta: TaskMetadata;
      pending: NonNullable<Session["quotaResume"]>;
    }
  | { kind: "card-model"; model: Model }
  | { kind: "model-comment"; text: string }
  | { kind: "throw"; error: Error };

export type LifecycleObservation =
  | { kind: "metadata" }
  | { kind: "limits" }
  | { kind: "quota-failed"; model: Model; readings: ProviderLimits[] }
  | { kind: "approval"; model: Model; meta: TaskMetadata }
  | { kind: "interrupted-prompt" }
  | { kind: "conflict-choice" };

type ObservationValue = TaskMetadata | ProviderLimits[] | Model | boolean | string | undefined;

/** Ordered effects, followed by at most one read and a pure continuation.
 * Reads are lazy so a paused task, an earlier failed effect, or a saved retry boundary
 * has exactly the same I/O ordering as delivery. No continuation performs I/O.
 */
export interface DrainPlan {
  state: SessionState;
  effects: LifecycleEffect[];
  status: WorkerSessionStatus;
  next?: { read: LifecycleObservation; then(value: ObservationValue): DrainPlan };
}

export interface LifecycleOptions {
  accountUsage?: boolean;
  comments?: boolean;
  drainWake?: boolean;
  quotaEnabled?: boolean;
  models?: Model[];
}

/** Plan one status observation without mutating its record, status, metadata or readings.
 * The runner executes effects in order, then supplies the requested observation.
 * Planning reads no clock: the send boundary is stamped by its own effect.
 */
export function plan(
  record: Session,
  status: WorkerSessionStatus,
  meta: TaskMetadata | undefined,
  readings: ProviderLimits[] | undefined,
  options: LifecycleOptions = {}
): DrainPlan {
  const current = structuredClone(record);
  const observed = { ...status };
  const state = sessionState(observed);
  const done = (effects: LifecycleEffect[] = [], result = observed): DrainPlan => ({
    state,
    effects,
    status: result,
  });
  const read = <T extends ObservationValue>(
    request: LifecycleObservation,
    then: (value: T) => DrainPlan,
    effects: LifecycleEffect[] = []
  ): DrainPlan => {
    if (request.kind === "metadata" && meta !== undefined) {
      const next = then(structuredClone(meta) as T);
      return { ...next, effects: [...effects, ...next.effects] };
    }
    if (request.kind === "limits" && readings !== undefined) {
      const next = then(readings as T);
      return { ...next, effects: [...effects, ...next.effects] };
    }
    return { ...done(effects), next: { read: request, then: (value) => then(value as T) } };
  };
  const running = (): WorkerSessionStatus => ({ ...observed, reason: "running", active: true });
  const suppressed = (task: TaskMetadata) =>
    task.merged ||
    task.state !== "OPEN" ||
    task.ownerPaused ||
    task.blocked ||
    taskHeld(task.title, task.body);
  const filtered = (task: TaskMetadata) => staleWakes(current, task);

  // Supplied observations make direct planning self-contained; the service leaves
  // them absent to retain lazy reads and their original failure boundaries.
  if (observed.reason === "idle" && options.comments !== false) {
    return meta ? classify(meta) : read<TaskMetadata>({ kind: "metadata" }, classify);
  }
  return start();

  function classify(task: TaskMetadata): DrainPlan {
    const latest = (role: string) =>
      task.comments
        .filter((comment) => comment.role === role && comment.body.startsWith(`[${role}]`))
        .map((comment) => comment.date)
        .sort()
        .at(-1) ?? "";
    if (latest("orchestrator") > latest("worker")) {
      observed.reason = "idle without reply";
    }
    return start();
  }

  function finishQuota(pending: NonNullable<Session["quotaResume"]>): DrainPlan {
    return read<TaskMetadata>({ kind: "metadata" }, (task) => {
      if (suppressed(task)) {
        return done();
      }
      const finish = (approved: boolean): DrainPlan => {
        if (!approved) {
          return done([{ kind: "throw", error: modelGateError(pending.model.family) }]);
        }
        const effects: LifecycleEffect[] = [];
        if (
          current.model.family !== pending.model.family ||
          current.model.model !== pending.model.model
        ) {
          effects.push({ kind: "change-model", model: pending.model, meta: task, pending });
        }
        if (!pending.synced) {
          if (!(
            pending.reason === "quota" &&
            current.conflictModel &&
            pending.text.startsWith("CONFLICT:")
          )) {
            effects.push({ kind: "card-model", model: pending.model });
          }
          effects.push(
            {
              kind: "model-comment",
              text: `${heading("NOTE")}: model switched to ${pending.model.family} (${pending.why.replace(/\s+/g, " ").trim()}); reason: ${pending.reason}`,
            },
            { kind: "record", set: { quotaResume: { ...pending, synced: true } } },
            { kind: "save" }
          );
        }
        effects.push(
          { kind: "send", text: pending.text, delivery: "queue" },
          { kind: "record", clear: ["pendingWake", "quotaResume"] }
        );
        if (current.conflictModel && !pending.text.startsWith("CONFLICT:")) {
          effects.push(
            current.pendingConflict
              ? { kind: "record", set: { conflictModel: pending.model } }
              : { kind: "record", clear: ["conflictModel", "conflictSentAt"] }
          );
        }
        const family = current.quotaStop!.family;
        const quotaEvent = `QUOTA #${current.pr}: ${family} quota-stopped; switched to ${pending.model.family} and resumed`;
        effects.push({ kind: "save" }, { kind: "report", text: quotaEvent });
        return done(effects, { ...running(), errorFamily: family, quotaEvent });
      };
      return pending.model.gate === "owner"
        ? read<boolean>({ kind: "approval", model: pending.model, meta: task }, finish)
        : finish(true);
    });
  }

  function quota(): DrainPlan {
    if (observed.active || !options.quotaEnabled) {
      return done();
    }
    if (current.quotaResume) {
      return finishQuota(current.quotaResume);
    }
    if (
      current.quotaStop &&
      current.quotaStop.turn === observed.turnId &&
      current.quotaStop.error === observed.error
    ) {
      return done([], { ...observed, errorFamily: current.quotaStop.family });
    }
    return read<TaskMetadata>({ kind: "metadata" }, (task) => {
      if (suppressed(task)) {
        return done();
      }
      return read<ProviderLimits[]>({ kind: "limits" }, (limits) => {
        const failed = current.model;
        current.quotaStop = {
          family: failed.family,
          error: observed.error ?? "",
          turn: observed.turnId,
        };
        const candidates =
          options.models?.find((model) => model.family === failed.family)?.fallback ?? [];
        const choose = (index: number): DrainPlan => {
          if (index === candidates.length) {
            return recover(undefined);
          }
          const model = options.models!.find((model) => model.family === candidates[index])!;
          if (
            model.kind !== failed.kind ||
            limits.find((reading) => reading.provider === modelProvider(model))?.atRisk
          ) {
            return choose(index + 1);
          }
          return read<boolean>({ kind: "quota-failed", model, readings: limits }, (failed) => {
            if (failed) {
              return choose(index + 1);
            }
            return model.gate === "owner"
              ? read<boolean>({ kind: "approval", model, meta: task }, (approved) =>
                  approved ? recover(model) : choose(index + 1)
                )
              : recover(model);
          });
        };
        const recover = (selected: Model | undefined): DrainPlan => {
          // The original recovery re-reads metadata for stale wakes, without clearing them.
          const resume = (texts: string[], reports: string[]): DrainPlan => {
            const effects: LifecycleEffect[] = reports.map((text) => ({ kind: "report", text }));
            if (!selected) {
              const quotaEvent = `QUOTA #${current.pr}: ${failed.family} quota-stopped; no eligible fallback`;
              return done([...effects, { kind: "report", text: quotaEvent }], {
                ...observed,
                errorFamily: failed.family,
                quotaEvent,
              });
            }
            const withText = (text: string | undefined): DrainPlan => {
              if (!text) {
                return done([
                  {
                    kind: "throw",
                    error: new Error(
                      `Cannot resume #${current.pr}: interrupted prompt is unavailable; send a prompt explicitly`
                    ),
                  },
                ]);
              }
              const pending: NonNullable<Session["quotaResume"]> = {
                model: selected,
                text,
                why: "automatic quota recovery",
                reason: "quota",
              };
              const next = finishQuota(pending);
              return {
                ...next,
                effects: [
                  { kind: "record", set: { quotaResume: pending } },
                  { kind: "save" },
                  ...next.effects,
                ],
              };
            };
            const next = texts.length
              ? withText(texts.join("\n"))
              : read<string | undefined>({ kind: "interrupted-prompt" }, withText);
            return { ...next, effects: [...effects, ...next.effects] };
          };
          return current.pendingWake?.length
            ? read<TaskMetadata>({ kind: "metadata" }, (task) => {
                const wakes = filtered(task);
                return resume(wakes.keep, wakes.reports);
              })
            : resume([], []);
        };
        const next = choose(0);
        return { ...next, effects: [{ kind: "mark-quota", readings: limits }, ...next.effects] };
      });
    });
  }

  function drain(): DrainPlan {
    if (
      options.drainWake === false ||
      observed.active ||
      ["permission-wait", "session unknown", "worktree gone"].includes(observed.reason)
    ) {
      return done();
    }
    if (current.pendingConflict) {
      return read<TaskMetadata>({ kind: "metadata" }, (task) => {
        if (task.merged) {
          return done([
            { kind: "record", clear: ["pendingConflict", "pendingWake", "conflictSentAt"] },
            { kind: "save" },
          ]);
        }
        if (task.ownerPaused) {
          return done();
        }
        return read<Model>({ kind: "conflict-choice" }, (model) =>
          done(
            [
              { kind: "switch-conflict", model },
              {
                kind: "send",
                text: conflictLine(current.pendingConflict!.base),
                delivery: "queue",
              },
              { kind: "stamp-conflict" },
              { kind: "record", clear: ["pendingConflict"] },
              { kind: "save" },
            ],
            running()
          )
        );
      });
    }
    if (current.pendingWake?.length) {
      return read<TaskMetadata>({ kind: "metadata" }, (task) => {
        const wakes = filtered(task);
        const effects: LifecycleEffect[] = wakes.reports.map((text) => ({ kind: "report", text }));
        if (!wakes.keep.length) {
          return done([
            ...effects,
            { kind: "record", clear: ["pendingWake", "conflictSentAt"] },
            { kind: "save" },
          ]);
        }
        effects.push({ kind: "record", set: { pendingWake: wakes.keep } });
        if (wakes.keep.some((text) => !text.startsWith(`${heading("CHECK-IN")}:`))) {
          effects.push({ kind: "restore-conflict" });
        }
        effects.push(
          { kind: "resume-model" },
          { kind: "send", text: wakes.keep.join("\n"), delivery: "queue" },
          { kind: "record", clear: ["pendingWake", "conflictSentAt"] },
          { kind: "save" }
        );
        return done(effects, running());
      });
    }
    return done();
  }

  function start(): DrainPlan {
    const usage: LifecycleEffect[] = options.accountUsage ? [{ kind: "account-usage" }] : [];
    if (options.drainWake !== false && observed.quotaStopped) {
      const next = quota();
      return { ...next, effects: [...usage, ...next.effects] };
    }
    const effects: LifecycleEffect[] = [];
    if (observed.active && current.quotaResume?.synced) {
      delete current.quotaResume;
      delete current.pendingWake;
      effects.push({ kind: "record", clear: ["quotaResume", "pendingWake"] }, { kind: "save" });
    }
    if (current.quotaStop && !observed.error) {
      delete current.quotaStop;
      effects.push({ kind: "record", clear: ["quotaStop"] }, { kind: "save" });
    }
    if (observed.error && current.quotaStop) {
      observed.errorFamily = current.quotaStop.family;
    }
    const next = drain();
    return { ...next, effects: [...usage, ...effects, ...next.effects] };
  }
}

function sessionState(status: WorkerSessionStatus): SessionState {
  if (status.active) {
    return "running";
  }
  if (status.reason === "session unknown") {
    return "unknown";
  }
  if (status.reason === "worktree gone") {
    return "gone";
  }
  if (status.reason === "permission-wait") {
    return "permission";
  }
  return status.quotaStopped ? "quota-stopped" : "idle";
}

/** Shared byte-identical conflict prompt for immediate dispatch and the idle drain. */
export function conflictLine(base: string): string {
  return `CONFLICT: merge origin/${base}, resolve keeping both sides' behaviour, push, wait-checks, READY. If every conflicted file is package-lock.json, npm-shrinkwrap.json, yarn.lock or pnpm-lock.yaml (at any path), do not hand-merge: keep package.json manifests as merged by git and regenerate the lockfiles with npm install --package-lock-only or the configured equivalent in postMerge.install. Commit the regeneration as the merge resolution; the remerge diff may touch only lockfiles, lockfile sync must pass and configured checks must be green. Mixed conflicts retain the conflicted-hunk rule.`;
}

/** Pure stale/suppressed wake result, including reports in original queue order. */
export function staleWakes(
  record: Pick<Session, "pr" | "pendingWake" | "conflictSentAt">,
  meta: Pick<TaskMetadata, "ownerPaused" | "merged" | "comments">
): { keep: string[]; dropped: string[]; reports: string[] } {
  const reports: string[] = [];
  const keep = filterStaleWakes(record, meta, (message) => reports.push(message));
  return {
    keep,
    dropped: (record.pendingWake ?? []).filter((text) => !keep.includes(text)),
    reports,
  };
}

/** Keep wakes unless suppressed or genuinely answered; conflict-turn replies answer nothing. */
export function filterStaleWakes(
  record: Pick<Session, "pr" | "pendingWake" | "conflictSentAt">,
  meta: Pick<TaskMetadata, "ownerPaused" | "merged" | "comments">,
  report: (message: string) => void
): string[] {
  const queued = record.pendingWake ?? [];
  if (!queued.length) {
    return [];
  }
  if (meta.ownerPaused || meta.merged) {
    return [];
  }
  const firstLine = (body: string): string => body.split(/\r?\n/)[0];
  const conflictSentAt = Date.parse(record.conflictSentAt ?? "");
  const reply = meta.comments
    .filter(
      (comment) =>
        comment.role === "worker" &&
        parseFirstLine(firstLine(comment.body), {
          role: "worker",
          tags: ["READY", "QUESTION", "BLOCKED", "DESIGN", "HANDOFF"],
        }) &&
        !(Date.parse(comment.date) >= conflictSentAt)
    )
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
    .at(-1);
  const kept = queued.filter((text) => {
    const heading = wakeHeading(text);
    if (!heading) {
      return true;
    }
    const triggered = meta.comments
      .filter(
        (comment) =>
          comment.role === "orchestrator" &&
          comment.body.split(/\r?\n/)[0].trim() === `[orchestrator] ${heading}`
      )
      .map((comment) => comment.date)
      .sort()
      .at(-1);
    if (!triggered || !reply || Date.parse(triggered) >= Date.parse(reply.date)) {
      return true;
    }
    report(
      `stale wake dropped for #${record.pr}: ${heading} (${triggered}) superseded by ${firstLine(reply.body)} at ${reply.date}`
    );
    return false;
  });
  return kept.length === queued.length ? queued : kept;
}
