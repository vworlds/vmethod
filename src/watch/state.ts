import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

interface Codec<T> {
  decode(text: string): T;
  encode(value: T): string;
}

const textCodec: Codec<string> = { decode: (text) => text.trim(), encode: (value) => value };

interface ReviewMemory {
  at?: string;
  id?: string;
}

interface ProtocolMemory {
  at?: string;
  active?: boolean;
  role?: string;
  tag?: string;
}

interface UnhandledWorker {
  at?: string;
  tag?: string;
  handled?: boolean;
}

interface WorkerMetricMemory {
  stop?: string;
  previous?: string;
  sequence?: number;
}

interface PendingProgress {
  status?: string;
  state?: string | null;
  round?: number | null;
  ci?: string;
  if?: string[];
  releaseOwner?: boolean;
}

/** A typed value plus its unchanged wire representation. Validation stays with readers. */
export class Marker<T = string> {
  constructor(
    readonly path: string,
    private readonly codec: Codec<T> = textCodec as unknown as Codec<T>
  ) {}

  exists(): boolean {
    return existsSync(this.path);
  }

  read(): T {
    return this.codec.decode(this.raw());
  }

  /** For callers that already tested existence and must surface a disappearing file. */
  readRequired(): T {
    return this.codec.decode(readFileSync(this.path, "utf8"));
  }

  text(): string {
    return this.raw().trim();
  }

  raw(): string {
    try {
      return readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "";
      }
      throw error;
    }
  }

  lines(): string[] {
    return this.raw().split("\n").filter(Boolean);
  }

  /** Atomic replacement, with exactly the supplied wire bytes (no added newline). */
  write(value: T): void {
    this.writeText(this.codec.encode(value));
  }

  writeText(value: string): void {
    writeFileSync(`${this.path}.tmp`, value, { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
  }

  /** Existing once markers and quiet drains deliberately use a direct write. */
  stamp(value: string): void {
    writeFileSync(this.path, value, { mode: 0o600 });
  }

  append(value: string): void {
    appendFileSync(this.path, value, { mode: 0o600 });
  }

  remove(): void {
    try {
      unlinkSync(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}

/** The old safeJson/object policy: malformed or non-object memory reads as empty. */
function memory<T extends object>(path: string, newline = true, trim = true): Marker<T> {
  return new Marker(path, {
    decode: (text) => {
      try {
        const value: unknown = JSON.parse(trim ? text.trim() : text);
        return (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as T;
      } catch {
        return {} as T;
      }
    },
    encode: (value) => `${JSON.stringify(value)}${newline ? "\n" : ""}`,
  });
}

/** A variable-key marker family; its prefix includes the full PR separator. */
class MarkerFamily {
  constructor(
    private readonly dir: string,
    private readonly prefix: string
  ) {}

  at(key: string): Marker {
    return new Marker(join(this.dir, `${this.prefix}${key}`));
  }

  clear(): void {
    for (const name of readdirSync(this.dir)) {
      if (name.startsWith(this.prefix)) {
        new Marker(join(this.dir, name)).remove();
      }
    }
  }
}

/** All per-PR watcher baselines. Names and wire bytes remain compatible with older loops. */
export class PrState {
  readonly open;
  readonly head;
  readonly branch;
  readonly ci;
  readonly activity;
  readonly review;
  readonly prompt;
  readonly promptsSeeded;
  readonly protocolSeeded;
  readonly protocol;
  readonly unhandledWorker;
  readonly stop;
  readonly checkin;
  readonly metric;
  readonly seeded;
  readonly picked;
  readonly mergeAttempt;
  readonly mergePending;
  readonly mergeNotified;
  readonly baseHead;
  readonly conflict;
  readonly conflictDispatched;
  readonly baseDispatched;
  readonly conflictResult;
  readonly cost;
  readonly pendingProgress;

  constructor(dir: string, pr: number) {
    const marker = (name: string) => new Marker(join(dir, `${name}-${pr}`));
    this.open = marker("open");
    this.head = marker("head");
    this.branch = marker("branch");
    this.ci = new Marker<"ok" | "red" | "">(marker("ci").path, {
      decode: (text) => text.trim() as "ok" | "red" | "",
      encode: (value) => `${value}\n`,
    });
    this.activity = marker("activity");
    this.review = memory<ReviewMemory>(marker("review").path, false);
    this.prompt = memory<ReviewMemory>(marker("worker-prompt").path);
    this.promptsSeeded = marker("worker-prompts-seeded");
    this.protocolSeeded = marker("worker-protocol-seeded");
    this.protocol = memory<ProtocolMemory>(marker("worker-protocol").path);
    this.unhandledWorker = memory<UnhandledWorker>(marker("unhandled-worker").path);
    this.stop = marker("worker-stop");
    this.checkin = new MarkerFamily(dir, `worker-checkin-${pr}-`);
    this.metric = memory<WorkerMetricMemory>(marker("worker-metric").path);
    this.seeded = marker("seeded");
    this.picked = marker("picked");
    this.mergeAttempt = marker("merge-attempt");
    this.mergePending = marker("merge-pending");
    this.mergeNotified = marker("merge-notified");
    this.baseHead = marker("base-head");
    this.conflict = marker("conflict");
    this.conflictDispatched = new MarkerFamily(dir, `conflict-dispatched-${pr}-`);
    this.baseDispatched = new MarkerFamily(dir, `base-dispatched-${pr}-`);
    this.conflictResult = new MarkerFamily(dir, `conflict-result-${pr}-`);
    this.cost = memory<{ id?: string; text?: string }>(marker("cost").path);
    this.pendingProgress = memory<PendingProgress>(marker("pending-progress").path, false, false);
  }

  /** Clear from the record itself, not a second list of file names.
   * The added cleanup markers have only open-PR readers: processOpenPr,
   * reconcileConflicts, workerStop/workerExpectedActive, pollWorkers (including
   * Cost), and watchOrchestratorTurns (closed cards are filtered in pollBoard).
   * Grading uses WorkerService's own records, not these watcher baselines.
   * Retain once-event acknowledgement history and markers outside the approved
   * cleanup expansion. Merge notification survives incomplete follow-up, and
   * pending Progress is still owned by queueProgress/applyClosedCard.
   */
  clear(): void {
    const retained = new Set<Marker<unknown> | MarkerFamily>([
      // These once-event histories were never in the clear list, and are not
      // among the nine marker kinds approved for the cleanup expansion.
      this.picked,
      this.mergeNotified,
      this.conflictResult,
      this.protocolSeeded,
      // processGonePr queues a final clear after cleanup; applyClosedCard also
      // owns removal. Do not alter that existing ordering or discard a move.
      this.pendingProgress,
    ]);
    for (const marker of Object.values(this)) {
      if (!retained.has(marker)) {
        if (marker instanceof MarkerFamily) {
          marker.clear();
        } else {
          marker.remove();
        }
      }
    }
  }
}

/** One project item's column, management-assignee mirror and dependency memory. */
export class CardState {
  readonly column;
  readonly who;
  readonly blockers;

  constructor(dir: string, id: string) {
    this.column = new Marker(join(dir, "board", id));
    this.who = new Marker(join(dir, "board", `${id}.who`));
    this.blockers = new Marker(join(dir, `blockers-${id}.json`));
  }
}

/** Loop-owned files, including dynamic once-event keys. */
export class LoopState {
  readonly boardDir;
  readonly pending;
  readonly quiet;
  readonly cursor;
  readonly listingBaseline;
  readonly mutes;
  readonly tracks;
  readonly chatReminder;
  readonly absences;
  readonly unestimated;
  readonly orchestratorTurns;
  readonly quotaRisk;
  readonly lock;
  readonly recheckNext;
  readonly holdStartable;
  readonly next;
  readonly launch;
  readonly scope;
  readonly delivered;
  readonly deliverySeq;
  readonly watchStart;

  constructor(readonly dir: string) {
    const marker = (name: string) => new Marker(join(dir, name));
    this.boardDir = join(dir, "board");
    this.pending = marker("pending.json");
    this.quiet = marker("quiet");
    this.cursor = marker("cursor");
    this.listingBaseline = marker("listing-baseline");
    this.mutes = marker("mutes");
    this.tracks = marker("tracks");
    this.chatReminder = marker("chat-reminder");
    this.absences = marker("board-absences.json");
    this.unestimated = marker("unestimated.json");
    this.orchestratorTurns = marker("orchestrator-turns.json");
    this.quotaRisk = marker("quota-risk");
    this.lock = marker("lock");
    this.recheckNext = marker("recheck-next");
    this.holdStartable = new Marker(join(this.boardDir, ".hold-startable"));
    this.next = new Marker(join(this.boardDir, "next"));
    this.launch = new Marker(join(this.boardDir, "launch"));
    this.scope = new Marker(join(this.boardDir, "scope"));
    this.delivered = marker("delivered.jsonl");
    this.deliverySeq = marker("delivery-seq");
    this.watchStart = marker("watch-start.json");
  }

  pr(number: number): PrState {
    return new PrState(this.dir, number);
  }

  card(id: string): CardState {
    return new CardState(this.dir, id);
  }

  /** Event keys are already protocol IDs; only stamping validates them, as before. */
  once(id: string): Marker {
    return new Marker(join(this.dir, id));
  }

  autopilot(number: number): { active: Marker; stop: Marker; step: Marker } {
    return {
      active: new Marker(join(this.dir, `autopilot-${number}`)),
      stop: new Marker(join(this.dir, `autopilot-${number}-stop`)),
      step: new Marker(join(this.dir, `autopilot-${number}-step`)),
    };
  }
}
