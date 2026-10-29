/** The Progress emoji table from the board baseline; a card renders `<state>[ 🔁round][ 🔴]`. */
export const progressStates: Record<string, string> = {
  hold: "⛔",
  working: "🤖🔨",
  question: "🤖❓",
  design: "🤖📐",
  blocked: "🤖🚫",
  ready: "🤖👍",
  verifying: "🧭🔍",
  "owner-review": "👤🔍",
  "owner-question": "👤❓",
  conflict: "💥",
  silent: "⏳",
  permission: "🔑",
  failed: "🪫",
  idle: "💤",
  handoff: "🤖🤝",
};

/** Stuck states return to working on any worker activity; the board baseline lists them. */
const stuckProgressStates = ["silent", "permission", "failed", "idle", "conflict"];

/** Worker activity also clears `handoff`: the new worker's first note or commit resumes work. */
export const revivedProgressStates = [...stuckProgressStates, "handoff"];

export type ManagementTurn = "owner" | "orchestrator" | null;

/** Explicit turns only: the watcher preserves existing assignees for other states. */
const progressTurns: Record<string, ManagementTurn> = {
  "owner-review": "owner",
  "owner-question": "owner",
  ready: "orchestrator",
  question: "orchestrator",
  blocked: "orchestrator",
  verifying: "orchestrator",
  design: "orchestrator",
  handoff: "orchestrator",
  working: null,
};

/** Housekeeping's complete turn policy, including its legacy review-column fallback.
 * Working explicitly clears the turn even in a review column. Empty/stuck/unknown
 * states instead hold the owner in Spec review/Owner review and nobody elsewhere. */
export function expectedTurn(state: string | null, column: string): ManagementTurn {
  const key = state ?? "";
  return !Object.hasOwn(progressTurns, key)
    ? ["Spec review", "Owner review"].includes(column)
      ? "owner"
      : null
    : progressTurns[key];
}

/** Watcher compatibility: undefined means leave the existing turn untouched, not
 * clear it. Unlike housekeeping, reconciliation has no column fallback. */
export function reconciledTurn(state: string | null): ManagementTurn | undefined {
  const key = state ?? "";
  return Object.hasOwn(progressTurns, key) ? expectedTurn(state, "") : undefined;
}

/** The server's intentionally partial owner-reply test, not the full turn policy.
 * Preserve its raw prefix check (including unknown 🧭 words); callers also accept
 * an actual orchestrator assignee independently of Progress. */
export function ownerReplyProgress(progress: unknown, column: string): boolean {
  return ["Owner review", "Executing"].includes(column) && hasOrchestratorProgress(progress);
}

/** Legacy reminder/owner-reply signal: raw leading compass, not every state that
 * holds an orchestrator turn. Do not trim or narrow this to known emoji words. */
export function hasOrchestratorProgress(progress: unknown): boolean {
  return String(progress ?? "").startsWith("🧭");
}

/** Guarded arrows queued by the watcher. Unguarded protocol/owner/lifecycle changes
 * may replace any state; the Executing owner-paused gate remains at the writer. */
export const progressGuards = {
  revive: revivedProgressStates,
  conflictResolved: ["conflict"],
  stopped: ["working"],
  silent: ["working"],
  permission: ["working", "silent", "idle", "failed"],
  failed: ["working", "silent", "idle", "permission"],
  idle: ["working", "silent"],
};

/** An explicit guard is the allowed source-state arrow table for this queued
 * change. No guard means unrestricted, even for unknown targets (renderProgress
 * still validates them). Null source matches the legacy empty-string guard. */
export function mayReplace(
  from: string | null,
  _to: string | null,
  guard?: readonly string[]
): boolean {
  return guard === undefined || guard.includes(from ?? "");
}

/** Review outcome → Progress; role selection is always expectedTurn on this state. */
export function reviewProgress(
  outcome: "changes" | "owner" | "answer" | "ask" | "approve",
  round: number
): ProgressParts {
  return {
    state: {
      changes: "working",
      owner: "owner-review",
      answer: "working",
      ask: "owner-question",
      approve: "verifying",
    }[outcome],
    round: outcome === "changes" ? round : null,
    red: false,
  };
}

export interface ProgressParts {
  state: string | null;
  round: number | null;
  red: boolean;
}

/** Round digits are keycaps: `1` plus U+FE0F and U+20E3, as the board policy writes them. */
function keycapRound(round: number): string {
  return String(round).replace(/\d/g, (digit) => `${digit}\u{FE0F}\u{20E3}`);
}

export function renderProgress(parts: ProgressParts): string {
  const words: string[] = [];
  if (parts.state !== null) {
    const emoji = progressStates[parts.state];
    if (!emoji) {
      throw new Error(`Unknown Progress state: ${parts.state}`);
    }
    words.push(emoji);
  }
  if (parts.round !== null) {
    words.push(`\u{1F501}${keycapRound(parts.round)}`);
  }
  if (parts.red) {
    words.push("\u{1F534}");
  }
  return words.join(" ");
}

/**
 * `handoff` is never `🔁`, which is the round marker: `🤖🤝 🔁2️⃣` stays one state plus a
 * round. An unknown state word (a newer migration's emoji in an older script) is ignored,
 * never an error, so expand-only migrations keep older parsers working.
 */
export function parseProgress(
  text: unknown,
  states: Record<string, string> = progressStates
): ProgressParts {
  const parts: ProgressParts = { state: null, round: null, red: false };
  for (const word of String(text ?? "")
    .split(/\s+/)
    .filter(Boolean)) {
    if (word.startsWith("\u{1F501}")) {
      const digits = word.replace(/\D/g, "");
      parts.round = digits ? Number(digits) : null;
    } else if (word === "\u{1F534}") {
      parts.red = true;
    } else {
      for (const [state, emoji] of Object.entries(states)) {
        if (word === emoji) {
          parts.state = state;
        }
      }
    }
  }
  return parts;
}
