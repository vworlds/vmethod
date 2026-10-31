import { expect, test } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WatchFake } from "./watch-fake.js";
import { WatchDelivery } from "../../src/gateway/watch-delivery.js";
import { fixture } from "../helpers.js";
import { people } from "./helpers.js";

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

test("collection excludes buffered events without acknowledgement, preserves quiet notes and redelivers after restart", async () => {
  const f = new WatchFake();
  try {
    let loop = f.loop();
    await loop.nextEvents({ timeoutSeconds: 0, pollOnce: true, watchStart: true });
    f.advance();
    f.comment("[worker] QUESTION\nBuffered");
    const first = await loop.nextEvents({ timeoutSeconds: 0, pollOnce: true });
    expect(first.events.length).toBeGreaterThan(0);
    const exclude = first.events.map((event) => event.id);
    const requests = f.requests.length;
    const empty = await loop.nextEvents({ timeoutSeconds: 1, exclude });
    expect(empty.events).toEqual([]);
    expect(f.requests.length).toBeGreaterThan(requests);
    f.advance();
    f.comment("[worker] BLOCKED\nAnother arrival");
    writeFileSync(join(f.dir, "quiet"), "NOTE new\n");
    const second = await loop.nextEvents({ timeoutSeconds: 0, pollOnce: true, exclude });
    expect(second.events.length).toBeGreaterThan(0);
    expect(second.events.some((event) => exclude.includes(event.id))).toBe(false);
    expect(second.events[0].quiet).toContain("NOTE new");
    loop.close();
    loop = f.loop();
    const restarted = await loop.nextEvents({ timeoutSeconds: 0 });
    expect(restarted.events).toEqual([...first.events, ...second.events]);
    const replay = await loop.nextEvents({ timeoutSeconds: 0, replay: "previous" });
    expect(replay.events).toEqual([...first.events, ...second.events, ...restarted.events]);
    await f.ack(loop, restarted.events);
    expect((await loop.nextEvents({ timeoutSeconds: 0 })).events).toEqual([]);
    await expect(loop.nextEvents({ timeoutSeconds: 0, exclude: ["bad id"] })).rejects.toThrow(
      "Invalid exclude ids"
    );
  } finally {
    f.done();
  }
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

test.each(["worker", "peer", "owner", "unknown", "edited"])(
  "a %s ANSWER does not handle the worker request",
  async (kind) => {
    const f = new WatchFake();
    try {
      f.task();
      if (kind === "peer") {
        // A peer project's orchestrator must not hold this project's turn (#186);
        // the fixture project keeps its own bound orchestrator.
        f.watchPeople = [
          ...people,
          {
            login: "vecsmaster",
            id: 900,
            type: "User",
            role: "orchestrator",
            repos: ["example/other"],
          },
        ];
      }
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
      if (kind === "peer") {
        comment.user = { login: "vecsmaster", id: 900, type: "User" };
      }
      if (kind === "unknown") {
        comment.user = { login: "impostor", id: 999999, type: "User" };
      }
      if (kind === "edited") {
        comment.updated_at = f.iso(1);
      }
      const delivered = await f.once(loop);
      if (kind === "peer") {
        // Watch delivers the peer project's orchestrator as this project's collaborator.
        expect(
          delivered.some((event) => event.line.includes("from vecsmaster (collaborator)"))
        ).toBe(true);
      }
      await f.once(loop);
      f.advance(4 * 60_000);
      expect(
        (await f.once(loop)).filter((event) => event.line.includes("READY unhandled"))
      ).toHaveLength(1);
      expect(f.reports).toEqual([]);
      if (kind === "peer") {
        // The peer's tag never reaches the worker session itself.
        expect(f.workerSends).toEqual([]);
      }
    } finally {
      f.done();
    }
  }
);

const CHAT_REMINDER =
  "REMINDER (owner rule): chat = #n pointers only or warnings; discuss on GitHub. Don't explain here what you will put in an issue/PR. Evidence, plans and summaries go on the issue/PR, never in chat.";

test("deliveries less than 30 minutes apart carry the chat-rule reminder once, then again 30 minutes later", async () => {
  const f = new WatchFake();
  try {
    const loop = f.loop();
    await loop.nextEvents({ timeoutSeconds: 0, pollOnce: true, watchStart: true });
    f.advance();
    f.comment("[worker] QUESTION\nFirst");
    const first = await loop.nextEvents({ timeoutSeconds: 0, pollOnce: true });
    expect(first.events).not.toHaveLength(0);
    expect(first.reminder).toBe(CHAT_REMINDER);
    await f.ack(loop, first.events);
    f.advance(15 * 60_000);
    f.comment("[worker] BLOCKED\nSecond");
    const second = await loop.nextEvents({ timeoutSeconds: 0, pollOnce: true });
    expect(second.events).not.toHaveLength(0);
    expect(second.reminder).toBeUndefined();
    await f.ack(loop, second.events);
    f.advance(15 * 60_000);
    f.comment("[worker] QUESTION\nThird");
    const third = await loop.nextEvents({ timeoutSeconds: 0, pollOnce: true });
    expect(third.events).not.toHaveLength(0);
    expect(third.reminder).toBe(CHAT_REMINDER);
    // The reminder is delivery metadata, never an event: record and replay hold
    // events only, and replay never produces a fresh reminder line.
    const replayed = await loop.nextEvents({ timeoutSeconds: 0, replay: "previous" });
    expect(replayed.events).not.toHaveLength(0);
    expect(replayed.reminder).toBeUndefined();
    expect(f.reports).toEqual([]);
  } finally {
    f.done();
  }
});

test("the chat-rule reminder never stands alone: an idle 30-minute+ window produces no output", async () => {
  const f = new WatchFake();
  try {
    const loop = f.loop();
    expect(await f.once(loop)).toEqual([]);
    f.advance(45 * 60_000);
    expect(await f.once(loop)).toEqual([]);
    f.comment("[worker] QUESTION\nLate");
    const late = await loop.nextEvents({ timeoutSeconds: 0, pollOnce: true });
    expect(late.events).not.toHaveLength(0);
    expect(late.reminder).toBe(CHAT_REMINDER);
    expect(f.reports).toEqual([]);
  } finally {
    f.done();
  }
});

test("a watcher restart inside the interval does not repeat the chat-rule reminder", async () => {
  const f = new WatchFake();
  try {
    let loop = f.loop();
    await loop.nextEvents({ timeoutSeconds: 0, pollOnce: true, watchStart: true });
    f.advance();
    f.comment("[worker] QUESTION\nFirst");
    const first = await loop.nextEvents({ timeoutSeconds: 0, pollOnce: true });
    expect(first.reminder).toBe(CHAT_REMINDER);
    await f.ack(loop, first.events);
    loop.close();
    loop = f.loop();
    f.advance(15 * 60_000);
    f.comment("[worker] BLOCKED\nAfter restart");
    const again = await loop.nextEvents({ timeoutSeconds: 0, pollOnce: true });
    expect(again.events).not.toHaveLength(0);
    expect(again.reminder).toBeUndefined();
    expect(f.reports).toEqual([]);
  } finally {
    f.done();
  }
});
