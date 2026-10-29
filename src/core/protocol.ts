/** Protocol syntax only: callers must authenticate the speaker separately. */
export const workerTags = [
  "ACK",
  "READY",
  "QUESTION",
  "DESIGN",
  "BLOCKED",
  "HANDOFF",
  "NOTE",
] as const;
export const orchestratorTags = [
  "REVIEW",
  "OWNER REVIEW",
  "SCOPE REVIEW",
  "OWNER QUESTION",
  "ANSWER",
  "AMENDMENT",
  "GO",
  "APPROVED",
  "AUTOPILOT",
  "AUTOPILOT APPROVED",
  "APPROVAL CARRIED",
  "NOTE",
  "GRADE",
  "CHECK-IN",
  "CHANGES",
  "Unapproved exception",
] as const;
export type WorkerTag = (typeof workerTags)[number];
export type OrchestratorTag = (typeof orchestratorTags)[number];
type Role = "worker" | "orchestrator";
type Tag = WorkerTag | OrchestratorTag;

/** Compatibility options preserve the deliberately different historical readers. */
export interface ParseOptions {
  role?: Role;
  tags?: readonly Tag[];
  /** READY matches the short prefix; full-ready requires READY FOR REVIEW. */
  ready?: "short" | "full";
  boundary?: "word" | "whitespace" | "line";
  ignoreCase?: boolean;
  /** Round readers require their suffix; task review requires exactly one space. */
  round?: "flexible" | "single-space";
}

/** Parse without trimming; default tags are case-sensitive word-boundary prefixes.
 * Round suffixes are optional unless options.round selects a historical round reader.
 * No identity, trust or authority is inferred from a successful parse.
 */
export function parseFirstLine(
  body: string,
  options: ParseOptions = {}
):
  | {
      role: Role;
      tag: Tag;
      round?: number;
    }
  | undefined {
  const roles: Role[] = options.role ? [options.role] : ["worker", "orchestrator"];
  for (const role of roles) {
    const tags = options.tags ?? (role === "worker" ? workerTags : orchestratorTags);
    // Prefer the longest vocabulary entry (AUTOPILOT APPROVED before AUTOPILOT).
    for (const tag of [...tags].sort((a, b) => b.length - a.length)) {
      const text = tag === "READY" && options.ready === "full" ? "READY FOR REVIEW" : tag;
      const suffix = options.round
        ? tag === "REVIEW"
          ? ` round${options.round === "single-space" ? " " : "\\s+"}(\\d+)`
          : tag === "READY"
            ? " \\(round\\s+(\\d+)\\)"
            : "(?!)"
        : options.boundary === "line"
          ? "(?:\\r?\\n|$)"
          : options.boundary === "whitespace"
            ? "(?:\\s|$)"
            : "\\b";
      const match = new RegExp(
        `^\\[${role}\\] ${text}${suffix}`,
        options.ignoreCase ? "i" : ""
      ).exec(body);
      if (match) {
        const round = options.round ? match[1] : roundText(body.split(/\r?\n/, 1)[0]);
        return { role, tag, ...(round === undefined ? {} : { round: Number(round) }) };
      }
    }
  }
  return undefined;
}

/** Find the historical free-form round suffix, preserving leading zeroes for wake text. */
export function roundText(text: string): string | undefined {
  return /round\s+(\d+)/i.exec(text)?.[1];
}

/** Render the exact orchestrator first line, optionally with its review round. */
export function heading(tag: OrchestratorTag | `REVIEW round ${number}`, round?: number): string {
  return `[orchestrator] ${tag}${round === undefined ? "" : ` round ${round}`}`;
}

/** Render the exact worker first line (READY uses the posted, long spelling). */
export function workerHeading(tag: WorkerTag, round?: number): string {
  return `[worker] ${tag === "READY" ? "READY FOR REVIEW" : tag}${round === undefined ? "" : ` (round ${round})`}`;
}

/** Prefix-only readers intentionally accept unknown tags and no following space. */
export function hasRolePrefix(body: string, role: Role): boolean {
  return body.startsWith(`[${role}]`);
}

/** The delegated approval proof requires exact LF separators and a complete head. */
export function autopilotHead(body: string): string | undefined {
  return /^\[orchestrator\] AUTOPILOT APPROVED\n\nCurrent head: ([a-f\d]{40})\n/i.exec(body)?.[1];
}

/** Scope summaries forbid a nested literal heading anywhere, not just on line one. */
export function containsScopeHeading(body: string): boolean {
  return body.includes(heading("SCOPE REVIEW"));
}

/** Recover the arbitrary heading of a queued wake, including its round suffix. */
export function wakeHeading(text: string): string | undefined {
  return /^\[orchestrator\] (.+) is on your PR;/.exec(text)?.[1];
}

/** Render the existing notification verbatim; tag may include the review round. */
export function wakeText(tag: string, pr: number | string): string {
  return `[orchestrator] ${tag} is on your PR; read it with vmethod read pr ${pr} --new and act. End your turn with one line naming what you posted.`;
}

/** Render the bounded idle-turn reminder verbatim. */
export function checkInText(pr: number): string {
  return `[orchestrator] CHECK-IN: your turn ended without a status comment on the PR. Post exactly one of READY, QUESTION, BLOCKED or DESIGN on PR #${pr} with \`vmethod pr-comment\`. If you are not done, finish only the remaining acceptance steps first, adding no new scope. If you are unsure or stuck, post QUESTION or BLOCKED and stop.`;
}
