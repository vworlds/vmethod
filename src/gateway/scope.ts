import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import { object, type ObjectData, type PeopleFilter, type Person } from "./people.js";
import { identityFields, actorFields, repoOf } from "./queries.js";
import type { GitHubClient } from "./client.js";
import { readState } from "../board/readme.js";
import { AutopilotReader, type AutopilotState } from "./autopilot.js";

/** Grandfather v5 owner approvals only before the recorded v6 migration. */
export function legacyScopeCutoff(readme: string): number {
  const state = readState(readme);
  if (state.version < 6) {
    return Infinity;
  }
  const cutoff = Date.parse(state.migrated?.split(" by ")[0] ?? "");
  return Number.isFinite(cutoff) ? cutoff : 0;
}

/** Hash the exact GitHub body; the review comment, never the body, carries the digest. */
export function bodyHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** The orchestrator role is per repository (#186): a peer project's orchestrator
 * never counts as this issue's trusted orchestrator, so its comments void the shortcut. */
function orchestrates(filter: PeopleFilter, person: Person | undefined, repo: string): boolean {
  return !!person && filter.roleIn(person, repo) === "orchestrator";
}

/** Scope evidence is independent of the card's current column, so parts share approval. */
export function scopeApproved(
  issue: ObjectData,
  comments: ObjectData[],
  timeline: ObjectData[],
  config: Config,
  filter: PeopleFilter,
  legacyBefore = Infinity,
  delegation?: AutopilotState
): boolean {
  if (typeof issue.body !== "string") {
    return false;
  }
  const repo = repoOf(issue).repo;
  const trusted = (item: ObjectData) =>
    orchestrates(filter, filter.identity(item.author), repo) &&
    (item.lastEditedAt == null || orchestrates(filter, filter.identity(item.editor), repo));
  const time = (item: ObjectData) => Date.parse(String(item.lastEditedAt ?? item.createdAt));
  const reviews = comments.filter(
    (comment) =>
      trusted(comment) && /^\[orchestrator\] SCOPE REVIEW(?:\r?\n|$)/.test(String(comment.body))
  );
  if (reviews.some((review) => !Number.isFinite(time(review)))) {
    return false;
  }
  const review = reviews.sort((a, b) => time(b) - time(a))[0];
  if (review) {
    const latest = reviews.filter((candidate) => time(candidate) === time(review));
    if (latest.some((candidate) => !matchesBody(candidate, String(issue.body)))) {
      return false;
    }
    if (
      /^Autopilot: scope approved\.$/m.test(String(review.body)) &&
      delegation?.at(time(review))
    ) {
      return true;
    }
    const labels = object(issue.labels).nodes;
    const fast = object(config.scope).fastPath;
    if (
      Array.isArray(labels) &&
      Array.isArray(fast) &&
      labels.some((label) => fast.includes(object(label).name))
    ) {
      return true;
    }
  } else if (!trusted(issue) || comments.some((comment) => !trusted(comment))) {
    return false;
  }
  const latest = ownerApprovalAt(
    timeline,
    config,
    filter,
    review ? "Spec review" : "Scoping",
    legacyBefore
  );
  const since = review ? time(review) : time(issue);
  return latest !== null && Number.isFinite(since) && latest > since;
}

function ownerApprovalAt(
  timeline: ObjectData[],
  config: Config,
  filter: PeopleFilter,
  from?: "Spec review" | "Scoping",
  legacyBefore = Infinity
): number | null {
  const time = (item: ObjectData) => Date.parse(String(item.createdAt));
  const events = timeline.filter(
    (event) =>
      event.__typename === "ProjectV2ItemStatusChangedEvent" &&
      object(event.project).number === Number(object(config.board).number)
  );
  // Missing actors or ordering cannot certify approval. Orchestrator moves between parts
  // do not revoke an owner's decision; a later owner decision does.
  if (events.some((event) => event.actor == null || !Number.isFinite(time(event)))) {
    return null;
  }
  const owners = events.filter((event) => filter.identity(event.actor)?.role === "owner");
  if (!owners.length) {
    return null;
  }
  const latest = Math.max(...owners.map(time));
  if (
    owners.some(
      (event) =>
        time(event) === latest &&
        !(
          (event.status === "Executing" &&
            (from
              ? event.previousStatus === from
              : ["Spec review", "Scoping"].includes(String(event.previousStatus)))) ||
          // Migration changes position, not the owner's historical decision. The
          // migration timestamp prevents new issue Approved moves becoming scope go.
          (event.status === "Approved" && time(event) < legacyBefore)
        )
    )
  ) {
    return null;
  }
  return latest;
}

function matchesBody(review: ObjectData, body: string): boolean {
  const lines = String(review.body)
    .split(/\r?\n/)
    .filter((line) => line.startsWith("body sha256:"));
  const hash = /^body sha256: (?:([a-f\d]{64})|`([a-f\d]{64})`)$/.exec(lines[0] ?? "");
  return lines.length === 1 && hash !== null && (hash[1] ?? hash[2]) === bodyHash(body);
}

/** Refusal diagnostics use metadata only for non-orchestrator comments, never their bodies. */
export function scopeRefusal(
  issue: ObjectData,
  comments: ObjectData[],
  timeline: ObjectData[],
  config: Config,
  filter: PeopleFilter
): string {
  const reasons: { at: number; text: string }[] = [];
  const time = (item: ObjectData) => Date.parse(String(item.lastEditedAt ?? item.createdAt));
  const repo = repoOf(issue).repo || String(config.repo);
  const trusted = (item: ObjectData) =>
    orchestrates(filter, filter.identity(item.author), repo) &&
    (item.lastEditedAt == null || orchestrates(filter, filter.identity(item.editor), repo));
  const reviews = comments
    .filter(
      (comment) =>
        trusted(comment) && /^\[orchestrator\] SCOPE REVIEW(?:\r?\n|$)/.test(String(comment.body))
    )
    .sort((a, b) => time(b) - time(a));
  const review = reviews[0];
  const events = timeline.filter(
    (event) =>
      event.__typename === "ProjectV2ItemStatusChangedEvent" &&
      object(event.project).number === Number(object(config.board).number)
  );
  const approvalAt = ownerApprovalAt(timeline, config, filter, review ? "Spec review" : "Scoping");
  if (
    issue.lastEditedAt != null &&
    approvalAt !== null &&
    time(issue) > approvalAt &&
    (!review || !matchesBody(review, String(issue.body)))
  ) {
    reasons.push({
      at: time(issue),
      text: `scope approval is stale: issue body edited by ${String(object(issue.editor).login ?? "<unknown>")} at ${String(issue.lastEditedAt)} after approval; run scope-review ${String(issue.number)} <file>`,
    });
  }
  for (const event of events) {
    if (event.previousStatus === "Backlog" && event.status === "Executing") {
      reasons.push({
        at: Date.parse(String(event.createdAt)),
        text: "Backlog → Executing is not a scope approval; move it Scoping → Executing, or run scope-review",
      });
    }
  }
  if (!review) {
    for (const comment of comments.filter((comment) => !trusted(comment))) {
      reasons.push({
        at: time(comment),
        text: `the trivial shortcut is void: comment ${String(comment.url ?? "<unknown>")} by ${String(object(comment.lastEditedAt == null ? comment.author : comment.editor).login ?? "<unknown>")}; run scope-review ${String(issue.number)} <file>`,
      });
    }
  }
  return (
    reasons.filter((reason) => Number.isFinite(reason.at)).sort((a, b) => b.at - a.at)[0]?.text ??
    `scope not approved: run scope-review ${String(issue.number)} <file> and ask the owner to move Spec review → Executing`
  );
}

function reviewPending(
  issue: ObjectData,
  comments: ObjectData[],
  timeline: ObjectData[],
  config: Config,
  filter: PeopleFilter,
  legacyBefore: number
): boolean {
  const time = (item: ObjectData) => Date.parse(String(item.lastEditedAt ?? item.createdAt));
  const repo = repoOf(issue).repo;
  const reviews = comments.filter(
    (comment) =>
      orchestrates(filter, filter.identity(comment.author), repoOf(comment).repo || repo) &&
      (comment.lastEditedAt == null ||
        orchestrates(filter, filter.identity(comment.editor), repoOf(comment).repo || repo)) &&
      /^\[orchestrator\] SCOPE REVIEW(?:\r?\n|$)/.test(String(comment.body))
  );
  const review = reviews.sort((a, b) => time(b) - time(a))[0];
  if (!review || !Number.isFinite(time(review)) || typeof issue.body !== "string") {
    return false;
  }
  if (!matchesBody(review, issue.body)) {
    return false;
  }
  const ownerAt = ownerApprovalAt(timeline, config, filter, undefined, legacyBefore);
  return (
    (ownerAt === null || ownerAt <= time(review)) &&
    !comments.some((comment) => time(comment) > time(review))
  );
}

/** Batch scope reads and refusal reasons for a board poll. Unknown authors are filtered before body reads.
 * Connections paginate; non-orchestrator comments (including rejected authors) void the shortcut.
 */
export class ScopeReader {
  constructor(
    private github: GitHubClient,
    private filter: PeopleFilter,
    private config: Config,
    private legacyBefore = Infinity,
    private delegations?: Map<string, AutopilotState>
  ) {}

  async approved(ids: string[]): Promise<Map<string, boolean>> {
    return new Map([...(await this.read(ids))].map(([id, state]) => [id, state.approved]));
  }

  async read(
    ids: string[]
  ): Promise<
    Map<
      string,
      { approved: boolean; ownerApproved: boolean; reviewPending: boolean; refusal?: string }
    >
  > {
    const result = new Map<
      string,
      { approved: boolean; ownerApproved: boolean; reviewPending: boolean; refusal?: string }
    >(ids.map((id) => [id, { approved: false, ownerApproved: false, reviewPending: false }]));
    if (ids.length > 100) {
      for (let index = 0; index < ids.length; index += 100) {
        for (const [id, state] of await this.read(ids.slice(index, index + 100))) {
          result.set(id, state);
        }
      }
      return result;
    }
    if (!ids.length) {
      return result;
    }
    const metadata = await this.nodes(ids, "Issue", "");
    const accepted = metadata.filter((item) => this.accept(item));
    const issues = await this.nodes(
      accepted.map((item) => String(item.id)),
      "Issue",
      "number body createdAt labels(first: 100) { nodes { name } pageInfo { hasNextPage } }"
    );
    const comments = await this.connections(issues, "comments");
    const timeline = await this.connections(issues, "timelineItems");
    const metas = [...comments.values()].flat();
    // Only a comment by an orchestrator of the issue's repository can ever match
    // SCOPE REVIEW; peer project orchestrators are collaborators here, so voiding
    // them still needs no body read.
    const binds = (item: ObjectData): boolean => {
      const person = this.filter.identity(item.author);
      return (
        !!person &&
        this.filter.roleIn(person, repoOf(item).repo || String(this.config.repo)) === "orchestrator"
      );
    };
    const trusted = metas.filter((item) => this.accept(item) && binds(item));
    const requestedComments = new Set(trusted.map((item) => item.id));
    const bodies = new Map(
      (
        await this.nodes(
          trusted.map((item) => String(item.id)),
          "IssueComment",
          "body createdAt"
        )
      )
        .filter((item) => this.accept(item))
        .map((item) => [item.id, item])
    );
    const delegatedIds = issues
      .filter((issue) =>
        (comments.get(String(issue.id)) ?? []).some((meta) =>
          /^Autopilot: scope approved\.$/m.test(String(bodies.get(meta.id)?.body))
        )
      )
      .map((issue) => String(issue.id));
    const delegations = new Map(this.delegations);
    for (const [id, state] of await new AutopilotReader(this.github, this.filter, this.config).read(
      delegatedIds.filter((id) => !delegations.has(id))
    )) {
      delegations.set(id, state);
    }
    for (const issue of issues) {
      if (!this.accept(issue) || object(object(issue.labels).pageInfo).hasNextPage !== false) {
        continue;
      }
      const id = String(issue.id);
      const events = timeline.get(id) ?? [];
      const commentMetas = comments.get(id) ?? [];
      // A rejected body re-read must not restore an earlier, trusted editor snapshot.
      const complete = !commentMetas.some(
        (meta) => requestedComments.has(meta.id) && !bodies.has(meta.id)
      );
      const discussion = commentMetas.map((meta) => bodies.get(meta.id) ?? meta);
      result.set(id, {
        refusal: scopeRefusal(issue, discussion, events, this.config, this.filter),
        approved:
          complete &&
          scopeApproved(
            issue,
            discussion,
            events,
            this.config,
            this.filter,
            this.legacyBefore,
            delegations.get(id)
          ),
        ownerApproved:
          ownerApprovalAt(events, this.config, this.filter, undefined, this.legacyBefore) !== null,
        reviewPending:
          complete &&
          reviewPending(issue, discussion, events, this.config, this.filter, this.legacyBefore),
      });
    }
    return result;
  }

  private accept(item: ObjectData): boolean {
    return !!this.filter.accept(
      item,
      repoOf(item).owner,
      `https://github.com/${String(this.config.repo)}`
    );
  }

  private async connections(
    issues: ObjectData[],
    field: "comments" | "timelineItems"
  ): Promise<Map<string, ObjectData[]>> {
    const output = new Map(issues.map((item) => [String(item.id), [] as ObjectData[]]));
    let pending = issues.map((item) => ({ id: String(item.id), cursor: null as string | null }));
    const seen = new Set<string>();
    while (pending.length) {
      const next: typeof pending = [];
      // Batch aliases rather than one request per board card. IDs/cursors are variables.
      const variables: ObjectData = {};
      const declarations: string[] = [];
      const selections = pending.map(({ id, cursor }, i) => {
        variables[`id${i}`] = id;
        variables[`cursor${i}`] = cursor;
        declarations.push(`$id${i}: ID!`, `$cursor${i}: String`);
        const selection =
          field === "comments"
            ? `${identityFields} url createdAt`
            : `__typename ... on ProjectV2ItemStatusChangedEvent { actor { ${actorFields} } status previousStatus createdAt project { number } }`;
        return `n${i}: node(id: $id${i}) { ... on Issue { ${identityFields} ${field}(first: 100, after: $cursor${i}${field === "timelineItems" ? ", itemTypes: [PROJECT_V2_ITEM_STATUS_CHANGED_EVENT]" : ""}) { nodes { ${selection} } pageInfo { hasNextPage endCursor } } } }`;
      });
      const data = object(
        await this.github.graphql(
          `query ScopeConnections(${declarations.join(",")}) { ${selections.join(" ")} }`,
          variables
        )
      );
      pending.forEach(({ id }, i) => {
        const parent = object(data[`n${i}`]);
        if (!this.accept(parent)) {
          throw new Error("Scope identity changed");
        }
        const connection = object(parent[field]);
        if (!Array.isArray(connection.nodes)) {
          throw new Error("Missing scope connection");
        }
        output.get(id)!.push(...connection.nodes.map(object));
        const page = object(connection.pageInfo);
        if (page.hasNextPage === false) {
          return;
        }
        const key = `${id}:${String(page.endCursor)}`;
        if (page.hasNextPage !== true || typeof page.endCursor !== "string" || seen.has(key)) {
          throw new Error("Invalid scope cursor");
        }
        seen.add(key);
        next.push({ id, cursor: page.endCursor });
      });
      pending = next;
    }
    return output;
  }

  private async nodes(ids: string[], type: string, fields: string): Promise<ObjectData[]> {
    if (ids.length > 100) {
      const output: ObjectData[] = [];
      for (let index = 0; index < ids.length; index += 100) {
        output.push(...(await this.nodes(ids.slice(index, index + 100), type, fields)));
      }
      return output;
    }
    if (!ids.length) {
      return [];
    }
    const data = object(
      await this.github.graphql(
        `query ScopeNodes($ids: [ID!]!) { nodes(ids: $ids) { ... on ${type} { ${identityFields} ${fields} } } }`,
        { ids }
      )
    );
    if (!Array.isArray(data.nodes) || data.nodes.length !== ids.length) {
      throw new Error("Missing scope nodes");
    }
    return data.nodes.map(object);
  }
}
