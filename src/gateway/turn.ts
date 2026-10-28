import { GitHubHttpError, type GitHubClient } from "./client.js";
import { object, pinnedIdentity, type ObjectData, type Person } from "./people.js";
import { actorFields } from "./queries.js";

/** Management assignees encode whose move it is; null preserves worker assignments.
 * Owner turns select the interaction winner supplied by ownerForTurn, otherwise
 * the first registry owner. Other roles still require exactly one candidate. */
export function turnAssignees(
  people: Person[],
  repo: string,
  current: string[],
  role: "owner" | "orchestrator" | "worker" | null,
  owner?: string
): string[] {
  // The orchestrator role is per repository (#186): only an orchestrator whose
  // owner-approved binding lists this repository can hold or hold over its turn.
  const manages = (p: Person) =>
    p.role === "owner" ||
    (p.role === "orchestrator" &&
      !!p.repos?.some((bound) => bound.toLowerCase() === repo.toLowerCase()));
  if (role === null) {
    const managed = new Set(people.filter(manages).map((p) => p.login.toLowerCase()));
    return current.filter((login) => !managed.has(login.toLowerCase()));
  }
  // Workers act globally (one worker account); only management roles are bound.
  const candidates = people.filter((p) => p.role === role && (role === "worker" || manages(p)));
  if (role === "owner") {
    if (!candidates.length) {
      throw new Error(`No owner configured for ${repo}`);
    }
    return [candidates.find((p) => p.login === owner)?.login ?? candidates[0].login];
  }
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one ${role} for ${repo}`);
  }
  return [candidates[0].login];
}

/** Identity-only activity, shared with the board poll; no external body text is needed. */
export function ownerActivityFields(pr: boolean, before = "null"): string {
  return `ownerActivity: timelineItems(last: 100, before: ${before}, itemTypes: [ISSUE_COMMENT, LABELED_EVENT, UNLABELED_EVENT, PROJECT_V2_ITEM_STATUS_CHANGED_EVENT${pr ? ", PULL_REQUEST_REVIEW" : ""}]) {
    nodes { __typename
      ... on IssueComment { createdAt lastEditedAt author { ${actorFields} } editor { ${actorFields} } }
      ... on LabeledEvent { createdAt actor { ${actorFields} } }
      ... on UnlabeledEvent { createdAt actor { ${actorFields} } }
      ... on ProjectV2ItemStatusChangedEvent { createdAt actor { ${actorFields} } }
      ${pr ? `... on PullRequestReview { createdAt lastEditedAt author { ${actorFields} } editor { ${actorFields} } }` : ""}
    } pageInfo { hasPreviousPage startCursor }
  }`;
}

/** Choose the latest pinned owner interaction, or registry order when none exists.
 * A board poll supplies the first page, avoiding a query per card. Read older
 * pages too: an older comment may have a newer owner edit. Timestamp ties use
 * registry order, and edited text belongs to its pinned editor. */
export async function ownerForTurn(
  github: GitHubClient,
  people: Person[],
  repo: string,
  number: number,
  initial?: ObjectData
): Promise<string | undefined> {
  const owners = people.filter((person) => person.role === "owner");
  if (owners.length <= 1) {
    return owners[0]?.login;
  }
  let connection = initial;
  let before: string | null = null;
  const seen = new Set<string>();
  const interactions: { login: string; time: number }[] = [];
  for (;;) {
    if (!connection) {
      const [owner, name] = repo.split("/");
      const data = object(
        await github.graphql(
          `query OwnerTurn($owner: String!, $name: String!, $number: Int!, $before: String) {
          repository(owner: $owner, name: $name) { issueOrPullRequest(number: $number) {
            ... on Issue { ${ownerActivityFields(false, "$before")} }
            ... on PullRequest { ${ownerActivityFields(true, "$before")} }
          } }
        }`,
          { owner, name, number, before }
        )
      );
      connection = object(object(object(data.repository).issueOrPullRequest).ownerActivity);
    }
    if (!Array.isArray(connection.nodes)) {
      throw new Error("Missing owner activity timeline");
    }
    interactions.push(
      ...connection.nodes.map(object).flatMap((event) => {
        const actor = event.lastEditedAt != null ? event.editor : (event.author ?? event.actor);
        const person = pinnedIdentity(people, actor);
        const time = Date.parse(String(event.lastEditedAt ?? event.createdAt));
        if (person?.role !== "owner") {
          return [];
        }
        if (!Number.isFinite(time)) {
          throw new Error("Invalid owner activity timestamp");
        }
        return [{ login: person.login, time }];
      })
    );
    const info = object(connection.pageInfo);
    if (info.hasPreviousPage === false) {
      interactions.sort(
        (a, b) =>
          b.time - a.time ||
          owners.findIndex((p) => p.login === a.login) -
            owners.findIndex((p) => p.login === b.login)
      );
      return interactions[0]?.login ?? owners[0].login;
    }
    if (
      info.hasPreviousPage !== true ||
      typeof info.startCursor !== "string" ||
      !info.startCursor ||
      seen.has(info.startCursor)
    ) {
      throw new Error("Invalid owner activity pagination");
    }
    before = info.startCursor;
    seen.add(before);
    connection = undefined;
  }
}

/** Apply a turn from an already-read snapshot, with no redundant assignment writes. */
export async function setTurn(
  github: GitHubClient,
  repo: string,
  number: number,
  current: string[],
  next: string[]
): Promise<void> {
  const path = `/repos/${repo}/issues/${number}/assignees`;
  const apply = async (assignees: string[]) => {
    const remove = assignees.filter((login) => !next.includes(login));
    const add = next.filter((login) => !assignees.includes(login));
    if (remove.length) {
      await github.rest(path, "DELETE", { assignees: remove });
    }
    if (add.length) {
      await github.rest(path, "POST", { assignees: add });
    }
  };
  try {
    await apply(current);
  } catch (error) {
    if (!(error instanceof GitHubHttpError) || error.status !== 422) {
      throw error;
    }
    const response = (await github.rest(`/repos/${repo}/issues/${number}`)) as {
      assignees?: { login?: string }[];
    };
    const latest = (response.assignees ?? []).flatMap((person) => person.login ?? []);
    if (sameAssignees(latest, next)) {
      return;
    }
    await apply(latest);
  }
}

/** Sorted-comparison of the same assignee set, for callers that must distinguish a
 * real turn change from a redundant setTurn write. */
export function sameAssignees(left: string[], right: string[]): boolean {
  const normalized = new Set(right.map((login) => login.toLowerCase()));
  return left.length === right.length && left.every((login) => normalized.has(login.toLowerCase()));
}
