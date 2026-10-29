import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bodyHash } from "../evidence/scope.js";
import { object, untrusted, type ObjectData } from "./people.js";
import type { ThreadRef } from "./refs.js";

/** One rendered thread section: the PR or issue itself, a comment, a review or a review comment. */
export interface ThreadItem {
  kind: "pr" | "issue" | "comment" | "review" | "review comment";
  /** The thread's pr and issue items carry the thread number; the rest a numeric REST id. */
  id: string;
  /** Minute-precision UTC creation time, as the item header shows it. */
  time: string;
  login: string;
  role: string;
  /** The delivered body part: untrusted fence; for the pr and issue items everything after the state line. */
  content: string;
  /** pr and issue items only: the structured state line, hashed separately from the body. */
  metaLine?: string;
}

/** A snapshot record: the item's header data plus its body hash (and a root item's state-line hash). */
export interface SnapshotRecord {
  kind: ThreadItem["kind"];
  id: string;
  time: string;
  login: string;
  role: string;
  hash: string;
  meta?: string;
}

export type ThreadSnapshot =
  | { state: "missing" }
  | { state: "unreadable"; reason: string }
  | { state: "ok"; records: SnapshotRecord[] };

export type ThreadDelta =
  | { nothing: true; unchanged: number }
  | {
      nothing: false;
      sections: readonly string[];
      unchanged: number;
      next: readonly ThreadItem[];
    };

const kinds: string[] = ["pr", "issue", "comment", "review", "review comment"];
const roles: string[] = ["owner", "orchestrator", "worker", "collaborator", "system"];

export function itemKey(item: Pick<ThreadItem, "kind" | "id">): string {
  return `${item.kind} ${item.id}`;
}

function threadHeader(
  item: Pick<ThreadItem, "kind" | "id" | "login" | "role" | "time">,
  marker?: "edited" | "deleted"
): string {
  return `### ${item.kind} ${item.id}, ${item.login} (${item.role}), ${
    item.time
  }${marker ? ` (${marker})` : ""}`;
}

export function threadSection(item: ThreadItem): string {
  return `${threadHeader(item)}\n\n${
    item.metaLine === undefined ? "" : `${item.metaLine}\n\n`
  }${item.content}`;
}

/** Minute-precision UTC time exactly like `2026-10-27T09:12Z`; the first parseable value wins. */
export function threadTime(...values: readonly unknown[]): string {
  const raw = values.find(
    (value) => typeof value === "string" && Number.isFinite(Date.parse(value))
  );
  if (typeof raw !== "string") {
    throw new Error("Missing item time");
  }
  return raw.replace(/(T\d\d:\d\d):\d\d(?:\.\d+)?Z$/, "$1Z");
}

/** Bodies arrive fenced like the labelled reads deliver them, hostile text included. */
export function threadContent(node: ObjectData): string {
  return untrusted([node.title, node.body].filter((part) => typeof part === "string").join("\n\n"));
}

/** The numeric REST id of a thread item; missing ids fail loudly, never diff silently. */
export function threadId(value: unknown, kind: ThreadItem["kind"]): string {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error(`Missing ${kind} id`);
  }
  return String(id);
}

function itemHash(item: ThreadItem): string {
  return bodyHash(`${threadHeader(item)}\n\n${item.content}`);
}

/** The structured state line hash; absent for comments, reviews and review comments. */
function metaHash(item: ThreadItem): string | undefined {
  return item.metaLine === undefined ? undefined : bodyHash(item.metaLine);
}

/** `.tmp/<n>-thread.md` under the checkout root; same-org foreign threads keep a repo-qualified name. */
export function snapshotBase(target: ThreadRef, repo: string): string {
  return target.repo.toLowerCase() === repo.toLowerCase()
    ? String(target.number)
    : `${target.repo.replace("/", "-")}-${target.number}`;
}

const threadFile = (root: string, base: string): string => join(root, ".tmp", `${base}-thread.md`);
const indexFile = (root: string, base: string): string =>
  join(root, ".tmp", `${base}-thread-index.json`);

/** Save the checkout-local snapshot the next `--new` compares against (index written last). */
export function saveThreadSnapshot(root: string, base: string, items: readonly ThreadItem[]): void {
  mkdirSync(join(root, ".tmp"), { recursive: true });
  const thread = threadFile(root, base);
  writeFileSync(`${thread}.tmp`, items.map(threadSection).join("\n\n"));
  renameSync(`${thread}.tmp`, thread);
  const index = indexFile(root, base);
  writeFileSync(
    `${index}.tmp`,
    JSON.stringify(
      items.map((item) => ({
        kind: item.kind,
        id: item.id,
        time: item.time,
        login: item.login,
        role: item.role,
        hash: itemHash(item),
        ...(metaHash(item) === undefined ? {} : { meta: metaHash(item) }),
      }))
    )
  );
  renameSync(`${index}.tmp`, index);
}

/** A usable snapshot needs both files: the rendered thread and a valid id → hash index. */
export function readThreadSnapshot(root: string, base: string): ThreadSnapshot {
  const thread = threadFile(root, base);
  const index = indexFile(root, base);
  if (!existsSync(thread) && !existsSync(index)) {
    return { state: "missing" };
  }
  if (!existsSync(index)) {
    return { state: "unreadable", reason: "index file missing" };
  }
  let text: string;
  try {
    text = readFileSync(index, "utf8");
  } catch {
    return { state: "unreadable", reason: "cannot read index" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: "unreadable", reason: "index is not valid JSON" };
  }
  if (!Array.isArray(parsed)) {
    return { state: "unreadable", reason: "index entries are not a list" };
  }
  const records: SnapshotRecord[] = [];
  const seen = new Set<string>();
  for (const value of parsed) {
    const entry = object(value);
    const kind: unknown = entry.kind;
    const id: unknown = entry.id;
    const time: unknown = entry.time;
    const login: unknown = entry.login;
    const role: unknown = entry.role;
    const hash: unknown = entry.hash;
    if (
      typeof kind !== "string" ||
      !kinds.includes(kind) ||
      typeof id !== "string" ||
      !/^[1-9]\d*$/.test(id) ||
      typeof time !== "string" ||
      typeof login !== "string" ||
      !/\S/.test(login) ||
      typeof role !== "string" ||
      !roles.includes(role) ||
      typeof hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(hash)
    ) {
      return { state: "unreadable", reason: "invalid index entry" };
    }
    const meta: unknown = entry.meta;
    // The thread's root item (pr or issue) hashes its state line separately from
    // its body; an old-format root record without it is unreadable, so a read
    // never diffs on a stale guess.
    const isRoot = kind === "pr" || kind === "issue";
    const stateHash = isRoot
      ? typeof meta === "string" && /^[0-9a-f]{64}$/.test(meta)
        ? meta
        : undefined
      : null;
    if (isRoot ? stateHash === undefined : meta !== undefined) {
      return { state: "unreadable", reason: "invalid index entry" };
    }
    const record: SnapshotRecord = {
      kind: kind as ThreadItem["kind"],
      id,
      time,
      login,
      role,
      hash,
      ...(stateHash === null || stateHash === undefined ? {} : { meta: stateHash }),
    };
    const key = itemKey(record);
    if (seen.has(key)) {
      return { state: "unreadable", reason: `duplicate index entry ${key}` };
    }
    seen.add(key);
    records.push(record);
  }
  if (!existsSync(thread)) {
    return { state: "unreadable", reason: "thread file missing" };
  }
  try {
    readFileSync(thread, "utf8");
  } catch {
    return { state: "unreadable", reason: "cannot read thread file" };
  }
  return { state: "ok", records };
}

/** Compare the fresh items with the snapshot by item id: new, edited and deleted
 * sections in thread order (deletions in old record order), then the count. */
export function threadDiff(
  items: readonly ThreadItem[],
  records: readonly SnapshotRecord[]
): ThreadDelta {
  const prior = new Map(records.map((record) => [itemKey(record), record] as const));
  const sections: string[] = [];
  let unchanged = 0;
  for (const item of items) {
    const record = prior.get(itemKey(item));
    if (!record) {
      sections.push(threadSection(item));
      continue;
    }
    // The pr and issue items print only the changed part: their state line
    // alone, or their body alone, or both; everything unchanged stays omitted.
    const metaChanged = record.meta !== metaHash(item);
    const bodyChanged = record.hash !== itemHash(item);
    if (!metaChanged && !bodyChanged) {
      unchanged++;
      continue;
    }
    const parts: string[] = [];
    if (metaChanged) {
      if (item.metaLine === undefined) {
        throw new Error(`State hash without a state line for ${itemKey(item)}`);
      }
      parts.push(item.metaLine);
    }
    if (bodyChanged) {
      parts.push(item.content);
    }
    sections.push(`${threadHeader(item, "edited")}\n\n${parts.join("\n\n")}`);
  }
  const current = new Set(items.map((item) => itemKey(item)));
  for (const record of records) {
    if (!current.has(itemKey(record))) {
      sections.push(threadHeader(record, "deleted"));
    }
  }
  if (!sections.length) {
    return { nothing: true, unchanged };
  }
  return { nothing: false, sections, unchanged, next: [...items] };
}
