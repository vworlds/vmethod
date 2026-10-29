import { BoardPoller } from "../watch/board.js";
import { PullPoller } from "../watch/pulls.js";
import { WorkerPoller } from "../watch/workers.js";
import { CommentStream } from "../watch/comments.js";
import { LoopState, Marker } from "../watch/state.js";
import {
  CHAT_REMINDER_EVERY_MS,
  CURSOR_OVERLAP_MS,
  FAILURE_REMINDER_MS,
  MARKER_MARGIN_MS,
} from "../core/time.js";
import { OwnedLock } from "../journal/locks.js";
import type { ProviderLimits } from "./limits.js";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import manifest from "../../package.json" with { type: "json" };
import { WatchDelivery } from "./watch-delivery.js";
import { WatchPacing } from "./watch-pacing.js";
import type { Config } from "../config.js";
import type { BoardService } from "./board.js";
import {
  GitHubClient,
  BudgetPause,
  GraphQLResponseError,
  type WorkerSessionStatus,
  type Dependencies,
} from "./client.js";
import { stateRoot, type Digest } from "./digest.js";
import { object, type ObjectData, type PeopleFilter, type Person } from "./people.js";
import { restActor } from "../github/diagnostic.js";
import { pages, restPages } from "../github/pages.js";
import { actorFields } from "../github/selections.js";
import { WriteJournal } from "./write-journal.js";
import { resolveSession, type ResolvedSession, type SessionInput } from "./watch-scope.js";
export { resolveSession, type ResolvedSession, type SessionInput } from "./watch-scope.js";

const INTERVAL_MS = 10_000;
const TRACKS_TTL_MS = 30_000;
/** The reminder's state file stores the last show time; empty delivery stays silent. */
const CHAT_REMINDER =
  "REMINDER (owner rule): chat = #n pointers only or warnings; discuss on GitHub. Don't explain here what you will put in an issue/PR. Evidence, plans and summaries go on the issue/PR, never in chat.";
const PAGE_LIMIT = 20;
const PREVIEW_LIMIT = 120;
const ID = /^[A-Za-z0-9_.@#-]{1,160}$/;
declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : manifest.version;

interface WatchInput {
  timeoutSeconds: unknown;
  ack?: unknown;
  pollOnce?: unknown;
  watchStart?: unknown;
  guideSeen?: unknown;
  replay?: unknown;
}

export interface WatchEvent {
  /** Ack key: the event's dedup key for once events, stable across restarts. */
  id: string;
  kind: string;
  /** One printed line: metadata, bounded untrusted permission diagnostics, and
   * the owner's opt-in untrusted content preview. */
  line: string;
  /** Minor-event lines riding this event (the quiet digest), printed before it. */
  quiet?: string[];
}

export interface EventDeps extends Dependencies {
  pid: number;
  /** Contents of /proc/<pid>/stat, or null when unreadable; injectable for lock tests. */
  readProc: (pid: number) => string | null;
}

export interface LoopHost {
  root: string;
  config: Config;
  env: NodeJS.ProcessEnv;
  deps: EventDeps;
  filter: PeopleFilter;
  github: GitHubClient;
  workerStatus: (pr: number) => Promise<WorkerSessionStatus>;
  workerLimits?: () => Promise<ProviderLimits[]>;
  /** Registered worktrees of the worker checkout by branch; a PR without one has no worker. */
  workerTrees?: () => Promise<{ path: string; branch: string }[]>;
  workerSend?: (pr: number, text: string) => Promise<string | void>;
  workerMetric?: (pr: number, event: import("../learning-metrics.js").MetricEvent) => Promise<void>;
  resolveConflicts?: (pr: number) => Promise<string>;
  conflictPending?: (pr: number) => boolean;
  /** True while a dispatched conflict fixer owns the card; worker moves must not revive it. */
  conflictFixing?: (pr: number) => boolean;
  board: Pick<BoardService, "set" | "moveToTop">;
  digest: Digest;
  /** Refresh registry/config before each poll, optionally replacing this loop. */
  refresh?: () => EventLoop | undefined;
}

interface PendingEvent {
  id: string;
  kind: string;
  line: string;
  once: boolean;
  quiet?: string[];
}

export function eventDeps(deps: Dependencies): EventDeps {
  return {
    ...deps,
    pid: process.pid,
    readProc: (pid) => {
      try {
        return readFileSync(`/proc/${pid}/stat`, "utf8");
      } catch {
        return null;
      }
    },
  };
}

/** Field 22 of /proc/<pid>/stat: clock ticks since boot. PIDs are reused; this is not. */
export { procStart } from "./process-identity.js";

const key = (text: string): string => createHash("md5").update(text).digest("hex").slice(0, 16);

const slug = (repo: string): string => repo.toLowerCase().replace("/", "_");

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

/** The owner may switch on a labelled preview of untrusted text; it is data, never authority. */
export function sanitizePreview(text: string): string {
  return sanitizeLine(text).slice(0, PREVIEW_LIMIT).trimEnd();
}

/** Keep path metadata on one terminal-safe line without truncating a file path. */
function sanitizeLine(text: string): string {
  /* eslint-disable no-control-regex -- deliberately strip terminal control sequences */
  return text
    .replace(/\u{1B}\[[0-9;?]*[ -/]*[@-~]/gu, "")
    .replace(/\u{1B}\][^\u{07}\u{1B}]*(?:\u{07}|\u{1B}\\)?/gu, "")
    .replace(/[\u{0000}-\u{001F}\u{007F}-\u{009F}]/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/\p{Cf}/gu, "")
    .replace(/«/g, "‹")
    .replace(/»/g, "›")
    .trim();
  /* eslint-enable no-control-regex */
}

interface ThreadRef {
  repo: string;
  number: number;
}

/** Mute references accept `<n>` and `#<n>` for the configured repository, or `org/repo#n`. */
function parseThreadRef(config: Config, ref: string): ThreadRef {
  const match = /^(?:#?([1-9]\d*)|(?:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+))#([1-9]\d*))$/.exec(ref);
  const parsed = count(match?.[1] ?? match?.[4]);
  if (!match || parsed === null) {
    throw new Error("Expected <number> or <org/repo#number>");
  }
  return { repo: match[2] ? `${match[2]}/${match[3]}` : String(config.repo), number: parsed };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function closingRefs(body: string): number[] {
  const refs: number[] = [];
  for (const match of body.matchAll(
    /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|part of)\s+#(\d+)/gi
  )) {
    const number = count(match[1]);
    if (number !== null) {
      refs.push(number);
    }
  }
  return refs;
}

function changeMute(
  config: Config,
  env: NodeJS.ProcessEnv,
  thread: ThreadRef,
  add: boolean
): string {
  const dir = stateRoot(env, resolveSession(config, {}).stateName);
  const marker = new LoopState(dir).mutes;
  const entry = `${thread.repo.toLowerCase()}#${thread.number}`;
  const current = marker.lines();
  const present = current.includes(entry);
  if (add === present) {
    return `${thread.repo}#${thread.number} is ${add ? "already muted" : "not muted"}`;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  marker.write(
    `${(add ? [...current, entry] : current.filter((line) => line !== entry)).sort().join("\n")}\n`
  );
  return `${add ? "muted" : "unmuted"} ${thread.repo}#${thread.number}`;
}

export function muteThread(config: Config, env: NodeJS.ProcessEnv, ref: string): string {
  return changeMute(config, env, parseThreadRef(config, ref), true);
}

export function unmuteThread(config: Config, env: NodeJS.ProcessEnv, ref: string): string {
  return changeMute(config, env, parseThreadRef(config, ref), false);
}

export function listMutes(config: Config, env: NodeJS.ProcessEnv): string {
  const lines = new LoopState(stateRoot(env, resolveSession(config, {}).stateName)).mutes.lines();
  return [`Muted: ${lines.length}`, ...lines].join("\n");
}

/**
 * One event loop per session (state directory): the server polls GitHub through the
 * gateway client, filters every author through people.yaml, and hands the client
 * metadata-only wake-up lines. Events are acknowledged only after the client
 * printed them, so a kill between fetch and print loses nothing.
 * Registry/config refresh runs before each poll; a supplied session preserves the
 * existing state directory across configuration rebuilds.
 * Scoped board closures reconcile Done/Progress/management turns silently.
 * Own task PRs include submitted inline review comments, deduplicated by database ID;
 * initially resolved threads are baselined without reporting their existing comments.
 * External issue closures emit CLOSED unless covered by a merged PR; NOT PLANNED instead
 * asks the orchestrator to notify a verified peer-project requester.
 */
export class EventLoop {
  private readonly dir: string;
  private readonly session: ResolvedSession;
  private readonly own: string;
  private readonly org: string;
  private readonly subscriptions: string[];
  private readonly taskBranch: RegExp;
  private readonly reserve: number;
  private readonly preview: boolean;
  private readonly writes: WriteJournal;
  private readonly subjectPreviews = new Map<
    string,
    { title: string; person: Person | undefined }
  >();

  private started = false;
  private firstRun = false;
  private cycle = 0;
  private fails = 0;
  private me: string | null = null;
  private meId: number | null = null;
  private tracksRead = 0;
  private readonly tracks = new Map<number, string>();
  private readonly known = new Set<number>();
  private readonly comments: CommentStream;
  private readonly boardPoller: BoardPoller;
  private readonly pulls: PullPoller;
  private readonly workers: WorkerPoller;
  private nextBoardAt = 0;
  private readonly pacing = new WatchPacing();
  private reportedShape = "";
  private reportedCost = 0;
  private reportedInterval = 0;
  /** Cost observation waiting to be confirmed; a changed cost reports once it
   * has held for three consecutive polls. */
  private pendingCost = 0;
  private costStreak = 0;
  /** Interval deviations must exceed the threshold in one direction for three polls. */
  private intervalStreak = 0;
  private intervalDirection = 0;
  private observedRead = 0;
  private reportedFailures = new Map<
    string,
    { message: string; since: number; reminded: number; step: string }
  >();
  private readonly state: LoopState;
  private reading = false;
  private budgetDeferred = false;
  private releaseLock?: () => void;

  /** Preserve the loop diagnostic used by the unchanged lock-contention regression. */
  private get workerPollErrors(): ReadonlyMap<number, ReadonlySet<string>> {
    return this.workers.pollErrors;
  }

  /** Release on a graceful server shutdown; a crash leaves the PID/start guard behind. */
  close(): void {
    if (this.releaseLock) {
      process.removeListener("exit", this.releaseLock);
      this.releaseLock();
      this.releaseLock = undefined;
    }
    this.started = false;
  }

  constructor(
    private readonly host: LoopHost,
    input: SessionInput,
    session?: ResolvedSession
  ) {
    const config = host.config;
    this.session = session ?? resolveSession(config, input);
    this.dir = stateRoot(host.env, this.session.stateName);
    this.state = new LoopState(this.dir);
    this.writes = new WriteJournal(config, host.env, host.deps.now, this.session.stateName);
    this.own = String(config.repo);
    this.org = String(config.org);
    const methodology = str(object(config.vmethod).repo) || "vworlds/vmethod";
    this.subscriptions =
      methodology !== "off" && methodology.toLowerCase() !== this.own.toLowerCase()
        ? [this.own, methodology]
        : [this.own];
    const branches = object(config.branches);
    const pattern = str(branches.taskPattern) || "<number>-<slug>";
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    this.taskBranch = new RegExp(
      `^(?:${escaped.replace(/<number>/g, "\\d+").replace(/<slug>/g, "[A-Za-z0-9._-]+")}|${(str(branches.packPrefix) || "pack/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`
    );
    const reserve = object(config.gateway).reserve;
    this.reserve = typeof reserve === "number" ? reserve : 100;
    this.preview = object(config.watch).preview === true;
    this.boardPoller = new BoardPoller({
      state: this.state,
      host,
      writes: this.writes,
      own: this.own,
      reserve: this.reserve,
      current: () => ({
        me: this.me,
        firstRun: this.firstRun,
        taskIssues: this.pulls.observation.taskIssues,
        pendingMergedIssues: this.pulls.observation.pendingMergedIssues,
        nextBoardAt: this.nextBoardAt,
      }),
      recordPoll: (cost) => this.pacing.recordPoll(cost),
      assignmentEvent: (...args) => this.assignmentEvent(...args),
      branchOf: (...args) => this.branchOf(...args),
      emit: (...args) => this.emit(...args),
      inScope: (...args) => this.inScope(...args),
      isOwn: (...args) => this.isOwn(...args),
      known: this.known,
      list: (...args) => this.list(...args),
      mark: (...args) => this.mark(...args),
      marked: (...args) => this.marked(...args),
      muted: (...args) => this.muted(...args),
      ownAssignment: (...args) => this.ownAssignment(...args),
      previewFromSubject: (...args) => this.previewFromSubject(...args),
      previewText: (...args) => this.previewText(...args),
      produceOnce: (...args) => this.produceOnce(...args),
      queueProgress: (...args) => this.queueProgress(...args),
      quiet: (...args) => this.quiet(...args),
      readMarker: (...args) => this.readMarker(...args),
      restPages: (...args) => this.restPages(...args),
      siblingActor: (...args) => this.siblingActor(...args),
      subjectPreviews: this.subjectPreviews,
      threadUrl: (...args) => this.threadUrl(...args),
      trackOne: (...args) => this.trackOne(...args),
      writeMarker: (...args) => this.writeMarker(...args),
    });
    this.comments = new CommentStream({
      state: this.state,
      github: host.github,
      filter: host.filter,
      writes: this.writes,
      own: this.own,
      subscriptions: this.subscriptions,
      preview: this.preview,
      known: this.known,
      subjectPreviews: this.subjectPreviews,
      now: () => host.deps.now(),
      current: () => ({
        me: this.me,
        meId: this.meId,
        firstRun: this.firstRun,
        taskIssues: this.pulls.observation.taskIssues,
      }),
      isOwn: (repo) => this.isOwn(repo),
      inScope: (number) => this.inScope(number),
      trackOne: (number) => this.trackOne(number),
      readCursor: () => this.readCursor(),
      restRead: (action) => this.restRead(action),
      restPages: (path, collect) => this.restPages(path, collect),
      marked: (marker) => this.marked(marker),
      mark: (marker) => this.mark(marker),
      pending: () => this.pending(),
      muted: (repo, number) => this.muted(repo, number),
      mentionsMe: (body) => this.mentionsMe(body),
      unmuteThread: (repo, number) => this.unmuteThread(repo, number),
      touchActivity: (number, at) => this.touchActivity(number, at),
      conflictFixing: (number) => host.conflictFixing?.(number) ?? false,
      queueProgress: (number, change) => this.queueProgress(number, change),
      previewText: (person, text) => this.previewText(person, text),
      ref: (repo, number) => this.ref(repo, number),
      threadUrl: (repo, number, kind) => this.threadUrl(repo, number, kind),
      produceOnce: (id, kind, line) => this.produceOnce(id, kind, line),
      quietOnce: (id, line) => this.quietOnce(id, line),
      sanitizeLine,
    });
    this.pulls = new PullPoller({
      state: this.state,
      host,
      writes: this.writes,
      own: this.own,
      org: this.org,
      session: this.session,
      taskBranch: this.taskBranch,
      subjectPreviews: this.subjectPreviews,
      current: () => ({ cycle: this.cycle, firstRun: this.firstRun, meId: this.meId }),
      updateLaunched: (launched) => this.boardPoller.updateLaunched(launched),
      pollReviewThreads: (number) => this.comments.pollReviewThreads(number),
      seedPrComments: (number) => this.comments.seedPrComments(number),
      inScope: (number) => this.inScope(number),
      muted: (...args) => this.muted(...args),
      threadUrl: (...args) => this.threadUrl(...args),
      restRead: (action) => this.restRead(action),
      restPages: (path, collect) => this.restPages(path, collect),
      readMarker: (marker) => this.readMarker(marker),
      writeMarker: (marker, text) => this.writeMarker(marker, text),
      marked: (marker) => this.marked(marker),
      mark: (marker) => this.mark(marker),
      touchActivity: (number, at) => this.touchActivity(number, at),
      previewFromSubject: (...args) => this.previewFromSubject(...args),
      previewText: (...args) => this.previewText(...args),
      produceOnce: (...args) => this.produceOnce(...args),
      emit: (...args) => this.emit(...args),
      quietOnce: (...args) => this.quietOnce(...args),
      queueProgress: (...args) => this.queueProgress(...args),
    });
    this.workers = new WorkerPoller({
      state: this.state,
      host,
      own: this.own,
      current: () => ({ cycle: this.cycle }),
      boardObservation: () => this.boardPoller.observation,
      readReview: (number) => this.comments.readReview(number),
      activityAt: (number) => this.activityAt(number),
      muted: (...args) => this.muted(...args),
      threadUrl: (...args) => this.threadUrl(...args),
      readMarker: (marker) => this.readMarker(marker),
      writeMarker: (marker, text) => this.writeMarker(marker, text),
      produceOnce: (...args) => this.produceOnce(...args),
      emit: (...args) => this.emit(...args),
      quietOnce: (...args) => this.quietOnce(...args),
      queueProgress: (...args) => this.queueProgress(...args),
    });
  }

  async nextEvents(input: WatchInput): Promise<{
    events: WatchEvent[];
    notice?: string;
    reminder?: string;
  }> {
    if (this.reading) {
      throw new Error("watch: another reader is already waiting for this session");
    }
    this.reading = true;
    try {
      const result = await this.readEvents(input);
      const reminder = input.replay === undefined ? this.chatReminder(result.events) : undefined;
      if (input.replay === undefined) {
        new WatchDelivery(this.dir, this.host.deps.now).append(result.events);
      }
      if (input.watchStart && !this.marked(this.state.once(`guide-seen-${VERSION}`))) {
        const projectRoot = resolve(this.host.env.VMETHOD_ROOT || this.host.root);
        const packageGuide = join(
          projectRoot,
          "node_modules/@vworlds/vmethod/docs/orchestrator-guide.md"
        );
        const selfGuide = join(projectRoot, "docs/orchestrator-guide.md");
        const guide = [packageGuide, selfGuide].find(existsSync);
        let selfHosted = false;
        try {
          selfHosted =
            object(JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"))).name ===
            "@vworlds/vmethod";
        } catch {
          // A consumer root may not have a readable package manifest.
        }
        const canonical = selfHosted ? selfGuide : packageGuide;
        const notice = `vmethod ${VERSION} in use: read ${guide ?? `${canonical} (not found locally)`} (changes: https://github.com/vworlds/vmethod/releases/tag/v${VERSION})`;
        return { ...result, ...(reminder ? { reminder } : {}), notice };
      }
      return { ...result, ...(reminder ? { reminder } : {}) };
    } finally {
      this.reading = false;
    }
  }

  private async readEvents(input: WatchInput): Promise<{ events: WatchEvent[] }> {
    if (
      typeof input.timeoutSeconds !== "number" ||
      !Number.isSafeInteger(input.timeoutSeconds) ||
      input.timeoutSeconds < 0 ||
      input.timeoutSeconds > 3600
    ) {
      throw new Error("Expected timeoutSeconds between 0 and 3600");
    }
    if (
      input.ack !== undefined &&
      (!Array.isArray(input.ack) || input.ack.some((id) => !ID.test(str(id))))
    ) {
      throw new Error("Invalid ack ids");
    }
    if (input.pollOnce !== undefined && typeof input.pollOnce !== "boolean") {
      throw new Error("Expected a boolean pollOnce");
    }
    if (input.watchStart !== undefined && typeof input.watchStart !== "boolean") {
      throw new Error("Expected a boolean watchStart");
    }
    if (input.guideSeen !== undefined && typeof input.guideSeen !== "boolean") {
      throw new Error("Expected a boolean guideSeen");
    }
    if (
      input.replay !== undefined &&
      (typeof input.replay !== "string" ||
        input.watchStart ||
        input.guideSeen ||
        (input.ack as string[] | undefined)?.length)
    ) {
      throw new Error("Replay requires a string selector, no start and no acknowledgements");
    }
    await this.start();
    const delivery = new WatchDelivery(this.dir, this.host.deps.now);
    if (typeof input.replay === "string") {
      return { events: delivery.replay(input.replay) };
    }
    if (input.watchStart) {
      delivery.start();
    }
    if (input.guideSeen) {
      this.mark(this.state.once(`guide-seen-${VERSION}`));
    }
    this.applyAck((input.ack ?? []) as string[]);
    // Deliver onboarding immediately rather than hiding it behind a five-minute long poll.
    if (
      input.watchStart &&
      !input.pollOnce &&
      !this.marked(this.state.once(`guide-seen-${VERSION}`))
    ) {
      return { events: this.buildBatch() };
    }
    // Zero timeout is the ack-only operation used by --once; do not fetch unprinted events.
    if ((input.timeoutSeconds === 0 && !input.pollOnce) || this.pending().length) {
      return { events: this.buildBatch() };
    }
    const deadline = this.host.deps.now() + input.timeoutSeconds * 1000;
    for (;;) {
      await this.pollOnce();
      if (input.pollOnce) {
        break;
      }
      if (this.pending().length) {
        // One settling poll, so the rest of the same action joins this wake-up.
        await this.pollOnce();
        break;
      }
      if (this.host.deps.now() >= deadline) {
        break;
      }
      await this.host.deps.sleep(Math.min(this.nextSleep(), deadline - this.host.deps.now()));
    }
    return { events: this.buildBatch() };
  }

  /** The chat-rule reminder attaches to a delivery that already has events, at
   * most once per interval; the timestamp persists across restarts in the state
   * directory. It is delivery metadata, never an event: history, replay and
   * acknowledgements carry events only.
   */
  private chatReminder(events: WatchEvent[]): string | undefined {
    if (!events.length) {
      return undefined;
    }
    const last = Date.parse(this.readMarker(this.state.chatReminder));
    if (Number.isFinite(last) && this.host.deps.now() - last < CHAT_REMINDER_EVERY_MS) {
      return undefined;
    }
    this.state.chatReminder.write(new Date(this.host.deps.now()).toISOString());
    return CHAT_REMINDER;
  }

  private nextSleep(): number {
    return this.fails > 0
      ? Math.min(INTERVAL_MS * 2 ** Math.min(this.fails, 5), 300_000)
      : INTERVAL_MS;
  }

  // ---------------------------------------------------------------- state files

  private mark(marker: Marker<unknown>): void {
    const name = marker.path.slice(this.dir.length + 1);
    if (!ID.test(name)) {
      throw new Error(`Invalid watcher state marker: ${name}`);
    }
    marker.stamp(this.windowMarker(name) ? new Date(this.host.deps.now()).toISOString() : "");
  }

  private marked(marker: Marker<unknown>): boolean {
    return marker.exists();
  }

  private windowMarker(name: string): boolean {
    return /^c-[a-f\d]{16}$/.test(name) || name.startsWith("new-");
  }

  private pruneWindowMarkers(cursor: string): void {
    const cutoff = Date.parse(cursor) - CURSOR_OVERLAP_MS - MARKER_MARGIN_MS;
    for (const name of readdirSync(this.dir)) {
      if (!this.windowMarker(name)) {
        continue;
      }
      const stamp = this.readMarker(this.state.once(name));
      const at = stamp ? Date.parse(stamp) : statSync(this.state.once(name).path).mtimeMs;
      if (!Number.isFinite(at)) {
        throw new Error(`Invalid watcher marker timestamp: ${name}`);
      }
      if (at < cutoff) {
        this.state.once(name).remove();
      }
    }
  }

  private readMarker(marker: Marker<unknown>): string {
    return marker.text();
  }

  private pending(): PendingEvent[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.state.pending.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw new Error("Invalid watcher pending state", { cause: error });
    }
    if (!Array.isArray(parsed)) {
      throw new Error("Invalid watcher pending state");
    }
    return parsed.map((entry) => {
      const event = object(entry);
      if (!ID.test(str(event.id)) || typeof event.line !== "string" || !event.line) {
        throw new Error("Invalid watcher pending event");
      }
      return {
        id: str(event.id),
        kind: str(event.kind),
        line: event.line,
        once: event.once === true,
        ...(Array.isArray(event.quiet) ? { quiet: event.quiet.map(str) } : {}),
      };
    });
  }

  private savePending(events: PendingEvent[]): void {
    this.state.pending.write(JSON.stringify(events));
  }

  private produceOnce(id: string, kind: string, line: string): boolean {
    if (this.marked(this.state.once(id)) || this.pending().some((event) => event.id === id)) {
      return false;
    }
    this.savePending([...this.pending(), { id, kind, line, once: true }]);
    return true;
  }

  /** An occurrence event: deduplicated by state files, never by a forever marker. */
  private emit(id: string, kind: string, line: string): boolean {
    if (this.pending().some((event) => event.id === id)) {
      return false;
    }
    this.savePending([...this.pending(), { id, kind, line, once: false }]);
    return true;
  }

  private applyAck(ids: string[]): void {
    if (!ids.length) {
      return;
    }
    const keep: PendingEvent[] = [];
    for (const event of this.pending()) {
      if (ids.includes(event.id)) {
        if (event.once) {
          this.mark(this.state.once(event.id));
        }
      } else {
        keep.push(event);
      }
    }
    this.savePending(keep);
  }

  private quiet(line: string): void {
    this.state.quiet.append(`${line}\n`);
  }

  private quietOnce(id: string, line: string): void {
    if (this.marked(this.state.once(id))) {
      return;
    }
    this.quiet(line);
    this.mark(this.state.once(id));
  }

  private buildBatch(): WatchEvent[] {
    const events: PendingEvent[] = [];
    const orphanedQuiet: string[] = [];
    for (const event of this.pending()) {
      const quiet = (event.quiet ?? []).filter((line) => !this.journaledCommentLine(line));
      if (this.journaledCommentLine(event.line)) {
        if (event.once) {
          this.mark(this.state.once(event.id));
        }
        orphanedQuiet.push(...quiet);
      } else {
        events.push({ ...event, ...(event.quiet ? { quiet } : {}) });
      }
    }
    for (const line of orphanedQuiet) {
      this.quiet(line);
    }
    if (events.length) {
      const lines = this.state.quiet.lines().filter((line) => !this.journaledCommentLine(line));
      if (lines.length) {
        events[0] = { ...events[0], quiet: [...(events[0].quiet ?? []), ...lines] };
      }
      this.state.quiet.stamp("");
    }
    this.savePending(events);
    return events.map(({ id, kind, line, quiet }) => ({
      id,
      kind,
      line,
      ...(quiet ? { quiet } : {}),
    }));
  }

  /** Revalidate persisted delivery after a separate writer's response is journaled.
   * Only exact same-account comment IDs can suppress a replay; no timestamp is
   * inferred from display text. Legacy quiet lines have this same generated form.
   */
  private journaledCommentLine(line: string): boolean {
    const author =
      /^COMMENT (\S+)(?: .*?)? from ([\w-]+) \(orchestrator\) \(this account, another session\)/.exec(
        line
      );
    if (!author) {
      return false;
    }
    const match =
      / https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/(?:pull|issues)\/(\d+)#(issuecomment-|discussion_r)(\d+)$/.exec(
        line
      );
    return (
      !!match &&
      author[1] === this.ref(match[1], Number(match[2])) &&
      this.writes.matches(
        {
          kind: match[3] === "discussion_r" ? "review-comment" : "comment",
          repo: match[1],
          number: Number(match[2]),
          commentId: Number(match[4]),
        },
        ""
      )
    );
  }

  private readCursor(): string | null {
    const value = this.readMarker(this.state.cursor);
    if (!value) {
      return null;
    }
    if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
      throw new Error("Invalid watcher cursor; refusing to replay history");
    }
    return value;
  }

  private mutes(): Set<string> {
    return new Set(this.state.mutes.lines());
  }

  private muted(repo: string, number: number): boolean {
    return this.mutes().has(`${repo.toLowerCase()}#${number}`);
  }

  private unmuteThread(repo: string, number: number): void {
    const entry = `${repo.toLowerCase()}#${number}`;
    const marker = this.state.mutes;
    marker.write(
      `${marker
        .lines()
        .filter((line) => line !== entry)
        .sort()
        .join("\n")}\n`
    );
  }

  private mentionsMe(body: string): boolean {
    return new RegExp(`@${this.me}(?![A-Za-z0-9-])`, "i").test(body);
  }

  private activityAt(number: number): string {
    const value = this.readMarker(this.state.pr(number).activity);
    return /^\d{4}-\d{2}-\d{2}T/.test(value) ? value : "";
  }

  private touchActivity(number: number, at: string): void {
    if (!at || at <= this.activityAt(number)) {
      return;
    }
    this.state.pr(number).activity.write(`${at}\n`);
  }

  // ---------------------------------------------------------------- start and lock

  private async start(): Promise<void> {
    if (this.started) {
      return;
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    mkdirSync(this.state.boardDir, { recursive: true, mode: 0o700 });
    this.acquireLock();
    try {
      await this.importLegacy();
      this.migrateActions();
    } catch (error) {
      this.close();
      throw error;
    }
    this.loadTracksCache();
    this.started = true;
  }

  /** Import obsolete writer stamps once; future writers only use the gateway journal. */
  private migrateActions(): void {
    if (this.marked(this.state.actionsMigrated)) {
      return;
    }
    const completed = object(safeJson(this.readMarker(this.state.legacyCompleted)));
    const turns = object(safeJson(this.readMarker(this.state.legacyTurns)));
    const obsolete: string[] = [];
    const shared = stateRoot(
      this.host.env,
      resolveSession(this.host.config, { track: this.session.track ?? undefined }).stateName
    );
    if (shared !== this.dir && existsSync(shared)) {
      for (const name of readdirSync(shared)) {
        const match = /^merged-(\d+)$/.exec(name);
        if (match) {
          completed[match[1]] = true;
        }
      }
    }
    for (const name of readdirSync(this.dir)) {
      const match = /^merged-(\d+)$/.exec(name);
      if (match) {
        completed[match[1]] = true;
        obsolete.push(this.state.once(name).path);
      }
    }
    for (const name of readdirSync(this.state.boardDir)) {
      if (name.startsWith(".turn-")) {
        turns[name] = true;
        obsolete.push(this.state.legacyBoard(name).path);
      }
    }
    this.writeMarker(this.state.legacyCompleted, JSON.stringify(completed));
    this.writeMarker(this.state.legacyTurns, JSON.stringify(turns));
    for (const file of obsolete) {
      new Marker(file).remove();
    }
    this.mark(this.state.actionsMigrated);
  }

  private acquireLock(): void {
    // A graceful exit clears our own lock; a crash leaves it to the staleness check.
    this.releaseLock = new OwnedLock(this.state.lock.path, this.host.deps).watch(this.dir);
    process.once("exit", this.releaseLock);
  }

  private async importLegacy(): Promise<void> {
    const names = (this.host.config.legacyState ?? []) as string[];
    if (!names.length) {
      return;
    }
    const marker = this.state.legacyImported;
    if (marker.exists()) {
      return;
    }
    const root = dirname(dirname(this.dir));
    const sources = names
      .map((name) =>
        join(root, `${name}${this.session.track !== null ? `-${this.session.track}` : ""}`)
      )
      .filter((source) => existsSync(source));
    const files: {
      source: string;
      target: string;
      number: number | null;
      pr: boolean;
      own: boolean;
    }[] = [];
    const collect = (source: string, target: string, name: string): void => {
      const match =
        /^(open|head|branch|ci|conflict|merge-attempt|merge-error|activity|review|seeded|merged|picked|closed|graded|grade|pending-progress|worker-stop|q|w|button)-(\d+)(?:[-@].*)?$/.exec(
          name
        );
      const scoped = /^(?:new-(.+)#|\.turn-(.+)-)(\d+)$/.exec(name);
      files.push({
        source,
        target,
        number: match ? count(match[2]) : scoped ? count(scoped[3]) : null,
        pr: match !== null && !["graded", "grade"].includes(match[1]),
        own: !scoped || (scoped[1] ?? scoped[2]) === slug(this.own),
      });
    };
    const skipTop = new Set([
      "watcher.lock",
      "quiet.log",
      "tracks",
      "lock",
      "cursor",
      "pending.json",
      "quiet",
      "mutes",
      "legacy-imported",
      "writes.jsonl",
      "writes.jsonl.lock",
      "writes.jsonl.tmp",
      "actions-migrated",
      "legacy-completed.json",
      "legacy-turns.json",
      "unestimated.json",
    ]);
    const skipBoard = new Set([".next", ".launch", ".hold-startable", ".seen", "next", "launch"]);
    for (const source of sources) {
      for (const entry of readdirSync(source, { withFileTypes: true })) {
        // Top-level once keys and the imported markers; never vecs' working files.
        if (
          entry.isFile() &&
          !entry.name.startsWith(".") &&
          !skipTop.has(entry.name) &&
          !/^(?:mine-|theirs-|merge-(?:attempt|error)-)/.test(entry.name)
        ) {
          collect(join(source, entry.name), this.state.once(entry.name).path, entry.name);
        }
      }
      const board = join(source, "board");
      if (!existsSync(board)) {
        continue;
      }
      for (const entry of readdirSync(board, { withFileTypes: true })) {
        if (
          entry.isFile() &&
          (entry.name.startsWith(".turn-") ||
            (!entry.name.startsWith(".") && !skipBoard.has(entry.name)))
        ) {
          collect(join(board, entry.name), this.state.legacyBoard(entry.name).path, entry.name);
        }
      }
    }
    // Validate every numbered marker before copying anything. Failure leaves the import retryable.
    const numbers = [
      ...new Set(files.flatMap((file) => (file.number === null || !file.own ? [] : [file.number]))),
    ];
    const valid = await this.validateLegacy(numbers);
    let dropped = 0;
    for (const file of files) {
      if (
        file.number !== null &&
        (!file.own ||
          !valid.has(file.number) ||
          (file.pr && valid.get(file.number) !== "PullRequest"))
      ) {
        dropped++;
        continue;
      }
      copyFileSync(file.source, file.target);
    }
    if (sources.length) {
      this.host.deps.report(
        `watcher: legacy import dropped ${dropped} markers not belonging to ${this.own}`
      );
    }
    marker.write(`${sources.join("\n")}\n`);
  }

  private async validateLegacy(numbers: number[]): Promise<Map<number, string>> {
    const valid = new Map<number, string>();
    const [owner, name] = this.own.split("/");
    for (let offset = 0; offset < numbers.length; offset += 50) {
      const batch = numbers.slice(offset, offset + 50);
      // Use the gateway's header-driven pacing, including between batches. Missing items
      // produce NOT_FOUND field errors; all other partial/error responses fail closed.
      const result = object(
        await this.host.github.rest("/graphql", "POST", {
          query: `query WatchLegacy($owner: String!, $name: String!) {
          repository(owner: $owner, name: $name) {
            ${batch.map((number) => `n${number}: issueOrPullRequest(number: ${number}) { __typename ... on Issue { number repository { nameWithOwner } } ... on PullRequest { number repository { nameWithOwner } } }`).join("\n")}
          }
        }`,
          variables: { owner, name },
        })
      );
      const repository = object(object(result.data).repository);
      if (
        !result.data ||
        !object(result.data).repository ||
        (result.errors !== undefined && !Array.isArray(result.errors))
      ) {
        throw new Error("Invalid legacy validation response");
      }
      for (const error of this.list(result.errors)) {
        const path = error.path;
        if (
          error.type !== "NOT_FOUND" ||
          !Array.isArray(path) ||
          path.length !== 2 ||
          path[0] !== "repository" ||
          !batch.some((number) => path[1] === `n${number}`) ||
          repository[String(path[1])] !== null
        ) {
          throw new Error("Legacy validation failed; refusing partial data");
        }
      }
      for (const number of batch) {
        const value = repository[`n${number}`];
        if (value === null) {
          continue;
        }
        const item = object(value);
        if (
          item.number !== number ||
          !["Issue", "PullRequest"].includes(str(item.__typename)) ||
          str(object(item.repository).nameWithOwner).toLowerCase() !== this.own.toLowerCase()
        ) {
          throw new Error("Invalid legacy validation item");
        }
        valid.set(number, str(item.__typename));
      }
    }
    return valid;
  }

  private loadTracksCache(): void {
    for (const line of this.state.tracks.lines()) {
      const [number, track] = line.split("\t");
      const parsed = count(number);
      if (parsed !== null) {
        this.known.add(parsed);
        if (track) {
          this.tracks.set(parsed, track);
        }
      }
    }
  }

  // ---------------------------------------------------------------- scope

  private isOwn(repo: string): boolean {
    return repo.toLowerCase() === this.own.toLowerCase();
  }

  private inScope(number: number): boolean {
    if (this.session.only !== null) {
      return this.session.only.includes(number);
    }
    if (this.session.skip !== null) {
      return !this.session.skip.includes(number);
    }
    const track = this.tracks.get(number) ?? "";
    return this.session.track !== null ? track === this.session.track : track === "";
  }

  /** One bounded lookup for a number the label cache has not listed yet. */
  private async trackOne(number: number): Promise<void> {
    if (this.known.has(number) || this.tracksRead === 0) {
      return;
    }
    const item = object(
      await this.restRead(() => this.host.github.rest(`/repos/${this.own}/issues/${number}`))
    );
    this.known.add(number);
    let track = this.labelTrack(item);
    if (!track && item.pull_request !== undefined) {
      for (const ref of closingRefs(str(item.body))) {
        const inherited = this.tracks.get(ref);
        if (inherited) {
          track = inherited;
          break;
        }
      }
    }
    if (track) {
      this.tracks.set(number, track);
    }
  }

  private labelTrack(item: ObjectData): string {
    for (const label of Array.isArray(item.labels) ? item.labels.map(object) : []) {
      const match = /^track:(.+)$/.exec(str(label.name));
      if (match) {
        return match[1];
      }
    }
    return "";
  }

  private ref(repo: string, number: number): string {
    return this.isOwn(repo) ? `#${number}` : `${repo}#${number}`;
  }

  private threadUrl(repo: string, number: number, kind: "ISSUE" | "PR" | "issue" | "pr"): string {
    return `https://github.com/${repo}/${kind === "PR" || kind === "pr" ? "pull" : "issues"}/${number}`;
  }

  private previewText(person: Person | undefined, text: string | undefined): string {
    if (!this.preview || !text || !person || person.role === "system") {
      return "";
    }
    const clean = sanitizePreview(text);
    return clean ? ` untrusted text: «${clean}»` : "";
  }

  private previewFromSubject(repo: string, number: number): string {
    const entry = this.subjectPreviews.get(`${repo.toLowerCase()}#${number}`);
    return this.previewText(entry?.person, entry?.title);
  }

  private restRead<T>(action: () => Promise<T>): Promise<T> {
    const budget = this.host.github.budget();
    const core = budget.resources.core;
    const bypass =
      this.host.github.budgetStopped() &&
      budget.secondaryUntil <= this.host.deps.now() &&
      (core === undefined || core.remaining > this.reserve + 1);
    // A GraphQL-budget pause must not stop the REST reads; an unhealthy core budget must.
    return bypass ? this.host.github.usingReserve(action) : action();
  }

  private async restPages<T>(
    path: (page: number) => string,
    collect: (data: unknown) => T[]
  ): Promise<T[]> {
    const items: T[] = [];
    for await (const collected of restPages<T>(
      async (page) => collect(await this.restRead(() => this.host.github.rest(path(page)))),
      {
        error: "Invalid watcher page",
        size: 100,
        limit: PAGE_LIMIT,
        limitError: "Watcher pagination limit reached",
      }
    )) {
      items.push(...collected);
    }
    return items;
  }

  private list(value: unknown): ObjectData[] {
    return Array.isArray(value) ? value.map(object) : [];
  }

  // ---------------------------------------------------------------- polling

  private async step(name: string, run: () => Promise<void>): Promise<boolean> {
    try {
      await run();
      for (const [signature, failure] of this.reportedFailures) {
        if (failure.step === name) {
          this.host.deps.report(
            `watcher: ${name} recovered after failing since ${new Date(failure.since).toISOString()}`
          );
          this.reportedFailures.delete(signature);
        }
      }
      return true;
    } catch (error) {
      if (error instanceof BudgetPause) {
        this.budgetDeferred = true;
        return false;
      }
      const message = (error as Error).message;
      const signature = message;
      const previous = this.reportedFailures.get(signature);
      const now = this.host.deps.now();
      if (!previous) {
        this.reportedFailures.set(signature, {
          message,
          since: now,
          reminded: now,
          step: name,
        });
        this.host.deps.report(`watcher: ${name} failed: ${message}`);
      } else {
        if (now - previous.reminded >= FAILURE_REMINDER_MS) {
          previous.reminded = now;
          this.host.deps.report(
            `watcher: still failing since ${new Date(previous.since).toISOString()}: ${message}`
          );
        }
      }
      if (error instanceof GraphQLResponseError) {
        this.produceOnce(
          `graphql-error-${key(error.errors.join(";"))}`,
          "query-error",
          "QUERY ERROR: GraphQL rejected a watcher query; details on stderr"
        );
      }
      return false;
    }
  }

  private async pollOnce(): Promise<void> {
    const replacement = this.host.refresh?.();
    if (replacement && replacement !== this) {
      await replacement.pollOnce();
      return;
    }
    await this.host.github.polling(() => this.runPoll(), this.dir);
  }

  private async runPoll(): Promise<void> {
    this.budgetDeferred = false;
    await this.start();
    this.firstRun = this.readCursor() === null;
    const startedAt = new Date(this.host.deps.now()).toISOString();
    if (this.firstRun && !this.marked(this.state.listingBaseline)) {
      this.writeMarker(this.state.listingBaseline, startedAt);
    }
    this.cycle++;
    this.workers.beginPoll();
    this.boardPoller.beginPoll();
    this.comments.beginPoll();
    let ok = true;
    if (this.me === null) {
      ok = await this.step("own identity", async () => {
        const user = object(await this.restRead(() => this.host.github.rest("/user")));
        const id = count(user.id);
        if (!str(user.login) || id === null) {
          throw new Error("cannot read own identity");
        }
        this.me = str(user.login);
        this.meId = id;
      });
      if (!ok) {
        await this.checkBudget();
        if (!this.budgetDeferred) {
          this.recordFailure();
        }
        return;
      }
    }
    if (this.tracksRead === 0 || this.host.deps.now() - this.tracksRead >= TRACKS_TTL_MS) {
      ok = (await this.step("track labels", () => this.refreshTracks())) && ok;
    }
    const pullsOk = await this.step("pull requests", () => this.pulls.pollPulls());
    const commentsOk = await this.step("comments", () => this.comments.pollComments());
    if (commentsOk && pullsOk) {
      for (const pr of this.pulls.observation.prs) {
        await this.workers.watchStale(pr);
      }
    }
    const itemsOk = await this.step("subscribed items", () => this.pollSubscribedItems());
    const assignedOk = await this.step("assignments", () => this.pollAssigned());
    await this.step("budget", () => this.checkBudget());
    const boardOk = await this.step("board", () => this.boardPoller.pollBoard(pullsOk));
    if (!boardOk) {
      this.state.unestimated.remove();
    }
    const workersOk = await this.step("worker sessions", () => this.workers.pollWorkers());
    await this.step("worker quotas", () => this.workers.pollQuotas());
    await this.step("budget", () => this.checkBudget());
    ok = ok && pullsOk && commentsOk && itemsOk && assignedOk && boardOk && workersOk;
    if (commentsOk && itemsOk && (!this.firstRun || ok)) {
      // Do not leave first-run mode until every baseline succeeded.
      this.writeMarker(this.state.cursor, startedAt);
      this.pruneWindowMarkers(startedAt);
    }
    if (!ok && !this.budgetDeferred) {
      this.recordFailure();
    } else if (ok) {
      this.fails = 0;
    }
  }

  private recordFailure(): void {
    this.fails++;
    if (this.fails === 3) {
      this.emit(
        `watcher-error@${this.host.deps.now()}`,
        "watcher-error",
        "WATCHER ERROR: three failed polls in a row; details on stderr"
      );
    }
  }

  private writeMarker(marker: Marker<unknown>, text: string): void {
    const name = marker.path.slice(this.dir.length + 1);
    if (!ID.test(name)) {
      throw new Error(`Invalid watcher state marker: ${name}`);
    }
    marker.writeText(`${text}\n`);
  }

  private async refreshTracks(): Promise<void> {
    const items = await this.restPages(
      (page) => `/repos/${this.own}/issues?state=open&per_page=100&page=${page}`,
      (data) => this.list(data)
    );
    const labelled = new Map<number, string>();
    for (const item of items) {
      const number = count(item.number);
      if (number === null || item.pull_request !== undefined) {
        continue;
      }
      const track = this.labelTrack(item);
      if (track) {
        labelled.set(number, track);
      } else {
        this.tracks.delete(number);
      }
    }
    const rows: string[] = [];
    for (const item of items) {
      const number = count(item.number);
      if (number === null) {
        continue;
      }
      this.known.add(number);
      let track = this.labelTrack(item);
      if (!track && item.pull_request !== undefined) {
        for (const ref of closingRefs(str(item.body))) {
          const inherited = labelled.get(ref) ?? this.tracks.get(ref);
          if (inherited) {
            track = inherited;
            break;
          }
        }
      }
      if (track) {
        this.tracks.set(number, track);
      } else {
        this.tracks.delete(number);
      }
      rows.push(`${number}\t${track ?? ""}`);
    }
    this.state.tracks.write(`${rows.join("\n")}\n`);
    this.tracksRead = this.host.deps.now();
  }

  private queueProgress(
    number: number,
    change: {
      status?: string;
      state?: string | null;
      round?: number | null;
      ci?: string;
      if?: string[];
      releaseOwner?: boolean;
    }
  ): void {
    if (!this.inScope(number)) {
      return;
    }
    const marker = this.state.pr(number).pendingProgress;
    const current = marker.exists() ? marker.readRequired() : {};
    const pending = { ...current, ...change };
    if (change.state !== undefined && change.if === undefined) {
      delete pending.if;
    }
    marker.write(pending);
  }

  private branchOf(number: number): string {
    return this.readMarker(this.state.pr(number).branch);
  }

  // ---------------------------------------------------------------- subscribed items

  private async pollSubscribedItems(): Promise<void> {
    const cursor = this.readCursor();
    if (cursor === null) {
      return;
    }
    const since = new Date(Date.parse(cursor) - CURSOR_OVERLAP_MS).toISOString();
    for (const repo of this.subscriptions) {
      if (this.isOwn(repo)) {
        continue;
      }
      const items = await this.restPages(
        (page) =>
          `/repos/${repo}/issues?state=all&since=${encodeURIComponent(since)}&sort=created&direction=asc&per_page=100&page=${page}`,
        (data) => this.list(data)
      );
      for (const item of items) {
        const number = count(item.number);
        const created = str(item.created_at);
        if (
          number === null ||
          !created ||
          Date.parse(created) < Date.parse(since) ||
          Date.parse(created) <= Date.parse(this.readMarker(this.state.listingBaseline))
        ) {
          continue;
        }
        if (this.muted(repo, number)) {
          continue;
        }
        const kind = item.pull_request === undefined ? "issue" : "pr";
        const url = str(item.html_url) || this.threadUrl(repo, number, kind);
        const person = this.host.filter.accept(
          {
            author: restActor(item.user),
            editor: null,
            lastEditedAt: null,
            repository: { nameWithOwner: repo, owner: { login: repo.split("/")[0] } },
          },
          repo.split("/")[0],
          url
        );
        if (
          !person ||
          (this.comments.isSelf(item) &&
            this.writes.matches({ kind: "created", repo, number }, created))
        ) {
          continue;
        }
        this.produceOnce(
          `new-${slug(repo)}#${number}`,
          "new",
          `NEW ${this.ref(repo, number)} (${kind}) from ${person.login} (${person.role})${this.previewText(person, str(item.title))} ${url}`
        );
      }
    }
  }

  // ---------------------------------------------------------------- assignments

  private async pollAssigned(): Promise<void> {
    const keep = new Set<string>();
    for (const repo of this.subscriptions) {
      const items = await this.restPages(
        (page) =>
          `/repos/${repo}/issues?state=open&assignee=${encodeURIComponent(this.me ?? "")}&per_page=100&page=${page}`,
        (data) => this.list(data)
      );
      for (const item of items) {
        const number = count(item.number);
        if (number === null) {
          continue;
        }
        const own = this.isOwn(repo);
        if (own && !this.known.has(number)) {
          await this.trackOne(number);
        }
        if ((own && !this.inScope(number)) || this.muted(repo, number)) {
          continue;
        }
        const marker = own ? `mine-${number}` : `mine-${slug(repo)}#${number}`;
        keep.add(marker);
        if (this.marked(this.state.once(marker))) {
          continue;
        }
        const kind = item.pull_request === undefined ? "ISSUE" : "PR";
        const person = this.host.filter.identity(restActor(item.user));
        const line = `ASSIGNED ${this.ref(repo, number)} (${kind})${this.previewText(person, str(item.title))} ${this.threadUrl(repo, number, kind)}`;
        if (this.firstRun) {
          this.mark(this.state.once(marker));
        } else {
          const event = await this.assignmentEvent(repo, number, "AssignedEvent", [this.me ?? ""]);
          if (this.ownAssignment(event, repo, number, "assigned")) {
            this.mark(this.state.once(marker));
          } else {
            this.produceOnce(marker, "assigned", `${line}${this.siblingActor(event)}`);
          }
        }
      }
    }
    for (const name of readdirSync(this.dir)) {
      if (name.startsWith("mine-") && !keep.has(name)) {
        this.state.once(name).remove();
      }
    }
  }

  private async assignmentEvent(
    repo: string,
    number: number,
    type: string,
    assignees: string[]
  ): Promise<ObjectData> {
    const [owner, name] = repo.split("/");
    const selection = `timelineItems(first: 100, after: $cursor, itemTypes: [ASSIGNED_EVENT, UNASSIGNED_EVENT]) { nodes { __typename ... on AssignedEvent { createdAt actor { ${actorFields} } assignee { ... on User { login databaseId } ... on Bot { login databaseId } } } ... on UnassignedEvent { createdAt actor { ${actorFields} } assignee { ... on User { login databaseId } ... on Bot { login databaseId } } } } pageInfo { hasNextPage endCursor } }`;
    let latest: ObjectData = {};
    for await (const connection of pages(
      async (cursor) => {
        const data = object(
          await this.host.github.graphql(
            `query WatchAssignment($owner: String!, $name: String!, $number: Int!, $cursor: String) { repository(owner: $owner, name: $name) { item: issueOrPullRequest(number: $number) { ... on Issue { ${selection} } ... on PullRequest { ${selection} } } } }`,
            { owner, name, number, cursor }
          )
        );
        return object(object(data.repository).item).timelineItems;
      },
      {
        connectionError: "Missing assignment timeline",
        cursorError: "Invalid assignment pagination cursor",
        limit: PAGE_LIMIT,
        limitError: "Assignment timeline pagination limit reached",
      }
    )) {
      for (const event of this.list(connection.nodes)) {
        if (
          event.__typename === type &&
          assignees.some(
            (login) => login.toLowerCase() === str(object(event.assignee).login).toLowerCase()
          ) &&
          str(event.createdAt) >= str(latest.createdAt)
        ) {
          latest = event;
        }
      }
    }
    return latest;
  }

  private ownAssignment(event: ObjectData, repo: string, number: number, kind: string): boolean {
    return (
      count(object(event.actor).databaseId) === this.meId &&
      this.writes.matches(
        {
          kind,
          repo,
          number,
          field: "Assignee",
          value: str(object(event.assignee).login).toLowerCase(),
        },
        str(event.createdAt)
      )
    );
  }

  private siblingActor(event: ObjectData): string {
    const actor = object(event.actor);
    const login = str(actor.login);
    return count(actor.databaseId) === this.meId
      ? ` by ${/^[\w-]+$/.test(login) ? login : "unknown"} (this account, another session)`
      : "";
  }

  // ---------------------------------------------------------------- board

  // ---------------------------------------------------------------- workers and budget

  private async checkBudget(): Promise<void> {
    const budget = this.host.github.budget();
    const now = this.host.deps.now();
    this.nextBoardAt = 0;
    for (const [resource, status] of Object.entries(budget.resources)) {
      if (status.reset * 1000 <= now) {
        continue;
      }
      const until = new Date(status.reset * 1000).toISOString();
      if (status.remaining <= this.reserve + 1) {
        this.produceOnce(
          `budget-${resource}-${Math.floor(status.reset)}`,
          "budget",
          `BUDGET: ${status.remaining} ${resource} points left of ${status.limit}; polls slow until ${until}; comments and assignments continue`
        );
      }
    }
    const graphql = budget.resources.graphql;
    const interval = this.pacing.observe(graphql, this.reserve, now);
    // The main watch loop already supplies the ten-second floor. Explicit
    // pollOnce calls remain immediate unless the account needs slower pacing.
    this.nextBoardAt =
      graphql && interval >= graphql.reset * 1000 - now
        ? graphql.reset * 1000
        : interval > INTERVAL_MS
          ? this.boardPoller.observation.lastPollAt + interval
          : 0;
    const sizes = this.boardPoller.observation.reader.sizes;
    const cost = this.boardPoller.observation.reader.cost;
    const shape = `${this.boardPoller.observation.reader.pages}/${this.boardPoller.observation.reader.overflow}`;
    // One read is one poll observation; both debounce rules count it once. A
    // changed cost reports only after the new value has held for three
    // consecutive polls, and an interval deviation strictly beyond the
    // threshold (10% and one second) reports after three consecutive polls in
    // the same direction. A page or overflow boundary reports at once.
    let heldCost = false;
    let heldInterval = false;
    if (this.observedRead !== this.boardPoller.observation.reader.readId) {
      this.observedRead = this.boardPoller.observation.reader.readId;
      if (cost === this.reportedCost) {
        this.costStreak = 0;
      } else {
        this.costStreak = cost === this.pendingCost ? this.costStreak + 1 : 1;
        this.pendingCost = cost;
      }
      heldCost = this.costStreak >= 3;
      if (
        Math.abs(interval - this.reportedInterval) > Math.max(1000, this.reportedInterval * 0.1)
      ) {
        const direction = Math.sign(interval - this.reportedInterval);
        this.intervalStreak = direction === this.intervalDirection ? this.intervalStreak + 1 : 1;
        this.intervalDirection = direction;
      } else {
        this.intervalStreak = 0;
      }
      heldInterval = this.intervalStreak >= 3;
    }
    if (cost > 0 && (shape !== this.reportedShape || heldCost || heldInterval)) {
      this.host.deps.report(
        `watcher: board pages items=${sizes.items} labels=${sizes.labels} blockers=${sizes.blockedBy} sub-issues=${sizes.subIssues} reviews=${sizes.reviews}; measured cost=${cost} points/poll; interval=${Math.ceil(interval / 1000)}s`
      );
      this.reportedShape = shape;
      this.reportedCost = cost;
      this.reportedInterval = interval;
      this.costStreak = 0;
      this.intervalStreak = 0;
    }
    if (budget.secondaryUntil > now) {
      this.produceOnce(
        `budget-secondary-${Math.floor(budget.secondaryUntil / 1000)}`,
        "budget-secondary",
        `BUDGET (secondary): honoring retry-after until ${new Date(budget.secondaryUntil).toISOString()}`
      );
    }
  }
}
