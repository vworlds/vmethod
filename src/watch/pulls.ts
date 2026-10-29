import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { progressGuards } from "../core/progress.js";
import { BUTTON_RETRY_MS } from "../core/time.js";
import { stateRoot } from "../gateway/digest.js";
import type { LoopHost } from "../gateway/events.js";
import { object, type ObjectData, type Person } from "../gateway/people.js";
import { restActor } from "../github/diagnostic.js";
import { type ResolvedSession } from "../gateway/watch-scope.js";
import type { WriteJournal } from "../gateway/write-journal.js";
import { taskHeld, taskIssueNumbers } from "../tasks/markers.js";
import { LoopState, type Marker } from "./state.js";
import { WORKER_EVERY } from "./workers.js";

export interface PrInfo {
  number: number;
  branch: string;
  sha: string;
  base: string;
  created: string;
  title: string;
  user: ObjectData;
  mergeable: string;
  baseMoved?: boolean;
  baseSha?: string;
}

/** Explicit loop callbacks and narrowed services; no EventLoop instance crosses this seam. */
interface PullDeps {
  state: LoopState;
  host: Pick<
    LoopHost,
    | "config"
    | "env"
    | "deps"
    | "github"
    | "filter"
    | "digest"
    | "resolveConflicts"
    | "conflictPending"
    | "conflictFixing"
  >;
  writes: WriteJournal;
  own: string;
  org: string;
  session: ResolvedSession;
  taskBranch: RegExp;
  subjectPreviews: Map<string, { title: string; person: Person | undefined }>;
  current(): { cycle: number; firstRun: boolean; meId: number | null };
  updateLaunched(launched: Set<number>): void;
  pollReviewThreads(number: number): Promise<void>;
  seedPrComments(number: number): Promise<void>;
  inScope(number: number): boolean;
  muted(repo: string, number: number): boolean;
  threadUrl(repo: string, number: number, kind: "PR"): string;
  restRead<T>(action: () => Promise<T>): Promise<T>;
  restPages<T>(path: (page: number) => string, collect: (data: unknown) => T[]): Promise<T[]>;
  readMarker(marker: Marker<unknown>): string;
  writeMarker(marker: Marker<unknown>, text: string): void;
  marked(marker: Marker<unknown>): boolean;
  mark(marker: Marker<unknown>): void;
  touchActivity(number: number, at: string): void;
  previewFromSubject(repo: string, number: number): string;
  previewText(person: Person | undefined, text: string | undefined): string;
  produceOnce(id: string, kind: string, line: string): boolean;
  emit(id: string, kind: string, line: string): boolean;
  quietOnce(id: string, line: string): void;
  queueProgress(
    number: number,
    change: { state?: string | null; round?: number | null; ci?: string; if?: string[] }
  ): void;
}

const RED_CI = ["FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"];
const key = (text: string): string => createHash("md5").update(text).digest("hex").slice(0, 16);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const list = (value: unknown): ObjectData[] => (Array.isArray(value) ? value.map(object) : []);
function count(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}
/** Pull listing, detail and lifecycle observation, including the conflict driver. */
export class PullPoller {
  private readonly state: LoopState;
  private readonly host: PullDeps["host"];
  private readonly writes: WriteJournal;
  private readonly own: string;
  private readonly org: string;
  private readonly dir: string;
  private taskIssues = new Map<number, number[]>();
  private pendingMergedIssues = new Set<number>();
  private heldTasks = new Map<number, string>();
  private observedPrs: PrInfo[] = [];

  constructor(private readonly deps: PullDeps) {
    this.state = deps.state;
    this.host = deps.host;
    this.writes = deps.writes;
    this.own = deps.own;
    this.org = deps.org;
    this.dir = deps.state.dir;
  }

  /** Last complete listing's links and PRs, retained when the next pull step fails. */
  get observation(): {
    taskIssues: ReadonlyMap<number, number[]>;
    pendingMergedIssues: ReadonlySet<number>;
    prs: readonly PrInfo[];
  } {
    return {
      taskIssues: this.taskIssues,
      pendingMergedIssues: this.pendingMergedIssues,
      prs: this.observedPrs,
    };
  }

  async pollPulls(): Promise<void> {
    const observedPrs: PrInfo[] = [];
    const taskIssues = new Map<number, number[]>();
    const pendingMergedIssues = new Set<number>();
    const heldTasks = new Map<number, string>();
    const items = await this.deps.restPages(
      (page) => `/repos/${this.own}/pulls?state=open&per_page=100&page=${page}`,
      (data) => list(data)
    );
    const open = new Set<number>();
    const launched = new Set<number>();
    for (const item of items) {
      if (this.host.filter.identity(restActor(item.user)) !== undefined) {
        const number = count(item.number);
        if (number !== null) {
          taskIssues.set(number, taskIssueNumbers(str(item.body)) ?? []);
          if (
            taskIssueNumbers(str(item.body)) !== undefined &&
            taskHeld(str(item.title), str(item.body))
          ) {
            heldTasks.set(number, `${str(item.title)}\n${str(item.body)}`);
          }
        }
        for (const issue of taskIssueNumbers(str(item.body)) ?? []) {
          launched.add(issue);
        }
      }
    }
    for (const item of items) {
      const number = count(item.number);
      const head = object(item.head);
      const branch = str(head.ref);
      const sha = str(head.sha);
      if (
        number === null ||
        !branch ||
        !/^[a-f\d]{40}$/i.test(sha) ||
        (taskIssueNumbers(str(item.body)) === undefined && !this.deps.taskBranch.test(branch))
      ) {
        continue;
      }
      if (!this.deps.inScope(number)) {
        continue;
      }
      open.add(number);
      if (this.deps.muted(this.own, number)) {
        continue;
      }
      const detail =
        this.deps.current().cycle % WORKER_EVERY === 1
          ? object(
              await this.deps.restRead(() =>
                this.host.github.rest(`/repos/${this.own}/pulls/${number}`)
              )
            )
          : {};
      this.deps.subjectPreviews.set(`${this.own.toLowerCase()}#${number}`, {
        title: str(item.title),
        person: this.host.filter.identity(restActor(item.user)),
      });
      if (this.host.filter.identity(restActor(item.user)) === undefined) {
        this.host.digest.drop(this.deps.threadUrl(this.own, number, "PR"));
        continue;
      }
      const pr: PrInfo = {
        number,
        branch,
        sha,
        base: str(object(item.base).ref),
        created: str(item.created_at),
        title: str(item.title),
        user: object(item.user),
        baseMoved: detail.mergeable_state === "behind",
        baseSha: str(object(detail.base).sha),
        mergeable:
          detail.mergeable === false
            ? "CONFLICTING"
            : detail.mergeable === true
              ? "MERGEABLE"
              : "UNKNOWN",
      };
      await this.processOpenPr(pr);
      await this.deps.pollReviewThreads(number);
      observedPrs.push(pr);
    }
    for (const name of readdirSync(this.dir)) {
      const match = /^open-(\d+)$/.exec(name);
      const number = match ? count(match[1]) : null;
      if (number !== null && !open.has(number)) {
        await this.processGonePr(number, pendingMergedIssues, heldTasks);
      }
    }
    if (this.deps.current().cycle % WORKER_EVERY === 1) {
      for (const item of items) {
        const number = count(item.number);
        const branch = str(object(item.head).ref);
        if (number !== null && open.has(number) && branch && !this.deps.muted(this.own, number)) {
          await this.pollPrDetails(number, branch, str(object(item.head).sha));
        }
      }
    }
    // Publish only a complete poll; downstream steps retain the last good links on failure.
    this.observedPrs = observedPrs;
    this.taskIssues = taskIssues;
    this.pendingMergedIssues = pendingMergedIssues;
    this.heldTasks = heldTasks;
    this.deps.updateLaunched(launched);
  }

  private async processOpenPr(pr: PrInfo): Promise<void> {
    const url = this.deps.threadUrl(this.own, pr.number, "PR");
    if (pr.baseSha && /^[a-f\d]{40}$/i.test(pr.baseSha)) {
      const oldBase = this.deps.readMarker(this.state.pr(pr.number).baseHead);
      pr.baseMoved ||= !!oldBase && oldBase !== pr.baseSha;
      this.deps.writeMarker(this.state.pr(pr.number).baseHead, pr.baseSha);
    }
    this.state.pr(pr.number).branch.write(`${pr.branch}\n`);
    if (!this.deps.marked(this.state.pr(pr.number).open)) {
      this.deps.mark(this.state.pr(pr.number).open);
      this.state.pr(pr.number).head.write(`${pr.sha}\n`);
      this.deps.touchActivity(pr.number, pr.created);
    }
    if (
      (this.deps.current().firstRun && !this.deps.marked(this.state.pr(pr.number).seeded)) ||
      !this.deps.marked(this.state.pr(pr.number).promptsSeeded) ||
      !this.deps.marked(this.state.pr(pr.number).protocolSeeded)
    ) {
      await this.deps.seedPrComments(pr.number);
      this.deps.mark(this.state.pr(pr.number).seeded);
      this.deps.mark(this.state.pr(pr.number).promptsSeeded);
      this.deps.mark(this.state.pr(pr.number).protocolSeeded);
    }
    const oldHead = this.deps.readMarker(this.state.pr(pr.number).head);
    if (oldHead !== pr.sha) {
      if (oldHead && !this.writes.pushed(this.own, pr.number, pr.sha)) {
        if (!this.host.conflictFixing?.(pr.number)) {
          this.deps.queueProgress(pr.number, { state: "working", if: progressGuards.revive });
        }
        this.deps.touchActivity(pr.number, new Date(this.host.deps.now()).toISOString());
      }
      this.state.pr(pr.number).head.write(`${pr.sha}\n`);
    }
    try {
      await this.reconcileConflicts(pr, url);
    } catch (error) {
      this.deps.produceOnce(
        `conflict-error-${pr.number}-${pr.sha}`,
        "conflict-resolution",
        `CONFLICT #${pr.number}: reconciliation failed (${error instanceof Error ? error.message : String(error)}); inspect gateway state before retrying`
      );
    }
    this.observedPrs.push(pr);
  }

  /** Terminal resolutions supersede every card move queued during the conflicted turn. */
  private settleConflicts(pr: PrInfo, result: string): void {
    if (result.startsWith("PENDING")) {
      return;
    }
    // The conflict service books an up-to-date PR itself; a no-op result has no
    // news and must not wake the orchestrator (a false alarm).
    if (result.startsWith("nothing to resolve for #")) {
      return;
    }
    this.deps.produceOnce(`conflict-result-${pr.number}-${pr.sha}`, "conflict-resolution", result);
    if (
      /^(?:RESOLVED|MERGED|BLOCKED)\b/.test(result) ||
      /^conflict on #\d+ resolved outside the fixer$/.test(result)
    ) {
      this.state.pr(pr.number).pendingProgress.remove();
    }
  }

  private async reconcileConflicts(pr: PrInfo, url: string): Promise<void> {
    if (pr.mergeable === "CONFLICTING") {
      if (this.host.resolveConflicts) {
        if (this.deps.readMarker(this.state.pr(pr.number).conflict) !== pr.sha) {
          this.deps.writeMarker(this.state.pr(pr.number).conflict, pr.sha);
          this.deps.queueProgress(pr.number, { state: "conflict" });
        }
      } else if (
        this.deps.produceOnce(
          `conflict-${pr.number}-${pr.sha}`,
          "conflict",
          `CONFLICT #${pr.number} (${pr.branch}): its worker must merge origin/${pr.base} and push${this.deps.previewFromSubject(this.own, pr.number)} ${url}`
        )
      ) {
        this.deps.writeMarker(this.state.pr(pr.number).conflict, pr.sha);
        this.deps.queueProgress(pr.number, { state: "conflict" });
      }
      if (
        this.host.resolveConflicts &&
        !this.deps.marked(this.state.pr(pr.number).conflictDispatched.at(pr.sha))
      ) {
        const result = await this.host.resolveConflicts(pr.number);
        // #373: mark after the call, and only once a resolution landed: a busy or
        // failed dispatch left no pending record and retries on the next poll.
        if (!result.startsWith("PENDING") || this.host.conflictPending?.(pr.number) !== false) {
          this.deps.mark(this.state.pr(pr.number).conflictDispatched.at(pr.sha));
        }
        this.settleConflicts(pr, result);
      }
    } else if (
      pr.mergeable === "MERGEABLE" &&
      this.deps.marked(this.state.pr(pr.number).conflict)
    ) {
      this.state.pr(pr.number).conflict.remove();
      this.deps.queueProgress(pr.number, { state: "working", if: progressGuards.conflictResolved });
    }
    if (
      pr.baseMoved &&
      this.host.resolveConflicts &&
      !this.deps.marked(this.state.pr(pr.number).baseDispatched.at(`${pr.sha}-${pr.baseSha}`))
    ) {
      const result = await this.host.resolveConflicts(pr.number);
      // Like the conflict dispatch: an unfinished base automation retries next poll.
      if (!result.startsWith("PENDING") || this.host.conflictPending?.(pr.number) !== false) {
        this.deps.mark(this.state.pr(pr.number).baseDispatched.at(`${pr.sha}-${pr.baseSha}`));
      }
      this.settleConflicts(pr, result);
    }
    if (this.host.conflictPending?.(pr.number)) {
      this.settleConflicts(pr, await this.host.resolveConflicts!(pr.number));
    }
  }

  private async pollPrDetails(number: number, branch: string, sha: string): Promise<void> {
    const commits = await this.deps.restPages(
      (page) => `/repos/${this.own}/pulls/${number}/commits?per_page=100&page=${page}`,
      (data) => list(data)
    );
    const last = commits.at(-1);
    if (last) {
      const commit = object(last.commit);
      this.deps.touchActivity(
        number,
        str(object(commit.committer).date) || str(object(commit.author).date)
      );
    }
    if (commits.length > 1 && !this.deps.marked(this.state.pr(number).picked)) {
      if (!this.deps.current().firstRun) {
        this.deps.quietOnce(
          `picked-${number}`,
          `NOTE PR #${number} (${branch}): picked up (${commits.length} commits)`
        );
      } else {
        this.deps.mark(this.state.pr(number).picked);
      }
    }
    const url = this.deps.threadUrl(this.own, number, "PR");
    const runs = await this.deps.restPages(
      (page) => `/repos/${this.own}/commits/${sha}/check-runs?per_page=100&page=${page}`,
      (data) => list(object(data).check_runs)
    );
    const red = runs.some(
      (run) =>
        this.host.filter.check(run, this.org, url) !== undefined &&
        RED_CI.includes(str(run.conclusion).toUpperCase())
    );
    const state = red ? "red" : "ok";
    if (this.deps.readMarker(this.state.pr(number).ci) !== state) {
      this.state.pr(number).ci.write(state);
      this.deps.queueProgress(number, { ci: state });
    }
  }

  private async processGonePr(
    number: number,
    pendingMergedIssues: Set<number>,
    heldTasks: Map<number, string>
  ): Promise<void> {
    if (this.deps.muted(this.own, number)) {
      return;
    }
    if (!this.deps.inScope(number)) {
      this.state.pr(number).open.remove();
      return;
    }
    const url = this.deps.threadUrl(this.own, number, "PR");
    const data = object(
      await this.deps.restRead(() => this.host.github.rest(`/repos/${this.own}/pulls/${number}`))
    );
    const person = this.host.filter.identity(restActor(data.user));
    const mergeFile = join(
      stateRoot(this.host.env, this.host.config.stateName ?? this.own.replace("/", "-")),
      `merge-${number}.json`
    );
    const followUp = existsSync(mergeFile)
      ? object(JSON.parse(readFileSync(mergeFile, "utf8")))
      : {};
    const complete = Array.isArray(followUp.done) && followUp.done.includes("follow-up");
    const mergeTime = Date.parse(str(data.merged_at));
    const journalActive =
      existsSync(mergeFile) &&
      !complete &&
      this.host.deps.now() - statSync(mergeFile).mtimeMs < BUTTON_RETRY_MS;
    // A recent checkpoint counts as a running follow-up. An interrupted journal
    // ages out; a missing journal still gets ten minutes from the merge itself.
    const followUpPending =
      !complete &&
      (journalActive ||
        (Number.isFinite(mergeTime) && this.host.deps.now() - mergeTime < BUTTON_RETRY_MS));
    if (data.merged === true && person !== undefined && followUpPending) {
      for (const issue of taskIssueNumbers(str(data.body)) ?? []) {
        pendingMergedIssues.add(issue);
      }
    }
    const self = count(object(data.merged_by).id) === this.deps.current().meId;
    const matched = this.writes.matches(
      { kind: "merged", repo: this.own, number },
      str(data.merged_at)
    );
    const notified = this.deps.marked(this.state.pr(number).mergeNotified);
    if (data.merged === true && complete && (!self || matched || notified)) {
      this.clearPrState(number);
      this.deps.queueProgress(number, { state: null, round: null, ci: "ok" });
      return;
    }
    if (data.merged === true) {
      // Never run follow-up from the watcher. A sibling's same-account merge is
      // still work unless this session recorded it AND recovery is complete.
      const attempted = Number(this.deps.readMarker(this.state.pr(number).mergeAttempt)) * 1000;
      if (this.host.deps.now() - attempted < BUTTON_RETRY_MS) {
        return;
      }
      if (self && !complete && notified) {
        return;
      }
      if (self && followUpPending) {
        return;
      }
      const at = Math.floor(this.host.deps.now() / 1000);
      const merger = str(object(data.merged_by).login);
      const sibling = self && !matched ? " (this account, another session)" : "";
      const action =
        self && !complete
          ? "follow-up not run: run merge-task"
          : complete
            ? "follow-up complete"
            : "run merge-task";
      const waiting = [...heldTasks]
        .filter(
          ([pr, reason]) => pr !== number && new RegExp(`(^|[^\\w])#${number}\\b`).test(reason)
        )
        .map(([pr]) => `#${pr}`);
      const holds = waiting.length ? `; held task references: ${waiting.join(", ")}` : "";
      this.deps.emit(
        `button-${number}@${at}`,
        "button-merge",
        `PR #${number} MERGED by ${/^[\w-]+$/.test(merger) ? merger : "unknown"}${sibling}: ${action}${holds}${this.deps.previewText(person, str(data.title))} ${url}`
      );
      this.deps.mark(this.state.pr(number).mergeNotified);
      this.state.pr(number).mergeAttempt.write(`${at}\n`);
      this.deps.queueProgress(number, { state: null, round: null, ci: "ok" });
      if (complete) {
        this.clearPrState(number);
      }
      return;
    }
    if (data.state === "closed" && str(data.closed_at)) {
      this.deps.emit(
        `closed-${number}@${key(str(data.closed_at))}`,
        "closed",
        `PR #${number} is now CLOSED${this.deps.previewText(person, str(data.title))}; task worktree is a cleanup candidate: run worker stop ${number} --cleanup (safety guards apply) ${url}`
      );
      this.clearPrState(number);
      this.deps.queueProgress(number, { state: null, round: null, ci: "ok" });
    }
    // Still open (a listing lag): keep the marker and look again next poll.
  }

  private clearPrState(number: number): void {
    this.state.pr(number).clear();
  }
}
