import type { GitHubClient } from "./client.js";
import { object, type ObjectData } from "./people.js";
import { actorFields } from "./queries.js";

type ListName = "labels" | "blockedBy" | "subIssues" | "reviews";
type Sizes = Record<"items" | ListName, number>;
const listNames: ListName[] = ["labels", "blockedBy", "subIssues", "reviews"];
const pageInfo = "pageInfo { hasNextPage endCursor }";
const fields: Record<ListName, string> = {
  labels: "nodes { name }",
  blockedBy: "totalCount nodes { number state repository { nameWithOwner } }",
  subIssues: "nodes { id }",
  reviews: `nodes { id state commit { oid } author { ${actorFields} } }`,
};
const nodes = (connection: ObjectData): ObjectData[] =>
  Array.isArray(connection.nodes) ? connection.nodes.map(object) : [];
const sizeFor = (count: number): number => Math.min(100, Math.max(10, count + 10));

interface Overflow {
  id: string;
  kind: "Issue" | "PullRequest";
  name: ListName;
  connection: ObjectData;
  seen: Set<string>;
}

/** One watch session's bounded, adaptive board pages; only complete reads train sizes. */
export class WatchBoard {
  sizes: Sizes = { items: 10, labels: 10, blockedBy: 10, subIssues: 10, reviews: 10 };
  /** Actual sum of rateLimit.cost across board and overflow queries in the last read. */
  cost = 0;
  /** Board page and overflow queries the last read needed; boundary changes report. */
  pages = 0;
  overflow = 0;

  constructor(private readonly github: Pick<GitHubClient, "graphql">) {}

  /** Read every board card and overflowing nested list before exposing the snapshot. */
  async read(
    owner: string,
    number: number,
    activity: { issue: string; pr: string }
  ): Promise<{ readme: string; nodes: ObjectData[] }> {
    this.cost = 0;
    this.pages = 0;
    this.overflow = 0;
    let cursor: string | null = null;
    let readme: string;
    const seen = new Set<string>();
    const cards: ObjectData[] = [];
    const overflow: Overflow[] = [];
    for (;;) {
      const data = await this.query(this.boardQuery(activity), { owner, number, cursor });
      this.pages++;
      const project = object(object(data.organization).projectV2);
      if (typeof project.id !== "string" || !project.id) {
        throw new Error("Missing board project");
      }
      readme = typeof project.readme === "string" ? project.readme : "";
      const connection = object(project.items);
      if (!Array.isArray(connection.nodes)) {
        throw new Error("Missing watcher board connection");
      }
      for (const card of nodes(connection)) {
        cards.push(card);
        const content = object(card.content);
        const kind = content.__typename;
        if (kind !== "Issue" && kind !== "PullRequest") {
          continue;
        }
        for (const name of listNames) {
          if (
            (kind === "Issue" && name === "reviews") ||
            (kind === "PullRequest" && (name === "blockedBy" || name === "subIssues"))
          ) {
            continue;
          }
          const list = object(content[name]);
          if (
            !Array.isArray(list.nodes) ||
            typeof object(list.pageInfo).hasNextPage !== "boolean"
          ) {
            throw new Error("Missing watcher nested connection");
          }
          if (object(list.pageInfo).hasNextPage === true) {
            if (typeof content.id !== "string" || nodes(list).length < this.sizes[name]) {
              throw new Error("Invalid watcher nested page");
            }
            overflow.push({ id: content.id, kind, name, connection: list, seen: new Set() });
          }
        }
      }
      if (object(connection.pageInfo).hasNextPage === false) {
        break;
      }
      cursor = this.cursor(connection, seen);
    }
    await this.complete(overflow);
    const next = { ...this.sizes, items: sizeFor(cards.length) };
    for (const name of listNames) {
      const largest = cards.reduce(
        (max, card) => Math.max(max, nodes(object(object(card.content)[name])).length),
        0
      );
      next[name] = sizeFor(largest);
    }
    this.sizes = next;
    return { readme, nodes: cards };
  }

  private boardQuery(activity: { issue: string; pr: string }): string {
    const list = (name: ListName): string =>
      `${name}(first: ${this.sizes[name]}) { ${fields[name]} ${pageInfo} }`;
    const common = `id number ${list("labels")} state closedAt title
      author { ${actorFields} } repository { nameWithOwner owner { login } }
      assignees(first: 10) { nodes { login } }`;
    return `query WatchBoard($owner: String!, $number: Int!, $cursor: String) {
      rateLimit { cost }
      organization(login: $owner) { projectV2(number: $number) { id readme
        items(first: ${this.sizes.items}, after: $cursor) { nodes {
          id
          status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name updatedAt } }
          estimate: fieldValueByName(name: "Estimate") { ... on ProjectV2ItemFieldNumberValue { number } }
          progress: fieldValueByName(name: "Progress") { ... on ProjectV2ItemFieldTextValue { text } }
          content { __typename
            ... on Issue { ${activity.issue} ${common} stateReason ${list("blockedBy")} ${list("subIssues")}
              closure: timelineItems(last: 1, itemTypes: [CLOSED_EVENT]) { nodes { ... on ClosedEvent { actor { login } } } }
            }
            ... on PullRequest { ${activity.pr} ${common} headRefOid ${list("reviews")}
              closure: timelineItems(last: 1, itemTypes: [CLOSED_EVENT, MERGED_EVENT]) { nodes {
                ... on ClosedEvent { actor { login } } ... on MergedEvent { actor { login } }
              } }
            }
          }
        } ${pageInfo} }
      } }
    }`;
  }

  private async complete(pending: Overflow[]): Promise<void> {
    // Batch overflow connections: never add a query per ordinary board card.
    while (pending.length) {
      const next: Overflow[] = [];
      for (let start = 0; start < pending.length; start += 50) {
        const batch = pending.slice(start, start + 50);
        const selections = batch.map((entry, index) => {
          const after = this.cursor(entry.connection, entry.seen);
          return `n${index}: node(id: ${JSON.stringify(entry.id)}) { ... on ${entry.kind} {
            ${entry.name}(first: ${this.sizes[entry.name]}, after: ${JSON.stringify(after)}) {
              ${fields[entry.name]} ${pageInfo}
            }
          } }`;
        });
        const data = await this.query(
          `query WatchBoardLists { rateLimit { cost } ${selections.join("\n")} }`
        );
        this.overflow++;
        batch.forEach((entry, index) => {
          const connection = object(object(data[`n${index}`])[entry.name]);
          if (
            !Array.isArray(connection.nodes) ||
            typeof object(connection.pageInfo).hasNextPage !== "boolean"
          ) {
            throw new Error("Missing watcher nested connection");
          }
          entry.connection.nodes = [...nodes(entry.connection), ...nodes(connection)];
          entry.connection.pageInfo = connection.pageInfo;
          if (object(connection.pageInfo).hasNextPage === true) {
            if (nodes(connection).length < this.sizes[entry.name]) {
              throw new Error("Invalid watcher nested page");
            }
            next.push(entry);
          }
        });
      }
      pending = next;
    }
  }

  private cursor(connection: ObjectData, seen: Set<string>): string {
    const info = object(connection.pageInfo);
    if (
      info.hasNextPage !== true ||
      typeof info.endCursor !== "string" ||
      !info.endCursor ||
      seen.has(info.endCursor)
    ) {
      throw new Error("Invalid board pagination cursor");
    }
    seen.add(info.endCursor);
    return info.endCursor;
  }

  private async query(query: string, variables: Record<string, unknown> = {}): Promise<ObjectData> {
    const data = object(await this.github.graphql(query, variables));
    const cost = object(data.rateLimit).cost;
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
      throw new Error("Missing measured watcher query cost");
    }
    this.cost += cost;
    return data;
  }
}
