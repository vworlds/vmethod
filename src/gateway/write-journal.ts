import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Kind, parse, valueFromASTUntyped, type FieldNode, type SelectionSetNode } from "graphql";
import type { Config } from "../config.js";
import { stateRoot } from "./digest.js";
import { object, type ObjectData } from "./people.js";
import { writeSession } from "./watch-scope.js";

const RETENTION_MS = 24 * 60 * 60_000;
const MATCH_MS = 2 * 60_000;

export interface WriteRecord {
  /** ISO-8601 server-observation time of the successful mutation response. */
  at: string;
  kind: string;
  repo: string;
  number: number;
  itemId?: string;
  field?: string;
  value?: string | number | null;
}

/** Successful writes only, recorded at the single GitHub I/O boundary. Unknown writes
 * are retained for diagnostics but cannot match a numbered event accidentally.
 */
export class WriteJournal {
  private readonly path: string;
  private readonly repo: string;
  private readonly nodes = new Map<string, { repo: string; number: number }>();
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

  /** Match the event's server timestamp, not the time a delayed poll observes it.
   * Missing timestamps fail open (report), never hide somebody else's activity.
   */
  matches(event: Omit<WriteRecord, "at">, at: string): boolean {
    const time = Date.parse(at);
    if (!Number.isFinite(time)) {
      return false;
    }
    return this.read().some(
      (entry) =>
        entry.kind === event.kind &&
        entry.repo.toLowerCase() === event.repo.toLowerCase() &&
        entry.number === event.number &&
        (!event.itemId || entry.itemId === event.itemId) &&
        entry.field === event.field &&
        entry.value === event.value &&
        Math.abs(Date.parse(entry.at) - time) <= MATCH_MS
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
      this.nodes.set(result.node_id, { repo, number });
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
    } else if (!item && /^(issues|pulls)$/.test(tail) && method === "POST") {
      kind = "created";
    } else if (object(body).state === "closed") {
      kind = "closed";
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
      this.append({ at, kind, repo, number });
    }
  }

  private append(entry: WriteRecord): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    // Do not lose a simultaneous writer's append during pruning. The critical
    // section contains no await/network I/O; contention is a visible retry, not
    // silently missing attribution. A crash lock requires operator inspection.
    let lock: number;
    try {
      lock = openSync(`${this.path}.lock`, "wx", 0o600);
    } catch (error) {
      throw new Error(
        "GitHub write succeeded but cannot lock gateway write journal; inspect the remote state and journal lock before retrying (do not blindly repeat creates)",
        { cause: error }
      );
    }
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
      closeSync(lock);
      unlinkSync(`${this.path}.lock`);
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
          input.itemId ?? input.contentId ?? input.pullRequestId ?? input.issueId ?? ""
        );
        const subject = this.nodes.get(id);
        const entry: WriteRecord = {
          at,
          kind: name,
          repo: subject?.repo.toLowerCase() ?? this.repo,
          number: subject?.number ?? 0,
        };
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
          this.nodes.set(id, { repo, number: subject.number });
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
            this.nodes.set(node.id, { repo: `${args.owner}/${args.name}`, number });
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
          Number(entry.number) < 0
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
