import { expect, test } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WatchFake } from "./watch-fake.js";
import { WatchDelivery } from "../../src/gateway/watch-delivery.js";
import { fixture } from "../helpers.js";

test("replay previous includes processed and lost batches, survives restart and does not acknowledge", async () => {
  const f = new WatchFake();
  try {
    let loop = f.loop();
    await loop.nextEvents({ timeoutSeconds: 0, pollOnce: true, watchStart: true });
    f.advance();
    f.comment("[worker] QUESTION\nFirst");
    const first = await loop.nextEvents({ timeoutSeconds: 0, pollOnce: true });
    expect(first.events).not.toHaveLength(0);
    await f.ack(loop, first.events);
    f.advance();
    f.comment("[worker] BLOCKED\nLost consumer output");
    const lost = await loop.nextEvents({ timeoutSeconds: 0, pollOnce: true });
    expect(lost.events).not.toHaveLength(0);
    loop.close();
    loop = f.loop();
    const requests = f.requests.length;
    const replay = await loop.nextEvents({ timeoutSeconds: 0, replay: "previous" });
    expect(replay.events).toEqual([...first.events, ...lost.events]);
    expect(f.requests).toHaveLength(requests);
    expect((await loop.nextEvents({ timeoutSeconds: 0, replay: "2" })).events).toEqual(lost.events);
    expect((await loop.nextEvents({ timeoutSeconds: 0, replay: f.iso() })).events).toEqual(
      lost.events
    );
    expect((await loop.nextEvents({ timeoutSeconds: 0 })).events).toEqual(lost.events);
    await f.ack(loop, lost.events);
    await loop.nextEvents({ timeoutSeconds: 0, watchStart: true });
    expect((await loop.nextEvents({ timeoutSeconds: 0, replay: "previous" })).events).toEqual([]);
    expect(f.reports).toEqual([]);
  } finally {
    f.done();
  }
});

test("delivery retention is seven days and sequences keep increasing after expiry", () => {
  const dir = fixture();
  let now = Date.UTC(2026, 9, 1);
  const delivery = new WatchDelivery(dir, () => now);
  const event = { id: "event", kind: "comment", line: "COMMENT", quiet: ["NOTE"] };
  delivery.start();
  delivery.append([event]);
  now += 7 * 24 * 60 * 60_000;
  expect(delivery.replay("previous")).toEqual([event]);
  now++;
  expect(delivery.replay("0")).toEqual([]);
  expect(readFileSync(join(dir, "delivered.jsonl"), "utf8")).toBe("");
  delivery.append([event]);
  expect(JSON.parse(readFileSync(join(dir, "delivered.jsonl"), "utf8")).seq).toBe(2);
  expect(delivery.replay("2")).toEqual([event]);
  expect(() => delivery.replay("yesterday")).toThrow("Expected --replay");
  writeFileSync(join(dir, "delivered.jsonl"), "corrupt\n");
  expect(() => delivery.replay("previous")).toThrow();
});

test.each(["READY FOR REVIEW (round 1)", "QUESTION", "BLOCKED"])(
  "unanswered %s reminds at five minutes, repeats after thirty and ANSWER stops it",
  async (tag) => {
    const f = new WatchFake();
    try {
      f.task();
      f.cards[0].progress = { text: "🧭🔍" };
      const loop = f.loop();
      await f.once(loop);
      f.advance();
      f.comment(`[worker] ${tag}`);
      await f.once(loop);
      const reminders = async () =>
        (await f.once(loop)).filter((event) => event.kind === "orchestrator-turn");
      f.advance(5 * 60_000 - 1);
      expect(await reminders()).toEqual([]);
      f.advance(1);
      expect((await reminders()).map((event) => event.line)).toEqual([
        `ORCHESTRATOR TURN #24: ${tag.split(" ")[0]} unhandled for 5+ min https://github.com/example/project/pull/24`,
      ]);
      f.advance(30 * 60_000 - 1);
      expect(await reminders()).toEqual([]);
      f.advance(1);
      expect(await reminders()).toHaveLength(1);
      f.advance();
      f.comment("[orchestrator] ANSWER", 2);
      await f.once(loop);
      f.advance(30 * 60_000);
      expect((await reminders()).some((event) => event.line.includes("unhandled"))).toBe(false);
      expect(f.reports).toEqual([]);
    } finally {
      f.done();
    }
  }
);

test("a version notice is per state directory and version marker, not per process", async () => {
  const f = new WatchFake();
  try {
    const guide = join(f.root, "node_modules/@vworlds/vmethod/docs/orchestrator-guide.md");
    mkdirSync(join(f.root, "node_modules/@vworlds/vmethod/docs"), { recursive: true });
    writeFileSync(guide, "guide");
    mkdirSync(f.dir, { recursive: true });
    writeFileSync(join(f.dir, "guide-seen-0.0.0-old"), "");
    let loop = f.loop();
    const first = await loop.nextEvents({ timeoutSeconds: 0, watchStart: true });
    expect(first.notice).toContain(`read ${guide}`);
    await loop.nextEvents({ timeoutSeconds: 0, guideSeen: true });
    expect(readFileSync(join(f.dir, "guide-seen-0.0.0-dev"), "utf8")).toBe("");
    loop.close();
    loop = f.loop();
    expect((await loop.nextEvents({ timeoutSeconds: 0, watchStart: true })).notice).toBeUndefined();
  } finally {
    f.done();
  }
});

test("a missing guide is informational and can still be acknowledged", async () => {
  const f = new WatchFake();
  try {
    mkdirSync(f.dir, { recursive: true });
    const loop = f.loop();
    const result = await loop.nextEvents({ timeoutSeconds: 0, watchStart: true });
    expect(result.notice).toContain(
      "node_modules/@vworlds/vmethod/docs/orchestrator-guide.md (not found locally)"
    );
    await loop.nextEvents({ timeoutSeconds: 0, guideSeen: true });
    expect(readFileSync(join(f.dir, "guide-seen-0.0.0-dev"), "utf8")).toBe("");
  } finally {
    f.done();
  }
});

test.each(["REVIEW round 1", "OWNER REVIEW", "ANSWER", "AMENDMENT", "GO"])(
  "%s handles a worker request even across restarts",
  async (reply) => {
    const f = new WatchFake();
    try {
      f.task();
      let loop = f.loop();
      await f.once(loop);
      f.advance();
      f.comment("[worker] READY FOR REVIEW (round 1)");
      await f.once(loop);
      f.advance();
      f.comment(`[orchestrator] ${reply}`, 2);
      await f.once(loop);
      loop.close();
      loop = f.loop();
      f.advance(6 * 60_000);
      expect((await f.once(loop)).filter((event) => event.line.includes("unhandled"))).toEqual([]);
      expect(f.reports).toEqual([]);
    } finally {
      f.done();
    }
  }
);

test.each(["worker", "owner", "unknown", "edited"])(
  "a %s ANSWER does not handle the worker request",
  async (kind) => {
    const f = new WatchFake();
    try {
      f.task();
      const loop = f.loop();
      await f.once(loop);
      f.advance();
      f.comment("[worker] READY FOR REVIEW (round 1)");
      await f.once(loop);
      f.advance();
      const comment = f.comment(
        "[orchestrator] ANSWER",
        kind === "worker" ? 1 : kind === "owner" ? 0 : 2
      );
      if (kind === "unknown") {
        comment.user = { login: "impostor", id: 999999, type: "User" };
      }
      if (kind === "edited") {
        comment.updated_at = f.iso(1);
      }
      await f.once(loop);
      f.advance(4 * 60_000);
      expect(
        (await f.once(loop)).filter((event) => event.line.includes("READY unhandled"))
      ).toHaveLength(1);
      expect(f.reports).toEqual([]);
    } finally {
      f.done();
    }
  }
);
