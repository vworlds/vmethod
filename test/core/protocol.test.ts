import { describe, expect, it } from "vitest";
import {
  autopilotHead,
  checkInText,
  containsScopeHeading,
  hasRolePrefix,
  heading,
  orchestratorTags,
  parseFirstLine,
  roundText,
  wakeHeading,
  wakeText,
  workerHeading,
  workerTags,
  type ParseOptions,
} from "../../src/core/protocol.js";

// Frozen pre-extraction readers are an independent acceptance oracle, not source greps.
const profiles: [string, ParseOptions, RegExp][] = [
  [
    "event self response",
    { role: "orchestrator", tags: ["ANSWER", "GO"] },
    /^\[orchestrator\] (?:ANSWER|GO)\b/,
  ],
  [
    "event owner summons",
    { role: "orchestrator", tags: ["OWNER QUESTION", "OWNER REVIEW"] },
    /^\[orchestrator\] OWNER (?:QUESTION|REVIEW)\b/,
  ],
  [
    "worker replies (events and stale wakes)",
    { role: "worker", tags: ["READY", "QUESTION", "DESIGN", "BLOCKED", "HANDOFF"] },
    /^\[worker\] (READY|QUESTION|DESIGN|BLOCKED|HANDOFF)\b/,
  ],
  [
    "unhandled worker",
    { role: "worker", tags: ["READY", "QUESTION", "BLOCKED"] },
    /^\[worker\] (READY|QUESTION|BLOCKED)\b/,
  ],
  [
    "handled worker",
    { role: "orchestrator", tags: ["REVIEW", "OWNER REVIEW", "ANSWER", "AMENDMENT", "GO"] },
    /^\[orchestrator\] (?:REVIEW|OWNER REVIEW|ANSWER|AMENDMENT|GO)\b/,
  ],
  [
    "active worker",
    { role: "orchestrator", tags: ["REVIEW", "CHANGES", "ANSWER", "AMENDMENT", "GO"] },
    /^\[orchestrator\] (?:REVIEW|CHANGES|ANSWER|AMENDMENT|GO)\b/,
  ],
  [
    "worker round",
    { role: "worker", tags: ["READY"], ready: "full", ignoreCase: true, round: "flexible" },
    /^\[worker\] READY FOR REVIEW \(round\s+(\d+)\)/i,
  ],
  [
    "session review round",
    { role: "orchestrator", tags: ["REVIEW"], ignoreCase: true, round: "flexible" },
    /^\[orchestrator\] REVIEW round\s+(\d+)/i,
  ],
  [
    "task review round",
    { role: "orchestrator", tags: ["REVIEW"], round: "single-space" },
    /^\[orchestrator\] REVIEW round (\d+)/,
  ],
  [
    "answer target",
    { role: "worker", tags: ["QUESTION", "BLOCKED", "DESIGN", "HANDOFF"] },
    /^\[worker\] (QUESTION|BLOCKED|DESIGN|HANDOFF)\b/,
  ],
  [
    "task summons",
    { role: "orchestrator", tags: ["OWNER QUESTION", "OWNER REVIEW"], boundary: "whitespace" },
    /^\[orchestrator\] OWNER (?:QUESTION|REVIEW)(?:\s|$)/,
  ],
  [
    "hold release",
    { role: "orchestrator", tags: ["GO"], boundary: "whitespace" },
    /^\[orchestrator\] GO(?:\s|$)/,
  ],
  ["grade", { role: "orchestrator", tags: ["GRADE"] }, /^\[orchestrator\] GRADE\b/],
  [
    "conflict blocked",
    { role: "worker", tags: ["BLOCKED", "QUESTION"] },
    /^\[worker\] (BLOCKED|QUESTION)\b/,
  ],
  [
    "owner handover",
    { role: "orchestrator", tags: ["OWNER REVIEW"], boundary: "whitespace" },
    /^\[orchestrator\] OWNER REVIEW(?:\s|$)/,
  ],
  [
    "scope",
    { role: "orchestrator", tags: ["SCOPE REVIEW"], boundary: "line" },
    /^\[orchestrator\] SCOPE REVIEW(?:\r?\n|$)/,
  ],
  ["metric review", { role: "orchestrator", tags: ["REVIEW"] }, /^\[orchestrator\] REVIEW\b/],
  [
    "metric reply",
    { role: "worker", tags: ["READY", "QUESTION", "BLOCKED", "DESIGN", "HANDOFF"], ready: "full" },
    /^\[worker\] (READY FOR REVIEW|QUESTION|BLOCKED|DESIGN|HANDOFF)\b/,
  ],
  ["metric ack", { role: "worker", tags: ["ACK"] }, /^\[worker\] ACK\b/],
  [
    "metric summons",
    { role: "orchestrator", tags: ["OWNER REVIEW", "OWNER QUESTION"] },
    /^\[orchestrator\] (OWNER REVIEW|OWNER QUESTION)\b/,
  ],
  [
    "metric response",
    { role: "orchestrator", tags: ["REVIEW", "ANSWER", "GO", "AMENDMENT"] },
    /^\[orchestrator\] (REVIEW|ANSWER|GO|AMENDMENT)\b/,
  ],
  [
    "annotation worker",
    { role: "worker", tags: ["READY", "QUESTION", "BLOCKED"], ready: "full" },
    /^\[worker\] (READY FOR REVIEW|QUESTION|BLOCKED)\b/,
  ],
  [
    "annotation orchestrator",
    { role: "orchestrator", tags: ["REVIEW", "ANSWER", "OWNER REVIEW", "NOTE", "GRADE"] },
    /^\[orchestrator\] (REVIEW|ANSWER|OWNER REVIEW|NOTE|GRADE)\b/,
  ],
];

const lines = [
  ...workerTags.map((tag) => `[worker] ${tag}`),
  "[worker] READY FOR REVIEW",
  "[worker] READY FOR REVIEW (round 02)",
  "[worker] ready for review (round\t3)",
  "[worker] READY FOR REVIEW (round\n4)",
  "[worker] READY FOR REVIEW (round 5",
  "[worker] READY FOR REVIEW(round 5)",
  ...orchestratorTags.map((tag) => `[orchestrator] ${tag}`),
  "[orchestrator] REVIEW round 02",
  "[orchestrator] REVIEW round\t3",
  "[orchestrator] REVIEW round\n4",
  "[orchestrator] review round 5",
  "[orchestrator] REVIEW round 6trailing",
  "[orchestrator] REVIEW Round 7",
  "[orchestrator] REVIEW round -1",
  "[orchestrator] REVIEW round x",
  "[worker] UNKNOWN",
  "[orchestrator] UNKNOWN",
  "[owner] REVIEW",
  "",
  "plain text",
].flatMap((line) => [
  line,
  `${line}\nbody`,
  `${line}\r\nbody`,
  `${line}\r`,
  `${line} extra`,
  `${line}: detail`,
  `${line}-suffix`,
  `${line}X`,
  `${line}_`,
  `${line}\t`,
  `${line} `,
  ` ${line}`,
  `\n${line}`,
  line.toLowerCase(),
  line.replace("] ", "]  "),
]);

describe("historical protocol reader acceptance", () => {
  it.each(profiles)(
    "%s preserves every boundary, case and round variant",
    (_name, options, original) => {
      for (const body of lines) {
        const match = original.exec(body);
        const parsed = parseFirstLine(body, options);
        expect(!!parsed, JSON.stringify(body)).toBe(!!match);
        if (parsed && match) {
          expect(parsed.role).toBe(options.role);
          const originalTag = /^\[(?:worker|orchestrator)\] (.+)/i.exec(body)![1];
          expect(originalTag.toUpperCase().startsWith(parsed.tag.toUpperCase())).toBe(true);
          if (options.round) {
            expect(parsed.round).toBe(Number(match[1]));
          }
        }
      }
    }
  );
});

describe("protocol vocabulary and rendering", () => {
  it.each<[string, ReturnType<typeof parseFirstLine>]>([
    ["[worker] READY: detail", { role: "worker", tag: "READY" }],
    ["[worker] READY FOR REVIEW (round 03)", { role: "worker", tag: "READY", round: 3 }],
    ["[orchestrator] REVIEW round 02", { role: "orchestrator", tag: "REVIEW", round: 2 }],
    ["[orchestrator] CHECK-IN: detail", { role: "orchestrator", tag: "CHECK-IN" }],
    ["[worker] READYish", undefined],
    ["[worker] ready", undefined],
    [" [worker] READY", undefined],
    ["\n[worker] READY", undefined],
    ["[worker]  READY", undefined],
    ["[owner] READY", undefined],
  ])("parses first line %j to its exact result", (body, expected) => {
    expect(parseFirstLine(body)).toEqual(expected);
  });
  it("retains the event reader's free-form round spelling", () => {
    expect(roundText("[worker] READY arbitrary ROUND\t003 suffix")).toBe("003");
    expect(roundText("[worker] READY round 0")).toBe("0");
    expect(roundText("[worker] READY round x")).toBeUndefined();
  });
  const worker = ["ACK", "READY", "QUESTION", "DESIGN", "BLOCKED", "HANDOFF", "NOTE"] as const;
  const orchestrator = [
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

  it.each(worker)("parses and renders worker %s", (tag) => {
    expect(parseFirstLine(`[worker] ${tag}`)).toEqual({ role: "worker", tag });
    expect(workerHeading(tag)).toBe(`[worker] ${tag === "READY" ? "READY FOR REVIEW" : tag}`);
    expect(parseFirstLine(workerHeading(tag))).toEqual({ role: "worker", tag });
  });
  it.each(orchestrator)("parses and renders orchestrator %s", (tag) => {
    expect(parseFirstLine(`[orchestrator] ${tag}`)).toEqual({ role: "orchestrator", tag });
    expect(heading(tag)).toBe(`[orchestrator] ${tag}`);
  });
  it("renders and parses review rounds without changing posted spelling", () => {
    expect(heading("REVIEW", 2)).toBe("[orchestrator] REVIEW round 2");
    expect(heading("REVIEW round 2")).toBe("[orchestrator] REVIEW round 2");
    expect(workerHeading("READY", 2)).toBe("[worker] READY FOR REVIEW (round 2)");
    expect(parseFirstLine("[worker] READY FOR REVIEW (round 02)")).toEqual({
      role: "worker",
      tag: "READY",
      round: 2,
    });
    expect(parseFirstLine("[orchestrator] REVIEW round 2")).toEqual({
      role: "orchestrator",
      tag: "REVIEW",
      round: 2,
    });
  });
  it.each(["REVIEW round 2", "ANSWER", "GO"])("renders exact %s wake", (tag) => {
    const text = `[orchestrator] ${tag} is on your PR; read it with vmethod read pr 411 --new and act. End your turn with one line naming what you posted.`;
    expect(wakeText(tag, 411)).toBe(text);
    expect(wakeHeading(text)).toBe(tag);
  });
  it("preserves arbitrary wake headings and rejects malformed wakes", () => {
    expect(wakeHeading("[orchestrator] custom is on your PR; rest")).toBe("custom");
    expect(wakeHeading(" [orchestrator] GO is on your PR;")).toBeUndefined();
    expect(wakeHeading("[orchestrator] GO\nis on your PR;")).toBeUndefined();
  });
  it("renders the exact idle-turn wake", () => {
    expect(checkInText(411)).toBe(
      "[orchestrator] CHECK-IN: your turn ended without a status comment on the PR. Post exactly one of READY, QUESTION, BLOCKED or DESIGN on PR #411 with `vmethod pr-comment`. If you are not done, finish only the remaining acceptance steps first, adding no new scope. If you are unsure or stuck, post QUESTION or BLOCKED and stop."
    );
  });
  it("keeps role-only and embedded-summary readers distinct from tag parsing", () => {
    expect(hasRolePrefix("[worker]anything", "worker")).toBe(true);
    expect(hasRolePrefix(" [worker] ACK", "worker")).toBe(false);
    expect(hasRolePrefix("[orchestrator] UNKNOWN", "orchestrator")).toBe(true);
    expect(parseFirstLine("[orchestrator] UNKNOWN")).toBeUndefined();
    expect(containsScopeHeading("prose [orchestrator] SCOPE REVIEWsuffix")).toBe(true);
    expect(containsScopeHeading("[orchestrator] scope review")).toBe(false);
  });
  it("requires exact delegated proof separators, head length and trailing newline", () => {
    const head = "a".repeat(40);
    const proof = `[orchestrator] AUTOPILOT APPROVED\n\nCurrent head: ${head}\n`;
    expect(autopilotHead(proof)).toBe(head);
    expect(autopilotHead(proof.toUpperCase())).toBe(head.toUpperCase());
    expect(autopilotHead(`${proof}more text`)).toBe(head);
    for (const body of [
      proof.trimEnd(),
      proof.replaceAll("\n", "\r\n"),
      ` ${proof}`,
      proof.replace(head, head.slice(1)),
      proof.replace(head, `${head}a`),
      proof.replace(head, "g".repeat(40)),
    ]) {
      expect(autopilotHead(body)).toBeUndefined();
    }
  });
});
