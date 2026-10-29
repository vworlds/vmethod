import type { Config } from "../config.js";
import type { GitHubClient } from "./client.js";
import { object, type ObjectData, type PeopleFilter } from "./people.js";
import { repoOf } from "../github/diagnostic.js";
import { batchPages, pageCursor } from "../github/pages.js";
import { actorFields, identityFields, labelEvents } from "../github/selections.js";
import { taskIssueNumbers } from "./task-flow-types.js";

/** Labels managed by vmethod workflow rather than describing task kind. */
export const workflowLabels = ["autopilot", "autopilot-stop"] as const;

interface Decision {
  at: number;
  enabled: boolean;
  id: string;
}

export interface AutopilotState {
  active: boolean;
  /** Owner grant identifying the authority copied by open-task. */
  grant?: string;
  /** Historical delegation never substitutes for current authority at a new gate. */
  at(time: number): boolean;
  unauthorized: boolean;
  /** A copy proof's source grant is missing from the read records (#253): the card
   * is never unauthorized and the watcher leaves it unjudged this poll. */
  unknown?: boolean;
}

/** Copy a current owner grant to a newly created task PR. Persist the exact
 * generated event ID in authenticated task metadata, then announce inheritance.
 * A revoked grant or an intervening label write refuses certification. Returns
 * whether a live grant existed and was copied; the watcher never judges a copied
 * label while this operation is in flight (#249).
 */
export async function inheritAutopilot(
  github: GitHubClient,
  filter: PeopleFilter,
  config: Config,
  issue: ObjectData,
  pr: ObjectData,
  announce = "[orchestrator] AUTOPILOT\n\nTask opened under autopilot; copied the issue's owner-authorized label."
): Promise<boolean> {
  const reader = new AutopilotReader(github, filter, config);
  const state = (await reader.read([String(issue.id)])).get(String(issue.id));
  if (!state?.active || !state.grant) {
    return false;
  }
  const repo = String(config.repo);
  const number = Number(pr.number);
  // The copied label sits alone for seconds until its proof lands; journal the
  // operation first so the watcher's polls leave the window unjudged (#249).
  github.writes.beginOperation("autopilot inherit", [{ repo, number }]);
  await github.rest(`/repos/${repo}/issues/${number}/labels`, "POST", { labels: ["autopilot"] });
  const data = object(
    await github.graphql(
      `query AutopilotCopy($id: ID!) { node(id: $id) { ... on PullRequest { ${identityFields} timelineItems(last: 20, itemTypes: [LABELED_EVENT, UNLABELED_EVENT]) { nodes { __typename ... on LabeledEvent { id createdAt actor { ${actorFields} } label { name } } ... on UnlabeledEvent { id createdAt actor { ${actorFields} } label { name } } } } } } }`,
      { id: pr.id }
    )
  );
  const current = object(data.node);
  if (!filter.accept(current, repoOf(current).owner, `https://github.com/${repo}/pull/${number}`)) {
    throw new Error("Autopilot copy identity changed");
  }
  const nodes = object(current.timelineItems).nodes;
  const timeline = Array.isArray(nodes)
    ? (nodes as ObjectData[]).map(object).filter((item) => object(item.label).name === "autopilot")
    : [];
  // Never certify a removed copy: a proof for a cleaned label would retro-activate
  // it and turn the watcher's own cleanup into a revocation (#249).
  const event = timeline.length ? timeline[timeline.length - 1] : {};
  const actor = filter.identity(event.actor);
  if (
    event.__typename !== "LabeledEvent" ||
    object(event.label).name !== "autopilot" ||
    typeof event.id !== "string" ||
    !actor ||
    filter.roleIn(actor, repo) !== "orchestrator"
  ) {
    throw new Error("Cannot certify copied autopilot label; inspect the created PR");
  }
  if (!(await reader.read([String(issue.id)])).get(String(issue.id))?.active) {
    throw new Error("Autopilot revoked during task creation; inspect the created PR");
  }
  const body = String(pr.body).replace(
    /<!-- vmethod-task \{[^\r\n]*\} -->\s*$/,
    (marker) =>
      `<!-- vmethod-autopilot-copy ${JSON.stringify({ event: event.id, source: state.grant })} -->\n\n${marker}`
  );
  if (body === pr.body) {
    throw new Error("Missing task metadata for autopilot copy");
  }
  await github.rest(`/repos/${repo}/pulls/${number}`, "PATCH", { body });
  await github.rest(
    `/repos/${repo}/issues/${number}/comments`,
    "POST",
    {
      body: announce,
    },
    false
  );
  return true;
}

/** Read owner-delegated authority from complete label history, not label presence.
 * Reads are batched across the existing board poll; no per-card polling query.
 * The sole non-owner addition allowed is open-task's exact, authenticated copy proof.
 */
export class AutopilotReader {
  constructor(
    private github: GitHubClient,
    private filter: PeopleFilter,
    private config: Config
  ) {}

  async read(ids: string[]): Promise<Map<string, AutopilotState>> {
    return autopilotStates(await this.records(ids), this.filter, String(this.config.repo));
  }

  /** The wire records behind read()'s states. The watcher cleans an unauthorized
   * label from these records in memory and recomputes the affected task groups
   * without another fetch (#249). */
  async records(ids: string[]): Promise<{ item: ObjectData; events: ObjectData[] }[]> {
    const metadata = await this.nodes(ids, "");
    const accepted = metadata.filter((item) => this.accept(item));
    const items = await this.nodes(
      accepted.map((item) => String(item.id)),
      "body number labels(first: 100) { nodes { name } pageInfo { hasNextPage } }"
    );
    const histories = await this.histories(items.filter((item) => this.accept(item)));
    return items
      .filter((item) => this.accept(item))
      .map((item) => ({
        item,
        events: histories.get(String(item.id)) ?? [],
      }));
  }

  private accept(item: ObjectData): boolean {
    return !!this.filter.accept(item, repoOf(item).owner, `https://github.com/${this.config.repo}`);
  }

  private async histories(items: ObjectData[]): Promise<Map<string, ObjectData[]>> {
    const result = new Map(items.map((item) => [String(item.id), [] as ObjectData[]]));
    const pending = items.map((item) => ({ id: String(item.id), cursor: null as string | null }));
    const seen = new Map(items.map((item) => [String(item.id), new Set<string>()]));
    await batchPages(
      pending,
      async (batch) => {
        const variables: ObjectData = {};
        const declarations: string[] = [];
        const selections = batch.map(({ id, cursor }, i) => {
          variables[`id${i}`] = id;
          variables[`cursor${i}`] = cursor;
          declarations.push(`$id${i}: ID!`, `$cursor${i}: String`);
          const fields = `${identityFields} timelineItems(first: 100, after: $cursor${i}, itemTypes: [LABELED_EVENT, UNLABELED_EVENT]) { nodes { ${labelEvents} } pageInfo { hasNextPage endCursor } }`;
          return `n${i}: node(id: $id${i}) { ... on Issue { ${fields} } ... on PullRequest { ${fields} } }`;
        });
        const data = object(
          await this.github.graphql(
            `query AutopilotHistory(${declarations.join(",")}) { ${selections.join(" ")} }`,
            variables
          )
        );
        batch.forEach((entry, i) => {
          const { id } = entry;
          const parent = object(data[`n${i}`]);
          if (!this.accept(parent)) {
            throw new Error("Autopilot identity changed");
          }
          const connection = object(parent.timelineItems);
          if (!Array.isArray(connection.nodes)) {
            throw new Error("Missing autopilot history");
          }
          result.get(id)!.push(...connection.nodes.map(object));
          const cursor = pageCursor(connection, seen.get(id)!, {
            cursorError: "Invalid autopilot history cursor",
          });
          entry.cursor = cursor;
        });
      },
      { size: 50, strategy: "rounds" }
    );
    return result;
  }

  private async nodes(ids: string[], fields: string): Promise<ObjectData[]> {
    const output: ObjectData[] = [];
    for (let start = 0; start < ids.length; start += 50) {
      const batch = ids.slice(start, start + 50);
      const data = object(
        await this.github.graphql(
          `query AutopilotNodes($ids: [ID!]!) { nodes(ids: $ids) { __typename ... on Issue { ${identityFields} ${fields} } ... on PullRequest { ${identityFields} ${fields} } } }`,
          { ids: batch }
        )
      );
      if (!Array.isArray(data.nodes) || data.nodes.length !== batch.length) {
        throw new Error("Missing autopilot nodes");
      }
      output.push(...data.nodes.map(object));
    }
    return output;
  }
}

/** Every card number of a task group among read records: a PR plus the issues its
 * structured body relation links, transitively in both directions (#253). The
 * watcher's guards and autopilotStates derive the same groups this way, so a
 * judged member's group is always inside the read set by construction.
 */
export function taskGroupNumbers(number: number, records: { item: ObjectData }[]): number[] {
  const group = new Set<number>([number]);
  for (;;) {
    const before = group.size;
    for (const { item } of records) {
      const issues =
        item.__typename === "PullRequest" ? (taskIssueNumbers(String(item.body)) ?? []) : [];
      if (group.has(Number(item.number)) || issues.some((issue) => group.has(issue))) {
        group.add(Number(item.number));
        issues.forEach((issue) => group.add(issue));
      }
    }
    if (before === group.size) {
      break;
    }
  }
  return [...group];
}

/** Interpret recorded wire events. Owner removals win timestamp ties and revoke
 * the whole task, including an inherited PR label. Unknown history fails closed.
 * A copy citing a source grant outside the read records reads unknown (#253):
 * never unauthorized, and it grants nothing on its own; the watcher skips such a
 * card instead of removing its label.
 */
export function autopilotStates(
  records: { item: ObjectData; events: ObjectData[] }[],
  filter: PeopleFilter,
  repo: string
): Map<string, AutopilotState> {
  const owners = new Map<string, Decision & { number: number }>();
  for (const { item, events } of records) {
    for (const event of events) {
      if (object(event.label).name !== "autopilot") {
        continue;
      }
      if (filter.identity(event.actor)?.role === "owner" && event.__typename === "LabeledEvent") {
        owners.set(String(event.id), {
          at: Date.parse(String(event.createdAt)),
          enabled: true,
          id: String(event.id),
          number: Number(item.number),
        });
      }
    }
  }
  const local = records.map(({ item, events }) => {
    const labels = object(item.labels);
    const complete = Array.isArray(labels.nodes) && object(labels.pageInfo).hasNextPage === false;
    const present =
      complete && (labels.nodes as ObjectData[]).some((label) => label.name === "autopilot");
    const relevant = events.filter((event) => object(event.label).name === "autopilot");
    const valid =
      complete &&
      relevant.every(
        (event) =>
          typeof event.id === "string" &&
          Number.isFinite(Date.parse(String(event.createdAt))) &&
          ["LabeledEvent", "UnlabeledEvent"].includes(String(event.__typename))
      );
    const proof = copyProof(item, filter, repo);
    let authorized = false;
    // An authenticated copy whose source grant is missing from the read records
    // reads unknown (#253), never unauthorized; it grants nothing on its own.
    let unknown = false;
    const decisions: Decision[] = [];
    for (const event of relevant.sort(
      (a, b) =>
        Date.parse(String(a.createdAt)) - Date.parse(String(b.createdAt)) ||
        (a.__typename === "UnlabeledEvent" ? 1 : -1)
    )) {
      const at = Date.parse(String(event.createdAt));
      const owner = filter.identity(event.actor)?.role === "owner";
      const actor = filter.identity(event.actor);
      const source = owners.get(String(proof?.source));
      const copyActor =
        event.__typename === "LabeledEvent" &&
        event.id === proof?.event &&
        !!actor &&
        filter.roleIn(actor, repo) === "orchestrator";
      const copied =
        copyActor &&
        !!source &&
        (taskIssueNumbers(String(item.body)) ?? []).includes(source.number) &&
        source.at <= at;
      if (event.__typename === "LabeledEvent") {
        if (owner) {
          authorized = true;
          unknown = false;
          decisions.push({ at, enabled: true, id: String(event.id) });
        } else if (copied) {
          authorized = true;
          unknown = false;
        } else if (copyActor && !source) {
          // The copy event is authenticated but its source grant is not in the
          // read records (#253): unknown, never unauthorized, granting nothing
          // by itself — the group's readable owner grant keeps standing.
          unknown = true;
          authorized = false;
        } else {
          authorized = false;
          unknown = false;
        }
      } else {
        // Removing a valid grant/copy is a stop, even if the remover is unknown.
        if (owner || authorized) {
          decisions.push({ at, enabled: false, id: String(event.id) });
        }
        authorized = false;
        unknown = false;
      }
    }
    return {
      item,
      valid: valid && (present === authorized || unknown),
      present,
      authorized,
      decisions,
      unauthorized: present && !authorized && !unknown,
      unknown,
    };
  });
  const result = new Map<string, AutopilotState>();
  for (const entry of local) {
    // Relations are task metadata, never title/branch-number guesses. Include all
    // cards of a task so a safety-valve removal on either side stops its next step.
    const group = taskGroupNumbers(Number(entry.item.number), local);
    const members = local.filter(({ item }) => group.includes(Number(item.number)));
    const decisions = members
      .flatMap((member) => member.decisions)
      .sort((a, b) => b.at - a.at || Number(a.enabled) - Number(b.enabled));
    const at = (time: number) =>
      members.every((member) => member.valid) &&
      decisions.find((decision) => decision.at <= time)?.enabled === true;
    const latest = decisions[0];
    // A missing current label never manufactures delegation from old history.
    const active = at(Infinity) && members.some((member) => member.present && member.authorized);
    result.set(String(entry.item.id), {
      active,
      ...(active && latest ? { grant: latest.id } : {}),
      at,
      unauthorized: entry.unauthorized,
      unknown: entry.unknown,
    });
  }
  return result;
}

function copyProof(
  item: ObjectData,
  filter: PeopleFilter,
  repo: string
): { event: string; source: string } | undefined {
  const author = filter.identity(item.author);
  const editor = item.lastEditedAt == null ? author : filter.identity(item.editor);
  if (
    item.__typename !== "PullRequest" ||
    !author ||
    !editor ||
    filter.roleIn(author, repo) !== "orchestrator" ||
    filter.roleIn(editor, repo) !== "orchestrator"
  ) {
    return;
  }
  const marker =
    /<!-- vmethod-autopilot-copy (\{[^\r\n]*\}) -->\s*<!-- vmethod-task \{[^\r\n]*\} -->\s*$/.exec(
      String(item.body)
    );
  if (!marker) {
    return;
  }
  try {
    const proof = object(JSON.parse(marker[1]));
    if (typeof proof.event === "string" && typeof proof.source === "string") {
      return { event: proof.event, source: proof.source };
    }
  } catch {
    /* malformed metadata confers no authority */
  }
}
