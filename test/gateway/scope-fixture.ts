import recorded from "../fixtures/github/issue-scope.json" with { type: "json" };
import { actor, item } from "./helpers.js";
import { type ObjectData } from "../../src/gateway/people.js";
import { parse } from "graphql";
import { expect } from "vitest";

/** Project the recorded issue/comment/status wire shapes to the isolated test pins. */
export function scopeIssue(overrides: ObjectData = {}): ObjectData {
  const projection: ObjectData = structuredClone(recorded.repository.issue);
  delete projection.comments;
  delete projection.timelineItems;
  return item({
    ...projection,
    id: "node-1",
    number: 8,
    author: actor(2),
    editor: null,
    lastEditedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    body: "Final scope",
    labels: { nodes: [], pageInfo: { hasNextPage: false } },
    repository: { nameWithOwner: "example/project", owner: { login: "example" } },
    ...overrides,
  });
}

export function scopeComment(overrides: ObjectData = {}): ObjectData {
  return item({
    ...structuredClone(recorded.repository.issue.comments.nodes[0]),
    id: "comment-1",
    author: actor(2),
    editor: null,
    lastEditedAt: null,
    createdAt: "2026-01-02T00:00:00Z",
    repository: { nameWithOwner: "example/project", owner: { login: "example" } },
    ...overrides,
  });
}

export function scopeMove(overrides: ObjectData = {}): ObjectData {
  const event = recorded.repository.issue.timelineItems.nodes.find(
    (event) => event.status === "Approved"
  );
  if (!event) {
    throw new Error("Recorded owner approval missing");
  }
  return {
    ...event,
    actor: actor(),
    project: { number: 1 },
    createdAt: "2026-01-03T00:00:00Z",
    ...overrides,
  };
}

export const scopeConnection = (nodes: ObjectData[]) => ({
  nodes,
  pageInfo: { hasNextPage: false },
});

/** Batched envelopes project recorded node fields; reject malformed or unfiltered queries. */
export function scopeGraph(data: unknown) {
  return {
    path: "/graphql",
    json: { data },
    checkQuery(query: string) {
      expect(() => parse(query)).not.toThrow();
      for (const field of ["author", "editor", "lastEditedAt", "repository", "databaseId"]) {
        expect(query).toContain(field);
      }
    },
  };
}
