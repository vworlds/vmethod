import { object, type ObjectData } from "../gateway/people.js";
import { taskRelation } from "../tasks/markers.js";

/** A column snapshot in GitHub's manual order; dependencies name board item IDs. */
export interface OrderCard {
  id: string;
  repo: string;
  dependencies: string[];
}

/** Stable dependency-first order. Strongly connected members retain recency order;
 * dependencies outside the supplied column are ignored, never traversed. */
export function executingOrder(cards: readonly OrderCard[], activity?: string) {
  const recent = [...cards];
  const active = recent.findIndex((card) => card.id === activity);
  if (active > 0) {
    recent.unshift(...recent.splice(active, 1));
  }
  const byId = new Map(recent.map((card) => [card.id, card]));
  const reach = (id: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(id)) {
      return seen;
    }
    seen.add(id);
    for (const dep of byId.get(id)?.dependencies ?? []) {
      if (byId.has(dep)) {
        reach(dep, seen);
      }
    }
    return seen;
  };
  const reachable = new Map(recent.map((card) => [card.id, reach(card.id)]));
  const groups: string[][] = [];
  const assigned = new Set<string>();
  for (const card of recent) {
    if (assigned.has(card.id)) {
      continue;
    }
    const group = recent
      .filter(
        (other) => reachable.get(card.id)!.has(other.id) && reachable.get(other.id)!.has(card.id)
      )
      .map((other) => other.id);
    groups.push(group);
    group.forEach((id) => assigned.add(id));
  }
  const cycles = groups.filter(
    (group) => group.length > 1 || byId.get(group[0])!.dependencies.includes(group[0])
  );
  const placed = new Set<string>();
  const order: string[] = [];
  while (order.length < recent.length) {
    const group = groups.find(
      (group) =>
        !placed.has(group[0]) &&
        group.every((id) =>
          byId
            .get(id)!
            .dependencies.every((dep) => !byId.has(dep) || placed.has(dep) || group.includes(dep))
        )
    )!;
    order.push(...group);
    group.forEach((id) => placed.add(id));
  }
  return { order, cycles };
}

/** Top-down position writes against the evolving column; foreign cards are anchors,
 * not mutation targets. The caller updates its working order only after success. */
export function positionMoves(
  current: readonly string[],
  target: readonly string[],
  owned: ReadonlySet<string>
) {
  const working = [...current];
  const moves: { itemId: string; afterId: string | null }[] = [];
  let afterId: string | null = null;
  for (const itemId of target) {
    const index = working.indexOf(itemId);
    if (owned.has(itemId) && (index === 0 ? null : working[index - 1]) !== afterId) {
      moves.push({ itemId, afterId });
      working.splice(index, 1);
      working.splice(afterId === null ? 0 : working.indexOf(afterId) + 1, 0, itemId);
    }
    afterId = itemId;
  }
  return moves;
}

/** Project complete, paginated board data into the Executing dependency graph. */
export function executingCards(nodes: readonly ObjectData[]): OrderCard[] {
  const list = (value: unknown): ObjectData[] => {
    const connection = object(value);
    if (!Array.isArray(connection.nodes)) {
      throw new Error("Missing ordering dependency connection");
    }
    return connection.nodes.map(object);
  };
  const cards = nodes.filter(
    (node) => !node.isArchived && object(node.status).name === "Executing"
  );
  const ref = (content: ObjectData) =>
    `${String(object(content.repository).nameWithOwner).toLowerCase()}#${content.number}`;
  const byContent = new Map(cards.map((node) => [object(node.content).id, String(node.id)]));
  const byRef = new Map(cards.map((node) => [ref(object(node.content)), String(node.id)]));
  const output = cards.map((node) => ({
    id: String(node.id),
    repo: String(object(object(node.content).repository).nameWithOwner),
    dependencies: [] as string[],
  }));
  const byItem = new Map(output.map((card) => [card.id, card]));
  for (const node of cards) {
    const content = object(node.content);
    const card = byItem.get(String(node.id))!;
    if (content.__typename === "Issue") {
      for (const child of list(content.subIssues)) {
        const id = byContent.get(child.id);
        if (id) {
          card.dependencies.push(id);
        }
      }
      for (const blocker of list(content.blockedBy)) {
        const id = byRef.get(ref(blocker));
        if (id) {
          card.dependencies.push(id);
        }
      }
    } else if (content.__typename === "PullRequest") {
      // A malformed user-editable marker is not a task relation. Native closing
      // links still count; do not let arbitrary PR prose abort the board poll.
      let relation: ReturnType<typeof taskRelation>;
      try {
        relation = taskRelation(String(content.body ?? ""));
      } catch {
        relation = undefined;
      }
      const issues = list(content.closingIssuesReferences).map(ref);
      if (relation && !relation.part) {
        issues.push(...relation.issues.map((number) => `${card.repo.toLowerCase()}#${number}`));
      }
      for (const issue of issues) {
        const id = byRef.get(issue);
        if (id) {
          byItem.get(id)!.dependencies.push(card.id);
        }
      }
    }
  }
  for (const card of output) {
    card.dependencies = [...new Set(card.dependencies)].sort();
  }
  return output;
}
