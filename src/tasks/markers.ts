/** The one decoder (and encoder) for a task PR body's machine markers: the
 * `# Task: … (issue #n)` header, the structured `<!-- vmethod-task {…} -->`
 * relation, the `<!-- vmethod-autopilot-copy {…} -->` proof, the hold banner and
 * title prefix, and the pre-adoption `Closes #n` / `Agent task for #n` headers.
 *
 * The task relation lives only in the header and the structured marker, never in
 * prose or closing keywords (D2), and a hold is exactly the banner or the title
 * prefix (D9). The former readers disagree deliberately; the compatibility
 * options below keep each reader's exact acceptance, and callers keep their own
 * bounds and error texts.
 */
import { object, type ObjectData } from "../gateway/people.js";

/** The task header decoded from a task PR body: `# Task: <title> ((part of )?issue #n)`. */
export interface TaskHeader {
  /** The delivery title between "# Task: " and the issue reference; an "any text"
   *  read instead covers everything up to the reference, including its spacing. */
  title: string;
  /** The referenced issue exactly as written; callers enforce their own bounds. */
  issue: number;
  /** Whether the reference carries the "part of " prefix. */
  part: boolean;
}

/** Compatibility options: the former header readers disagree deliberately.
 *  - anchor: the relation decoder and link-task's rewrite read only the body's
 *    first line; the issue-number and metadata readers read any line start.
 *  - title: "required" needs at least one character, "optional" also accepts an
 *    empty title, and "any text" (the metadata reader) reads lazily up to the
 *    reference: an empty title and a missing separator space still match.
 *  - end: "line end" requires the reference to end its line (trailing tabs and
 *    spaces allowed); "anywhere" lets text follow on the same line.
 */
export interface TaskHeaderRead {
  anchor: "first line" | "any line";
  title: "optional" | "required" | "any text";
  end: "line end" | "anywhere";
}

/** Decode the task header's issue reference; prose, closing links and branch
 * numbers never match. */
export function taskHeader(body: string, read: TaskHeaderRead): TaskHeader | undefined {
  const match = headerPattern(read).exec(body);
  return match
    ? { title: match[1], issue: Number(match[3]), part: match[2] !== undefined }
    : undefined;
}

/** Rewrite the first-line header's part-of prefix on link promotion/demotion; a
 * header anywhere else in the body stays untouched, exactly as before. */
export function setHeaderPart(body: string, part: boolean): string {
  return body.replace(
    headerPattern(rewriteHeaderRead),
    (_match, title: string, _prefix: string, issue: string) =>
      `# Task: ${title} (${part ? "part of " : ""}issue #${issue})`
  );
}

/** Decode only vmethod's structured relation, never prose or GitHub closing links. */
export function taskRelation(body: string): { issues: number[]; part: boolean } | undefined {
  const header = taskHeader(body, relationHeaderRead);
  if (header) {
    if (!Number.isSafeInteger(header.issue)) {
      throw new Error("Invalid task header issue");
    }
    return { issues: [header.issue], part: header.part };
  }
  const text = markerText(body, { which: "first-cr" });
  if (text === undefined) {
    return undefined;
  }
  const relation = JSON.parse(text);
  if (relation.part !== undefined && typeof relation.part !== "boolean") {
    throw new Error("Invalid partial task relation");
  }
  if (
    !Array.isArray(relation.issues) ||
    relation.issues.some((n: unknown) => !Number.isSafeInteger(n) || Number(n) < 1)
  ) {
    throw new Error("Invalid task issue relation");
  }
  return { issues: [...new Set<number>(relation.issues)], part: relation.part === true };
}

/** Issue relations from a task header/marker; an empty list is a valid direct task. */
export function taskIssueNumbers(body: string): number[] | undefined {
  const header = taskHeader(body, issueHeaderRead);
  const issues = header && Number.isSafeInteger(header.issue) ? [header.issue] : [];
  const text = markerText(body, { which: "first" });
  if (text !== undefined) {
    try {
      const value = JSON.parse(text);
      if (
        Array.isArray(value.issues) &&
        value.issues.every((n: unknown) => Number.isSafeInteger(n) && Number(n) > 0) &&
        (value.part === undefined || typeof value.part === "boolean")
      ) {
        return [...new Set<number>([...issues, ...value.issues])];
      }
    } catch {
      // A malformed marker is not a relation; a valid header still is.
    }
  }
  return issues.length ? issues : undefined;
}

/** Recognize a task header or a valid structured task marker, including direct tasks. */
export function isTaskPrompt(body: string): boolean {
  return taskIssueNumbers(body) !== undefined;
}

/** An opening model override: the card family replaced at launch and why. */
export interface TaskModelOverride {
  from: string;
  to: string;
  reason: string;
}

/** The opening model override `open-task` recorded in the structured marker, never prose. */
export function taskModelOverride(body: string): TaskModelOverride | undefined {
  const text = markerText(body, { which: "first" });
  if (text === undefined) {
    return undefined;
  }
  let value: { modelOverride?: unknown };
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (value.modelOverride === undefined) {
    return undefined;
  }
  const override =
    typeof value.modelOverride === "object" && value.modelOverride !== null
      ? (value.modelOverride as { from?: unknown; to?: unknown; reason?: unknown })
      : undefined;
  if (
    !override ||
    ![override.from, override.to, override.reason].every(
      (field) => typeof field === "string" && field.trim()
    )
  ) {
    throw new Error("Invalid task model override");
  }
  return {
    from: override.from as string,
    to: override.to as string,
    reason: override.reason as string,
  };
}

/** Decode the structured marker that ends the body, modulo trailing whitespace
 * (merge's scope-exception read); a malformed payload fails the read loudly, and
 * a body without a trailing marker reads as undefined. */
export function trailingTaskMarker(body: string): ObjectData | undefined {
  const text = markerText(body, { which: "trailing" });
  return text === undefined ? undefined : object(JSON.parse(text));
}

/** Rewrite the structured marker's issues/part flags on link promotion/demotion.
 * The template's marker is last, and marker examples inside the worker prompt are
 * data: the last marker is the rewrite target. A body without a marker is
 * returned unchanged, exactly as today. */
export function updateTaskMarker(body: string, issues: number[], part: boolean): string {
  const marker = markerMatch(body, { which: "last" });
  if (!marker) {
    return body;
  }
  const value = object(JSON.parse(marker[1]));
  const updated = `<!-- vmethod-task ${JSON.stringify({ ...value, issues, part })} -->`;
  return body.slice(0, marker.index) + updated + body.slice(marker.index + marker[0].length);
}

/** Decode the copy proof immediately preceding the trailing structured marker; the
 * identity checks that turn a proof into authority stay with the autopilot reader. */
export function autopilotCopyProof(body: string): { event: string; source: string } | undefined {
  const match = copyProofPattern.exec(body);
  if (!match) {
    return undefined;
  }
  try {
    const proof = object(JSON.parse(match[1]));
    if (typeof proof.event === "string" && typeof proof.source === "string") {
      return { event: proof.event, source: proof.source };
    }
  } catch {
    // malformed metadata confers no authority
  }
  return undefined;
}

/** The open-task copy proof: the authenticated label event and source grant
 * written immediately before the trailing structured marker. A body without a
 * trailing marker is returned unchanged; the caller reports the missing metadata. */
export function withAutopilotCopyProof(
  body: string,
  proof: { event: string; source: string }
): string {
  return body.replace(
    markerPatterns.trailing,
    (marker) =>
      `<!-- vmethod-autopilot-copy ${JSON.stringify({ event: proof.event, source: proof.source })} -->\n\n${marker}`
  );
}

/** The complete banner emitted by open-task --hold; quoted prose is not a hold. */
export const holdBanner = "> ⛔ ON HOLD. Wait for [orchestrator] GO.";

/** Remove only machine hold markers, retaining the rest of the title and prompt. */
export function withoutHold(title: string, body: string): { title: string; body: string } {
  return { title: title.replace(titlePrefix, ""), body: body.replace(bannerLine, "") };
}

/** Legacy title prefixes also count, but mentions elsewhere do not. */
export function taskHeld(title: string, body: string): boolean {
  return titlePrefix.test(title) || bannerLine.test(body);
}

/** Native closing references of a task PR: the connection must be complete, every
 * node valid, and foreign-repository nodes are excluded, not errors. */
export function closingIssueNumbers(item: ObjectData, repo: string): Set<number> {
  const references = object(item.closingIssuesReferences);
  if (!Array.isArray(references.nodes) || object(references.pageInfo).hasNextPage !== false) {
    throw new Error("Missing or incomplete closing issue references");
  }
  const numbers = new Set<number>();
  for (const value of references.nodes) {
    const node = object(value);
    if (
      !Number.isSafeInteger(node.number) ||
      Number(node.number) < 1 ||
      typeof object(node.repository).nameWithOwner !== "string"
    ) {
      throw new Error("Invalid closing issue reference");
    }
    if (object(node.repository).nameWithOwner === repo) {
      numbers.add(Number(node.number));
    }
  }
  return numbers;
}

/** The issue relation a merge completes, in order: the structured relation, a
 * "Part of #n" prose line (which completes nothing, D2), the native closing
 * references; `report` names which fallback was
 * used, exactly as the watcher reported it before. */
export function taskIssues(
  item: ObjectData,
  repo: string,
  report: (line: string) => void
): number[] {
  const body = String(item.body);
  const relation = taskRelation(body);
  if (relation) {
    return relation.part ? [] : relation.issues;
  }
  if (proseDependency.test(body)) {
    return [];
  }
  const references = object(item.closingIssuesReferences);
  if (object(references.pageInfo).hasNextPage === true) {
    throw new Error("Too many legacy issue links");
  }
  const linked = Array.isArray(references.nodes)
    ? references.nodes
        .map(object)
        .filter((node) => object(node.repository).nameWithOwner === repo)
        .map((node) => Number(node.number))
    : [];
  if (linked.some((number) => !Number.isSafeInteger(number))) {
    throw new Error("Invalid legacy issue link");
  }
  if (linked.length) {
    report("legacy link: using pre-adoption issue relation");
  } else {
    report("no linked issue");
  }
  return [...new Set(linked)];
}

const relationHeaderRead: TaskHeaderRead = {
  anchor: "first line",
  title: "optional",
  end: "line end",
};
const issueHeaderRead: TaskHeaderRead = { anchor: "any line", title: "required", end: "line end" };
const rewriteHeaderRead: TaskHeaderRead = {
  anchor: "first line",
  title: "optional",
  end: "anywhere",
};

const titlePatterns: Record<"optional" | "required", string> = {
  optional: "[^\\r\\n]*",
  required: "[^\\r\\n]+",
};

const headerPattern = (read: TaskHeaderRead): RegExp =>
  new RegExp(
    `^# Task:${
      read.title === "any text" ? "(.*?)" : ` (${titlePatterns[read.title]}) `
    }\\((part of )?issue #([1-9]\\d*)\\)${read.end === "line end" ? "[\\t ]*(?:\\r?\\n|$)" : ""}`,
    read.anchor === "any line" ? "m" : ""
  );

/** Compatibility options: which structured marker a read targets. "first" reads
 * the body's first marker on one strict line (the issue-number and override
 * readers); "first-cr" tolerates a carriage return inside the payload (the
 * relation reader); "last" is link-task's rewrite target, reading the last marker
 * with the same tolerance; "trailing" must end the body, modulo whitespace, like
 * merge's scope-exception read and the autopilot proof anchor. */
interface TaskMarkerRead {
  which: "first" | "first-cr" | "last" | "trailing";
}

const markerPatterns: Record<TaskMarkerRead["which"], RegExp> = {
  first: /<!-- vmethod-task (\{[^\r\n]*\}) -->/,
  "first-cr": /<!-- vmethod-task (\{[^\n]*\}) -->/,
  last: /<!-- vmethod-task (\{[^\n]*\}) -->/g,
  trailing: /<!-- vmethod-task (\{[^\r\n]*\}) -->\s*$/,
};

const copyProofPattern =
  /<!-- vmethod-autopilot-copy (\{[^\r\n]*\}) -->\s*<!-- vmethod-task \{[^\r\n]*\} -->\s*$/;

const markerMatch = (
  body: string,
  read: TaskMarkerRead
): (RegExpMatchArray & { index: number }) | undefined =>
  read.which === "last"
    ? [...body.matchAll(markerPatterns.last)].at(-1)
    : (markerPatterns[read.which].exec(body) ?? undefined);

const markerText = (body: string, read: TaskMarkerRead): string | undefined =>
  markerMatch(body, read)?.[1];

/** A prose dependency line completes nothing; only the structured flags decide (D2). */
const proseDependency = /^[\t ]*(?:>[\t ]*)?(?:\*\*)?Part of\s+#([1-9]\d*)\b/im;

const bannerLine = /^> ⛔ ON HOLD\. Wait for \[orchestrator\] GO\.(?:\r?\n|$)/m;
const titlePrefix = /^\[HOLD(?::[^\]\r\n]*)?\](?:[\t ]+|$)/i;
