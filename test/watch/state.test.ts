import { afterEach, expect, test } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LoopState, Marker } from "../../src/watch/state.js";
import { fixture } from "../helpers.js";
import { WatchFake, user } from "../gateway/watch-fake.js";

let fake: WatchFake | undefined;
afterEach(() => {
  fake?.done();
  fake = undefined;
});

test("old per-PR file names round trip through named markers without changing bytes", () => {
  const dir = fixture();
  const pr = new LoopState(dir).pr(24);
  const values: [Marker<unknown>, string, string][] = [
    [pr.open, "open-24", ""],
    [pr.head, "head-24", "abc\n"],
    [pr.branch, "branch-24", "6-watch\n"],
    [pr.ci, "ci-24", "red\n"],
    [pr.activity, "activity-24", "2026-10-17T10:00:00Z\n"],
    [pr.review, "review-24", '{"at":"now","id":"review"}'],
    [pr.prompt, "worker-prompt-24", '{"at":"now","id":"prompt"}\n'],
    [pr.promptsSeeded, "worker-prompts-seeded-24", ""],
    [pr.protocolSeeded, "worker-protocol-seeded-24", ""],
    [
      pr.protocol,
      "worker-protocol-24",
      '{"at":"now","active":false,"role":"worker","tag":"READY"}\n',
    ],
    [pr.unhandledWorker, "unhandled-worker-24", '{"at":"now","tag":"READY"}\n'],
    [pr.stop, "worker-stop-24", '["idle","abc",null]\n'],
    [pr.checkin.at("round"), "worker-checkin-24-round", "2\n"],
    [pr.metric, "worker-metric-24", '{"sequence":3}\n'],
    [pr.seeded, "seeded-24", ""],
    [pr.picked, "picked-24", ""],
    [pr.mergeAttempt, "merge-attempt-24", "100\n"],
    [pr.mergePending, "merge-pending-24", ""],
    [pr.mergeNotified, "merge-notified-24", ""],
    [pr.baseHead, "base-head-24", "base\n"],
    [pr.conflict, "conflict-24", "head\n"],
    [pr.conflictDispatched.at("head"), "conflict-dispatched-24-head", ""],
    [pr.baseDispatched.at("head-base"), "base-dispatched-24-head-base", ""],
    [pr.conflictResult.at("head"), "conflict-result-24-head", ""],
    [pr.cost, "cost-24", '{"id":"PVTI_24","text":"$1"}\n'],
    [pr.pendingProgress, "pending-progress-24", '{"state":null,"ci":"ok"}'],
  ];
  for (const [marker, name, bytes] of values) {
    writeFileSync(join(dir, name), bytes, { mode: 0o600 });
    expect(marker.raw()).toBe(bytes);
    marker.writeText(marker.raw());
    expect(readFileSync(join(dir, name), "utf8")).toBe(bytes);
    expect(statSync(marker.path).mode & 0o777).toBe(0o600);
  }
  expect(pr.protocol.read()).toEqual({ at: "now", active: false, role: "worker", tag: "READY" });
  expect(pr.metric.read()).toEqual({ sequence: 3 });
  expect(pr.pendingProgress.read()).toEqual({ state: null, ci: "ok" });
  expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test("typed JSON writers retain each marker's historical newline policy", () => {
  const dir = fixture();
  const pr = new LoopState(dir).pr(24);
  pr.review.write({ at: "now", id: "review" });
  pr.prompt.write({ at: "now", id: "prompt" });
  pr.protocol.write({ at: "now", active: true, role: "owner" });
  pr.pendingProgress.write({ state: null, round: null, ci: "ok" });
  expect(readFileSync(join(dir, "review-24"), "utf8")).toBe('{"at":"now","id":"review"}');
  expect(readFileSync(join(dir, "worker-prompt-24"), "utf8")).toBe('{"at":"now","id":"prompt"}\n');
  expect(readFileSync(join(dir, "worker-protocol-24"), "utf8")).toBe(
    '{"at":"now","active":true,"role":"owner"}\n'
  );
  expect(readFileSync(join(dir, "pending-progress-24"), "utf8")).toBe(
    '{"state":null,"round":null,"ci":"ok"}'
  );
});

test("memory preserves trimmed marker reads and raw pending-Progress reads", () => {
  const dir = fixture();
  writeFileSync(join(dir, "worker-protocol-24"), '\ufeff{"active":true}\n');
  writeFileSync(join(dir, "pending-progress-24"), '\ufeff{"state":"working"}');
  const pr = new LoopState(dir).pr(24);
  expect(pr.protocol.read()).toEqual({ active: true });
  expect(pr.pendingProgress.read()).toEqual({});
});

test("old card and loop files keep their exact locations and line semantics", () => {
  const dir = fixture();
  mkdirSync(join(dir, "board"));
  const state = new LoopState(dir);
  const values: [Marker, string, string][] = [
    [state.card("PVTI_24").column, "board/PVTI_24", "Executing\n"],
    [state.card("PVTI_24").who, "board/PVTI_24.who", "owner,worker\n"],
    [state.card("PVTI_24").blockers, "blockers-PVTI_24.json", '{"waiting":true}\n'],
    [state.absences, "board-absences.json", '{"PVTI_24":{"first":1,"count":2}}\n'],
    [state.pending, "pending.json", "[]"],
    [state.quiet, "quiet", "first\n\nsecond\n"],
    [state.cursor, "cursor", "2026-10-17T10:00:00Z\n"],
    [state.listingBaseline, "listing-baseline", "2026-10-17T10:00:00Z\n"],
    [state.mutes, "mutes", "example/project#24\n"],
    [state.tracks, "tracks", "24\tfeature\n"],
    [state.chatReminder, "chat-reminder", "2026-10-17T10:00:00Z"],
    [state.unestimated, "unestimated.json", "{}\n"],
    [state.orchestratorTurns, "orchestrator-turns.json", "{}\n"],
    [state.quotaRisk, "quota-risk", "[]\n"],
    [state.lock, "lock", '{"pid":1}\n'],
    [state.legacyImported, "legacy-imported", "old\n"],
    [state.legacyCompleted, "legacy-completed.json", "{}\n"],
    [state.legacyTurns, "legacy-turns.json", "{}\n"],
    [state.actionsMigrated, "actions-migrated", ""],
    [state.recheckNext, "recheck-next", ""],
    [state.holdStartable, "board/.hold-startable", ""],
    [state.next, "board/next", "{}\n"],
    [state.launch, "board/launch", "{}\n"],
    [state.scope, "board/scope", "{}\n"],
    [state.delivered, "delivered.jsonl", '{"seq":1}\n'],
    [state.deliverySeq, "delivery-seq", "1"],
    [state.watchStart, "watch-start.json", '{"seq":0}'],
    [state.once("c-0123456789abcdef"), "c-0123456789abcdef", "2026-10-17T10:00:00Z"],
    [state.autopilot(24).active, "autopilot-24", "on\n"],
    [state.autopilot(24).stop, "autopilot-24-stop", ""],
    [state.autopilot(24).step, "autopilot-24-step", "on:Executing:\n"],
    [state.legacyBoard("graded-6"), "board/graded-6", ""],
  ];
  for (const [marker, name, bytes] of values) {
    writeFileSync(join(dir, name), bytes);
    expect(marker.raw()).toBe(bytes);
    expect(marker.read()).toBe(bytes.trim());
    marker.write(marker.raw());
    expect(readFileSync(join(dir, name), "utf8")).toBe(bytes);
  }
  expect(state.quiet.lines()).toEqual(["first", "second"]);
});

test.each(["missing", "broken", "[]", "null", '"scalar"'])(
  "memory retains the tolerant reader policy for %s state",
  (value) => {
    const dir = fixture();
    if (value !== "missing") {
      writeFileSync(join(dir, "worker-protocol-24"), value);
    }
    expect(new LoopState(dir).pr(24).protocol.read()).toEqual({});
  }
);

test("marker I/O distinguishes absence from read/remove/write failures", () => {
  const dir = fixture();
  const marker = new Marker(join(dir, "missing"));
  expect(marker.read()).toBe("");
  expect(marker.exists()).toBe(false);
  expect(() => marker.readRequired()).toThrow();
  marker.remove();
  mkdirSync(marker.path);
  expect(() => marker.read()).toThrow();
  expect(() => marker.remove()).toThrow();
  expect(() => marker.write("value")).toThrow();
});

const cleared = [
  "base-head-24",
  "worker-protocol-24",
  "worker-stop-24",
  "worker-checkin-24-round-a",
  "worker-checkin-24-round-b",
  "worker-metric-24",
  "cost-24",
  "unhandled-worker-24",
  "conflict-dispatched-24-head-a",
  "conflict-dispatched-24-head-b",
  "base-dispatched-24-head-base",
];

test("cleanup preserves acknowledgement history and the pending board move", () => {
  const dir = fixture();
  const state = new LoopState(dir);
  const retained = [
    "picked-24",
    "merge-notified-24",
    "conflict-result-24-head",
    "worker-protocol-seeded-24",
    "pending-progress-24",
  ];
  const oldBaselines = [
    "open-24",
    "head-24",
    "branch-24",
    "ci-24",
    "conflict-24",
    "merge-attempt-24",
    "merge-pending-24",
    "activity-24",
    "review-24",
    "seeded-24",
    "worker-prompt-24",
    "worker-prompts-seeded-24",
  ];
  for (const name of [...retained, ...oldBaselines]) {
    writeFileSync(join(dir, name), "existing\n");
  }
  state.pr(24).clear();
  expect(readdirSync(dir).sort()).toEqual(retained.sort());
  for (const name of retained) {
    expect(readFileSync(join(dir, name), "utf8")).toBe("existing\n");
  }
});

test.each(cleared)("completed merge removes %s and leaves other PRs alone", async (name) => {
  const f = (fake = new WatchFake());
  f.task();
  const loop = f.loop();
  await f.once(loop);
  writeFileSync(join(f.dir, name), "old memory\n");
  const other = name.replace("-24", "-240");
  writeFileSync(join(f.dir, other), "other memory\n");
  f.pulls = [];
  f.cards = [];
  f.gone = { merged: true, merged_at: f.iso(), user: user(), merged_by: user(0) };
  writeFileSync(join(f.dir, "merge-24.json"), JSON.stringify({ done: ["follow-up"] }));
  f.advance();
  expect(await f.once(loop)).toEqual([]);
  expect(existsSync(join(f.dir, name))).toBe(false);
  expect(readFileSync(join(f.dir, other), "utf8")).toBe("other memory\n");
});

test("incomplete button-merge follow-up retains state and its notification dedupe", async () => {
  const f = (fake = new WatchFake());
  f.task();
  const loop = f.loop();
  await f.once(loop);
  writeFileSync(join(f.dir, "worker-metric-24"), '{"sequence":2}\n');
  f.pulls = [];
  f.cards = [];
  f.gone = {
    merged: true,
    merged_at: f.iso(),
    user: user(),
    merged_by: { login: "me", id: 999, type: "User" },
  };
  f.advance(11 * 60_000);
  const events = await f.once(loop);
  expect(events.map((event) => event.kind)).toEqual(["button-merge"]);
  expect(existsSync(join(f.dir, "worker-metric-24"))).toBe(true);
  expect(existsSync(join(f.dir, "merge-notified-24"))).toBe(true);
  f.advance(11 * 60_000);
  expect(await f.once(loop)).toEqual([]);
  writeFileSync(join(f.dir, "merge-24.json"), JSON.stringify({ done: ["follow-up"] }));
  expect(await f.once(loop)).toEqual([]);
  expect(existsSync(join(f.dir, "worker-metric-24"))).toBe(false);
  expect(existsSync(join(f.dir, "merge-notified-24"))).toBe(true);
});
