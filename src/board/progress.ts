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
