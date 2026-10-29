import { LoopState } from "../watch/state.js";
import type { WatchEvent } from "./events.js";

const RETENTION_MS = 7 * 24 * 60 * 60_000;

interface Delivery {
  seq: number;
  at: string;
  events: WatchEvent[];
}

/** Durable, per-state-directory delivery history. Call only while holding the watcher lock. */
export class WatchDelivery {
  private readonly state: LoopState;

  constructor(
    dir: string,
    private readonly now: () => number
  ) {
    this.state = new LoopState(dir);
  }

  /** Record a real client start, not a long-poll continuation or a replay. */
  start(): void {
    this.prune(this.history());
    this.state.watchStart.write(JSON.stringify({ seq: this.sequence() }));
  }

  /** Persist before returning a batch, including batches stdout never receives. */
  append(events: WatchEvent[]): void {
    if (!events.length) {
      return;
    }
    const history = this.history();
    const seq = this.sequence() + 1;
    this.state.deliverySeq.write(String(seq));
    this.prune(history);
    this.state.delivered.append(
      `${JSON.stringify({ seq, at: new Date(this.now()).toISOString(), events })}\n`
    );
  }

  /** Replay inclusive sequence/time selectors; previous means since the last real watch start. */
  replay(selector: string): WatchEvent[] {
    let includes: (delivery: Delivery) => boolean;
    if (selector === "previous") {
      const start = this.state.watchStart.raw();
      const seq: unknown = start ? JSON.parse(start).seq : 0;
      if (!Number.isSafeInteger(seq) || Number(seq) < 0) {
        throw new Error("Invalid watch start state");
      }
      includes = (delivery) => delivery.seq > Number(seq);
    } else if (/^\d+$/.test(selector) && Number.isSafeInteger(Number(selector))) {
      includes = (delivery) => delivery.seq >= Number(selector);
    } else {
      const at = /^\d{4}-\d\d-\d\dT/.test(selector) ? Date.parse(selector) : NaN;
      if (!Number.isFinite(at)) {
        throw new Error("Expected --replay previous, a sequence number or an ISO timestamp");
      }
      includes = (delivery) => Date.parse(delivery.at) >= at;
    }
    const history = this.history();
    this.prune(history);
    return history.filter(includes).flatMap((delivery) => delivery.events);
  }

  private history(): Delivery[] {
    let previous = 0;
    return this.state.delivered
      .raw()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const delivery = JSON.parse(line) as Delivery;
        if (
          !Number.isSafeInteger(delivery.seq) ||
          delivery.seq <= previous ||
          !Number.isFinite(Date.parse(delivery.at)) ||
          !Array.isArray(delivery.events) ||
          delivery.events.some(
            (event) => !event || typeof event.id !== "string" || typeof event.line !== "string"
          )
        ) {
          throw new Error("Invalid watcher delivery history");
        }
        previous = delivery.seq;
        return delivery;
      })
      .filter((delivery) => Date.parse(delivery.at) >= this.now() - RETENTION_MS);
  }

  private prune(history: Delivery[]): void {
    this.state.delivered.write(history.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  }

  private sequence(): number {
    const seq = Number(this.state.deliverySeq.raw() || "0");
    if (!Number.isSafeInteger(seq) || seq < 0 || seq === Number.MAX_SAFE_INTEGER) {
      throw new Error("Invalid watcher delivery sequence");
    }
    return seq;
  }
}
