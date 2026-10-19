/** Machine-owned switch categories. Narrative is retained separately, never used as a category. */
export const switchReasons = [
  "quota",
  "stopped-twice",
  "red-tests-blocked",
  "amendment-ignored",
  "owner-hint",
  "conflict-only",
  "orchestrator-judgement",
] as const;
export type SwitchReason = (typeof switchReasons)[number];
export interface MetricEvent {
  id: string;
  at: string;
  type: "changes" | "answer" | "conflict" | "owner-change" | "checkin" | "stop";
}
export interface ThreadEvent {
  body: string;
  role: string;
  date: string;
  url?: string;
}
export interface ExactMetrics {
  reviews: { changes: number; answer: number; conflict: number | null; ownerChange: number };
  checkins: number | null;
  stopsWithoutStatus: number | null;
  blocked: number;
  questions: number;
  escalations: number;
  workingMs: number | null;
  ownerWaitMs: number | null;
  peakContext: number | null;
  compactions: number | null;
  diff: { files: number; additions: number; deletions: number } | null;
}

/** Reduce authenticated protocol events in a half-open segment interval; time is wall-clock, not CPU. */
export function exactMetrics(input: {
  start: string;
  end?: string;
  comments: ThreadEvent[];
  events?: MetricEvent[];
  escalations?: number;
  peakContext?: number | null;
  compactions?: number | null;
  diff?: ExactMetrics["diff"];
}): ExactMetrics {
  const start = Date.parse(input.start),
    end = Date.parse(input.end ?? "");
  const inRange = (at: string) =>
    Date.parse(at) >= start && (!Number.isFinite(end) || Date.parse(at) < end);
  const comments = input.comments.filter((c) => inRange(c.date));
  const events = [
    ...new Map((input.events ?? []).filter((e) => inRange(e.at)).map((e) => [e.id, e])).values(),
  ];
  const count = (type: MetricEvent["type"]) => events.filter((e) => e.type === type).length;
  const tagged = (role: string, tag: string) =>
    comments.filter(
      (c) => c.role === role && new RegExp(`^\\[${role}\\] ${tag}(?:\\b|:)`).test(c.body)
    ).length;
  const ownerUrls = new Set(
    input.comments
      .filter((c) => c.role === "owner")
      .map((c) => c.url)
      .filter(Boolean)
  );
  const ownerChanges = comments.filter(
    (c) =>
      c.role === "orchestrator" &&
      /^\[orchestrator\] REVIEW\b/.test(c.body) &&
      ownerUrls.has(/^in reply to (\S+)$/m.exec(c.body)?.[1])
  ).length;
  let state: "working" | "owner" | "other" = "working",
    since = start;
  let workingMs = 0,
    ownerWaitMs = 0;
  // Include earlier transitions so a segment beginning during owner wait inherits that state.
  for (const c of [...input.comments].sort((a, b) => Date.parse(a.date) - Date.parse(b.date))) {
    const at = Date.parse(c.date);
    if (!Number.isFinite(at) || at >= end) {
      continue;
    }
    let next: "working" | "owner" | "other" | undefined;
    if (c.role === "owner") {
      next = "other";
    }
    if (
      c.role === "worker" &&
      /^\[worker\] (READY FOR REVIEW|QUESTION|BLOCKED|DESIGN|HANDOFF)\b/.test(c.body)
    ) {
      next = "other";
    }
    if (c.role === "worker" && /^\[worker\] ACK\b/.test(c.body)) {
      next = "working";
    }
    if (
      c.role === "orchestrator" &&
      /^\[orchestrator\] (OWNER REVIEW|OWNER QUESTION)\b/.test(c.body)
    ) {
      next = "owner";
    }
    if (
      c.role === "orchestrator" &&
      /^\[orchestrator\] (REVIEW|ANSWER|GO|AMENDMENT)\b/.test(c.body)
    ) {
      next = "working";
    }
    if (!next) {
      continue;
    }
    if (at >= start) {
      if (state === "working") {
        workingMs += at - since;
      }
      if (state === "owner") {
        ownerWaitMs += at - since;
      }
      since = at;
    }
    state = next;
  }
  if (Number.isFinite(end) && end >= start) {
    if (state === "working") {
      workingMs += end - since;
    }
    if (state === "owner") {
      ownerWaitMs += end - since;
    }
  }
  return {
    reviews: {
      changes: tagged("orchestrator", "REVIEW") - ownerChanges,
      answer: tagged("orchestrator", "ANSWER"),
      conflict: input.events === undefined ? null : count("conflict"),
      ownerChange: ownerChanges + count("owner-change"),
    },
    checkins: input.events === undefined ? null : count("checkin"),
    stopsWithoutStatus: input.events === undefined ? null : count("stop"),
    blocked: tagged("worker", "BLOCKED"),
    questions: tagged("worker", "QUESTION"),
    escalations: input.escalations ?? 0,
    workingMs: Number.isFinite(end) && Number.isFinite(start) ? workingMs : null,
    ownerWaitMs: Number.isFinite(end) && Number.isFinite(start) ? ownerWaitMs : null,
    peakContext: input.peakContext ?? null,
    compactions: input.compactions ?? null,
    diff: input.diff ?? null,
  };
}
