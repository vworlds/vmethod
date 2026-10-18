import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

// Implementation issues supplied by the orchestrator's approved review table.
const verbIssues = new Map<string, number | null>([
  ["post", 4],
  ["read", 4],
  ["gh-read", 4],
  ["board status", 5],
  ["board migrate", 5],
  ["check --online", 5],
  ["watch", 6],
  ["mute", 6],
  ["mutes", 6],
  ["unmute", 6],
  ["start-task", 7],
  ["read-pr", 7],
  ["pr-comment", 7],
  ["push", 7],
  ["check-markdown", 7],
  ["open-task", 8],
  ["review", 8],
  ["merge-task", 8],
  ["release-hold", 8],
  ["worker", 9],
  ["claude-worker", 9],
  ["start-worker", 9],
  ["suggest-model", 9],
  ["grade", 9],
  ["wait-checks", 10],
  ["verify", 10],
  ["refresh-checks", 10],
  ["check-task-ci", 10],
  ["learnings submit", 11],
  ["learnings show", 11],
  ["learnings report", 11],
  ["propose", null],
]);

test("worker task template ends status turns instead of review polling", () => {
  const template = readFileSync("templates/task-pr.md", "utf8");
  expect(template).not.toContain("wait-review");
  expect(template).toContain("After posting READY, QUESTION, BLOCKED or DESIGN, end your");
});

test("all future-verb annotations in docs and templates name the implementation issue", () => {
  let references = 0;
  for (const directory of ["docs", "templates"]) {
    for (const entry of readdirSync(directory, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile()) {
        continue;
      }
      const path = join(entry.parentPath, entry.name);
      references += validateReferences(readFileSync(path, "utf8"), path);
    }
  }
  expect(references).toBeGreaterThan(0);
}, 15000);

test("reference validation accepts the full table and rejects wrong, unknown and unbound annotations", () => {
  for (const [verb, issue] of verbIssues) {
    const annotation = issue === null ? "(planned)" : `(vmethod 1.0, #${issue})`;
    expect(validateReferences(`Use \`${verb}\` ${annotation}.`)).toBe(1);
    expect(() => validateReferences(`Use \`${verb}\` (vmethod 1.0, #1).`)).toThrow("expected");
  }
  expect(() => validateReferences("Use `unknown` (vmethod 1.0, #7).")).toThrow("unknown verb");
  expect(() => validateReferences("Gateway remains planned (vmethod 1.0, #4).")).toThrow(
    "must immediately follow"
  );
  expect(() => validateReferences("Use `open-task` and `start-worker` (vmethod 1.0, #8).")).toThrow(
    "start-worker"
  );
  expect(validateReferences("Use `mute`, `mutes` and `unmute` (vmethod 1.0,\n#6).")).toBe(3);
  expect(validateReferences("Use `open-task --direct` (vmethod 1.0, #8).")).toBe(1);
  expect(validateReferences("Use `merge-task --merge-commit` (vmethod 1.0, #8).")).toBe(1);
  expect(validateReferences("Use `board migrate --dry-run` (vmethod 1.0, #5).")).toBe(1);
}, 15000);

function validateReferences(text: string, path = "example"): number {
  let count = 0;
  for (const match of text.matchAll(/\((?:vmethod\s+1\.0,\s*#(\d+)|planned)\)/g)) {
    // An annotation binds to the immediately preceding inline command or list.
    // Reject orphan prose rather than silently skipping an unrecognised form.
    const commands = text
      .slice(0, match.index)
      .match(/(`[^`\n]+`(?:\s*(?:,\s*(?:and\s+)?|and\s+|or\s+)`[^`\n]+`)*)\s*$/);
    if (!commands) {
      throw new Error(`${path}: annotation must immediately follow command code`);
    }
    for (const command of commands[1].matchAll(/`([^`]+)`/g)) {
      const verb = [...verbIssues.keys()].find(
        (candidate) => command[1] === candidate || command[1].startsWith(`${candidate} `)
      );
      if (!verb) {
        throw new Error(`${path}: unknown verb ${command[1]}`);
      }
      const issue = match[1] === undefined ? null : Number(match[1]);
      if (issue !== verbIssues.get(verb)) {
        throw new Error(
          `${path}: ${command[1]} expected ${verbIssues.get(verb) ?? "planned"}, got ${issue}`
        );
      }
      count++;
    }
  }
  return count;
}
