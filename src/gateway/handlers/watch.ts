import { statSync } from "node:fs";
import { getConfig, loadYaml, type Config } from "../../config.js";
import { stateRoot } from "../digest.js";
import { PeopleFilter, object, type Person } from "../people.js";
import { type Handlers } from "../transport.js";
import { resolve } from "node:path";
import {
  EventLoop,
  eventDeps,
  resolveSession,
  muteThread,
  unmuteThread,
  listMutes,
} from "../events.js";
import { procWatchStopDeps, watchStop as stopWatch } from "../watch-stop.js";
import { conflictLockWaitMs } from "../conflicts.js";
import type { GatewayServices } from "../server.js";
import type { Handler } from "./types.js";

export const nextEvents: Handler<"nextEvents"> = async function (input) {
  const name = resolveSession(this.watchStateConfig, input).stateName;
  // The guard belongs to the session, not a loop that a config edit can replace.
  if (this.eventReaders.has(name)) {
    throw new Error("watch: another reader is already waiting for this session");
  }
  this.eventReaders.add(name);
  try {
    return await this.eventLoop(input).nextEvents(input);
  } finally {
    this.eventReaders.delete(name);
  }
};

export const watchMute: Handler<"watchMute"> = async function ({ ref }) {
  return muteThread(this.config, this.env, ref);
};

export const watchUnmute: Handler<"watchUnmute"> = async function ({ ref }) {
  return unmuteThread(this.config, this.env, ref);
};

export const watchMutes: Handler<"watchMutes"> = async function () {
  return listMutes(this.config, this.env);
};

/** Stop the running watcher for this resolved session's state directory (#340):
 * the same session resolution as `nextEvents`, without starting a loop.
 */
export const watchStop: Handler<"watchStop"> = async function ({ force, ...session }) {
  return stopWatch(
    stateRoot(this.env, resolveSession(this.watchStateConfig, session).stateName),
    force === true,
    procWatchStopDeps(this.deps.now, this.deps.sleep)
  );
};

export function eventLoop(
  this: GatewayServices,
  input: Parameters<Handlers["nextEvents"]>[0]
): EventLoop {
  const session = resolveSession(this.watchStateConfig, input);
  const name = session.stateName;
  let loop = this.loops.get(name);
  if (!loop) {
    const methodology = String(object(this.config.vmethod).repo ?? "vworlds/vmethod");
    const filter = new PeopleFilter(
      this.filter.people,
      String(this.config.org),
      this.digest,
      methodology === "off" ? [] : [methodology]
    );
    loop = new EventLoop(
      {
        root: this.root,
        config: this.config,
        env: this.env,
        deps: eventDeps(this.deps),
        filter,
        refresh: () => {
          this.reloadWatchFiles();
          filter.reload(this.filter.people);
          return this.eventLoop(input);
        },
        github: this.github,
        workerStatus: (pr) => this.workers.watchStatus(pr),
        workerLimits: () => this.workers.quotaReadings(),
        // Without a configured worker checkout no task can have a worker worktree.
        workerTrees: async () =>
          this.config.workerCheckout === undefined ? [] : this.workerWorktrees.registered(),
        workerSend: (pr, text) => this.workers.resume(pr, text),
        workerMetric: (pr, event) => this.workers.recordMetric(pr, event),
        // #373: the dispatch waits out a refresh-checks push (bounded), then
        // resolve re-reads the head and base before any fixer starts.
        resolveConflicts: (pr) => this.conflicts.resolve(pr, false, conflictLockWaitMs),
        conflictPending: (pr) => this.conflicts.pending(pr),
        conflictFixing: (pr) => this.conflicts.fixing(pr),
        board: {
          set: (input) => this.board.set(input),
          moveToTop: (itemId) => this.board.moveToTop(itemId),
        },
        digest: this.digest,
      },
      input,
      session
    );
    this.loops.set(name, loop);
  }
  return loop;
}

export function reloadWatchFiles(this: GatewayServices): void {
  // Remember attempted versions too: a bad edit is reported once, not every poll.
  const peopleMtime = this.watchMtime("people");
  if (peopleMtime !== this.peopleMtime) {
    this.peopleMtime = peopleMtime;
    try {
      this.filter.reload(loadYaml(this.root, "people") as Person[]);
      const owners = this.filter.people.filter((p) => p.role === "owner").map((p) => p.login);
      this.deps.report(`people.yaml reloaded (owners: ${owners.join(", ")})`);
    } catch (error) {
      this.deps.report(
        `people.yaml reload failed: ${(error as Error).message}; keeping the previous list`
      );
    }
  }
  const configMtime = this.watchMtime("vmethod");
  if (configMtime !== this.configMtime) {
    this.configMtime = configMtime;
    let config: Config;
    try {
      config = getConfig(this.root, this.env);
    } catch (error) {
      this.deps.report(
        `vmethod.yaml reload failed: ${(error as Error).message}; keeping the previous config`
      );
      return;
    }
    for (const loop of this.loops.values()) {
      loop.close();
    }
    this.loops.clear();
    this.config = config;
    this.client = undefined;
    this.boardClient = undefined;
    this.workersClient = undefined;
    this.deps.report("vmethod.yaml reloaded");
  }
}

export function watchMtime(this: GatewayServices, kind: string): number {
  try {
    return statSync(resolve(this.root, `${kind}.yaml`)).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return -1;
    }
    throw error;
  }
}
