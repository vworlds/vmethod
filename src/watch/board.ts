import { readdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { heading } from "../core/protocol.js";
import {
  parseProgress,
  renderProgress,
  mayReplace,
  reconciledTurn,
  hasOrchestratorProgress,
} from "../core/progress.js";
import {
  HOLD_MAX_AGE_MS,
  MIGRATION_WINDOW_MS,
  TURN_WAIT_MS,
  UNHANDLED_TURN_REMINDER_MINUTES,
  WAITING_TURN_REMINDER_MINUTES,
} from "../core/time.js";
import { readState } from "../board/readme.js";
import { ScopeReader, legacyScopeCutoff } from "../evidence/scope.js";
import {
  AutopilotReader,
  autopilotStates,
  taskGroupNumbers,
  type AutopilotState,
} from "../evidence/autopilot.js";
import { repoOf } from "../github/diagnostic.js";
import { pages } from "../github/pages.js";
import { actorFields } from "../github/selections.js";
import { GraphQLResponseError } from "../gateway/client.js";
import type { LoopHost } from "../gateway/events.js";
import { object, type ObjectData, type Person } from "../gateway/people.js";
import { taskIssueNumbers } from "../tasks/markers.js";
import {
  ownerActivityFields,
  ownerForTurn,
  sameAssignees,
  setTurn,
  turnAssignees,
} from "../gateway/turn.js";
import { WatchBoard } from "../gateway/watch-board.js";
import type { WriteJournal } from "../gateway/write-journal.js";
import type { LoopState, Marker } from "./state.js";

/** Loop facilities used by the board poll. No EventLoop instance crosses this seam. */
interface BoardDeps {
  state: LoopState;
  host: Pick<LoopHost, "config" | "deps" | "github" | "filter" | "board">;
  writes: WriteJournal;
  own: string;
  reserve: number;
  known: ReadonlySet<number>;
  subjectPreviews: Map<string, { title: string; person: Person | undefined }>;
  current(): {
    me: string | null;
    firstRun: boolean;
    taskIssues: ReadonlyMap<number, number[]>;
    pendingMergedIssues: ReadonlySet<number>;
    nextBoardAt: number;
  };
  recordPoll(cost: number): void;
  isOwn(repo: string): boolean;
  inScope(number: number): boolean;
  trackOne(number: number): Promise<void>;
  muted(repo: string, number: number): boolean;
  branchOf(number: number): string;
  readMarker(marker: Marker<unknown>): string;
  writeMarker(marker: Marker<unknown>, text: string): void;
  marked(marker: Marker<unknown>): boolean;
  mark(marker: Marker<unknown>): void;
  queueProgress(
    number: number,
    change: {
      status?: string;
      state?: string | null;
      round?: number | null;
      ci?: string;
      if?: string[];
      releaseOwner?: boolean;
    }
  ): void;
  assignmentEvent(
    repo: string,
    number: number,
    type: string,
    logins: string[]
  ): Promise<ObjectData>;
  ownAssignment(event: ObjectData, repo: string, number: number, kind: string): boolean;
  siblingActor(event: ObjectData): string;
  restPages<T>(path: (page: number) => string, collect: (data: unknown) => T[]): Promise<T[]>;
  list(value: unknown): ObjectData[];
  previewText(person: Person | undefined, text: string | undefined): string;
  previewFromSubject(repo: string, number: number): string;
  threadUrl(repo: string, number: number, kind: "ISSUE" | "PR"): string;
  produceOnce(id: string, kind: string, line: string): boolean;
  emit(id: string, kind: string, line: string): boolean;
  quiet(line: string): void;
}

const NEXT_RECHECK_MS = 60_000;
const GRADE_SETTLE_MS = 60_000;
/** Both the count and the elapsed window must hold before pruning a card baseline. */
const BOARD_ABSENT_POLLS = 3;
const BOARD_ABSENT_MS = 24 * 60 * 60_000;
const PAGE_LIMIT = 20;
const key = (text: string): string => createHash("md5").update(text).digest("hex").slice(0, 16);
const slug = (repo: string): string => repo.toLowerCase().replace("/", "_");

interface CardInfo {
  ownerActivity?: ObjectData;
  autopilotLabel?: boolean;
  autopilotStopped?: boolean;
  contentId: string;
  scopePending?: boolean;
  ownerReview?: string;
  id: string;
  repo: string;
  number: number;
  kind: "ISSUE" | "PR";
  state: string;
  stateReason: string;
  subIssueIds?: string[];
  blockedBy?: { number: number; repo: string; state: string }[];
  blockerCount?: number;
  closedBy: string;
  closedAt: string;
  column: string;
  columnAt: string;
  assignees: string[];
  estimate: number | null;
  progress: string;
  title: string;
  person: Person | undefined;
}

interface StartableValue {
  number: number;
  kind: "ISSUE" | "PR";
  repo: string;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function migrationActive(
  state: { migrating?: string },
  now: number,
  report: (message: string) => void
): boolean {
  if (!state.migrating) {
    return false;
  }
  const match = /since (\S+)\s*$/.exec(state.migrating);
  const since = match ? Date.parse(match[1]) : NaN;
  if (!Number.isFinite(since)) {
    report("board migration window without a valid timestamp; treating board moves as stamped");
    return true;
  }
  return now - since < MIGRATION_WINDOW_MS;
}

/** Board observation, judgement and turn reconciliation; the loop owns pacing and delivery. */
export class BoardPoller {
  private readonly state: LoopState;
  private readonly host: BoardDeps["host"];
  private readonly writes: WriteJournal;
  private readonly own: string;
  private readonly dir: string;
  private readonly cycleOwnMoves = new Set<string>();
  private inprogress: { number: number; branch: string; working: boolean }[] = [];
  private prCostCards = new Map<number, string>();
  private lastBoardAt = 0;
  private readonly boardReader: WatchBoard;
  private autopilot = new Map<string, AutopilotState>();
  private nextSignature = "";
  private nextAt = 0;
  private launchedIssues = new Set<number>();
  private readonly boardEnabled: boolean;

  constructor(private readonly deps: BoardDeps) {
    this.state = deps.state;
    this.host = deps.host;
    this.writes = deps.writes;
    this.own = deps.own;
    this.dir = deps.state.dir;
    this.boardReader = new WatchBoard(deps.host.github);
    this.boardEnabled = object(deps.host.config.board).enabled !== false;
  }

  /** Live board output consumed by the worker poll and the loop's pacing report. */
  get observation(): {
    executing: readonly { number: number; branch: string; working: boolean }[];
    costCards: ReadonlyMap<number, string>;
    lastPollAt: number;
    reader: Pick<WatchBoard, "sizes" | "cost" | "pages" | "overflow" | "readId">;
  } {
    return {
      executing: this.inprogress,
      costCards: this.prCostCards,
      lastPollAt: this.lastBoardAt,
      reader: this.boardReader,
    };
  }

  /** Clear only cycle-local move evidence, including when this cycle skips the board read. */
  beginPoll(): void {
    this.cycleOwnMoves.clear();
  }

  /** Publish the successful pull listing's launched set; changes invalidate NEXT immediately. */
  updateLaunched(launched: Set<number>): void {
    if ([...launched].sort().join(",") !== [...this.launchedIssues].sort().join(",")) {
      this.nextSignature = "";
    }
    this.launchedIssues = launched;
  }

  /** Run the board step in its existing order; prune absences only after full success. */
  async pollBoard(pullsOk: boolean): Promise<void> {
    if (!this.boardAllowed()) {
      this.state.unestimated.remove();
      return;
    }
    const settings = object(this.host.config.board);
    const owner = str(settings.owner);
    const number = count(settings.number);
    if (!owner || number === null) {
      throw new Error("Missing board configuration");
    }
    const cards = await this.readBoard(owner, number);
    await this.watchAutopilot(cards.list);
    const ownerWaits = cards.list.filter(
      (card) =>
        this.deps.isOwn(card.repo) &&
        card.kind === "ISSUE" &&
        card.state === "OPEN" &&
        parseProgress(card.progress).state === "owner-review"
    );
    const scopeWaits = await new ScopeReader(
      this.host.github,
      this.host.filter,
      this.host.config,
      legacyScopeCutoff(cards.readme),
      this.autopilot
    ).read(ownerWaits.map((card) => card.contentId));
    for (const card of ownerWaits) {
      card.scopePending = scopeWaits.get(card.contentId)?.reviewPending;
    }
    this.prCostCards = new Map(
      cards.list
        .filter((card) => card.repo === this.own && card.kind === "PR")
        .map((card) => [card.number, card.id])
    );
    this.lastBoardAt = this.host.deps.now();
    const migration = migrationActive(readState(cards.readme), this.host.deps.now(), (message) =>
      this.host.deps.report(`watcher: ${message}`)
    );
    this.inprogress = [];
    const ready: CardInfo[] = [];
    const specReview: CardInfo[] = [];
    const approved: CardInfo[] = [];
    const currentCards: CardInfo[] = [];
    const present = new Set<string>();
    const theirs = new Set<string>();
    const unestimated = object(safeJson(this.deps.readMarker(this.state.unestimated)));
    const nextUnestimated: Record<string, number> = {};
    for (const card of cards.list) {
      present.add(card.id);
      this.deps.subjectPreviews.set(`${card.repo.toLowerCase()}#${card.number}`, {
        title: card.title,
        person: card.person,
      });
      if (!this.deps.isOwn(card.repo)) {
        // A foreign card assigned to me asks for a reply there, not for board authority.
        if (await this.watchForeignAssignment(card)) {
          theirs.add(`theirs-${slug(card.repo)}-${card.number}`);
        }
        continue;
      }
      if (!this.deps.known.has(card.number)) {
        await this.deps.trackOne(card.number);
      }
      if (!this.deps.inScope(card.number) || this.deps.muted(card.repo, card.number)) {
        continue;
      }
      this.watchBlockers(card);
      const waiting = this.waiting(card);
      if (
        !waiting &&
        !migration &&
        card.kind === "ISSUE" &&
        card.column === "Executing" &&
        card.subIssueIds?.length &&
        card.subIssueIds.every((id) =>
          cards.list.some((child) => child.contentId === id && child.column === "Done")
        ) &&
        ![...this.deps.current().taskIssues.values()].some((issues) => issues.includes(card.number))
      ) {
        const next = turnAssignees(this.host.filter.people, card.repo, card.assignees, null);
        await setTurn(this.host.github, card.repo, card.number, card.assignees, next);
        await this.host.board.set({
          itemId: card.id,
          field: "Status",
          value: "Done",
          progress: null,
        });
        card.assignees = next;
        card.column = "Done";
        card.progress = "";
        this.state.card(card.id).column.write("Done\n");
        this.deps.produceOnce(
          `epic-done-${card.id}@${key(card.subIssueIds.join(","))}`,
          "board",
          `DONE #${card.number}: all sub-issues Done ${this.deps.threadUrl(card.repo, card.number, card.kind)}`
        );
      }
      if (card.state === "CLOSED" || card.state === "MERGED") {
        await this.applyClosedCard(card);
        continue;
      }
      if (
        card.ownerReview &&
        !this.deps.marked(this.state.once(`owner-review-${card.number}@${key(card.ownerReview)}`))
      ) {
        if (!this.deps.current().firstRun) {
          this.deps.queueProgress(card.number, { state: "verifying" });
          this.deps.produceOnce(
            `owner-review-event-${card.number}@${key(card.ownerReview)}`,
            "owner-review",
            `OWNER REVIEW #${card.number}: orchestrator's move ${this.deps.threadUrl(card.repo, card.number, card.kind)}`
          );
        }
        this.deps.mark(this.state.once(`owner-review-${card.number}@${key(card.ownerReview)}`));
      }
      const pendingProgress = this.state.pr(card.number).pendingProgress.exists();
      if (!waiting) {
        await this.applyProgress(card);
      }
      if (card.kind === "PR" && card.column === "Executing") {
        this.inprogress.push({
          number: card.number,
          branch: this.deps.branchOf(card.number),
          working: parseProgress(card.progress).state === "working",
        });
      }
      await this.watchAssignees(card);
      if (!(await this.watchColumn(card, migration))) {
        continue;
      }
      currentCards.push(card);
      const columnProgress = this.state.pr(card.number).pendingProgress.exists();
      if (!waiting) {
        await this.applyProgress(card);
      }
      if (
        !waiting &&
        card.autopilotStopped &&
        ["Spec review", "Owner review", "Approved"].includes(card.column)
      ) {
        const next = turnAssignees(
          this.host.filter.people,
          card.repo,
          card.assignees,
          "owner",
          await ownerForTurn(
            this.host.github,
            this.host.filter.people,
            card.repo,
            card.number,
            card.ownerActivity
          )
        );
        await setTurn(this.host.github, card.repo, card.number, card.assignees, next);
        await this.host.board.set({ itemId: card.id, field: "Progress", value: "👤🔍" });
        card.assignees = next;
        card.progress = "👤🔍";
      }
      if (!waiting && card.autopilotStopped) {
        this.state.autopilot(card.number).stop.remove();
      }
      if (!waiting) {
        await this.reconcileTurn(card, pullsOk && !pendingProgress && !columnProgress);
      }
      if (
        card.kind === "ISSUE" &&
        card.state === "OPEN" &&
        card.column !== "Done" &&
        card.estimate === null &&
        !this.deps.marked(this.state.once(`graded-${card.number}`)) &&
        !this.state.legacyBoard(`graded-${card.number}`).exists() &&
        !this.deps.marked(this.state.once(`grade-${card.number}`))
      ) {
        const now = this.host.deps.now();
        const previous = unestimated[card.id];
        const since = typeof previous === "number" && previous <= now ? previous : now;
        nextUnestimated[card.id] = since;
        if (now - since >= GRADE_SETTLE_MS) {
          this.deps.produceOnce(
            `grade-${card.number}`,
            "grade",
            `GRADE #${card.number} (ISSUE): no Estimate yet${this.deps.previewText(card.person, card.title)} ${this.deps.threadUrl(card.repo, card.number, "ISSUE")}`
          );
        }
      }
      if (!waiting && card.column === "Scoping" && card.kind === "ISSUE" && card.state === "OPEN") {
        ready.push(card);
      }
      if (
        !waiting &&
        card.column === "Spec review" &&
        card.kind === "ISSUE" &&
        card.state === "OPEN"
      ) {
        specReview.push(card);
      }
      if (
        !waiting &&
        card.column === "Executing" &&
        card.kind === "ISSUE" &&
        card.state === "OPEN"
      ) {
        approved.push(card);
      }
    }
    await this.clearStaleOwnerMirrors(currentCards);
    this.watchOrchestratorTurns(currentCards);
    this.deps.writeMarker(this.state.unestimated, JSON.stringify(nextUnestimated));
    for (const name of readdirSync(this.dir)) {
      if (name.startsWith("theirs-") && !theirs.has(name)) {
        this.state.once(name).remove();
      }
    }
    await this.watchNext(ready, approved, specReview, legacyScopeCutoff(cards.readme));
    // Last step of the poll: absence counters and pruning move only when the
    // whole board poll succeeded, never after a failed or partial one.
    this.pruneBoardBaselines(present);
  }

  private boardAllowed(): boolean {
    if (!this.boardEnabled) {
      return false;
    }
    const now = this.host.deps.now();
    if (this.host.github.budgetStopped() || now < this.deps.current().nextBoardAt) {
      return false;
    }
    for (const status of Object.values(this.host.github.budget().resources)) {
      if (status.remaining <= this.deps.reserve + 1 && status.reset * 1000 > now) {
        return false;
      }
    }
    return true;
  }

  /**
   * Prune a card baseline (and its `.who` mirror) only after its item has been
   * absent from every successful poll for `BOARD_ABSENT_MS` and from at least
   * `BOARD_ABSENT_POLLS` of them, tracked per item in `board-absences.json` as
   * the first-absent timestamp plus the poll count. A single listing can omit
   * existing items for a while, so an absent-from-one-poll baseline must
   * survive: while it does, a reappearing card with an unchanged column emits
   * nothing. Being the last step of `pollBoard`, this never runs for a failed
   * or partial poll; reappearance resets both the window and the count.
   */
  private pruneBoardBaselines(present: Set<string>): void {
    const absences = object(safeJson(this.deps.readMarker(this.state.absences)));
    const nextAbsences: Record<string, { first: number; count: number }> = {};
    const now = this.host.deps.now();
    const absent = new Set<string>();
    for (const name of readdirSync(this.state.boardDir)) {
      if (
        (!/^PVTI_/.test(name) && !/\.who$/.test(name)) ||
        present.has(name.replace(/\.who$/, ""))
      ) {
        continue;
      }
      absent.add(name.replace(/\.who$/, ""));
    }
    for (const id of absent) {
      const previous = object(absences[id]);
      const recordedFirst = previous.first;
      const recordedCount = count(previous.count);
      const valid =
        typeof recordedFirst === "number" &&
        Number.isFinite(recordedFirst) &&
        recordedFirst <= now &&
        recordedCount !== null;
      const missed = (valid ? recordedCount : 0) + 1;
      const firstAt = valid ? recordedFirst : now;
      if (missed >= BOARD_ABSENT_POLLS && now - firstAt >= BOARD_ABSENT_MS) {
        this.state.card(id).column.remove();
        this.state.card(id).who.remove();
        continue;
      }
      nextAbsences[id] = { first: firstAt, count: missed };
    }
    this.deps.writeMarker(this.state.absences, JSON.stringify(nextAbsences));
  }

  /** A partial relation page cannot prove that the last blocker has closed. */
  private waiting(card: CardInfo): boolean {
    return (
      card.state === "OPEN" &&
      ["Scoping", "Spec review", "Executing", "Approved"].includes(card.column) &&
      ((card.blockerCount ?? 0) > (card.blockedBy?.length ?? 0) ||
        !!card.blockedBy?.some((blocker) => blocker.state === "OPEN"))
    );
  }

  /** Persist dependency transitions across restarts without extra GitHub reads. */
  private watchBlockers(card: CardInfo): void {
    const marker = this.state.card(card.id).blockers;
    const previous = object(safeJson(this.deps.readMarker(marker)));
    const open = (card.blockedBy ?? []).filter((blocker) => blocker.state === "OPEN");
    const incomplete = (card.blockerCount ?? 0) > (card.blockedBy?.length ?? 0);
    const quiet = this.state.quiet.lines();
    const retained = quiet.filter((line) => !line.startsWith(`WAITING #${card.number} on `));
    if (quiet.length !== retained.length) {
      this.state.quiet.write(retained.length ? `${retained.join("\n")}\n` : "");
    }
    if (this.waiting(card)) {
      const known = incomplete ? [...this.deps.list(previous.open), ...open] : open;
      const unique = new Map(
        known.map((blocker) => [`${blocker.repo}#${blocker.number}`, blocker])
      );
      this.deps.writeMarker(marker, JSON.stringify({ waiting: true, open: [...unique.values()] }));
      const refs = open.map((blocker) => `${blocker.repo}#${blocker.number}`);
      if (incomplete) {
        refs.push("additional blockers (incomplete relation page)");
      }
      const line = `WAITING #${card.number} on ${refs.join(", ")}`;
      this.deps.quiet(line);
    } else if (previous.waiting) {
      const closed = this.deps
        .list(previous.open)
        .filter((old) =>
          card.blockedBy?.some(
            (blocker) =>
              blocker.repo === old.repo &&
              blocker.number === old.number &&
              blocker.state === "CLOSED"
          )
        );
      if (card.state === "OPEN" && !incomplete && !open.length && closed.length) {
        this.deps.emit(
          `unblocked-${card.id}@${this.host.deps.now()}`,
          "unblocked",
          `UNBLOCKED #${card.number}: ${closed.map((blocker) => `${blocker.repo}#${blocker.number} closed`).join(", ")} ${this.deps.threadUrl(card.repo, card.number, card.kind)}`
        );
      }
      this.deps.writeMarker(marker, JSON.stringify({ resumed: this.host.deps.now() }));
    }
  }

  /** Backstop unanswered worker protocol at five minutes; other turns settle for thirty. */
  private watchOrchestratorTurns(cards: CardInfo[]): void {
    const previous = object(safeJson(this.deps.readMarker(this.state.orchestratorTurns)));
    const next: Record<string, { since: number; reminded?: number; request?: string }> = {};
    const now = this.host.deps.now();
    for (const card of cards) {
      if (this.waiting(card)) {
        continue;
      }
      const protocol = object(
        safeJson(this.deps.readMarker(this.state.pr(card.number).unhandledWorker))
      );
      const unanswered =
        protocol.tag && !protocol.handled && Number.isFinite(Date.parse(str(protocol.at)));
      const assigned = card.assignees.some(
        (login) =>
          login.toLowerCase() === this.deps.current().me?.toLowerCase() ||
          this.host.filter.people.some(
            (person) =>
              this.host.filter.roleIn(person, card.repo) === "orchestrator" &&
              person.login === login
          )
      );
      if (
        card.state !== "OPEN" ||
        card.column === "Done" ||
        (!hasOrchestratorProgress(card.progress) &&
          !(
            (card.column === "Executing" || card.column === "Spec review" || unanswered) &&
            assigned
          ))
      ) {
        continue;
      }
      const old = object(previous[card.id]);
      const request = unanswered ? str(protocol.at) : undefined;
      const resumed = object(
        safeJson(this.deps.readMarker(this.state.card(card.id).blockers))
      ).resumed;
      const since = Math.max(
        typeof resumed === "number" ? resumed : 0,
        unanswered
          ? Date.parse(str(protocol.at))
          : typeof old.since === "number" && old.since <= now
            ? old.since
            : now
      );
      const reminded =
        old.request === request && typeof old.reminded === "number" ? old.reminded : undefined;
      const turn = {
        since,
        ...(request ? { request } : {}),
        ...(reminded === undefined ? {} : { reminded }),
      };
      if (
        now - since >= (unanswered ? 5 * 60_000 : TURN_WAIT_MS) &&
        (reminded === undefined ||
          now - reminded >=
            (unanswered ? UNHANDLED_TURN_REMINDER_MINUTES : WAITING_TURN_REMINDER_MINUTES) *
              60_000) &&
        this.deps.emit(
          `orchestrator-turn-${card.number}@${since}-${now}`,
          "orchestrator-turn",
          `ORCHESTRATOR TURN #${card.number}: ${unanswered ? `${str(protocol.tag)} unhandled for 5+ min` : `waiting on you for 30+ min (${card.progress})`} ${this.deps.threadUrl(card.repo, card.number, card.kind)}`
        )
      ) {
        turn.reminded = now;
      }
      next[card.id] = turn;
    }
    this.deps.writeMarker(this.state.orchestratorTurns, JSON.stringify(next));
  }

  /** Observe label changes in the same scoped board poll. The orchestrator still
   * makes the engineering decisions; these wake-ups release its owner wait. */
  private async watchAutopilot(cards: CardInfo[]): Promise<void> {
    const own = cards.filter(
      (card) =>
        this.deps.isOwn(card.repo) &&
        this.deps.inScope(card.number) &&
        card.state === "OPEN" &&
        card.person
    );
    const selected = new Set(
      own
        .filter(
          (card) =>
            card.autopilotLabel ||
            this.deps.readMarker(this.state.autopilot(card.number).active) === "on" ||
            this.deps.marked(this.state.autopilot(card.number).stop)
        )
        .map((card) => card.number)
    );
    for (;;) {
      const size = selected.size;
      for (const [pr, issues] of this.deps.current().taskIssues) {
        if (selected.has(pr) || issues.some((number) => selected.has(number))) {
          selected.add(pr);
          issues.forEach((number) => selected.add(number));
        }
      }
      if (size === selected.size) {
        break;
      }
    }
    // The watcher judges whole task groups (#253): a verb write touching any
    // member (a journal operation within the two-minute window, #199) keeps every
    // member of that group unjudged this poll — judging the PR without a
    // just-written member's history would read its valid inherited copy as
    // unauthorized and stop the task. Reads cover every selected card first;
    // only judging and cleaning are guarded.
    const selectedCards = own.filter((card) => selected.has(card.number));
    const reader = new AutopilotReader(this.host.github, this.host.filter, this.host.config);
    const records = await reader.records(selectedCards.map((card) => card.contentId));
    // Judged members always read their full task group (#253): a PR's body names
    // its linked issues, and the owner grant a copy proof cites sits on one of
    // them. Board cards absent from this poll stay unread; their group's copy
    // then judges unknown, never unauthorized, so nothing is removed from
    // incomplete evidence.
    const byNumber = new Map(
      cards.filter((card) => this.deps.isOwn(card.repo)).map((card) => [card.number, card] as const)
    );
    const known = new Set(records.map((record) => String(record.item.id)));
    const missing = new Set<string>();
    for (const { item } of records) {
      if (item.__typename !== "PullRequest") {
        continue;
      }
      for (const number of taskIssueNumbers(String(item.body)) ?? []) {
        const member = byNumber.get(number);
        if (member && !known.has(member.contentId)) {
          missing.add(member.contentId);
        }
      }
    }
    if (missing.size) {
      records.push(...(await reader.records([...missing])));
    }
    const targets = selectedCards.filter((card) =>
      taskGroupNumbers(card.number, records).every(
        (number) => !this.writes.recentlyWrote(card.repo, number)
      )
    );
    let states = autopilotStates(records, this.host.filter, String(this.host.config.repo));
    for (const card of targets) {
      if (!states.get(card.contentId)?.unauthorized) {
        continue;
      }
      await this.host.github.rest(
        `/repos/${this.own}/issues/${card.number}/labels/autopilot`,
        "DELETE"
      );
      await this.host.github.rest(
        `/repos/${this.own}/issues/${card.number}/comments`,
        "POST",
        {
          body: `${heading("AUTOPILOT")}\n\nRemoved an unauthorized autopilot label. Only the pinned owner can grant autopilot; open-task may copy an existing owner grant.`,
        },
        false
      );
      this.deps.emit(
        `autopilot-invalid-${card.number}@${this.host.deps.now()}`,
        "autopilot",
        `AUTOPILOT #${card.number}: unauthorized label removed ${this.deps.threadUrl(card.repo, card.number, card.kind)}`
      );
      // This watcher's cleanup is not a revocation: drop the label from the read
      // records and recompute, so the affected task keeps its other members' active
      // delegation in this same poll instead of a poll of false "stopped" (#249).
      for (const record of records) {
        if (String(record.item.id) !== card.contentId) {
          continue;
        }
        const labels = object(record.item.labels);
        if (Array.isArray(labels.nodes)) {
          labels.nodes = (labels.nodes as ObjectData[]).filter(
            (label) => label.name !== "autopilot"
          );
        }
      }
      states = autopilotStates(records, this.host.filter, String(this.host.config.repo));
    }
    this.autopilot = states;
    for (const card of targets) {
      const state = this.autopilot.get(card.contentId);
      if (!state) {
        continue;
      }
      const name = `autopilot-${card.number}`;
      // A copy whose source grant is missing from the read set reads unknown
      // (#253): the card is skipped — markers, steps and stop reports stay
      // untouched, since unknown history never removes a label or stops a task.
      // An already recorded stop from earlier polls keeps being reported.
      if (state.unknown) {
        card.autopilotStopped = this.deps.marked(this.state.autopilot(card.number).stop);
        continue;
      }
      const old = this.deps.readMarker(this.state.autopilot(card.number).active);
      const value = state.active ? "on" : "off";
      if (old === "on" && !state.active) {
        this.deps.mark(this.state.autopilot(card.number).stop);
      }
      if (state.active) {
        this.state.autopilot(card.number).stop.remove();
      }
      card.autopilotStopped = this.deps.marked(this.state.autopilot(card.number).stop);
      const step = `${value}:${card.column}:${state.grant ?? ""}`;
      if (
        this.deps.readMarker(this.state.autopilot(card.number).step) !== step &&
        (state.active || old === "on")
      ) {
        this.deps.emit(
          `${name}@${key(step)}`,
          "autopilot",
          `AUTOPILOT #${card.number}: ${state.active ? "owner-delegated" : "stopped; owner's control at the current step"} (${card.column}) ${this.deps.threadUrl(card.repo, card.number, card.kind)}`
        );
        this.nextSignature = "";
      }
      this.deps.writeMarker(this.state.autopilot(card.number).active, value);
      this.deps.writeMarker(this.state.autopilot(card.number).step, step);
    }
  }

  private async readBoard(
    owner: string,
    number: number
  ): Promise<{ readme: string; list: CardInfo[] }> {
    try {
      const result = await this.boardReader.read(owner, number, {
        issue: this.owners.size > 1 ? ownerActivityFields(false) : "",
        pr: this.owners.size > 1 ? ownerActivityFields(true) : "",
      });
      return {
        readme: result.readme,
        list: result.nodes.map((node) => this.decodeCard(node)).filter((card) => card !== null),
      };
    } catch (error) {
      if (error instanceof GraphQLResponseError) {
        // An invalid query once made a watcher blind for hours: report at once.
        this.deps.produceOnce(
          `graphql-error-${key(error.errors.join(";"))}`,
          "query-error",
          "QUERY ERROR: GraphQL rejected the board query; details on stderr"
        );
      }
      throw error;
    } finally {
      this.deps.recordPoll(this.boardReader.cost);
    }
  }

  private decodeCard(node: ObjectData): CardInfo | null {
    const content = object(node.content);
    const number = count(content.number);
    const scope = repoOf(content);
    const kind =
      content.__typename === "PullRequest" ? "PR" : content.__typename === "Issue" ? "ISSUE" : null;
    if (number === null || kind === null || !scope.repo) {
      return null;
    }
    const estimate = object(node.estimate).number;
    return {
      autopilotLabel:
        this.deps.list(object(content.labels).nodes).some((label) => label.name === "autopilot") ||
        object(object(content.labels).pageInfo).hasNextPage === true,
      ownerReview: this.deps
        .list(object(content.reviews).nodes)
        .filter(
          (review) =>
            this.host.filter.identity(review.author)?.role === "owner" &&
            object(review.commit).oid === content.headRefOid &&
            ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"].includes(str(review.state))
        )
        .map((review) => str(review.id))
        .filter(Boolean)
        .at(-1),
      id: str(node.id),
      ownerActivity: this.owners.size > 1 ? object(content.ownerActivity) : undefined,
      contentId: str(content.id),
      repo: scope.repo,
      number,
      kind,
      state: str(content.state),
      stateReason: str(content.stateReason),
      subIssueIds:
        object(object(content.subIssues).pageInfo).hasNextPage === false
          ? this.deps.list(object(content.subIssues).nodes).map((node) => str(node.id))
          : undefined,
      blockedBy: this.deps.list(object(content.blockedBy).nodes).map((blocker) => ({
        number: count(blocker.number) ?? 0,
        repo: str(object(blocker.repository).nameWithOwner),
        state: str(blocker.state),
      })),
      blockerCount: count(object(content.blockedBy).totalCount) ?? 0,
      closedBy: str(object(this.deps.list(object(content.closure).nodes).at(-1)?.actor).login),
      closedAt: str(content.closedAt),
      column: str(object(node.status).name),
      columnAt: str(object(node.status).updatedAt),
      assignees: this.deps.list(object(content.assignees).nodes).map((entry) => str(entry.login)),
      estimate: typeof estimate === "number" && Number.isFinite(estimate) ? estimate : null,
      progress: str(object(node.progress).text),
      title: str(content.title),
      person: this.host.filter.identity(content.author),
    };
  }

  private async watchAssignees(card: CardInfo): Promise<void> {
    const marker = this.state.card(card.id).who;
    const next = card.assignees.join(",");
    const old = marker.lines().join(",");
    if (old === next) {
      return;
    }
    const remember = () => marker.write(`${next}\n`);
    const turn = `.turn-${slug(card.repo)}-${card.number}`;
    const turns = object(safeJson(this.deps.readMarker(this.state.legacyTurns)));
    const stamped = turns[turn] === true;
    if (stamped) {
      delete turns[turn];
      this.deps.writeMarker(this.state.legacyTurns, JSON.stringify(turns));
    }
    const hadOwner = old
      .split(",")
      .filter(Boolean)
      .some((login) => this.owners.has(login.toLowerCase()));
    const hasOwner = card.assignees.some((login) => this.owners.has(login.toLowerCase()));
    if (hasOwner) {
      remember();
      return;
    }
    if (hadOwner && !this.deps.current().firstRun && stamped) {
      remember();
      return;
    }
    if (hadOwner && !this.deps.current().firstRun) {
      const event = await this.deps.assignmentEvent(
        card.repo,
        card.number,
        "UnassignedEvent",
        old.split(",").filter((login) => this.owners.has(login.toLowerCase()))
      );
      if (this.deps.ownAssignment(event, card.repo, card.number, "unassigned")) {
        remember();
        return;
      }
      if (
        this.host.filter.identity(event.actor)?.role === "owner" &&
        object(event.actor).databaseId === object(event.assignee).databaseId &&
        ["owner-review", "owner-question"].includes(parseProgress(card.progress).state ?? "")
      ) {
        this.deps.queueProgress(card.number, { state: "verifying", releaseOwner: true });
      }
      this.deps.emit(
        `owner-done-${card.id}@${key(`${old}>${next}`)}`,
        "owner-done",
        `OWNER DONE #${card.number} (${card.kind})${this.deps.siblingActor(event)}${this.deps.previewText(card.person, card.title)} ${this.deps.threadUrl(card.repo, card.number, card.kind)}`
      );
    }
    remember();
  }

  private async watchColumn(card: CardInfo, migration: boolean): Promise<boolean> {
    const marker = this.state.card(card.id).column;
    const old = marker.lines().join("");
    if (old === card.column) {
      return true;
    }
    // An empty Status read on a card whose baseline holds a column is a
    // transient read (GitHub mid-update), not a move: emit nothing, keep the
    // baseline and treat this poll's read as unknown (#216).
    if (!card.column && old) {
      return false;
    }
    const remember = () => marker.write(`${card.column}\n`);
    const progress = () => {
      if (this.waiting(card)) {
        return;
      }
      if (card.column === "Approved") {
        this.deps.queueProgress(card.number, { state: "verifying" });
      }
      if (card.column === "Done" || card.state === "CLOSED" || card.state === "MERGED") {
        this.deps.queueProgress(card.number, { state: null, round: null, ci: "ok" });
      }
    };
    if (this.deps.current().firstRun || migration) {
      progress();
      remember();
      return true;
    }
    const queueMove = Boolean(old) && ["Backlog", "Scoping"].includes(card.column);
    const lifecycleMove =
      Boolean(old) && ["Scoping", "Spec review", "Executing", "Approved"].includes(card.column);
    const { current, events } = await this.currentBoard(card, queueMove || lifecycleMove);
    const status = object(current.status);
    // An archived/deleted card is no longer evidence of a current move either.
    if (str(status.name) !== card.column) {
      this.host.deps.report(
        `watcher: discarded stale BOARD #${card.number}: ${old} → ${card.column}; current ${str(status.name) || "absent"}`
      );
      // Preserve the previous baseline. A later fresh poll must still report a
      // genuine move to a third value instead of silently adopting it here.
      return false;
    }
    card.columnAt = str(status.updatedAt);
    progress();
    if (this.ownBoardMove(card)) {
      this.cycleOwnMoves.add(card.id);
      remember();
      return true;
    }
    if (lifecycleMove) {
      const moves = events.filter(
        (event) =>
          event.__typename === "ProjectV2ItemStatusChangedEvent" &&
          object(event.project).number === Number(object(this.host.config.board).number)
      );
      const latest = Math.max(...moves.map((event) => Date.parse(str(event.createdAt))));
      const matched = moves.filter((event) => Date.parse(str(event.createdAt)) === latest);
      const ownerMove =
        latest === Date.parse(card.columnAt) &&
        matched.length > 0 &&
        matched.every(
          (event) =>
            this.host.filter.identity(event.actor)?.role === "owner" &&
            event.status === card.column &&
            event.previousStatus === old
        );
      if (
        !this.waiting(card) &&
        ownerMove &&
        (!queueMove || this.queueMoveCancelsTurn(card, current, events)) &&
        ((card.kind === "ISSUE" && ["Scoping", "Spec review", "Executing"].includes(card.column)) ||
          (card.kind === "PR" &&
            ((old === "Owner review" && card.column === "Executing") ||
              card.column === "Approved")))
      ) {
        this.deps.queueProgress(card.number, {
          state: card.kind === "ISSUE" && card.column === "Executing" ? null : "verifying",
          round: null,
          ci: "ok",
          releaseOwner: true,
        });
      }
    }
    // Only an authenticated person's newer move cancels a turn, not a gateway
    // move or a question asked after the move but before this poll observed it.
    if (!this.waiting(card) && queueMove && this.queueMoveCancelsTurn(card, current, events)) {
      const next = turnAssignees(this.host.filter.people, card.repo, card.assignees, null);
      await setTurn(this.host.github, card.repo, card.number, card.assignees, next);
      card.assignees = next;
      if (card.progress) {
        await this.host.board.set({ itemId: card.id, field: "Progress", value: null });
        card.progress = "";
      }
    }
    const url = this.deps.threadUrl(card.repo, card.number, card.kind);
    const preview = this.deps.previewText(card.person, card.title);
    if (!old) {
      if (card.column === "Backlog" || card.column === "Executing") {
        this.deps.quiet(`NOTE #${card.number} (${card.kind}): new card → ${card.column} ${url}`);
      } else {
        this.deps.emit(
          `board-${card.id}@${key(`new>${card.column}`)}`,
          "board",
          `BOARD #${card.number} (${card.kind}): new card → ${card.column}${preview} ${url}`
        );
      }
      remember();
      return true;
    }
    if (card.column === "Executing" && !(card.kind === "PR" && old === "Owner review")) {
      this.deps.quiet(`NOTE #${card.number} (${card.kind}): ${old} → ${card.column} ${url}`);
      remember();
      return true;
    }
    if (card.kind === "PR" && card.column === "Done") {
      remember();
      return true;
    }
    // Scoping moves and delivery-review bounces wake the orchestrator too.
    this.deps.emit(
      `board-${card.id}@${key(`${old}>${card.column}`)}`,
      "board",
      `BOARD #${card.number} (${card.kind}): ${old} → ${card.column}${preview} ${url}`
    );
    remember();
    return true;
  }

  private async applyClosedCard(card: CardInfo): Promise<void> {
    // Clear the turn before moving to Done; a failed write remains retryable.
    const next = turnAssignees(this.host.filter.people, card.repo, card.assignees, null);
    if (next.join(",") !== card.assignees.join(",")) {
      await setTurn(this.host.github, card.repo, card.number, card.assignees, next);
      card.assignees = next;
    }
    this.state.pr(card.number).pendingProgress.remove();
    if (card.column !== "Done") {
      await this.host.board.set({
        itemId: card.id,
        field: "Status",
        value: "Done",
        progress: null,
      });
      card.column = "Done";
      card.progress = "";
    } else if (card.progress) {
      await this.host.board.set({ itemId: card.id, field: "Progress", value: null });
      card.progress = "";
    }
    this.state.card(card.id).column.write("Done\n");
    if (card.kind === "ISSUE") {
      await this.notifyClosedIssue(card);
    }
  }

  private async notifyClosedIssue(card: CardInfo): Promise<void> {
    const closure = key(`${card.repo}#${card.number}@${card.closedAt}`);
    const observed = `closure-observed-${closure}`;
    if (this.deps.marked(this.state.once(observed))) {
      return;
    }
    const reason = card.stateReason === "NOT_PLANNED" ? "not planned" : "completed";
    const openTasks = [...this.deps.current().taskIssues]
      .filter(([, issues]) => issues.includes(card.number))
      .map(([pr]) => `#${pr}`);
    const taskNote = openTasks.length ? `; open task PR ${openTasks.join(", ")} remains` : "";
    if (
      reason === "not planned" &&
      card.person?.role === "orchestrator" &&
      card.person.login.toLowerCase() !== this.deps.current().me?.toLowerCase() &&
      card.person.repos?.some((repo) => repo.toLowerCase() !== card.repo.toLowerCase()) &&
      !card.person.repos.some((repo) => repo.toLowerCase() === card.repo.toLowerCase())
    ) {
      this.deps.produceOnce(
        `not-planned-${closure}`,
        "not-planned",
        `NOT PLANNED #${card.number} (requested by ${card.person.login}): tell the requester${taskNote} ${this.deps.threadUrl(card.repo, card.number, card.kind)}`
      );
    } else if (
      card.closedBy.toLowerCase() !== this.deps.current().me?.toLowerCase() &&
      !this.writes.matches(
        { kind: "closed", repo: card.repo, number: card.number },
        card.closedAt
      ) &&
      !(await this.issueClosedByMerge(card))
    ) {
      this.deps.produceOnce(
        `closed-${closure}`,
        "closed",
        `CLOSED #${card.number} (${reason}) by ${/^[\w-]+$/.test(card.closedBy) ? card.closedBy : "unknown"}${taskNote} ${this.deps.threadUrl(card.repo, card.number, card.kind)}`
      );
    }
    this.deps.mark(this.state.once(observed));
  }

  private async issueClosedByMerge(card: CardInfo): Promise<boolean> {
    const [owner, name] = card.repo.split("/");
    for await (const connection of pages(
      async (cursor) => {
        const data = object(
          await this.host.github.graphql(
            `query WatchIssueClosers($owner: String!, $name: String!, $number: Int!, $cursor: String) { repository(owner: $owner, name: $name) { issue(number: $number) { closedByPullRequestsReferences(first: 100, after: $cursor) { nodes { state } pageInfo { hasNextPage endCursor } } } } }`,
            { owner, name, number: card.number, cursor }
          )
        );
        return object(object(data.repository).issue).closedByPullRequestsReferences;
      },
      {
        connectionError: "Missing issue closing references",
        cursorError: "Invalid issue closing references cursor",
        limit: PAGE_LIMIT,
        limitError: "Issue closing references pagination limit reached",
      }
    )) {
      if (this.deps.list(connection.nodes).some((pr) => pr.state === "MERGED")) {
        return true;
      }
    }
    return false;
  }

  /** Extend the existing changed-card re-read, paginating only queue-move evidence. */
  private async currentBoard(
    card: CardInfo,
    turn: boolean
  ): Promise<{ current: ObjectData; events: ObjectData[] }> {
    const timeline = `timelineItems(first: 100, after: $cursor, itemTypes: [PROJECT_V2_ITEM_STATUS_CHANGED_EVENT, ASSIGNED_EVENT]) { nodes { __typename ... on ProjectV2ItemStatusChangedEvent { actor { ${actorFields} } status previousStatus createdAt project { number } } ... on AssignedEvent { createdAt assignee { ... on User { login } ... on Bot { login } } } } pageInfo { hasNextPage endCursor } }`;
    const events: ObjectData[] = [];
    let current: ObjectData = {};
    for await (const connection of pages(
      async (cursor) => {
        const result = object(
          await this.host.github.graphql(
            `query WatchBoardCurrent($id: ID!, $turn: Boolean!, $cursor: String) { node(id: $id) { ... on ProjectV2Item { status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name updatedAt } } progress: fieldValueByName(name: "Progress") @include(if: $turn) { ... on ProjectV2ItemFieldTextValue { text updatedAt } } content @include(if: $turn) { ... on Issue { ${timeline} } ... on PullRequest { ${timeline} } } } } }`,
            { id: card.id, turn, cursor }
          )
        );
        if (
          !Object.hasOwn(result, "node") ||
          (result.node !== null && !Object.hasOwn(object(result.node), "status"))
        ) {
          throw new Error("Missing current board value");
        }
        return result;
      },
      {
        connectionError: "Missing queue-move evidence",
        cursorError: "Invalid queue-move pagination cursor",
        limit: PAGE_LIMIT,
        limitError: "Queue-move pagination limit reached",
        stop: (result) => {
          current = object(result.node);
          return !turn || result.node === null;
        },
        connection: () => {
          const connection = object(object(current.content).timelineItems);
          if (!Array.isArray(connection.nodes) || !Object.hasOwn(current, "progress")) {
            throw new Error("Missing queue-move evidence");
          }
          return connection;
        },
      }
    )) {
      events.push(...this.deps.list(connection.nodes));
    }
    return { current, events };
  }

  private queueMoveCancelsTurn(card: CardInfo, current: ObjectData, events: ObjectData[]): boolean {
    const moves = events.filter(
      (event) =>
        event.__typename === "ProjectV2ItemStatusChangedEvent" &&
        object(event.project).number === Number(object(this.host.config.board).number)
    );
    const time = (event: ObjectData) => Date.parse(str(event.createdAt));
    if (moves.some((event) => !Number.isFinite(time(event)))) {
      return false;
    }
    const latest = Math.max(...moves.map(time));
    const move = moves.filter((event) => time(event) === latest);
    if (
      !move.length ||
      latest !== Date.parse(card.columnAt) ||
      move.some((event) => {
        const person = this.host.filter.identity(event.actor);
        // The role is per repository (#186): a peer orchestrator's move is a collaborator's.
        const authoritative =
          !!person &&
          ["owner", "collaborator"].includes(this.host.filter.roleIn(person, card.repo));
        return (
          !authoritative ||
          person.type !== "User" ||
          event.status !== card.column ||
          !event.previousStatus ||
          event.previousStatus === event.status
        );
      })
    ) {
      return false;
    }
    const progress = object(current.progress);
    // Use the fresh value, never restore a listing's older question during reconciliation.
    card.progress = str(progress.text);
    if (current.progress !== null && !(Date.parse(str(progress.updatedAt)) < latest)) {
      return false;
    }
    return !events.some(
      (event) =>
        event.__typename === "AssignedEvent" &&
        this.host.filter.people.some(
          (person) =>
            (person.role === "owner" ||
              this.host.filter.roleIn(person, card.repo) === "orchestrator") &&
            person.login.toLowerCase() === str(object(event.assignee).login).toLowerCase()
        ) &&
        !(time(event) < latest)
    );
  }

  private ownBoardMove(card: CardInfo): boolean {
    return this.writes.matches(
      {
        kind: "board",
        repo: card.repo,
        number: card.number,
        itemId: card.id,
        field: "Status",
        value: card.column || null,
      },
      card.columnAt || (card.column ? "" : new Date(this.host.deps.now()).toISOString())
    );
  }

  private async watchForeignAssignment(card: CardInfo): Promise<boolean> {
    if (
      !card.assignees.some(
        (login) => login.toLowerCase() === (this.deps.current().me ?? "").toLowerCase()
      )
    ) {
      return false;
    }
    if (this.deps.muted(card.repo, card.number)) {
      return false;
    }
    const marker = `theirs-${slug(card.repo)}-${card.number}`;
    if (this.deps.marked(this.state.once(marker))) {
      return true;
    }
    if (!this.deps.current().firstRun) {
      const event = await this.deps.assignmentEvent(card.repo, card.number, "AssignedEvent", [
        this.deps.current().me ?? "",
      ]);
      if (this.deps.ownAssignment(event, card.repo, card.number, "assigned")) {
        this.deps.mark(this.state.once(marker));
        return true;
      }
      this.deps.produceOnce(
        marker,
        "assigned",
        `ASSIGNED ${card.repo}#${card.number} (${card.kind})${this.deps.siblingActor(event)}${this.deps.previewText(card.person, card.title)} ${this.deps.threadUrl(card.repo, card.number, card.kind)}`
      );
    } else {
      this.deps.mark(this.state.once(marker));
    }
    return true;
  }

  private async applyProgress(card: CardInfo): Promise<void> {
    const marker = this.state.pr(card.number).pendingProgress;
    if (!marker.exists()) {
      return;
    }
    const pending = marker.readRequired();
    const current = parseProgress(card.progress);
    const ownerPaused =
      card.column === "Executing" &&
      ["owner-review", "owner-question"].includes(current.state ?? "");
    const only = Array.isArray(pending.if) ? pending.if.map(str) : undefined;
    const stateAllowed =
      mayReplace(current.state, pending.state === null ? null : str(pending.state), only) &&
      (!ownerPaused ||
        pending.releaseOwner === true ||
        ["owner-review", "owner-question"].includes(str(pending.state)));
    const state =
      pending.state === undefined || !stateAllowed
        ? current.state
        : pending.state === null
          ? null
          : str(pending.state);
    const round =
      pending.round === undefined
        ? current.round
        : pending.round === null
          ? null
          : count(pending.round);
    const red = pending.ci === "red" ? true : pending.ci === "ok" ? false : current.red;
    const text = renderProgress({ state, round, red });
    // Whether this cycle already wrote Progress/Status: its own order hook already
    // positioned an Executing card, so an assignee release must not reorder again.
    let wroteBoard = false;
    try {
      if (
        pending.status !== undefined &&
        str(pending.status) !== card.column &&
        (!ownerPaused || pending.releaseOwner === true)
      ) {
        await this.host.board.set({
          itemId: card.id,
          field: "Status",
          value: str(pending.status),
          progress: text || null,
        });
        card.column = str(pending.status);
        this.state.card(card.id).column.write(`${card.column}\n`);
        wroteBoard = true;
      } else if (text !== card.progress) {
        await this.host.board.set({ itemId: card.id, field: "Progress", value: text || null });
        wroteBoard = true;
      }
      card.progress = text;
      if (pending.releaseOwner === true && state === null) {
        const next = turnAssignees(this.host.filter.people, card.repo, card.assignees, null);
        const changed = !sameAssignees(card.assignees, next);
        await setTurn(this.host.github, card.repo, card.number, card.assignees, next);
        card.assignees = next;
        // An Executing handback is activity too, unless the Status/Progress write
        // above already ordered this card to the top this cycle (best effort).
        if (changed && card.column === "Executing" && !wroteBoard) {
          await this.host.board.moveToTop(card.id);
        }
      }
      marker.remove();
    } catch (error) {
      this.host.deps.report(
        `watcher: Progress update failed for #${card.number}: ${(error as Error).message}`
      );
    }
  }

  private async reconcileTurn(card: CardInfo, report = true): Promise<void> {
    const state = parseProgress(card.progress).state;
    const linkedIssue =
      this.deps.isOwn(card.repo) &&
      card.kind === "ISSUE" &&
      !card.scopePending &&
      ([...this.deps.current().taskIssues.values()].some((issues) =>
        issues.includes(card.number)
      ) ||
        this.deps.current().pendingMergedIssues.has(card.number));
    const role = reconciledTurn(state);
    const next =
      role === undefined
        ? undefined
        : turnAssignees(
            this.host.filter.people,
            card.repo,
            card.assignees,
            role,
            role === "owner"
              ? await ownerForTurn(
                  this.host.github,
                  this.host.filter.people,
                  card.repo,
                  card.number,
                  card.ownerActivity
                )
              : undefined
          );
    const mismatch = next && [...next].sort().join(",") !== [...card.assignees].sort().join(",");
    if (
      report &&
      !linkedIssue &&
      // In flight, keep quiet (issue #199): the card carries a verb operation record
      // or a recent handoff Status move, both within the two-minute window, so a
      // poll between the verb's own writes never reports its handoff.
      !this.writes.recentlyWrote(card.repo, card.number) &&
      ((["Spec review", "Owner review"].includes(card.column) && card.assignees.length !== 1) ||
        mismatch)
    ) {
      this.deps.produceOnce(
        `turn-${card.id}@${key(`${card.column}:${card.progress}:${card.assignees.join(",")}`)}`,
        "board-violation",
        `BOARD VIOLATION #${card.number}: ${["Spec review", "Owner review"].includes(card.column) && !card.assignees.length ? `${card.column} with no assignee` : "Progress and assignee mismatch"} ${this.deps.threadUrl(card.repo, card.number, card.kind)}`
      );
    }
    if (next && mismatch) {
      await setTurn(this.host.github, card.repo, card.number, card.assignees, next);
      card.assignees = next;
      // A reconciled Executing turn is an assignee change: activity moves to the top.
      if (card.column === "Executing") {
        await this.host.board.moveToTop(card.id);
      }
    }
  }

  private async clearStaleOwnerMirrors(cards: CardInfo[]): Promise<void> {
    const linkedIssues = new Set<number>();
    for (const [pr, issues] of this.deps.current().taskIssues) {
      if (!this.deps.inScope(pr)) {
        continue;
      }
      const task = cards.find(
        (card) => this.deps.isOwn(card.repo) && card.number === pr && card.kind === "PR"
      );
      if (!task) {
        continue;
      }
      for (const number of issues) {
        linkedIssues.add(number);
      }
    }
    for (const number of linkedIssues) {
      const issue = cards.find(
        (card) => this.deps.isOwn(card.repo) && card.number === number && card.kind === "ISSUE"
      );
      if (
        !issue ||
        !this.deps.inScope(number) ||
        issue.scopePending ||
        issue.column === "Executing" ||
        this.waiting(issue)
      ) {
        continue;
      }
      const mirrored = ["owner-review", "owner-question"].includes(
        parseProgress(issue.progress).state ?? ""
      );
      const ownerAssigned = this.host.filter.people.some(
        (person) =>
          person.role === "owner" &&
          issue.assignees.some((login) => login.toLowerCase() === person.login.toLowerCase())
      );
      if (!ownerAssigned && !mirrored) {
        continue;
      }
      // Retain the owner-state marker until assignment succeeds, so a failed
      // clear is discoverable and retried on the next board poll.
      const next = turnAssignees(this.host.filter.people, issue.repo, issue.assignees, null);
      await setTurn(this.host.github, issue.repo, issue.number, issue.assignees, next);
      issue.assignees = next;
      if (mirrored) {
        await this.host.board.set({ itemId: issue.id, field: "Progress", value: null });
        issue.progress = "";
      }
    }
  }

  private held(): boolean {
    const path = this.state.holdStartable.path;
    if (!existsSync(path)) {
      return false;
    }
    try {
      return this.host.deps.now() - statSync(path).mtimeMs < HOLD_MAX_AGE_MS;
    } catch (error) {
      this.host.deps.report(`watcher: hold file unreadable: ${(error as Error).message}`);
      return false;
    }
  }

  /** A card whose turn is with the owner: owner-assigned or carrying an owner
   * Progress state (`👤…`). NEXT never names such a Scoping card until the owner
   * hands the turn back (#320): retiring another card only brings it to the top
   * of the queue, which still leaves the move to the owner. */
  private ownerTurn(card: CardInfo): boolean {
    return (
      card.assignees.some((login) => this.owners.has(login.toLowerCase())) ||
      reconciledTurn(parseProgress(card.progress).state) === "owner"
    );
  }

  private async watchNext(
    ready: CardInfo[],
    approved: CardInfo[],
    specReview: CardInfo[],
    legacyBefore: number
  ): Promise<void> {
    if (this.held()) {
      return;
    }
    const signature = `${ready.map((card) => card.number).join(",")}|${approved
      .map((card) => card.number)
      .join(",")}|${specReview.map((card) => card.number).join(",")}`;
    const recheck = this.deps.marked(this.state.recheckNext);
    if (
      signature === this.nextSignature &&
      !recheck &&
      this.host.deps.now() - this.nextAt < NEXT_RECHECK_MS
    ) {
      return;
    }
    this.nextSignature = signature;
    this.nextAt = this.host.deps.now();
    if (recheck) {
      this.state.recheckNext.remove();
    }
    // Select the first Scoping card whose turn is the orchestrator's; cards
    // waiting on the owner stay unselected (#320) and rejoin the queue when the
    // owner hands the turn back.
    const selected = ready.find((card) => !this.ownerTurn(card));
    const next = selected
      ? { number: selected.number, kind: selected.kind, repo: selected.repo }
      : null;
    const candidates = approved.filter((card) => !this.launchedIssues.has(card.number));
    const scopes = await new ScopeReader(
      this.host.github,
      this.host.filter,
      this.host.config,
      legacyBefore,
      this.autopilot
    ).read([...candidates, ...specReview].map((card) => card.contentId));
    const launch = await this.firstUnblocked(
      candidates.filter((card) => scopes.get(card.contentId)?.approved === true)
    );
    const scope = specReview.find((card) => !scopes.get(card.contentId)?.reviewPending);
    this.recordStartable(
      "scope",
      scope ? { number: scope.number, kind: scope.kind, repo: scope.repo } : null,
      scope ? this.cycleOwnMoves.has(scope.id) : false
    );
    this.recordStartable(
      "next",
      next,
      ready.some((card) => card.number === next?.number && this.cycleOwnMoves.has(card.id))
    );
    this.recordStartable(
      "launch",
      launch,
      approved.some((card) => card.number === launch?.number && this.cycleOwnMoves.has(card.id))
    );
  }

  private recordStartable(
    name: "scope" | "next" | "launch",
    value: StartableValue | null,
    ownMove: boolean
  ): void {
    const marker = this.state[name];
    const stored = value ? JSON.stringify(value) : "";
    if (marker.lines().join("") === stored) {
      return;
    }
    if (!this.deps.current().firstRun && value && !ownMove) {
      const line =
        name === "next"
          ? `NEXT #${value.number} (${value.kind})`
          : name === "scope"
            ? `SCOPE #${value.number}: agreed conclusions; rewrite body, revise Estimate and request scope review`
            : `LAUNCH #${value.number} (${value.kind}): approved and nothing blocks it`;
      this.deps.emit(
        `${name}-${key(stored)}`,
        name,
        `${line}${this.deps.previewFromSubject(value.repo, value.number)} ${this.deps.threadUrl(value.repo, value.number, value.kind)}`
      );
    }
    marker.write(`${stored}\n`);
  }

  private async firstUnblocked(cards: CardInfo[]): Promise<StartableValue | null> {
    for (const card of cards) {
      if (card.kind === "ISSUE") {
        const blockers = await this.deps.restPages(
          (page) =>
            `/repos/${card.repo}/issues/${card.number}/dependencies/blocked_by?per_page=100&page=${page}`,
          (data) => this.deps.list(data)
        );
        if (blockers.some((blocker) => str(blocker.state) === "open")) {
          continue;
        }
      }
      return { number: card.number, kind: card.kind, repo: card.repo };
    }
    return null;
  }

  private get owners(): Set<string> {
    return new Set(
      this.host.filter.people
        .filter((person) => person.role === "owner")
        .map((person) => person.login.toLowerCase())
    );
  }
}
