import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { stringify } from "yaml";
import { getConfig } from "../../src/config.js";
import type { Dependencies } from "../../src/gateway/client.js";
import {
  filterStaleWakes,
  WorkerService,
  type TaskMetadata,
  type WorkerHooks,
} from "../../src/gateway/workers.js";
import { validProject } from "../helpers.js";
import captured from "../fixtures/usage/opencode-session.json" with { type: "json" };

const time = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
const wake = (heading: string) =>
  `[orchestrator] ${heading} is on your PR; read it with vmethod read pr 31 --new and act.`;
const answer = wake("ANSWER");
const review = wake("REVIEW round 2");
const checkin = "[orchestrator] CHECK-IN: your turn ended without a status comment on the PR.";
const conflict =
  "CONFLICT: merge origin/dev, resolve keeping both sides' behaviour, push, wait-checks, READY. If every conflicted file is package-lock.json, npm-shrinkwrap.json, yarn.lock or pnpm-lock.yaml (at any path), do not hand-merge: keep package.json manifests as merged by git and regenerate the lockfiles with npm install --package-lock-only or the configured equivalent in postMerge.install. Commit the regeneration as the merge resolution; the remerge diff may touch only lockfiles, lockfile sync must pass and configured checks must be green. Mixed conflicts retain the conflicted-hunk rule.";
const comment = (role: string, body: string, minute: number): TaskMetadata["comments"][number] => ({
  role,
  body,
  date: time(minute),
});
const trigger = (minute = 1) => comment("orchestrator", "[orchestrator] ANSWER", minute);
const reply = (minute = 2, heading = "READY FOR REVIEW (round 1)") =>
  comment("worker", `[worker] ${heading}`, minute);
const staleMessage = (heading: string, triggered: number, replied: number, tag: string) =>
  `stale wake dropped for #31: ${heading} (${time(triggered)}) superseded by [worker] ${tag} at ${time(replied)}`;

interface FilterRow {
  name: string;
  queued?: string[];
  conflictSentAt?: string;
  comments: TaskMetadata["comments"];
  merged?: boolean;
  ownerPaused?: boolean;
  kept: string[];
  dropped: string[];
  reports?: string[];
}

const filterRows: FilterRow[] = [
  { name: "W2 #105: absent queue is empty", comments: [], kept: [], dropped: [] },
  { name: "W2 #181: empty queue is empty", queued: [], comments: [], kept: [], dropped: [] },
  {
    name: "W3 #193: no later genuine reply keeps the wake",
    queued: [answer],
    comments: [trigger()],
    kept: [answer],
    dropped: [],
  },
  {
    name: "W3 #193: a reply before queue time answers nothing",
    queued: [answer],
    comments: [reply(0), trigger()],
    kept: [answer],
    dropped: [],
  },
  {
    name: "W3 #193: reply exactly at queue trigger time is not later",
    queued: [answer],
    comments: [trigger(), reply(1)],
    kept: [answer],
    dropped: [],
  },
  ...["READY FOR REVIEW (round 1)", "QUESTION", "BLOCKED", "DESIGN", "HANDOFF"].map(
    (tag): FilterRow => ({
      name: `W3 #193: genuine later ${tag} drops the wake`,
      queued: [answer],
      comments: [trigger(), reply(2, tag)],
      kept: [],
      dropped: [answer],
      reports: [staleMessage("ANSWER", 1, 2, tag)],
    })
  ),
  ...["ACK", "READYISH", "plain text\n[worker] READY", " READY"].map((tag): FilterRow => ({
    name: `W3 #193: non-reply ${JSON.stringify(tag)} keeps the wake`,
    queued: [answer],
    comments: [trigger(), reply(2, tag)],
    kept: [answer],
    dropped: [],
  })),
  {
    name: "W3 #193: collaborator's worker tag is not a genuine reply",
    queued: [answer],
    comments: [trigger(), comment("collaborator", "[worker] READY", 2)],
    kept: [answer],
    dropped: [],
  },
  {
    name: "W3 #193: collaborator's orchestrator tag is not a trigger",
    queued: [answer],
    comments: [comment("collaborator", "[orchestrator] ANSWER", 1), reply()],
    kept: [answer],
    dropped: [],
  },
  {
    name: "W3 #193: latest repeated trigger wins even with unsorted comments",
    queued: [answer],
    comments: [trigger(3), reply(), trigger()],
    kept: [answer],
    dropped: [],
  },
  {
    name: "W3 #193: latest genuine reply wins even with unsorted comments",
    queued: [answer],
    comments: [reply(3), trigger(), reply(0)],
    kept: [],
    dropped: [answer],
    reports: [staleMessage("ANSWER", 1, 3, "READY FOR REVIEW (round 1)")],
  },
  {
    name: "W2 #105: unmatched wake and CHECK-IN survive later replies",
    queued: [checkin, review, "Read the new review"],
    comments: [trigger(), reply()],
    kept: [checkin, review, "Read the new review"],
    dropped: [],
  },
  {
    name: "W3 #331: genuine reply before conflict boundary still drops old wake",
    queued: [answer],
    conflictSentAt: time(3),
    comments: [trigger(), reply()],
    kept: [],
    dropped: [answer],
    reports: [staleMessage("ANSWER", 1, 2, "READY FOR REVIEW (round 1)")],
  },
  {
    name: "W3 #331: reply exactly at conflictSentAt answers nothing",
    queued: [answer],
    conflictSentAt: time(3),
    comments: [trigger(), reply(3)],
    kept: [answer],
    dropped: [],
  },
  {
    name: "W3 #331: reply during conflict turn answers no earlier wake",
    queued: [answer],
    conflictSentAt: time(3),
    comments: [trigger(), reply(4)],
    kept: [answer],
    dropped: [],
  },
  {
    name: "W3 #331 PR #345 round 1: reply answers no wake queued exactly at conflict send",
    queued: [answer],
    conflictSentAt: time(3),
    comments: [trigger(3), reply(4)],
    kept: [answer],
    dropped: [],
  },
  {
    name: "W3 #331 PR #345 round 1: reply answers no wake queued after conflict send",
    queued: [answer],
    conflictSentAt: time(3),
    comments: [trigger(4), reply(5)],
    kept: [answer],
    dropped: [],
  },
  {
    name: "W3 #331: conflict reply does not hide an earlier genuine reply",
    queued: [answer],
    conflictSentAt: time(3),
    comments: [reply(4), trigger(), reply()],
    kept: [],
    dropped: [answer],
    reports: [staleMessage("ANSWER", 1, 2, "READY FOR REVIEW (round 1)")],
  },
  {
    name: "W3 #193: partial drops report in queue order and preserve surviving order",
    queued: [review, checkin, answer],
    comments: [
      reply(4, "QUESTION\r\nDetails"),
      trigger(),
      comment("orchestrator", "[orchestrator] REVIEW round 2\r\nDetails", 3),
    ],
    kept: [checkin],
    dropped: [review, answer],
    reports: [
      staleMessage("REVIEW round 2", 3, 4, "QUESTION"),
      staleMessage("ANSWER", 1, 4, "QUESTION"),
    ],
  },
  {
    name: "W2 #193: owner summons deliberately suppresses wakes without stale report",
    queued: [answer, checkin],
    ownerPaused: true,
    comments: [trigger(), reply()],
    kept: [],
    dropped: [answer, checkin],
  },
  {
    name: "W2 #373: merge deliberately suppresses wakes without stale report",
    queued: [answer, review],
    merged: true,
    comments: [],
    kept: [],
    dropped: [answer, review],
  },
];

const filterRan = new Set<string>();
test.each(filterRows)("filter: $name", (row) => {
  const record = { pr: 31, pendingWake: row.queued, conflictSentAt: row.conflictSentAt };
  const meta = {
    comments: row.comments,
    merged: row.merged ?? false,
    ownerPaused: row.ownerPaused,
  };
  const original = structuredClone({ record, meta });
  const reports: string[] = [];
  const kept = filterStaleWakes(record, meta, (message) => reports.push(message));
  expect(kept).toEqual(row.kept);
  expect((row.queued ?? []).filter((text) => !kept.includes(text))).toEqual(row.dropped);
  expect(reports).toEqual(row.reports ?? []);
  if (row.queued?.length && !row.dropped.length) {
    expect(kept).toBe(row.queued);
  }
  expect({ record, meta }).toEqual(original);
  filterRan.add(row.name);
});

interface Request {
  path: string;
  method?: string;
  body?: unknown;
  data?: unknown;
}
interface Saved {
  model: { family: string; model: string; kind: "opencode"; gate: "none"; tier: "cheap" };
  pendingWake?: string[];
  pendingConflict?: { model: Saved["model"]; base: string };
  conflictSentAt?: string;
  conflictModel?: Saved["model"];
}

// Same ordered, fail-loud fetch/exec fake as workers.test.ts, narrowed to this seam.
// Session totals are projected from the recorded OpenCode fixture; ids are local.
function fixture(requests: Request[]) {
  const root = validProject();
  const directory = join(root, ".worktrees", "9-task");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(root, "models.yaml"),
    stringify([{ family: "glm", model: "fake/glm", kind: "opencode", gate: "none", tier: "cheap" }])
  );
  const env = {
    XDG_STATE_HOME: join(root, "state"),
    OPENCODE_BASE_URL: "https://opencode.invalid",
    OPENCODE_SERVER_USERNAME: "fake-user",
    OPENCODE_SERVER_PASSWORD: "secret-password",
  };
  const meta: TaskMetadata = {
    pr: 31,
    issue: 9,
    base: "dev",
    branch: "9-task",
    title: "Task $(hostile)",
    body: "PR description `data`",
    state: "OPEN",
    draft: true,
    blocked: false,
    estimate: 3,
    pointsOpen: 3,
    model: "glm",
    kind: "tooling",
    merged: false,
    comments: [],
  };
  let index = 0;
  const unexpected: string[] = [];
  const prompts: { text: string; delivery: string }[] = [];
  const deps: Dependencies = {
    fetch: async (url, init) => {
      const target = new URL(String(url));
      // Existing fake's explicit optional-plugin absence, not a catch-all response.
      if (target.pathname === "/api/rpc/oc-limits/limits") {
        return Response.json(
          { error: { name: "RpcError", message: "plugin not installed" } },
          { status: 404 }
        );
      }
      const expected = requests[index++];
      if (!expected) {
        unexpected.push(target.pathname);
        throw new Error("Unexpected fake opencode request");
      }
      expect(target.origin).toBe("https://opencode.invalid");
      expect(target.pathname + target.search).toBe(expected.path);
      expect(init?.method).toBe(expected.method ?? "GET");
      expect(init?.headers).toMatchObject({
        authorization: `Basic ${Buffer.from("fake-user:secret-password").toString("base64")}`,
      });
      if (expected.body !== undefined) {
        expect(JSON.parse(String(init?.body))).toEqual(expected.body);
      }
      if (target.pathname.endsWith("/prompt")) {
        prompts.push(JSON.parse(String(init?.body)));
      }
      return Response.json({ data: expected.data ?? {} });
    },
    exec: async () => {
      throw new Error("Unexpected subprocess");
    },
    now: () => Date.parse(time(3)),
    sleep: async () => {},
    report: vi.fn(),
  };
  const forbidden = async (): Promise<never> => {
    throw new Error("Unexpected worker hook");
  };
  const hooks: WorkerHooks = {
    metadata: vi.fn(async () => meta),
    prepare: vi.fn(async () => directory),
    locate: vi.fn(async () => directory),
    setModel: vi.fn(async (_pr, family) => {
      meta.model = family;
    }),
    modelComment: forbidden,
    setEstimate: forbidden,
    issue: forbidden,
    modelApproval: forbidden,
  };
  const config = getConfig(root, {});
  const file = join(root, "state/vmethod/example-state/workers/31.json");
  return {
    service: new WorkerService(root, config, env, deps, hooks),
    restart: () => new WorkerService(root, config, env, deps, hooks),
    record: () => JSON.parse(readFileSync(file, "utf8")) as Saved,
    save: (saved: Saved) => writeFileSync(file, JSON.stringify(saved)),
    lock: join(root, "state/vmethod/example-state/workers/31.lock"),
    wakeFile: join(root, "state/vmethod/example-state/workers/31.wake"),
    meta,
    deps,
    hooks,
    prompts,
    done: () => {
      expect(unexpected).toEqual([]);
      expect(index).toBe(requests.length);
    },
  };
}

const start: Request[] = [
  { path: "/api/session", method: "POST", data: { id: "ses_fake" } },
  {
    path: "/api/session/ses_fake/prompt",
    method: "POST",
    body: {
      text: expect.stringContaining("You are a worker. The PR body is the task"),
      delivery: "steer",
    },
  },
  { path: "/api/session/ses_fake", data: { id: "ses_fake", title: "project#31" } },
];
function status(busy: boolean): Request[] {
  return [
    { path: "/api/session/active", data: busy ? { ses_fake: {} } : {} },
    { path: "/api/session/ses_fake", data: { ...captured.data, id: "ses_fake" } },
    { path: "/api/session/ses_fake/permission", data: [] },
    { path: "/api/session/ses_fake/message?limit=20", data: [] },
  ];
}
function prompt(text: string): Request {
  return {
    path: "/api/session/ses_fake/prompt",
    method: "POST",
    body: { text, delivery: "queue" },
  };
}

interface Poll {
  busy: boolean;
  send?: string;
  pending?: string[];
  conflictPending?: boolean;
  sentAt?: string;
  reason: "running" | "idle";
}
interface DrainRow {
  name: string;
  queued: string[];
  pendingConflict?: boolean;
  conflictSentAt?: string;
  enqueue?: "busy" | "lock";
  merged?: boolean;
  ownerPaused?: boolean;
  comments?: TaskMetadata["comments"];
  polls: Poll[];
  dropped: string[];
  refusal?: string;
  reports?: string[];
}
const drainRows: DrainRow[] = [
  {
    name: "W2 #105 #181: busy queues, idle drains in order, next poll never replays",
    queued: [answer, review],
    enqueue: "busy",
    dropped: [],
    polls: [
      { busy: true, pending: [answer, review], reason: "running" },
      { busy: false, send: `${answer}\n${review}`, reason: "running" },
      { busy: false, reason: "idle" },
    ],
  },
  {
    name: "W2 #181: lock contention persists wake file, restart drains once idle",
    queued: [answer],
    enqueue: "lock",
    dropped: [],
    polls: [
      { busy: true, pending: [answer], reason: "running" },
      { busy: false, send: answer, reason: "running" },
      { busy: false, reason: "idle" },
    ],
  },
  {
    name: "W2 W4 #331: busy holds conflict and wakes, idle sends CONFLICT first with timestamp",
    queued: [answer, review],
    pendingConflict: true,
    dropped: [],
    polls: [
      { busy: true, pending: [answer, review], conflictPending: true, reason: "running" },
      {
        busy: false,
        send: conflict,
        pending: [answer, review],
        sentAt: time(3),
        reason: "running",
      },
      { busy: false, send: `${answer}\n${review}`, reason: "running" },
    ],
  },
  {
    name: "W4 #331: conflict-only idle drain records send even with no wakes",
    queued: [],
    pendingConflict: true,
    dropped: [],
    polls: [
      { busy: false, send: conflict, sentAt: time(3), reason: "running" },
      { busy: false, sentAt: time(3), reason: "idle" },
    ],
  },
  {
    name: "W3 #193: idle drops genuinely answered wake and clears conflict boundary",
    queued: [answer],
    conflictSentAt: time(3),
    comments: [trigger(), reply()],
    dropped: [answer],
    reports: [staleMessage("ANSWER", 1, 2, "READY FOR REVIEW (round 1)")],
    polls: [{ busy: false, reason: "idle" }],
  },
  {
    name: "W2 W3 #193: partial stale drain sends only unanswered wake",
    queued: [answer, review],
    comments: [trigger(), reply(), comment("orchestrator", "[orchestrator] REVIEW round 2", 3)],
    dropped: [answer],
    reports: [staleMessage("ANSWER", 1, 2, "READY FOR REVIEW (round 1)")],
    polls: [{ busy: false, send: review, reason: "running" }],
  },
  {
    name: "W3 #331 PR #345 round 1: wake queued during conflict survives fixer's reply",
    queued: [review],
    conflictSentAt: time(3),
    comments: [comment("orchestrator", "[orchestrator] REVIEW round 2", 4), reply(5)],
    dropped: [],
    polls: [{ busy: false, send: review, reason: "running" }],
  },
  {
    name: "W2 #373: merged wake drain drops deliberately with resume message",
    queued: [answer],
    merged: true,
    conflictSentAt: time(3),
    dropped: [answer],
    refusal: "#31 is merged; nothing sent",
    polls: [{ busy: false, reason: "idle" }],
  },
  {
    name: "W2 W4 #373: merged conflict drain clears both queues and boundary",
    queued: [answer],
    pendingConflict: true,
    merged: true,
    conflictSentAt: time(3),
    dropped: [answer],
    refusal: "#31 is merged; nothing sent",
    polls: [{ busy: false, reason: "idle" }],
  },
  {
    name: "W2 #373 #181: merged persisted wake file is consumed without delivery",
    queued: [answer],
    enqueue: "lock",
    merged: true,
    dropped: [answer],
    refusal: "#31 is merged; nothing sent",
    polls: [{ busy: false, reason: "idle" }],
  },
  {
    name: "W2 #193: owner summons drops wake queue silently until explicit resume message",
    queued: [answer],
    ownerPaused: true,
    conflictSentAt: time(3),
    dropped: [answer],
    refusal: "owner summons paused for #31; nothing sent",
    polls: [{ busy: false, reason: "idle" }],
  },
  {
    name: "W2 W4 #193 #331: owner summons holds pending conflict and therefore wake drain",
    queued: [answer],
    pendingConflict: true,
    ownerPaused: true,
    conflictSentAt: time(2),
    dropped: [],
    polls: [
      { busy: false, pending: [answer], conflictPending: true, sentAt: time(2), reason: "idle" },
    ],
  },
  {
    name: "W2 #373: busy merged session retains wakes until first idle drain",
    queued: [answer],
    merged: true,
    dropped: [answer],
    refusal: "#31 is merged; nothing sent",
    polls: [
      { busy: true, pending: [answer], reason: "running" },
      { busy: false, reason: "idle" },
    ],
  },
];

const drainRan = new Set<string>();
test.each(drainRows)("drains: $name", async (row) => {
  const f = fixture([
    ...start,
    ...(row.enqueue === "busy" ? row.queued.flatMap(() => status(true)) : []),
    ...row.polls.flatMap((poll) => [
      ...status(poll.busy),
      ...(poll.send ? [prompt(poll.send)] : []),
    ]),
  ]);
  await f.service.command(["start", "31"]);
  const saved = f.record();
  if (!row.enqueue && row.queued.length) {
    saved.pendingWake = [...row.queued];
  }
  if (row.pendingConflict) {
    saved.pendingConflict = { model: saved.model, base: "dev" };
  }
  if (row.conflictSentAt) {
    saved.conflictSentAt = row.conflictSentAt;
  }
  f.save(saved);
  if (row.enqueue === "lock") {
    mkdirSync(f.lock);
  }
  for (const text of row.enqueue ? row.queued : []) {
    expect(await f.service.resume(31, text)).toBe("queued for #31");
  }
  if (row.enqueue === "lock") {
    expect(readFileSync(f.wakeFile, "utf8")).toBe(`${row.queued.join("\n")}\n`);
    expect(f.record().pendingWake).toBeUndefined();
    rmSync(f.lock, { recursive: true });
  }
  if (row.enqueue === "busy") {
    expect(f.record().pendingWake).toEqual(row.queued);
  }
  f.meta.merged = row.merged ?? false;
  f.meta.ownerPaused = row.ownerPaused;
  f.meta.comments = row.comments ?? [];
  const restarted = f.restart();
  const sent: string[] = [];
  for (const poll of row.polls) {
    const result = await restarted.watchStatus(31);
    expect(result).toMatchObject({ reason: poll.reason, active: poll.reason === "running" });
    if (poll.send) {
      sent.push(poll.send);
    }
    expect(f.prompts.slice(1)).toEqual(sent.map((text) => ({ text, delivery: "queue" })));
    const record = f.record();
    expect(record.pendingWake).toEqual(poll.pending);
    expect(record.pendingConflict).toEqual(
      poll.conflictPending ? { model: saved.model, base: "dev" } : undefined
    );
    expect(record.conflictSentAt).toBe(poll.sentAt);
    expect(existsSync(f.wakeFile)).toBe(false);
  }
  const delivered = sent.flatMap((text) => (text === conflict ? [] : text.split("\n")));
  expect(
    row.queued.filter(
      (text) => !delivered.includes(text) && !f.record().pendingWake?.includes(text)
    )
  ).toEqual(row.dropped);
  expect(f.deps.report).toHaveBeenCalledTimes(row.reports?.length ?? 0);
  expect(vi.mocked(f.deps.report).mock.calls.map(([message]) => message)).toEqual(
    row.reports ?? []
  );
  if (row.refusal) {
    expect(await restarted.resume(31, answer)).toBe(row.refusal);
  }
  expect(f.prompts).toHaveLength(sent.length + 1);
  // All continuation prompts, unlike onboarding, were queued rather than steered.
  expect(f.prompts[0].delivery).toBe("steer");
  f.done();
  drainRan.add(row.name);
});

afterAll(() => {
  for (const [rows, ran] of [
    [filterRows, filterRan],
    [drainRows, drainRan],
  ] as const) {
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((row) => row.name)).size).toBe(rows.length);
    expect([...ran].sort()).toEqual(rows.map((row) => row.name).sort());
  }
});
