import { createHash } from "node:crypto";
import { checkInText } from "../core/protocol.js";
import { progressGuards } from "../core/progress.js";
import { WORKER_STALE_MS } from "../core/time.js";
import { boardCost } from "../cost.js";
import { OpencodeClient, type WorkerSessionStatus, type WorkerStatus } from "../gateway/client.js";
import type { LoopHost } from "../gateway/events.js";
import { QuotaCrossings, limitsConfig } from "../gateway/limits.js";
import { renderPermissions } from "../gateway/permission-detail.js";
import type { BoardPoller } from "./board.js";
import type { CommentStream } from "./comments.js";
import type { PrInfo } from "./pulls.js";
import type { LoopState, Marker } from "./state.js";

/** Loop facilities used by worker observations; no EventLoop crosses this seam. */
interface WorkerDeps {
  state: LoopState;
  host: Pick<
    LoopHost,
    | "config"
    | "deps"
    | "env"
    | "workerStatus"
    | "workerLimits"
    | "workerTrees"
    | "workerSend"
    | "workerMetric"
    | "board"
  >;
  own: string;
  current(): { cycle: number };
  boardObservation(): BoardPoller["observation"];
  readReview: CommentStream["readReview"];
  activityAt(number: number): string;
  muted(repo: string, number: number): boolean;
  threadUrl(repo: string, number: number, kind: "PR"): string;
  readMarker(marker: Marker<unknown>): string;
  writeMarker(marker: Marker<unknown>, text: string): void;
  produceOnce(id: string, kind: string, line: string): boolean;
  emit(id: string, kind: string, line: string): boolean;
  quietOnce(id: string, line: string): void;
  queueProgress(number: number, change: { state?: string; if?: string[] }): void;
}

/** Shared cadence for pull details and worker sessions. */
export const WORKER_EVERY = 6;
const SILENT_MS = 40 * 60_000;
const key = (text: string): string => createHash("md5").update(text).digest("hex").slice(0, 16);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** Stale/silent turns, bounded check-ins, cost synchronization and quota crossings. */
export class WorkerPoller {
  private readonly state: LoopState;
  private readonly host: WorkerDeps["host"];
  private readonly own: string;
  private readonly dir: string;
  private readonly cycleWorkers = new Map<number, WorkerSessionStatus>();
  private readonly cycleStale = new Set<number>();
  private opencode?: OpencodeClient;
  private quotaCrossings?: QuotaCrossings;
  private readonly quotaWorkers = new Map<
    number,
    { pr: number; family: string; provider: string }
  >();
  private quotaPolledAt = -Infinity;
  private opencodeError = "";
  private workerPollErrors = new Map<number, Set<string>>();
  /** One report per distinct failure to list the worker checkout's worktrees. */
  private workerTreeErrors = new Set<string>();

  constructor(private readonly deps: WorkerDeps) {
    this.state = deps.state;
    this.host = deps.host;
    this.own = deps.own;
    this.dir = deps.state.dir;
  }

  /** Read-only failure diagnostics; lock contention never enters this map. */
  get pollErrors(): ReadonlyMap<number, ReadonlySet<string>> {
    return this.workerPollErrors;
  }

  /** Reset only per-cycle status and stale observations. */
  beginPoll(): void {
    this.cycleStale.clear();
    this.cycleWorkers.clear();
  }

  async watchStale(pr: PrInfo): Promise<void> {
    const url = this.deps.threadUrl(this.own, pr.number, "PR");
    const review = this.deps.readReview(pr.number);
    const activity = this.deps.activityAt(pr.number);
    if (
      this.workerExpectedActive(pr.number) &&
      review &&
      activity &&
      activity <= review.at &&
      Date.parse(review.at) <= this.host.deps.now() - WORKER_STALE_MS
    ) {
      let unreachable: boolean;
      try {
        const worker = await this.readWorkerStatus(pr.number);
        unreachable = worker.reason === "session unknown";
        const stop = this.workerStop(pr.number, worker);
        if (
          stop.state === "failed" &&
          this.deps.readMarker(this.state.pr(pr.number).stop) === this.stopKey(stop, worker.updated)
        ) {
          this.cycleStale.add(pr.number);
          return;
        }
        if (
          worker.active &&
          typeof worker.updated === "number" &&
          Number.isFinite(worker.updated) &&
          worker.updated >= this.host.deps.now() - WORKER_STALE_MS
        ) {
          return;
        }
      } catch {
        // Transport details may contain private data; only report availability.
        unreachable = true;
      }
      this.cycleStale.add(pr.number);
      if (
        this.deps.produceOnce(
          `s-${key(review.id)}`,
          "stale",
          `PR #${pr.number} (${pr.branch}): STALE${unreachable ? " (worker unreachable)" : ""}: no worker reply for 30+ min after my review ${url}`
        )
      ) {
        this.deps.queueProgress(pr.number, { state: "idle", if: progressGuards.stopped });
      }
    }
  }

  async pollQuotas(): Promise<void> {
    const config = limitsConfig(this.host.config);
    const active = [...this.quotaWorkers.values()].filter((w) =>
      this.deps.boardObservation().executing.some((pr) => pr.number === w.pr)
    );
    if (
      !config.enabled ||
      !active.length ||
      !this.host.workerLimits ||
      this.host.deps.now() - this.quotaPolledAt < config.pollSeconds * 1000
    ) {
      return;
    }
    this.quotaPolledAt = this.host.deps.now();
    if (!this.quotaCrossings) {
      const raw = this.deps.readMarker(this.state.quotaRisk);
      const previous: unknown = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(previous) || previous.some((p) => typeof p !== "string")) {
        throw new Error("Invalid quota crossing state");
      }
      this.quotaCrossings = new QuotaCrossings(previous);
    }
    for (const line of this.quotaCrossings.update(await this.host.workerLimits(), active)) {
      this.deps.emit(`quota-${key(line)}-${this.host.deps.now()}`, "worker", line);
    }
    this.deps.writeMarker(this.state.quotaRisk, JSON.stringify(this.quotaCrossings.snapshot()));
  }

  async pollWorkers(): Promise<void> {
    if (this.deps.current().cycle % WORKER_EVERY !== 1) {
      return;
    }
    const costs = new Map<number, { usd: number | null; lowerBound?: boolean }>();
    let trees: Map<string, string>;
    try {
      trees = new Map(
        (await (this.host.workerTrees?.() ?? Promise.resolve([]))).map((tree) => [
          tree.branch,
          tree.path,
        ])
      );
    } catch (error) {
      const message = `watcher: worker worktrees unavailable: ${(error as Error).message}`;
      if (!this.workerTreeErrors.has(message)) {
        this.workerTreeErrors.add(message);
        this.host.deps.report(message);
      }
      trees = new Map();
    }
    for (const pr of this.deps.boardObservation().executing) {
      if (this.deps.muted(this.own, pr.number)) {
        continue;
      }
      const url = this.deps.threadUrl(this.own, pr.number, "PR");
      const activity = this.deps.activityAt(pr.number);
      if (
        this.workerExpectedActive(pr.number, pr.working) &&
        activity &&
        Date.parse(activity) <= this.host.deps.now() - SILENT_MS &&
        !this.cycleStale.has(pr.number)
      ) {
        if (
          this.deps.produceOnce(
            `q-${pr.number}-${key(activity)}`,
            "silent",
            `PR #${pr.number} (${pr.branch}): SILENT: no commit or comment for 40+ min while Executing ${url}`
          )
        ) {
          this.deps.queueProgress(pr.number, { state: "silent", if: progressGuards.silent });
        }
      }
      if (!pr.branch) {
        continue;
      }
      const dir = trees.get(pr.branch);
      if (!dir) {
        continue;
      }
      let status: WorkerStatus;
      let updated: number | undefined;
      let recorded: WorkerSessionStatus;
      try {
        recorded = await this.readWorkerStatus(pr.number);
        if (recorded.prCost) {
          costs.set(pr.number, recorded.prCost);
        }
        status = this.workerStop(pr.number, recorded);
        updated = recorded.updated;
        if (recorded.reason === "session unknown") {
          const client = this.workerClient();
          if (!client) {
            continue;
          }
          status = await client.status(dir);
        }
      } catch (error) {
        const message = (error as Error).message;
        if (/^Worker #\d+ is locked:/.test(message)) {
          continue;
        }
        const signature = message.split(": ")[0];
        const seen = this.workerPollErrors.get(pr.number) ?? new Set<string>();
        if (!seen.has(signature)) {
          this.host.deps.report(`watcher: worker #${pr.number} poll failed: ${message}`);
          seen.add(signature);
          this.workerPollErrors.set(pr.number, seen);
        }
        continue;
      }
      this.workerPollErrors.delete(pr.number);
      const stopMarker = this.state.pr(pr.number).stop;
      const stop = this.stopKey(status, updated);
      const previous = this.deps.readMarker(this.state.pr(pr.number).stop);
      if (stop === previous) {
        continue;
      }
      // A backend without updated timestamps can return the same idle key after recovery.
      // Persist a transition sequence before handing events off, so crash retries reuse ids.
      const metricMarker = this.state.pr(pr.number).metric;
      const metric = metricMarker.read();
      const priorSequence = Number(metric.sequence ?? 0);
      if (!Number.isSafeInteger(priorSequence) || priorSequence < 0) {
        throw new Error(`Invalid worker metric sequence for #${pr.number}`);
      }
      const sequence =
        metric.stop === stop && metric.previous === previous ? priorSequence : priorSequence + 1;
      metricMarker.write({ stop, previous, sequence });
      const metricId = `${key(this.dir)}-${pr.number}-${sequence}`;
      if (status.state === "permission") {
        if (
          this.deps.emit(
            `w-${pr.number}@${this.host.deps.now()}`,
            "worker",
            `WORKER #${pr.number} (${pr.branch}): waits for a permission; see ${dir}${renderPermissions(status.permissionDetails)}`
          )
        ) {
          this.deps.queueProgress(pr.number, {
            state: "permission",
            if: progressGuards.permission,
          });
        }
      } else if (status.state === "failed") {
        if (
          this.deps.emit(
            `w-${pr.number}@${this.host.deps.now()}`,
            "worker",
            `WORKER #${pr.number} (${pr.branch}): its turn failed; see ${dir}`
          )
        ) {
          this.deps.queueProgress(pr.number, { state: "failed", if: progressGuards.failed });
        }
      } else if (status.state === "idle") {
        const at = new Date(this.host.deps.now()).toISOString();
        await this.host.workerMetric?.(pr.number, { id: `stop-${metricId}`, at, type: "stop" });
        const prompt = this.state.pr(pr.number).prompt.read();
        const round = str(prompt.id) || "unknown";
        const count = Number(
          this.deps.readMarker(this.state.pr(pr.number).checkin.at(key(round))) || 0
        );
        if (count < 2 && this.host.workerSend) {
          await this.host.workerSend(pr.number, checkInText(pr.number));
          this.deps.writeMarker(this.state.pr(pr.number).checkin.at(key(round)), String(count + 1));
          await this.host.workerMetric?.(pr.number, {
            id: `checkin-${metricId}`,
            at,
            type: "checkin",
          });
        } else {
          this.deps.emit(
            `w-${pr.number}@${this.host.deps.now()}`,
            "worker",
            `WORKER #${pr.number}: stopped without reply; send it a nudge ${url}`
          );
          this.deps.queueProgress(pr.number, { state: "idle", if: progressGuards.idle });
        }
      }
      stopMarker.write(`${stop}\n`);
    }
    for (const [pr, cost] of costs) {
      const id = this.deps.boardObservation().costCards.get(pr);
      const text = boardCost(cost.usd, cost.lowerBound);
      const value = JSON.stringify({ id, text });
      if (id && this.deps.readMarker(this.state.pr(pr).cost) !== value) {
        await this.host.board.set({ itemId: id, field: "Cost", value: text });
        this.deps.writeMarker(this.state.pr(pr).cost, value);
      }
    }
  }

  private async readWorkerStatus(number: number): Promise<WorkerSessionStatus> {
    const cached = this.cycleWorkers.get(number);
    if (cached) {
      return cached;
    }
    const status = await this.host.workerStatus(number);
    if (status.active && status.family && status.provider) {
      this.quotaWorkers.set(number, {
        pr: number,
        family: status.family,
        provider: status.provider,
      });
    } else {
      this.quotaWorkers.delete(number);
    }
    if (status.quotaEvent) {
      this.deps.emit(`quota-${number}-${this.host.deps.now()}`, "worker", status.quotaEvent);
    }
    this.cycleWorkers.set(number, status);
    return status;
  }

  private workerStop(number: number, status: WorkerSessionStatus): WorkerStatus {
    if (status.reason === "provider-error" || status.reason === "quota") {
      return { state: "failed", detail: status.error };
    }
    if (status.reason === "permission-wait") {
      return {
        state: "permission",
        detail: JSON.stringify(status.permissionDetails ?? []),
        permissionDetails: status.permissionDetails,
      };
    }
    const prompt = this.state.pr(number).prompt.read();
    const review = this.deps.readReview(number);
    const at = str(prompt.at) || review?.at;
    const protocolReply = this.state.pr(number).protocol.read();
    const hasReply =
      protocolReply.role === "worker" &&
      ["READY", "QUESTION", "BLOCKED", "DESIGN", "HANDOFF"].includes(str(protocolReply.tag)) &&
      str(protocolReply.at) >= (at ?? "");
    if ((status.reason === "idle without reply" || status.reason === "idle") && !hasReply) {
      return { state: "idle", detail: str(prompt.id) || review?.id || status.updated?.toString() };
    }
    return { state: "other" };
  }

  private stopKey(status: WorkerStatus, updated?: number): string {
    return status.state === "other"
      ? ""
      : JSON.stringify([status.state, key(status.detail ?? ""), updated ?? null]);
  }

  private workerExpectedActive(number: number, working = true): boolean {
    // Without a protocol turn, use working Progress (or the unanswered review for STALE).
    const active = this.state.pr(number).protocol.read().active;
    return typeof active === "boolean" ? active : working;
  }

  private workerClient(): OpencodeClient | null {
    if (this.opencode) {
      return this.opencode;
    }
    if (this.opencodeError) {
      return null;
    }
    try {
      this.opencode = new OpencodeClient(
        this.host.env,
        this.host.deps.fetch,
        this.host.deps.now,
        this.host.deps.report
      );
      return this.opencode;
    } catch (error) {
      this.opencodeError = (error as Error).message;
      this.host.deps.report(`watcher: worker status unavailable: ${this.opencodeError}`);
      this.deps.quietOnce(
        `no-opencode-${key(this.opencodeError)}`,
        `NOTE: worker status unavailable: ${this.opencodeError}`
      );
      return null;
    }
  }
}
