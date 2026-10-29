import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Kind, parse, valueFromASTUntyped, type FieldNode, type SelectionSetNode } from "graphql";
import type { Config } from "../config.js";
import { stateRoot } from "./digest.js";
import { object, type ObjectData } from "./people.js";
import { writeSession } from "./watch-scope.js";
import { PidLock } from "../journal/locks.js";
import { JOURNAL_MATCH_MS, OPERATION_INFLIGHT_MS } from "../core/time.js";

const RETENTION_MS = 24 * 60 * 60_000;

export interface WriteRecord {
  /** ISO-8601 server-observation time of the successful mutation response. */
  at: string;
  kind: string;
  repo: string;
  number: number;
  commentId?: number;
  nodeId?: string;
  itemId?: string;
  field?: string;
  value?: string | number | null;
  /** Operation label for a verb's own in-flight handoff record. */
  op?: string;
}

/** Successful writes only, recorded at the single GitHub I/O boundary. Unknown writes
 * are retained for diagnostics but cannot match a numbered event accidentally.
 */
export class WriteJournal {
  private readonly path: string;
  private readonly repo: string;
  private readonly nodes = new Map<string, { repo: string; number: number; nodeId?: string }>();
  private readonly fields = new Map<string, ObjectData>();

  constructor(
    config: Config,
    env: NodeJS.ProcessEnv,
    private now: () => number,
    stateName = writeSession(config, env).stateName
  ) {
    this.path = join(stateRoot(env, stateName), "writes.jsonl");
    this.repo = String(config.repo).toLowerCase();
  }

  /** Match comment response IDs first, with server time only for id-less writes.
   * Other writes still need time and field/value correlation: a board item ID is
   * not the identity of a particular field change. Missing evidence reports.
   */
  matches(event: Omit<WriteRecord, "at">, at: string): boolean {
    const time = Date.parse(at);
    return this.read().some(
      (entry) =>
        entry.kind === event.kind &&
        entry.repo.toLowerCase() === event.repo.toLowerCase() &&
        entry.number === event.number &&
        (!event.itemId || entry.itemId === event.itemId) &&
        entry.field === event.field &&
        entry.value === event.value &&
        (["comment", "review-comment"].includes(entry.kind) &&
        (entry.commentId !== undefined || entry.nodeId !== undefined)
          ? entry.commentId !== undefined && event.commentId !== undefined
            ? entry.commentId === event.commentId
            : entry.nodeId !== undefined && entry.nodeId === event.nodeId
          : Number.isFinite(time) && Math.abs(Date.parse(entry.at) - time) <= JOURNAL_MATCH_MS)
    );
  }

  /** Record the start of a verb's multi-field operation for every card it will write (#199).
   * The watcher's violation checks skip a card whose operation record is within two minutes,
   * so a poll between the verb's own writes never reports its handoff.
   */
  beginOperation(op: string, targets: { repo: string; number: number }[]): void {
    try {
      for (const target of targets) {
        this.append({
          at: new Date(this.now()).toISOString(),
          kind: "operation",
          op,
          repo: target.repo,
          number: target.number,
        });
      }
    } catch (error) {
      throw new Error(
        `Cannot record the ${op} operation before its writes; the watcher would report the affected cards' handoff`,
        { cause: error }
      );
    }
  }

  /** Whether this account's journal marks this card in flight, keeping the watcher's
   * violation checks quiet: a verb's operation record within the window (#199), or a
   * recent Status move into a delivery column (the #178 open-task skip).
   */
  recentlyWrote(repo: string, number: number, withinMs = OPERATION_INFLIGHT_MS): boolean {
    const since = this.now() - withinMs;
    return this.read().some(
      (entry) =>
        entry.repo.toLowerCase() === repo.toLowerCase() &&
        entry.number === number &&
        Date.parse(entry.at) >= since &&
        (entry.kind === "operation" ||
          (entry.kind === "board" &&
            entry.field === "Status" &&
            ["Spec review", "Executing", "Owner review"].includes(String(entry.value))))
    );
  }

  /** Observe decoded reads for ID correlation and journal successful mutations.
   * Call only after HTTP/GraphQL success; failed or partial answers must not stamp.
   */
  record(path: string, method: string, body: unknown, response: unknown, at: string): void {
    this.observe(response);
    if (path === "/graphql") {
      this.observeQuery(object(body), object(response));
      this.graphql(object(body), object(response), at);
      return;
    }
    const route = /^\/repos\/([^/]+\/[^/]+)\/(.*)$/.exec(path);
    const repo = route?.[1].toLowerCase() ?? this.repo;
    const tail = route?.[2] ?? path;
    const item = /^(?:issues|pulls)\/(\d+)(?:\/(.*))?$/.exec(tail);
    const result = object(response);
    const number = item ? Number(item[1]) : typeof result.number === "number" ? result.number : 0;
    if (number > 0 && typeof result.node_id === "string") {
      this.nodes.set(result.node_id, { repo, number, nodeId: result.node_id });
    }
    if (method === "GET") {
      return;
    }
    const suffix = item?.[2];
    let kind = `${method} ${tail.replace(/\?.*$/, "")}`;
    if (suffix === "assignees") {
      kind = method === "DELETE" ? "unassigned" : "assigned";
    } else if (suffix === "merge" && result.merged === true) {
      kind = "merged";
    } else if (suffix === "comments") {
      kind = "comment";
    } else if (/^comments\/\d+\/replies$/.test(suffix ?? "")) {
      kind = "review-comment";
    } else if (!item && /^(issues|pulls)$/.test(tail) && method === "POST") {
      kind = "created";
    } else if (object(body).state === "closed") {
      kind = "closed";
    } else if (object(body).state === "open") {
      kind = "reopened";
    }
    if (
      (kind === "assigned" || kind === "unassigned") &&
      Array.isArray(object(body).assignees) &&
      (object(body).assignees as unknown[]).length
    ) {
      for (const login of object(body).assignees as unknown[]) {
        if (typeof login === "string") {
          this.append({ at, kind, repo, number, field: "Assignee", value: login.toLowerCase() });
        }
      }
    } else {
      this.append({
        at,
        kind,
        repo,
        number,
        ...(["comment", "review-comment"].includes(kind) && Number.isSafeInteger(result.id)
          ? { commentId: Number(result.id) }
          : {}),
        ...(typeof result.node_id === "string" ? { nodeId: result.node_id } : {}),
      });
    }
  }

  /** Attribute a successful git ref update to this orchestrator's journal, not worker activity. */
  recordPush(repo: string, number: number, head: string): void {
    this.append({
      at: new Date(this.now()).toISOString(),
      kind: "push",
      repo,
      number,
      field: "Head",
      value: head,
    });
  }

  /** Exact commit identity remains attributable throughout journal retention, even after a delayed poll. */
  pushed(repo: string, number: number, head: string): boolean {
    return this.read().some(
      (entry) =>
        entry.kind === "push" &&
        entry.repo.toLowerCase() === repo.toLowerCase() &&
        entry.number === number &&
        entry.field === "Head" &&
        entry.value === head
    );
  }

  private append(entry: WriteRecord): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    // Do not lose a simultaneous writer's append during pruning. The critical
    // section contains no await/network I/O; brief contention is retried.
    const lock = new PidLock(`${this.path}.lock`);
    const fd = lock.acquire();
    try {
      const recent = this.read();
      writeFileSync(
        `${this.path}.tmp`,
        recent.map((record) => `${JSON.stringify(record)}\n`).join(""),
        { mode: 0o600 }
      );
      renameSync(`${this.path}.tmp`, this.path);
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } finally {
      lock.release(fd);
    }
  }

  private graphql(body: ObjectData, response: ObjectData, at: string): void {
    if (typeof body.query !== "string") {
      return;
    }
    const document = parse(body.query);
    const variables = object(body.variables);
    const fragments = new Map(
      document.definitions.flatMap((definition) =>
        definition.kind === Kind.FRAGMENT_DEFINITION
          ? [[definition.name.value, definition.selectionSet] as const]
          : []
      )
    );
    for (const operation of document.definitions) {
      if (operation.kind !== Kind.OPERATION_DEFINITION || operation.operation !== "mutation") {
        continue;
      }
      let recorded = false;
      for (const selection of rootFields(operation.selectionSet, fragments)) {
        const name = selection.name.value;
        if (!object(response.data)[selection.alias?.value ?? name]) {
          continue;
        }
        const inputArg = selection.arguments?.find((arg) => arg.name.value === "input");
        const input = object(inputArg ? valueFromASTUntyped(inputArg.value, variables) : {});
        const result = object(object(response.data)[selection.alias?.value ?? name]);
        const id = String(
          input.itemId ??
            input.contentId ??
            input.pullRequestId ??
            input.issueId ??
            input.subjectId ??
            ""
        );
        const subject = this.nodes.get(id);
        const entry: WriteRecord = {
          at,
          kind: name,
          repo: subject?.repo.toLowerCase() ?? this.repo,
          number: subject?.number ?? 0,
          ...(id ? { nodeId: subject?.nodeId ?? id } : {}),
        };
        if (name === "addComment") {
          const comment = object(object(result.commentEdge).node);
          entry.kind = "comment";
          if (Number.isSafeInteger(comment.databaseId)) {
            entry.commentId = Number(comment.databaseId);
          }
          if (typeof comment.id === "string") {
            entry.nodeId = comment.id;
          } else {
            delete entry.nodeId;
          }
        }
        if (["updateProjectV2ItemFieldValue", "clearProjectV2ItemFieldValue"].includes(name)) {
          const field = this.fields.get(String(input.fieldId));
          const value = object(input.value);
          const option = (Array.isArray(field?.options) ? field.options : [])
            .map(object)
            .find((option) => option.id === value.singleSelectOptionId);
          entry.kind = "board";
          entry.itemId = String(input.itemId);
          if (typeof field?.name === "string") {
            entry.field = field.name;
          }
          const scalar = value.text ?? value.number ?? option?.name ?? null;
          if (typeof scalar === "string" || typeof scalar === "number" || scalar === null) {
            entry.value = scalar;
          }
        }
        if (name === "addProjectV2ItemById") {
          const itemId = object(result.item).id;
          if (typeof itemId === "string" && subject) {
            this.nodes.set(itemId, subject);
          }
          if (typeof itemId === "string") {
            entry.itemId = itemId;
          }
        }
        this.append(entry);
        recorded = true;
      }
      if (!recorded) {
        this.append({ at, kind: operation.name?.value ?? "mutation", repo: this.repo, number: 0 });
      }
    }
  }

  private observe(value: unknown): void {
    if (Array.isArray(value)) {
      for (const entry of value) {
        this.observe(entry);
      }
      return;
    }
    const node = object(value);
    const content = object(node.content);
    const subject = typeof content.number === "number" ? content : node;
    const repo = object(subject.repository).nameWithOwner;
    if (typeof subject.number === "number" && typeof repo === "string") {
      for (const id of [node.id, node.node_id, subject.id]) {
        if (typeof id === "string") {
          this.nodes.set(id, {
            repo,
            number: subject.number,
            ...(typeof subject.id === "string" ? { nodeId: subject.id } : {}),
          });
        }
      }
    }
    if (typeof node.id === "string" && typeof node.name === "string" && node.dataType) {
      this.fields.set(node.id, node);
    }
    for (const child of Object.values(node)) {
      if (child && typeof child === "object") {
        this.observe(child);
      }
    }
  }

  private observeQuery(body: ObjectData, response: ObjectData): void {
    if (typeof body.query !== "string") {
      return;
    }
    const variables = object(body.variables);
    for (const operation of parse(body.query).definitions) {
      if (operation.kind !== Kind.OPERATION_DEFINITION || operation.operation !== "query") {
        continue;
      }
      for (const root of operation.selectionSet.selections) {
        if (root.kind !== Kind.FIELD || root.name.value !== "repository") {
          continue;
        }
        const args = Object.fromEntries(
          (root.arguments ?? []).map((arg) => [
            arg.name.value,
            valueFromASTUntyped(arg.value, variables),
          ])
        );
        if (typeof args.owner !== "string" || typeof args.name !== "string") {
          continue;
        }
        const repository = object(object(response.data)[root.alias?.value ?? root.name.value]);
        for (const selection of root.selectionSet?.selections ?? []) {
          if (
            selection.kind !== Kind.FIELD ||
            !["issue", "pullRequest", "issueOrPullRequest"].includes(selection.name.value)
          ) {
            continue;
          }
          const numberArg = selection.arguments?.find((arg) => arg.name.value === "number");
          const number = numberArg ? valueFromASTUntyped(numberArg.value, variables) : null;
          const node = object(repository[selection.alias?.value ?? selection.name.value]);
          if (
            typeof node.id === "string" &&
            typeof number === "number" &&
            Number.isSafeInteger(number) &&
            number > 0
          ) {
            this.nodes.set(node.id, {
              repo: `${args.owner}/${args.name}`,
              number,
              nodeId: node.id,
            });
          }
        }
      }
    }
  }

  private read(): WriteRecord[] {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const entries = text
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const entry = object(JSON.parse(line));
        if (
          typeof entry.at !== "string" ||
          !Number.isFinite(Date.parse(entry.at)) ||
          typeof entry.kind !== "string" ||
          typeof entry.repo !== "string" ||
          !Number.isSafeInteger(entry.number) ||
          Number(entry.number) < 0 ||
          (entry.commentId !== undefined &&
            (!Number.isSafeInteger(entry.commentId) || Number(entry.commentId) < 1)) ||
          (entry.nodeId !== undefined && (typeof entry.nodeId !== "string" || !entry.nodeId))
        ) {
          throw new Error("Invalid gateway write journal");
        }
        return entry as unknown as WriteRecord;
      });
    const recent = entries.filter((entry) => Date.parse(entry.at) >= this.now() - RETENTION_MS);
    return recent;
  }
}

function rootFields(
  selectionSet: SelectionSetNode,
  fragments: Map<string, SelectionSetNode>,
  seen = new Set<string>()
): FieldNode[] {
  return selectionSet.selections.flatMap((selection): FieldNode[] => {
    if (selection.kind === Kind.FIELD) {
      return [selection];
    }
    if (selection.kind === Kind.INLINE_FRAGMENT) {
      return rootFields(selection.selectionSet, fragments, seen);
    }
    const name = selection.name.value;
    if (seen.has(name)) {
      throw new Error("Cyclic mutation fragment in gateway journal");
    }
    const fragment = fragments.get(name);
    if (!fragment) {
      throw new Error("Missing mutation fragment in gateway journal");
    }
    return rootFields(fragment, fragments, new Set([...seen, name]));
  });
}
