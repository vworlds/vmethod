import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type { Config } from "../config.js";
import { parseProgress, renderProgress, revivedProgressStates } from "../board/progress.js";
import { readState } from "../board/readme.js";
import type { BoardService } from "./board.js";
import {
  GitHubClient,
  BudgetPause,
  GraphQLResponseError,
  OpencodeClient,
  type Dependencies,
  type WorkerStatus,
} from "./client.js";
import { stateRoot, type Digest } from "./digest.js";
import { object, type ObjectData, type PeopleFilter, type Person } from "./people.js";
import { repoOf, restActor } from "./queries.js";

const INTERVAL_MS = 10_000;
const WORKER_EVERY = 6;
const STALE_MS = 30 * 60_000;
const SILENT_MS = 40 * 60_000;
const BUTTON_RETRY_MS = 10 * 60_000;
const TRACKS_TTL_MS = 30_000;
const NEXT_RECHECK_MS = 60_000;
const MIGRATION_WINDOW_MS = 60 * 60_000;
const HOLD_MAX_AGE_MS = 120_000;
const POLL_COST = 2;
const PAGE_LIMIT = 20;
const PREVIEW_LIMIT = 120;
const RED_CI = ["FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"];
const ID = /^[A-Za-z0-9_.@#-]{1,160}$/;

export interface WatchEvent {
  /** Ack key: the event's dedup key for once events, stable across restarts. */
  id: string;
  kind: string;
  /** One printed line: metadata only, plus the owner's opt-in untrusted preview. */
  line: string;
  /** Minor-event lines riding this event (the quiet digest), printed before it. */
  quiet?: string[];
}

export interface SessionInput {
  track?: string;
  only?: number[];
  skip?: number[];
}

export interface ResolvedSession {
  stateName: string;
  track: string | null;
  only: number[] | null;
  skip: number[] | null;
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
  board: Pick<BoardService, "set">;
  digest: Digest;
}

interface PendingEvent {
  id: string;
  kind: string;
  line: string;
  once: boolean;
  quiet?: string[];
}

interface PrInfo {
  number: number;
  branch: string;
  sha: string;
  base: string;
  created: string;
  title: string;
  user: ObjectData;
  mergeable: string;
}

interface CardInfo {
  id: string;
  repo: string;
  number: number;
  kind: "ISSUE" | "PR";
  state: string;
  column: string;
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
export function procStart(stat: string | null): number | null {
  if (stat === null) {
    return null;
  }
  const fields = stat
    .slice(stat.lastIndexOf(")") + 1)
    .trim()
    .split(/\s+/);
  const value = Number(fields[19]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

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
  /* eslint-disable no-control-regex -- deliberately strip terminal control sequences */
  return text
    .replace(/\u{1B}\[[0-9;?]*[ -/]*[@-~]/gu, "")
    .replace(/\u{1B}\][^\u{07}\u{1B}]*(?:\u{07}|\u{1B}\\)?/gu, "")
    .replace(/[\u{0000}-\u{001F}\u{007F}-\u{009F}]/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/\p{Cf}/gu, "")
    .replace(/«/g, "‹")
    .replace(/»/g, "›")
    .trim()
    .slice(0, PREVIEW_LIMIT)
    .trimEnd();
  /* eslint-enable no-control-regex */
}

function normalizeNumbers(value: unknown): number[] | null {
  if (value === undefined) {
    return null;
  }
  if (!Array.isArray(value) || !value.length) {
    throw new Error("Expected a nonempty list of item numbers");
  }
  const numbers = value.map((entry) => {
    const parsed = count(entry);
    if (parsed === null) {
      throw new Error("Expected positive item numbers");
    }
    return parsed;
  });
  return [...new Set(numbers)].sort((a, b) => a - b);
}

export function resolveSession(config: Config, input: SessionInput): ResolvedSession {
  const track =
    input.track ?? (typeof config.track === "string" && config.track ? config.track : null);
  if (track !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(track)) {
    throw new Error("Invalid track name");
  }
  const only = normalizeNumbers(input.only);
  const skip = normalizeNumbers(input.skip);
  if ([track !== null, only !== null, skip !== null].filter(Boolean).length > 1) {
    throw new Error("Choose one session: --track, --only or --skip");
  }
  const base = String(config.stateName ?? String(config.repo).replace("/", "-"));
  const suffix =
    track !== null
      ? `-${track}`
      : only !== null
        ? `-only-${only.join("-")}`
        : skip !== null
          ? `-skip-${skip.join("-")}`
          : "";
  return { stateName: `${base}${suffix}`, track, only, skip };
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

function readLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function atomicWrite(path: string, text: string): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}

function remove(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
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

function changeMute(
  config: Config,
  env: NodeJS.ProcessEnv,
  thread: ThreadRef,
  add: boolean
): string {
  const dir = stateRoot(env, resolveSession(config, {}).stateName);
  const path = join(dir, "mutes");
  const entry = `${thread.repo.toLowerCase()}#${thread.number}`;
  const current = readLines(path);
  const present = current.includes(entry);
  if (add === present) {
    return `${thread.repo}#${thread.number} is ${add ? "already muted" : "not muted"}`;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWrite(
    path,
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
  const lines = readLines(join(stateRoot(env, resolveSession(config, {}).stateName), "mutes"));
  return [`Muted: ${lines.length}`, ...lines].join("\n");
}

export function rememberBoardMove(
  config: Config,
  env: NodeJS.ProcessEnv,
  itemId: string,
  column: string
): void {
  if (!ID.test(itemId)) {
    throw new Error("Invalid board item id");
  }
  const dir = join(stateRoot(env, resolveSession(config, {}).stateName), "board");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWrite(join(dir, itemId), `${column}\n`);
}

/**
 * One event loop per session (state directory): the server polls GitHub through the
 * gateway client, filters every author through people.yaml, and hands the client
 * metadata-only wake-up lines. Events are acknowledged only after the client
 * printed them, so a kill between fetch and print loses nothing.
 */
export class EventLoop {
  private readonly dir: string;
  private readonly session: ResolvedSession;
  private readonly own: string;
  private readonly org: string;
  private readonly subscriptions: string[];
  private readonly taskBranch: RegExp;
  private readonly worktreeRoot: string;
  private readonly reserve: number;
  private readonly preview: boolean;
  private readonly boardEnabled: boolean;
  private readonly owners: Set<string>;
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
  private readonly cycleStale = new Set<number>();
  private inprogress: { number: number; branch: string }[] = [];
  private observedPrs: PrInfo[] = [];
  private nextBoardAt = 0;
  private lastBoardAt = 0;
  private nextSignature = "";
  private nextAt = 0;
  private opencode?: OpencodeClient;
  private opencodeError = "";
  private reading = false;
  private budgetDeferred = false;
  private releaseLock?: () => void;

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
    input: SessionInput
  ) {
    const config = host.config;
    this.session = resolveSession(config, input);
    this.dir = stateRoot(host.env, this.session.stateName);
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
    this.worktreeRoot = str(branches.worktreeRoot) || ".worktrees";
    const reserve = object(config.gateway).reserve;
    this.reserve = typeof reserve === "number" ? reserve : 100;
    this.preview = object(config.watch).preview === true;
    this.boardEnabled = object(config.board).enabled !== false;
    this.owners = new Set(
      host.filter.people
        .filter((person) => person.role === "owner")
        .map((person) => person.login.toLowerCase())
    );
  }

  async nextEvents(input: { timeoutSeconds: unknown; ack?: unknown }): Promise<{
    events: WatchEvent[];
  }> {
    if (this.reading) {
      throw new Error("watch: another reader is already waiting for this session");
    }
    this.reading = true;
    try {
      return await this.readEvents(input);
    } finally {
      this.reading = false;
    }
  }

  private async readEvents(input: {
    timeoutSeconds: unknown;
    ack?: unknown;
  }): Promise<{ events: WatchEvent[] }> {
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
    this.start();
    this.applyAck((input.ack ?? []) as string[]);
    // Zero timeout is the ack-only operation used by --once; do not fetch unprinted events.
    if (input.timeoutSeconds === 0 || this.pending().length) {
      return { events: this.buildBatch() };
    }
    const deadline = this.host.deps.now() + input.timeoutSeconds * 1000;
    for (;;) {
      await this.pollOnce();
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

  private nextSleep(): number {
    return this.fails > 0
      ? Math.min(INTERVAL_MS * 2 ** Math.min(this.fails, 5), 300_000)
      : INTERVAL_MS;
  }

  // ---------------------------------------------------------------- state files

  private mark(name: string): void {
    if (!ID.test(name)) {
      throw new Error(`Invalid watcher state marker: ${name}`);
    }
    writeFileSync(join(this.dir, name), "", { mode: 0o600 });
  }

  private marked(name: string): boolean {
    return existsSync(join(this.dir, name));
  }

  private readMarker(name: string): string {
    try {
      return readFileSync(join(this.dir, name), "utf8").trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "";
      }
      throw error;
    }
  }

  private pending(): PendingEvent[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(this.dir, "pending.json"), "utf8"));
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
    atomicWrite(join(this.dir, "pending.json"), JSON.stringify(events));
  }

  private produceOnce(id: string, kind: string, line: string): boolean {
    if (this.marked(id) || this.pending().some((event) => event.id === id)) {
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
          this.mark(event.id);
        }
      } else {
        keep.push(event);
      }
    }
    this.savePending(keep);
  }

  private quiet(line: string): void {
    appendFileSync(join(this.dir, "quiet"), `${line}\n`, { mode: 0o600 });
  }

  private quietOnce(id: string, line: string): void {
    if (this.marked(id)) {
      return;
    }
    this.quiet(line);
    this.mark(id);
  }

  private buildBatch(): WatchEvent[] {
    const events = this.pending();
    if (events.length) {
      const lines = readLines(join(this.dir, "quiet"));
      if (lines.length) {
        events[0] = { ...events[0], quiet: [...(events[0].quiet ?? []), ...lines] };
        this.savePending(events);
        writeFileSync(join(this.dir, "quiet"), "", { mode: 0o600 });
      }
    }
    return events.map(({ id, kind, line, quiet }) => ({
      id,
      kind,
      line,
      ...(quiet ? { quiet } : {}),
    }));
  }

  private readCursor(): string | null {
    const value = this.readMarker("cursor");
    if (!value) {
      return null;
    }
    if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
      throw new Error("Invalid watcher cursor; refusing to replay history");
    }
    return value;
  }

  private mutes(): Set<string> {
    return new Set(readLines(join(this.dir, "mutes")));
  }

  private muted(repo: string, number: number): boolean {
    return this.mutes().has(`${repo.toLowerCase()}#${number}`);
  }

  private unmuteThread(repo: string, number: number): void {
    const entry = `${repo.toLowerCase()}#${number}`;
    const path = join(this.dir, "mutes");
    atomicWrite(
      path,
      `${readLines(path)
        .filter((line) => line !== entry)
        .sort()
        .join("\n")}\n`
    );
  }

  private mentionsMe(body: string): boolean {
    return new RegExp(`@${this.me}(?![A-Za-z0-9-])`, "i").test(body);
  }

  private activityAt(number: number): string {
    const value = this.readMarker(`activity-${number}`);
    return /^\d{4}-\d{2}-\d{2}T/.test(value) ? value : "";
  }

  private touchActivity(number: number, at: string): void {
    if (!at || at <= this.activityAt(number)) {
      return;
    }
    atomicWrite(join(this.dir, `activity-${number}`), `${at}\n`);
  }

  private readReview(number: number): { at: string; id: string } | null {
    const parsed = object(safeJson(this.readMarker(`review-${number}`)));
    return typeof parsed.at === "string" && typeof parsed.id === "string"
      ? { at: parsed.at, id: parsed.id }
      : null;
  }

  private writeReview(number: number, review: { at: string; id: string }): void {
    atomicWrite(join(this.dir, `review-${number}`), JSON.stringify(review));
  }

  // ---------------------------------------------------------------- start and lock

  private start(): void {
    if (this.started) {
      return;
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    mkdirSync(join(this.dir, "board"), { recursive: true, mode: 0o700 });
    this.acquireLock();
    this.importLegacy();
    this.loadTracksCache();
    this.started = true;
  }

  private acquireLock(): void {
    const path = join(this.dir, "lock");
    const start = procStart(this.host.deps.readProc(this.host.deps.pid));
    if (start === null) {
      throw new Error("watcher lock requires /proc/<pid>/stat (Linux)");
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const fd = openSync(path, "wx", 0o600);
        writeFileSync(
          fd,
          `${JSON.stringify({
            pid: this.host.deps.pid,
            start,
            at: new Date(this.host.deps.now()).toISOString(),
          })}\n`,
          { mode: 0o600 }
        );
        closeSync(fd);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        let holderText: string;
        try {
          holderText = readFileSync(path, "utf8");
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === "ENOENT" && attempt < 2) {
            continue;
          }
          throw readError;
        }
        const holder = object(safeJson(holderText));
        if (count(holder.pid) === null && this.host.deps.now() - statSync(path).mtimeMs < 60_000) {
          throw new Error("watch: another watcher is initializing the lock; retry shortly", {
            cause: error,
          });
        }
        const holderPid = count(holder.pid);
        const holderStart = procStart(
          holderPid === null ? null : this.host.deps.readProc(holderPid)
        );
        // The same PID with a different start time is a reused PID: stale, not alive.
        if (holderPid !== null && holderStart !== null && holderStart === holder.start) {
          throw new Error(`watch: another watcher (pid ${holderPid}) holds ${this.dir}`, {
            cause: error,
          });
        }
        if (attempt >= 2) {
          throw new Error(`watch: cannot clear the stale watcher lock in ${this.dir}`, {
            cause: error,
          });
        }
        // Another contender may already have replaced this stale file.
        if (readFileSync(path, "utf8") !== holderText) {
          continue;
        }
        unlinkSync(path);
      }
    }
    // A graceful exit clears our own lock; a crash leaves it to the staleness check.
    this.releaseLock = () => {
      try {
        const holder = object(safeJson(readFileSync(path, "utf8")));
        if (count(holder.pid) === this.host.deps.pid && holder.start === start) {
          unlinkSync(path);
        }
      } catch {
        /* an exit handler must never throw */
      }
    };
    process.once("exit", this.releaseLock);
  }

  private importLegacy(): void {
    const marker = join(this.dir, "legacy-imported");
    if (existsSync(marker)) {
      return;
    }
    const root = dirname(dirname(this.dir));
    const sources = [
      join(root, `vecs-watch${this.session.track !== null ? `-${this.session.track}` : ""}`),
      ...(this.session.track !== null ? [] : [join(root, "spacerocks-watch")]),
    ].filter((source) => existsSync(source));
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
          copyFileSync(join(source, entry.name), join(this.dir, entry.name));
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
          copyFileSync(join(board, entry.name), join(this.dir, "board", entry.name));
        }
      }
    }
    atomicWrite(marker, `${sources.join("\n")}\n`);
  }

  private loadTracksCache(): void {
    for (const line of readLines(join(this.dir, "tracks"))) {
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
    for (let page = 1; page <= PAGE_LIMIT; page++) {
      const collected = collect(await this.restRead(() => this.host.github.rest(path(page))));
      items.push(...collected);
      if (collected.length < 100) {
        return items;
      }
    }
    throw new Error("Watcher pagination limit reached");
  }

  private list(value: unknown): ObjectData[] {
    return Array.isArray(value) ? value.map(object) : [];
  }

  // ---------------------------------------------------------------- polling

  private async step(name: string, run: () => Promise<void>): Promise<boolean> {
    try {
      await run();
      return true;
    } catch (error) {
      if (error instanceof BudgetPause) {
        this.budgetDeferred = true;
        return false;
      }
      this.host.deps.report(`watcher: ${name} failed: ${(error as Error).message}`);
      return false;
    }
  }

  private async pollOnce(): Promise<void> {
    await this.host.github.polling(() => this.runPoll());
  }

  private async runPoll(): Promise<void> {
    this.budgetDeferred = false;
    this.start();
    this.firstRun = this.readCursor() === null;
    const startedAt = new Date(this.host.deps.now()).toISOString();
    this.cycle++;
    this.cycleStale.clear();
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
    const pullsOk = await this.step("pull requests", () => this.pollPulls());
    const commentsOk = await this.step("comments", () => this.pollComments());
    if (commentsOk && pullsOk) {
      for (const pr of this.observedPrs) {
        this.watchStale(pr);
      }
    }
    const itemsOk = await this.step("subscribed items", () => this.pollSubscribedItems());
    const assignedOk = await this.step("assignments", () => this.pollAssigned());
    const boardOk = await this.step("board", () => this.pollBoard());
    const workersOk = await this.step("worker sessions", () => this.pollWorkers());
    await this.step("budget", () => this.checkBudget());
    ok = ok && pullsOk && commentsOk && itemsOk && assignedOk && boardOk && workersOk;
    if (commentsOk && itemsOk && (!this.firstRun || ok)) {
      // Do not leave first-run mode until every baseline succeeded.
      this.writeMarker("cursor", startedAt);
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

  private writeMarker(name: string, text: string): void {
    if (!ID.test(name)) {
      throw new Error(`Invalid watcher state marker: ${name}`);
    }
    atomicWrite(join(this.dir, name), `${text}\n`);
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
    atomicWrite(join(this.dir, "tracks"), `${rows.join("\n")}\n`);
    this.tracksRead = this.host.deps.now();
  }

  // ---------------------------------------------------------------- pull requests

  private async pollPulls(): Promise<void> {
    this.observedPrs = [];
    const items = await this.restPages(
      (page) => `/repos/${this.own}/pulls?state=open&per_page=100&page=${page}`,
      (data) => this.list(data)
    );
    const open = new Set<number>();
    for (const item of items) {
      const number = count(item.number);
      const head = object(item.head);
      const branch = str(head.ref);
      const sha = str(head.sha);
      if (
        number === null ||
        !branch ||
        !/^[a-f\d]{40}$/i.test(sha) ||
        !this.taskBranch.test(branch)
      ) {
        continue;
      }
      if (!this.inScope(number)) {
        continue;
      }
      open.add(number);
      if (this.muted(this.own, number)) {
        continue;
      }
      const detail =
        this.cycle % WORKER_EVERY === 1
          ? object(
              await this.restRead(() => this.host.github.rest(`/repos/${this.own}/pulls/${number}`))
            )
          : {};
      this.subjectPreviews.set(`${this.own.toLowerCase()}#${number}`, {
        title: str(item.title),
        person: this.host.filter.identity(restActor(item.user)),
      });
      if (this.host.filter.identity(restActor(item.user)) === undefined) {
        this.host.digest.drop(this.threadUrl(this.own, number, "PR"));
        continue;
      }
      await this.processOpenPr({
        number,
        branch,
        sha,
        base: str(object(item.base).ref),
        created: str(item.created_at),
        title: str(item.title),
        user: object(item.user),
        mergeable:
          detail.mergeable === false
            ? "CONFLICTING"
            : detail.mergeable === true
              ? "MERGEABLE"
              : "UNKNOWN",
      });
    }
    for (const name of readdirSync(this.dir)) {
      const match = /^open-(\d+)$/.exec(name);
      const number = match ? count(match[1]) : null;
      if (number !== null && !open.has(number)) {
        await this.processGonePr(number);
      }
    }
    if (this.cycle % WORKER_EVERY === 1) {
      for (const item of items) {
        const number = count(item.number);
        const branch = str(object(item.head).ref);
        if (number !== null && open.has(number) && branch && !this.muted(this.own, number)) {
          await this.pollPrDetails(number, branch, str(object(item.head).sha));
        }
      }
    }
  }

  private async processOpenPr(pr: PrInfo): Promise<void> {
    const url = this.threadUrl(this.own, pr.number, "PR");
    atomicWrite(join(this.dir, `branch-${pr.number}`), `${pr.branch}\n`);
    if (!this.marked(`open-${pr.number}`)) {
      this.mark(`open-${pr.number}`);
      atomicWrite(join(this.dir, `head-${pr.number}`), `${pr.sha}\n`);
      this.touchActivity(pr.number, pr.created);
    }
    if (this.firstRun && !this.marked(`seeded-${pr.number}`)) {
      await this.seedPrComments(pr);
      this.mark(`seeded-${pr.number}`);
    }
    const oldHead = this.readMarker(`head-${pr.number}`);
    if (oldHead !== pr.sha) {
      if (oldHead) {
        this.queueProgress(pr.number, { state: "working", if: revivedProgressStates });
        this.touchActivity(pr.number, new Date(this.host.deps.now()).toISOString());
      }
      atomicWrite(join(this.dir, `head-${pr.number}`), `${pr.sha}\n`);
    }
    if (pr.mergeable === "CONFLICTING") {
      if (
        this.produceOnce(
          `conflict-${pr.number}-${pr.sha}`,
          "conflict",
          `CONFLICT #${pr.number} (${pr.branch}): its worker must merge origin/${pr.base} and push${this.previewFromSubject(this.own, pr.number)} ${url}`
        )
      ) {
        this.writeMarker(`conflict-${pr.number}`, pr.sha);
        this.queueProgress(pr.number, { state: "conflict" });
      }
    } else if (pr.mergeable === "MERGEABLE" && this.marked(`conflict-${pr.number}`)) {
      remove(join(this.dir, `conflict-${pr.number}`));
      this.queueProgress(pr.number, { state: "working", if: ["conflict"] });
    }
    this.observedPrs.push(pr);
  }

  private watchStale(pr: PrInfo): void {
    const url = this.threadUrl(this.own, pr.number, "PR");
    const review = this.readReview(pr.number);
    const activity = this.activityAt(pr.number);
    if (
      review &&
      activity &&
      activity <= review.at &&
      Date.parse(review.at) <= this.host.deps.now() - STALE_MS
    ) {
      this.cycleStale.add(pr.number);
      if (
        this.produceOnce(
          `s-${key(review.id)}`,
          "stale",
          `PR #${pr.number} (${pr.branch}): STALE: no worker reply for 30+ min after my review ${url}`
        )
      ) {
        this.queueProgress(pr.number, { state: "idle", if: ["working"] });
      }
    }
  }

  /** First run records the current comments of each task PR: activity and my last review. */
  private async seedPrComments(pr: PrInfo): Promise<void> {
    const comments = await this.restPages(
      (page) =>
        `/repos/${this.own}/issues/${pr.number}/comments?per_page=100&sort=created&direction=desc&page=${page}`,
      (data) => this.list(data)
    );
    for (const comment of comments) {
      const created = str(comment.created_at);
      if (!created) {
        continue;
      }
      this.touchActivity(pr.number, created);
      if (this.isSelf(comment)) {
        const first = str(comment.body).split(/\r?\n/)[0];
        if (/^\[orchestrator\] (?:CHANGES|ANSWER|GO)\b/.test(first)) {
          if (created >= (this.readReview(pr.number)?.at ?? "")) {
            this.writeReview(pr.number, { at: created, id: str(comment.html_url) });
          }
        }
      }
    }
  }

  private async pollPrDetails(number: number, branch: string, sha: string): Promise<void> {
    const commits = await this.restPages(
      (page) => `/repos/${this.own}/pulls/${number}/commits?per_page=100&page=${page}`,
      (data) => this.list(data)
    );
    const last = commits.at(-1);
    if (last) {
      const commit = object(last.commit);
      this.touchActivity(
        number,
        str(object(commit.committer).date) || str(object(commit.author).date)
      );
    }
    if (commits.length > 1 && !this.marked(`picked-${number}`)) {
      if (!this.firstRun) {
        this.quietOnce(
          `picked-${number}`,
          `NOTE PR #${number} (${branch}): picked up (${commits.length} commits)`
        );
      } else {
        this.mark(`picked-${number}`);
      }
    }
    const url = this.threadUrl(this.own, number, "PR");
    const runs = await this.restPages(
      (page) => `/repos/${this.own}/commits/${sha}/check-runs?per_page=100&page=${page}`,
      (data) => this.list(object(data).check_runs)
    );
    const red = runs.some(
      (run) =>
        this.host.filter.check(run, this.org, url) !== undefined &&
        RED_CI.includes(str(run.conclusion).toUpperCase())
    );
    const state = red ? "red" : "ok";
    if (this.readMarker(`ci-${number}`) !== state) {
      atomicWrite(join(this.dir, `ci-${number}`), `${state}\n`);
      this.queueProgress(number, { ci: state });
    }
  }

  private async processGonePr(number: number): Promise<void> {
    if (this.muted(this.own, number)) {
      return;
    }
    if (!this.inScope(number)) {
      remove(join(this.dir, `open-${number}`));
      return;
    }
    const url = this.threadUrl(this.own, number, "PR");
    const data = object(
      await this.restRead(() => this.host.github.rest(`/repos/${this.own}/pulls/${number}`))
    );
    const person = this.host.filter.identity(restActor(data.user));
    if (data.merged === true && this.marked(`merged-${number}`)) {
      // Our own merge-task follow-up: not news.
      remove(join(this.dir, `merged-${number}`));
      this.clearPrState(number);
      this.queueProgress(number, { state: null, round: null, ci: "ok" });
      return;
    }
    if (data.merged === true) {
      // Owner button merge: the watcher stays read-only; the orchestrator runs the follow-up.
      const attempted = Number(this.readMarker(`merge-attempt-${number}`)) * 1000;
      if (this.host.deps.now() - attempted < BUTTON_RETRY_MS) {
        return;
      }
      const at = Math.floor(this.host.deps.now() / 1000);
      this.emit(
        `button-${number}@${at}`,
        "button-merge",
        `PR #${number} MERGED by owner: run merge-task${this.previewText(person, str(data.title))} ${url}`
      );
      atomicWrite(join(this.dir, `merge-attempt-${number}`), `${at}\n`);
      this.queueProgress(number, { state: null, round: null, ci: "ok" });
      return;
    }
    if (data.state === "closed" && str(data.closed_at)) {
      this.emit(
        `closed-${number}@${key(str(data.closed_at))}`,
        "closed",
        `PR #${number} is now CLOSED${this.previewText(person, str(data.title))} ${url}`
      );
      this.clearPrState(number);
      this.queueProgress(number, { state: null, round: null, ci: "ok" });
    }
    // Still open (a listing lag): keep the marker and look again next poll.
  }

  private clearPrState(number: number): void {
    for (const name of [
      `open-${number}`,
      `head-${number}`,
      `branch-${number}`,
      `ci-${number}`,
      `conflict-${number}`,
      `merge-attempt-${number}`,
      `activity-${number}`,
      `review-${number}`,
      `seeded-${number}`,
    ]) {
      remove(join(this.dir, name));
    }
  }

  private queueProgress(
    number: number,
    change: {
      status?: string;
      state?: string | null;
      round?: number | null;
      ci?: string;
      if?: string[];
    }
  ): void {
    if (!this.inScope(number)) {
      return;
    }
    const path = join(this.dir, `pending-progress-${number}`);
    const current = existsSync(path) ? object(safeJson(readFileSync(path, "utf8"))) : {};
    const pending = { ...current, ...change };
    if (change.state !== undefined && change.if === undefined) {
      delete pending.if;
    }
    atomicWrite(path, JSON.stringify(pending));
  }

  // ---------------------------------------------------------------- comments

  private async pollComments(): Promise<void> {
    const since = this.readCursor() ?? new Date(this.host.deps.now()).toISOString();
    for (const repo of this.subscriptions) {
      const comments = await this.restPages(
        (page) =>
          `/repos/${repo}/issues/comments?since=${encodeURIComponent(since)}&sort=created&direction=asc&per_page=100&page=${page}`,
        (data) => this.list(data)
      );
      for (const comment of comments) {
        if (this.firstRun && str(comment.created_at) <= since) {
          this.mark(`c-${key(str(comment.html_url))}`);
          continue;
        }
        await this.processComment(repo, comment);
      }
    }
  }

  private isSelf(comment: ObjectData): boolean {
    const id = count(restActor(comment.user).databaseId);
    return id !== null && id === this.meId;
  }

  private async processComment(repo: string, comment: ObjectData): Promise<void> {
    const number = count(str(comment.issue_url).split("/").at(-1));
    const url = str(comment.html_url);
    const body = str(comment.body);
    const created = str(comment.created_at);
    const login = str(object(comment.user).login);
    if (number === null || !url || !created) {
      throw new Error("Invalid comment payload");
    }
    const own = this.isOwn(repo);
    if (own && !this.known.has(number)) {
      await this.trackOne(number);
    }
    if (own && !this.inScope(number)) {
      return;
    }
    const person = this.host.filter.accept(
      {
        author: restActor(comment.user),
        editor: null,
        lastEditedAt: null,
        repository: { nameWithOwner: repo, owner: { login: repo.split("/")[0] } },
      },
      repo.split("/")[0],
      url
    );
    if (!person && !this.isSelf(comment)) {
      return;
    }
    const commentKey = `c-${key(url)}`;
    if (
      !this.isSelf(comment) &&
      (this.marked(commentKey) || this.pending().some((event) => event.id === commentKey))
    ) {
      return;
    }
    if (this.muted(repo, number)) {
      if (this.mentionsMe(body)) {
        this.unmuteThread(repo, number);
      } else {
        return;
      }
    }
    const firstLine = body.split(/\r?\n/)[0];
    const edited = created !== str(comment.updated_at) ? " (edited: verify editor)" : "";
    const taskPr = own && this.marked(`open-${number}`);
    if (this.isSelf(comment)) {
      // Only the watching orchestrator's own comments are skipped; matched by id.
      if (taskPr) {
        this.touchActivity(number, created);
        if (/^\[orchestrator\] (?:CHANGES|ANSWER|GO)\b/.test(firstLine)) {
          this.writeReview(number, { at: created, id: url });
        }
      }
      if (own && /^\[orchestrator\] (?:ANSWER|GO)\b/.test(firstLine)) {
        this.queueProgress(number, { state: taskPr ? "working" : null });
      }
      return;
    }
    if (!person) {
      return;
    }
    if (taskPr && person.role === "worker") {
      this.touchActivity(number, created);
      this.queueProgress(number, { state: "working", if: revivedProgressStates });
    }
    let subject = this.subjectPreviews.get(`${repo.toLowerCase()}#${number}`);
    if (this.preview && !subject) {
      const item = object(
        await this.restRead(() => this.host.github.rest(`/repos/${repo}/issues/${number}`))
      );
      subject = { title: str(item.title), person };
      this.subjectPreviews.set(`${repo.toLowerCase()}#${number}`, subject);
    }
    const preview = edited ? "" : this.previewText(person, `${subject?.title ?? ""} ${firstLine}`);
    // REST cannot identify the editor. Wake for verification, never execute an edited tag.
    const workerTag = edited
      ? null
      : /^\[worker\] (READY|QUESTION|DESIGN|BLOCKED|HANDOFF)\b/.exec(firstLine);
    const round = /round\s+(\d+)/i.exec(firstLine);
    if (taskPr && person.role === "worker" && workerTag) {
      if (
        this.produceOnce(
          `c-${key(url)}`,
          workerTag[1].toLowerCase(),
          `PR #${number} (${this.branchOf(number)}): worker ${workerTag[1]}${round ? ` (round ${round[1]})` : ""} from ${login} (${person.role})${preview} ${url}`
        )
      ) {
        this.touchActivity(number, created);
        if (workerTag[1] === "READY") {
          this.queueProgress(number, {
            status: "In review",
            state: "ready",
            ...(round ? { round: count(round[1]) } : {}),
          });
        } else {
          this.queueProgress(number, { state: workerTag[1].toLowerCase() });
        }
      }
      return;
    }
    if (!edited && /^\[worker\]/.test(firstLine) && person.role === "worker" && !workerTag) {
      this.touchActivity(number, created);
      if (taskPr) {
        this.queueProgress(number, { state: "working", if: revivedProgressStates });
        this.quietOnce(
          `c-${key(url)}`,
          `NOTE PR #${number} (${this.branchOf(number)}): worker note from ${login} (${person.role})${preview} ${url}`
        );
      } else {
        this.quietOnce(
          `c-${key(url)}`,
          `NOTE ${this.ref(repo, number)}: worker note from ${login} (${person.role})${preview} ${url}`
        );
      }
      return;
    }
    // Peer orchestrators wake on our threads too: a peer may ask, never approve.
    if (
      this.produceOnce(
        `c-${key(url)}`,
        "comment",
        `COMMENT ${this.ref(repo, number)} from ${login} (${person.role})${edited}${preview} ${url}`
      ) &&
      taskPr
    ) {
      this.touchActivity(number, created);
    }
  }

  private branchOf(number: number): string {
    return this.readMarker(`branch-${number}`);
  }

  // ---------------------------------------------------------------- subscribed items

  private async pollSubscribedItems(): Promise<void> {
    const since = this.readCursor();
    if (since === null) {
      return;
    }
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
        if (number === null || !created || created < since) {
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
        if (!person) {
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
        if (this.marked(marker)) {
          continue;
        }
        const kind = item.pull_request === undefined ? "ISSUE" : "PR";
        const person = this.host.filter.identity(restActor(item.user));
        const line = `ASSIGNED ${this.ref(repo, number)} (${kind})${this.previewText(person, str(item.title))} ${this.threadUrl(repo, number, kind)}`;
        if (this.firstRun) {
          this.mark(marker);
        } else {
          this.produceOnce(marker, "assigned", line);
        }
      }
    }
    for (const name of readdirSync(this.dir)) {
      if (name.startsWith("mine-") && !keep.has(name)) {
        remove(join(this.dir, name));
      }
    }
  }

  // ---------------------------------------------------------------- board

  private boardAllowed(): boolean {
    if (!this.boardEnabled) {
      return false;
    }
    const now = this.host.deps.now();
    if (this.host.github.budgetStopped() || now < this.nextBoardAt) {
      return false;
    }
    for (const status of Object.values(this.host.github.budget().resources)) {
      if (status.remaining <= this.reserve + 1 && status.reset * 1000 > now) {
        return false;
      }
    }
    return true;
  }

  private async pollBoard(): Promise<void> {
    if (!this.boardAllowed()) {
      return;
    }
    const settings = object(this.host.config.board);
    const owner = str(settings.owner);
    const number = count(settings.number);
    if (!owner || number === null) {
      throw new Error("Missing board configuration");
    }
    const cards = await this.readBoard(owner, number);
    this.lastBoardAt = this.host.deps.now();
    const migration = migrationActive(readState(cards.readme), this.host.deps.now(), (message) =>
      this.host.deps.report(`watcher: ${message}`)
    );
    this.inprogress = [];
    const ready: CardInfo[] = [];
    const approved: CardInfo[] = [];
    const present = new Set<string>();
    const theirs = new Set<string>();
    for (const card of cards.list) {
      present.add(card.id);
      this.subjectPreviews.set(`${card.repo.toLowerCase()}#${card.number}`, {
        title: card.title,
        person: card.person,
      });
      if (!this.isOwn(card.repo)) {
        // A foreign card assigned to me asks for a reply there, not for board authority.
        if (this.watchForeignAssignment(card)) {
          theirs.add(`theirs-${slug(card.repo)}-${card.number}`);
        }
        continue;
      }
      if (!this.known.has(card.number)) {
        await this.trackOne(card.number);
      }
      if (!this.inScope(card.number) || this.muted(card.repo, card.number)) {
        continue;
      }
      await this.applyProgress(card);
      if (card.kind === "PR" && card.column === "In progress") {
        this.inprogress.push({ number: card.number, branch: this.branchOf(card.number) });
      }
      this.watchAssignees(card);
      this.watchColumn(card, migration);
      if (
        card.kind === "ISSUE" &&
        card.state === "OPEN" &&
        card.column !== "Done" &&
        card.estimate === null &&
        !this.marked(`graded-${card.number}`) &&
        !existsSync(join(this.dir, "board", `graded-${card.number}`)) &&
        !this.marked(`grade-${card.number}`)
      ) {
        this.produceOnce(
          `grade-${card.number}`,
          "grade",
          `GRADE #${card.number} (ISSUE): no Estimate yet${this.previewText(card.person, card.title)} ${this.threadUrl(card.repo, card.number, "ISSUE")}`
        );
      }
      if (card.column === "Ready" && card.state === "OPEN") {
        ready.push(card);
      }
      if (card.column === "Approved" && card.kind === "ISSUE" && card.state === "OPEN") {
        approved.push(card);
      }
    }
    for (const name of readdirSync(join(this.dir, "board"))) {
      if (
        (!/^PVTI_/.test(name) && !/\.who$/.test(name)) ||
        present.has(name.replace(/\.who$/, ""))
      ) {
        continue;
      }
      remove(join(this.dir, "board", name));
    }
    for (const name of readdirSync(this.dir)) {
      if (name.startsWith("theirs-") && !theirs.has(name)) {
        remove(join(this.dir, name));
      }
    }
    await this.watchNext(ready, approved);
  }

  private async readBoard(
    owner: string,
    number: number
  ): Promise<{ readme: string; list: CardInfo[] }> {
    const cards: CardInfo[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    try {
      for (;;) {
        const data = object(
          await this.host.github.graphql(
            `query WatchBoard($owner: String!, $number: Int!, $cursor: String) { organization(login: $owner) { projectV2(number: $number) { id readme items(first: 100, after: $cursor, query: "-status:Done") { nodes { id status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } estimate: fieldValueByName(name: "Estimate") { ... on ProjectV2ItemFieldNumberValue { number } } progress: fieldValueByName(name: "Progress") { ... on ProjectV2ItemFieldTextValue { text } } content { __typename ... on Issue { number state title author { __typename login ... on User { databaseId } ... on Bot { databaseId } } repository { nameWithOwner owner { login } } assignees(first: 10) { nodes { login } } } ... on PullRequest { number state title author { __typename login ... on User { databaseId } ... on Bot { databaseId } } repository { nameWithOwner owner { login } } assignees(first: 10) { nodes { login } } } } } pageInfo { hasNextPage endCursor } } } } }`,
            { owner, number, cursor }
          )
        );
        const project = object(object(object(data.organization)).projectV2);
        if (!str(project.id)) {
          throw new Error("Missing board project");
        }
        const readme = str(project.readme);
        const connection = object(project.items);
        for (const node of this.list(connection.nodes)) {
          const card = this.decodeCard(node);
          if (card) {
            cards.push(card);
          }
        }
        const info = object(connection.pageInfo);
        if (info.hasNextPage === false) {
          return { readme, list: cards };
        }
        if (
          info.hasNextPage !== true ||
          typeof info.endCursor !== "string" ||
          seen.has(info.endCursor)
        ) {
          throw new Error("Invalid board pagination cursor");
        }
        cursor = info.endCursor;
        seen.add(cursor);
      }
    } catch (error) {
      if (error instanceof GraphQLResponseError) {
        // An invalid query once made a watcher blind for hours: report at once.
        this.produceOnce(
          `graphql-error-${key(error.errors.join(";"))}`,
          "query-error",
          "QUERY ERROR: GraphQL rejected the board query; details on stderr"
        );
      }
      throw error;
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
      id: str(node.id),
      repo: scope.repo,
      number,
      kind,
      state: str(content.state),
      column: str(object(node.status).name),
      assignees: this.list(object(content.assignees).nodes).map((entry) => str(entry.login)),
      estimate: typeof estimate === "number" && Number.isFinite(estimate) ? estimate : null,
      progress: str(object(node.progress).text),
      title: str(content.title),
      person: this.host.filter.identity(content.author),
    };
  }

  private watchAssignees(card: CardInfo): void {
    const path = join(this.dir, "board", `${card.id}.who`);
    const next = card.assignees.join(",");
    const old = readLines(path).join(",");
    if (old === next) {
      return;
    }
    const remember = () => atomicWrite(path, `${next}\n`);
    const turn = join(this.dir, "board", `.turn-${slug(card.repo)}-${card.number}`);
    const hadOwner = old
      .split(",")
      .filter(Boolean)
      .some((login) => this.owners.has(login.toLowerCase()));
    const hasOwner = card.assignees.some((login) => this.owners.has(login.toLowerCase()));
    if (hasOwner) {
      // Assigned to the owner again: whoever takes them off next is news unless marked.
      remove(turn);
      remember();
      return;
    }
    if (hadOwner && !this.firstRun && existsSync(turn)) {
      remove(turn);
      remember();
      return;
    }
    if (hadOwner && !this.firstRun) {
      this.emit(
        `owner-done-${card.id}@${key(`${old}>${next}`)}`,
        "owner-done",
        `OWNER DONE #${card.number} (${card.kind})${this.previewText(card.person, card.title)} ${this.threadUrl(card.repo, card.number, card.kind)}`
      );
    }
    remember();
  }

  private watchColumn(card: CardInfo, migration: boolean): void {
    const path = join(this.dir, "board", card.id);
    const old = readLines(path).join("");
    if (old === card.column) {
      return;
    }
    const remember = () => atomicWrite(path, `${card.column}\n`);
    if (card.column === "Approved") {
      this.queueProgress(card.number, { state: null });
    }
    if (card.column === "Done" || card.state === "CLOSED" || card.state === "MERGED") {
      this.queueProgress(card.number, { state: null, round: null, ci: "ok" });
    }
    if (this.firstRun || migration) {
      remember();
      return;
    }
    const url = this.threadUrl(card.repo, card.number, card.kind);
    const preview = this.previewText(card.person, card.title);
    if (!old) {
      if (card.column === "Backlog" || card.column === "In progress") {
        this.quiet(`NOTE #${card.number} (${card.kind}): new card → ${card.column} ${url}`);
      } else {
        this.emit(
          `board-${card.id}@${key(`new>${card.column}`)}`,
          "board",
          `BOARD #${card.number} (${card.kind}): new card → ${card.column}${preview} ${url}`
        );
      }
      remember();
      return;
    }
    if (card.column === "In progress") {
      this.quiet(`NOTE #${card.number} (${card.kind}): ${old} → ${card.column} ${url}`);
      remember();
      return;
    }
    if (card.kind === "PR" && card.column === "Done") {
      remember();
      return;
    }
    // Moves to Ready wake too: the tested rule never silences what could need us.
    this.emit(
      `board-${card.id}@${key(`${old}>${card.column}`)}`,
      "board",
      `BOARD #${card.number} (${card.kind}): ${old} → ${card.column}${preview} ${url}`
    );
    remember();
  }

  private watchForeignAssignment(card: CardInfo): boolean {
    if (!card.assignees.some((login) => login.toLowerCase() === (this.me ?? "").toLowerCase())) {
      return false;
    }
    if (this.muted(card.repo, card.number)) {
      return false;
    }
    const marker = `theirs-${slug(card.repo)}-${card.number}`;
    if (this.marked(marker)) {
      return true;
    }
    if (!this.firstRun) {
      this.produceOnce(
        marker,
        "assigned",
        `ASSIGNED ${card.repo}#${card.number} (${card.kind})${this.previewText(card.person, card.title)} ${this.threadUrl(card.repo, card.number, card.kind)}`
      );
    } else {
      this.mark(marker);
    }
    return true;
  }

  private async applyProgress(card: CardInfo): Promise<void> {
    const path = join(this.dir, `pending-progress-${card.number}`);
    if (!existsSync(path)) {
      return;
    }
    const pending = object(safeJson(readFileSync(path, "utf8")));
    const current = parseProgress(card.progress);
    const only = Array.isArray(pending.if) ? pending.if.map(str) : undefined;
    const stateAllowed = !only || only.includes(current.state ?? "");
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
    try {
      if (pending.status !== undefined && str(pending.status) !== card.column) {
        await this.host.board.set({
          itemId: card.id,
          field: "Status",
          value: str(pending.status),
          progress: text || null,
        });
        card.column = str(pending.status);
        atomicWrite(join(this.dir, "board", card.id), `${card.column}\n`);
      } else if (text !== card.progress) {
        await this.host.board.set({ itemId: card.id, field: "Progress", value: text || null });
      }
      remove(path);
    } catch (error) {
      this.host.deps.report(
        `watcher: Progress update failed for #${card.number}: ${(error as Error).message}`
      );
    }
  }

  private held(): boolean {
    const path = join(this.dir, "board", ".hold-startable");
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

  private async watchNext(ready: CardInfo[], approved: CardInfo[]): Promise<void> {
    if (this.held()) {
      return;
    }
    const signature = `${ready.map((card) => card.number).join(",")}|${approved
      .map((card) => card.number)
      .join(",")}`;
    const recheck = this.marked("recheck-next");
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
      remove(join(this.dir, "recheck-next"));
    }
    const next = await this.firstUnblocked(ready);
    const launch = await this.firstUnblocked(approved);
    this.recordStartable("next", next);
    this.recordStartable("launch", launch);
  }

  private recordStartable(name: string, value: StartableValue | null): void {
    const path = join(this.dir, "board", name);
    const stored = value ? JSON.stringify(value) : "";
    if (readLines(path).join("") === stored) {
      return;
    }
    if (!this.firstRun && value) {
      const line =
        name === "next"
          ? `NEXT #${value.number} (${value.kind})`
          : `LAUNCH #${value.number} (${value.kind}): approved and nothing blocks it`;
      this.emit(
        `${name}-${key(stored)}`,
        name,
        `${line}${this.previewFromSubject(value.repo, value.number)} ${this.threadUrl(value.repo, value.number, value.kind)}`
      );
    }
    atomicWrite(path, `${stored}\n`);
  }

  private async firstUnblocked(cards: CardInfo[]): Promise<StartableValue | null> {
    for (const card of cards) {
      if (card.kind === "ISSUE") {
        const blockers = await this.restPages(
          (page) =>
            `/repos/${card.repo}/issues/${card.number}/dependencies/blocked_by?per_page=100&page=${page}`,
          (data) => this.list(data)
        );
        if (blockers.some((blocker) => str(blocker.state) === "open")) {
          continue;
        }
      }
      return { number: card.number, kind: card.kind, repo: card.repo };
    }
    return null;
  }

  // ---------------------------------------------------------------- workers and budget

  private workerClient(): OpencodeClient | null {
    if (this.opencode) {
      return this.opencode;
    }
    if (this.opencodeError) {
      return null;
    }
    try {
      this.opencode = new OpencodeClient(this.host.env, this.host.deps.fetch);
      return this.opencode;
    } catch (error) {
      this.opencodeError = (error as Error).message;
      this.host.deps.report(`watcher: worker status unavailable: ${this.opencodeError}`);
      this.quietOnce(
        `no-opencode-${key(this.opencodeError)}`,
        `NOTE: worker status unavailable: ${this.opencodeError}`
      );
      return null;
    }
  }

  private async pollWorkers(): Promise<void> {
    if (this.cycle % WORKER_EVERY !== 1) {
      return;
    }
    const failures: Error[] = [];
    for (const pr of this.inprogress) {
      if (this.muted(this.own, pr.number)) {
        continue;
      }
      const url = this.threadUrl(this.own, pr.number, "PR");
      const activity = this.activityAt(pr.number);
      if (
        activity &&
        Date.parse(activity) <= this.host.deps.now() - SILENT_MS &&
        !this.cycleStale.has(pr.number)
      ) {
        if (
          this.produceOnce(
            `q-${pr.number}-${key(activity)}`,
            "silent",
            `PR #${pr.number} (${pr.branch}): SILENT: no commit or comment for 40+ min while In progress ${url}`
          )
        ) {
          this.queueProgress(pr.number, { state: "silent", if: ["working"] });
        }
      }
      if (!pr.branch) {
        continue;
      }
      const dir = resolve(this.host.root, this.worktreeRoot, `auto-${pr.branch}`);
      if (!existsSync(dir)) {
        continue;
      }
      let status: WorkerStatus;
      const client = this.workerClient();
      if (!client) {
        continue;
      }
      try {
        status = await client.status(dir);
      } catch (error) {
        failures.push(error as Error);
        continue;
      }
      const stopPath = join(this.dir, `worker-stop-${pr.number}`);
      const stop =
        status.state === "other" ? "" : JSON.stringify([status.state, status.detail ?? ""]);
      const previous = this.readMarker(`worker-stop-${pr.number}`);
      if (stop === previous) {
        continue;
      }
      if (status.state === "permission") {
        if (
          this.emit(
            `w-${pr.number}@${this.host.deps.now()}`,
            "worker",
            `WORKER #${pr.number} (${pr.branch}): waits for a permission; see ${dir}`
          )
        ) {
          this.queueProgress(pr.number, {
            state: "permission",
            if: ["working", "silent", "idle", "failed"],
          });
        }
      } else if (status.state === "failed") {
        if (
          this.emit(
            `w-${pr.number}@${this.host.deps.now()}`,
            "worker",
            `WORKER #${pr.number} (${pr.branch}): its turn failed; see ${dir}`
          )
        ) {
          this.queueProgress(pr.number, {
            state: "failed",
            if: ["working", "silent", "idle", "permission"],
          });
        }
      }
      atomicWrite(stopPath, `${stop}\n`);
    }
    if (failures.length) {
      throw failures[0];
    }
  }

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
      const pause = Math.ceil(
        (POLL_COST * (status.reset * 1000 - now)) / Math.max(1, status.remaining - this.reserve)
      );
      if (pause > INTERVAL_MS) {
        this.nextBoardAt = Math.max(this.nextBoardAt, this.lastBoardAt + pause);
        this.quietOnce(
          `slow-${resource}-${Math.floor(status.reset)}`,
          `NOTE: ${status.remaining} ${resource} points left; board polls run slower until ${until}`
        );
      }
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
