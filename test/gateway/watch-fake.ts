import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { parse, Kind, visit } from "graphql";
import type { Config } from "../../src/config.js";
import { BoardService } from "../../src/gateway/board.js";
import {
  EventLoop,
  type EventDeps,
  type SessionInput,
  type WatchEvent,
} from "../../src/gateway/events.js";
import { watchClient } from "../../src/cli/watch.js";
import type { Operations } from "../../src/gateway/transport.js";
import {
  GitHubClient,
  type Dependencies,
  type WorkerSessionStatus,
} from "../../src/gateway/client.js";
import { Digest } from "../../src/gateway/digest.js";
import { PeopleFilter, object, type ObjectData } from "../../src/gateway/people.js";
import { fixture, ghConfig } from "../helpers.js";
import { actor, people, sha } from "./helpers.js";
import recordedActions from "../fixtures/github/watch-actions.json" with { type: "json" };
import recordedBoard from "../fixtures/github/board-write-inputs.json" with { type: "json" };
import recordedComment from "../fixtures/github/review-comment.json" with { type: "json" };
import recordedThreads from "../fixtures/github/review-threads.json" with { type: "json" };
import recordedOpencode from "../fixtures/opencode/watch-status.json" with { type: "json" };
import { scopeIssue, scopeMove, scopeConnection } from "./scope-fixture.js";
import type { ProviderLimits } from "../../src/gateway/limits.js";

export function proc(start = 42): string {
  return `1 (worker (with spaces)) S ${Array(18).fill("0").join(" ")} ${start} 0`;
}

/** WatchBoard page cursors: null requests the first page, then the served endCursor. */
function pageCursor(cursor: unknown): string | null {
  if (cursor === null) {
    return null;
  }
  if (typeof cursor !== "string" || !/^\d+$/.test(cursor)) {
    throw new Error(`Invalid WatchBoard cursor ${String(cursor)}`);
  }
  return cursor;
}

/** Project requested connection metadata onto minimal card state/older recordings. */
function boardCards(cards: ObjectData[]): ObjectData[] {
  return structuredClone(cards).map((card) => {
    const content = object(card.content);
    const names =
      content.__typename === "PullRequest"
        ? ["labels", "reviews", "closingIssuesReferences"]
        : ["labels", "blockedBy", "subIssues"];
    for (const name of names) {
      const original = object(content[name]);
      content[name] = {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
        ...original,
      };
    }
    return card;
  });
}
export const user = (index = 1) => ({
  login: people[index].login,
  id: people[index].id,
  type: people[index].type,
});

/** Stateful scripted timeline. Every allowed route is explicit; unknown I/O fails the test even if caught. */
export class WatchFake {
  root = fixture();
  clock = Date.UTC(2026, 9, 17, 10);
  config: Config = {
    repo: "example/project",
    org: "example",
    stateName: "watch-test",
    baseBranch: "dev",
    board: { owner: "example", number: 5, repos: ["example/project"] },
    vmethod: { repo: "vworlds/vmethod" },
    gateway: { maxRetries: 0 },
  };
  env = {
    XDG_STATE_HOME: join(this.root, "state"),
    GH_CONFIG_DIR: ghConfig("fake-secret"),
    OPENCODE_BASE_URL: "http://opencode.invalid",
    OPENCODE_SERVER_USERNAME: "fake",
    OPENCODE_SERVER_PASSWORD: "fake",
  };
  dir = join(this.env.XDG_STATE_HOME, "vmethod", "watch-test");
  pulls: ObjectData[] = [];
  issues: ObjectData[] = [];
  comments: Record<string, ObjectData[]> = { "example/project": [], "vworlds/vmethod": [] };
  reviewThreads: ObjectData[] = [];
  reviewThreadPages: ObjectData[][] | null = null;
  reviewCommentPages: ObjectData[][] | null = null;
  failReviewThreads = false;
  reviewThreadReads: number[] = [];
  assigned: Record<string, ObjectData[]> = { "example/project": [], "vworlds/vmethod": [] };
  newItems: ObjectData[] = [];
  cards: ObjectData[] = [];
  readme = "";
  /** rateLimit.cost each scripted or non-scripted WatchBoard response reports. */
  boardCost = 1;
  mergeable: boolean | null = true;
  baseMoved = false;
  resolveConflicts?: (pr: number) => Promise<string>;
  conflictPending?: (pr: number) => boolean;
  conflictFixing?: (pr: number) => boolean;
  gone: ObjectData = { state: "closed", closed_at: "2026-10-17T10:01:00Z", user: user() };
  commits: ObjectData[] = [];
  checks: ObjectData[] = [];
  blockers: ObjectData[] = [];
  history: ObjectData[] = [];
  permissions: ObjectData[] = [];
  messages: ObjectData[] = [];
  active: ObjectData = {};
  queryError = false;
  fail = false;
  failSet = false;
  headers: Record<string, string> = {};
  secondary = false;
  requests: string[] = [];
  unexpected: string[] = [];
  reports: string[] = [];
  /** Informational pacing reports are asserted separately from failures. */
  pollReports: string[] = [];
  sleeps: number[] = [];
  writes: ObjectData[] = [];
  /** Executing order movements the loop requested through `board.moveToTop`. */
  orders: { itemId: string; afterId: string | null }[] = [];
  loops: EventLoop[] = [];
  processStart = 42;
  assignmentEvents: ObjectData[] = [];
  closingPrs: Record<number, ObjectData[][]> = {};
  boardSnapshot: ObjectData[] | null = null;
  /** Scripted WatchBoard pagination; each entry is one page's nodes, or null to fail that page. */
  boardPages: (ObjectData[] | null)[] | null = null;
  boardTimeline: Record<string, ObjectData[][]> = {};
  scopeComments: ObjectData[] = [];
  scopeTimeline: ObjectData[] | null = null;
  scopeBody = "Final scope";
  writeActor = { login: "me", id: 999, type: "User" };
  viewer = { login: "me", id: 999 };
  staleWorker: WorkerSessionStatus | Error = { reason: "session unknown", active: false };
  staleWorkerReads: number[] = [];
  workerSends: { pr: number; text: string }[] = [];
  workerMetrics: { pr: number; event: import("../../src/learning-metrics.js").MetricEvent }[] = [];
  workerStatus?: (pr: number) => Promise<WorkerSessionStatus>;
  workerLimits?: () => Promise<ProviderLimits[]>;
  watchPeople = people;
  fields: ObjectData[] = structuredClone(recordedBoard.fields.nodes).map((field) =>
    field.name === "Status"
      ? {
          ...field,
          options: [
            "Backlog",
            "Scoping",
            "Spec review",
            "Executing",
            "Owner review",
            "Approved",
            "Done",
          ].map((name, index) => ({ ...field.options?.[0], id: `status-${index}`, name })),
        }
      : field
  );
  enableWrites = false;
  deps: EventDeps = {
    pid: 1,
    readProc: () => proc(this.processStart),
    now: () => this.clock,
    exec: async () => {
      throw new Error("Unexpected exec");
    },
    sleep: async (ms) => {
      this.sleeps.push(ms);
      this.clock += ms;
    },
    report: (message) => {
      if (
        /^watcher: board pages items=\d+ labels=\d+ blockers=\d+ sub-issues=\d+ reviews=\d+; measured cost=\d+ points\/poll; interval=\d+s$/.test(
          message
        )
      ) {
        this.pollReports.push(message);
      } else {
        this.reports.push(message);
      }
    },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const route = url.pathname;
      this.requests.push(`${init?.method} ${url}`);
      if (this.requests.length > 1000) {
        throw new Error("Timeline exceeded request bound");
      }
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeDefined();
      let response: unknown;
      if (url.origin === "http://opencode.invalid") {
        expect(init?.method).toBe("GET");
        if (route === "/api/session/active") {
          response = this.active;
        } else if (route === "/api/session/ses_test") {
          response = {
            ...recordedOpencode.session.data,
            id: "ses_test",
            location: { directory: join(this.root, ".worktrees/auto-6-watch") },
          };
        } else if (route === "/api/session/ses_test/permission") {
          response = this.permissions;
        } else if (route === "/api/session/ses_test/message" && url.search === "?limit=20") {
          response = this.messages;
        } else {
          return this.unknown(url);
        }
        response = { data: response };
      } else if (url.origin === "https://api.github.com") {
        if (this.fail) {
          throw new Error("scripted transport failure");
        }
        if (route === "/graphql") {
          expect(init?.method).toBe("POST");
          const payload = JSON.parse(String(init?.body));
          if (
            payload.query === "query GatewayIdentity { viewer { databaseId login __typename } }"
          ) {
            return Response.json({ data: { viewer: actor(2) } });
          }
          const operation = parse(payload.query).definitions[0];
          expect(operation.kind).toBe(Kind.OPERATION_DEFINITION);
          if (
            operation.kind === Kind.OPERATION_DEFINITION &&
            ["WatchReviewThreads", "WatchReviewThreadComments"].includes(
              operation.name?.value ?? ""
            )
          ) {
            if (this.failReviewThreads) {
              throw new Error("scripted review-thread failure");
            }
            const comments = operation.name?.value === "WatchReviewThreadComments";
            if (!comments) {
              expect(payload.variables.owner).toBe("example");
              expect(payload.variables.name).toBe("project");
              this.reviewThreadReads.push(Number(payload.variables.number));
            }
            const pages = comments ? this.reviewCommentPages : this.reviewThreadPages;
            const index = payload.variables.cursor === null ? 0 : Number(payload.variables.cursor);
            const nodes = pages ? pages[index] : this.reviewThreads;
            if (!nodes) {
              return this.unknown(url);
            }
            const connection = {
              ...recordedThreads,
              nodes,
              pageInfo: {
                hasNextPage: pages ? index + 1 < pages.length : false,
                endCursor: String(index + 1),
              },
            };
            return Response.json({
              data: comments
                ? { node: { comments: connection } }
                : { repository: { pullRequest: { reviewThreads: connection } } },
            });
          }
          if (
            operation.kind === Kind.OPERATION_DEFINITION &&
            operation.name?.value === "ScopeNodes"
          ) {
            const nodes = (payload.variables.ids as string[]).map((id) => {
              const comment = this.scopeComments.find((comment) => comment.id === id);
              if (comment) {
                return comment;
              }
              const card = this.cards.find((card) => object(card.content).id === id);
              if (!card) {
                throw new Error(`Unknown scope node ${id}`);
              }
              return scopeIssue({ id, body: this.scopeBody });
            });
            return Response.json({ data: { nodes } });
          }
          if (
            operation.kind === Kind.OPERATION_DEFINITION &&
            operation.name?.value === "ScopeConnections"
          ) {
            const data: ObjectData = {};
            Object.keys(payload.variables)
              .filter((key) => key.startsWith("id"))
              .forEach((key) => {
                const id = payload.variables[key];
                if (!this.cards.some((card) => object(card.content).id === id)) {
                  throw new Error(`Unknown scope parent ${id}`);
                }
                const comments = String(payload.query).includes("comments(");
                data[`n${key.slice(2)}`] = scopeIssue({
                  id,
                  [comments ? "comments" : "timelineItems"]: scopeConnection(
                    comments
                      ? this.scopeComments
                      : (this.scopeTimeline ?? [
                          scopeMove({
                            previousStatus: "Scoping",
                            project: { number: object(this.config.board).number },
                          }),
                        ])
                  ),
                });
              });
            return Response.json({ data });
          }
          if (this.enableWrites && operation.kind === Kind.OPERATION_DEFINITION) {
            const name = operation.name?.value;
            const graph = (data: unknown) => new Response(JSON.stringify({ data }));
            if (name === "BoardProject") {
              return graph({ organization: { projectV2: { id: "project", readme: this.readme } } });
            }
            if (name === "BoardFields") {
              return graph({
                node: { fields: { nodes: this.fields, pageInfo: { hasNextPage: false } } },
              });
            }
            if (name === "BoardCards") {
              return graph({
                node: {
                  items: {
                    nodes: this.cards
                      .filter((card) => card.isArchived !== true)
                      .map((card) => this.boardCard(card)),
                    pageInfo: { hasNextPage: false },
                  },
                },
              });
            }
            if (name === "BoardRepositoryCards") {
              const repo = `${payload.variables.owner}/${payload.variables.name}`;
              const kind = String(payload.query).includes("pullRequests(first:")
                ? "PullRequest"
                : "Issue";
              const field = kind === "Issue" ? "issues" : "pullRequests";
              return graph({
                repository: {
                  [field]: {
                    nodes: this.cards
                      .filter((card) => {
                        const content = object(card.content);
                        return (
                          content.__typename === kind &&
                          object(content.repository).nameWithOwner === repo
                        );
                      })
                      .map((card) => ({
                        id: object(card.content).id,
                        projectItems: {
                          nodes: [this.boardCard(card)],
                          pageInfo: { hasNextPage: false },
                        },
                      })),
                    pageInfo: { hasNextPage: false },
                  },
                },
              });
            }
            if (name === "BoardItem") {
              const card = this.cards.find((card) => card.id === payload.variables.id);
              if (!card) {
                return this.unknown(url);
              }
              return graph({ node: this.boardCard(card) });
            }
            if (name === "BoardContent") {
              return graph({
                node: { __typename: "Issue", repository: { nameWithOwner: "example/project" } },
              });
            }
            if (name === "BoardContentItems") {
              const card = this.cards.find(
                (card) => object(card.content).id === payload.variables.id
              );
              return graph({
                node: {
                  projectItems: {
                    nodes: card ? [this.boardCard(card)] : [],
                    pageInfo: { hasNextPage: false },
                  },
                },
              });
            }
            if (name === "BoardAdd") {
              const card = this.cards.find(
                (card) => object(card.content).id === payload.variables.input.contentId
              );
              if (!card) {
                return this.unknown(url);
              }
              return graph({ addProjectV2ItemById: { item: { id: card.id } } });
            }
            if (name === "TaskReady") {
              return graph({
                markPullRequestReadyForReview: { pullRequest: { id: payload.variables.id } },
              });
            }
            if (name === "BoardSetCards") {
              const result: ObjectData = {};
              for (const [alias, raw] of Object.entries(payload.variables)) {
                const input = object(raw);
                const card = this.cards.find((card) => card.id === input.itemId);
                const field = this.fields.find((field) => field.id === input.fieldId);
                if (!card || !field) {
                  return this.unknown(url);
                }
                const value = object(input.value);
                const option = (Array.isArray(field.options) ? field.options : [])
                  .map(object)
                  .find((option) => option.id === value.singleSelectOptionId);
                const scalar = value.text ?? value.number ?? option?.name ?? null;
                this.writes.push({ itemId: card.id, field: field.name, value: scalar });
                if (field.name === "Status") {
                  card.status = { ...recordedActions.status, name: scalar, updatedAt: this.iso() };
                } else if (field.name === "Estimate") {
                  card.estimate = { number: scalar };
                } else if (field.name === "Progress") {
                  card.progress = { text: scalar };
                }
                result[alias] = { projectV2Item: { id: card.id } };
              }
              return graph(result);
            }
            if (name === "BoardPosition") {
              // One manual order per project; `afterId: null` is the top.
              const input = object(payload.variables.input);
              const index = this.cards.findIndex((card) => card.id === input.itemId);
              if (index < 0) {
                return this.unknown(url);
              }
              const [moved] = this.cards.splice(index, 1);
              if (input.afterId === null || input.afterId === undefined) {
                this.cards.unshift(moved);
              } else {
                const after = this.cards.findIndex((card) => card.id === input.afterId);
                if (after < 0) {
                  return this.unknown(url);
                }
                this.cards.splice(after + 1, 0, moved);
              }
              this.writes.push({ itemId: input.itemId, position: input.afterId ?? null });
              return graph({ BoardPosition: { clientMutationId: null } });
            }
          }
          if (
            operation.kind === Kind.OPERATION_DEFINITION &&
            operation.name?.value === "WatchAssignment"
          ) {
            return new Response(
              JSON.stringify({
                data: {
                  repository: {
                    item: {
                      timelineItems: {
                        nodes: this.assignmentEvents,
                        pageInfo: { hasNextPage: false },
                      },
                    },
                  },
                },
              })
            );
          }
          if (
            operation.kind === Kind.OPERATION_DEFINITION &&
            operation.name?.value === "WatchIssueClosers"
          ) {
            const pages = this.closingPrs[Number(payload.variables.number)] ?? [[]];
            const index = payload.variables.cursor === null ? 0 : Number(payload.variables.cursor);
            if (!pages[index]) {
              return this.unknown(url);
            }
            return new Response(
              JSON.stringify({
                data: {
                  repository: {
                    issue: {
                      closedByPullRequestsReferences: {
                        nodes: pages[index],
                        pageInfo: {
                          hasNextPage: index + 1 < pages.length,
                          endCursor: String(index + 1),
                        },
                      },
                    },
                  },
                },
              })
            );
          }
          if (
            operation.kind === Kind.OPERATION_DEFINITION &&
            operation.name?.value === "WatchBoardCurrent"
          ) {
            const card = this.cards.find((card) => card.id === payload.variables.id);
            if (!card) {
              return this.unknown(url);
            }
            const pages = this.boardTimeline[String(card.id)] ?? [[]];
            const index = payload.variables.cursor === null ? 0 : Number(payload.variables.cursor);
            if (!pages[index]) {
              return this.unknown(url);
            }
            return new Response(
              JSON.stringify({
                data: {
                  node: {
                    status: card.status,
                    ...(payload.variables.turn
                      ? {
                          progress: card.progress,
                          content: {
                            timelineItems: {
                              nodes: pages[index],
                              pageInfo: {
                                hasNextPage: index + 1 < pages.length,
                                endCursor: String(index + 1),
                              },
                            },
                          },
                        }
                      : {}),
                  },
                },
              })
            );
          }
          if (
            operation.kind !== Kind.OPERATION_DEFINITION ||
            operation.name?.value !== "WatchBoard"
          ) {
            return this.unknown(url);
          }
          if (this.boardPages) {
            // Scripted pagination: each entry serves one page's nodes; a null
            // entry fails that page's request like a transport error.
            expect(payload.variables).toEqual({
              owner: "example",
              number: 5,
              cursor: pageCursor(payload.variables.cursor),
            });
            const index = Number(payload.variables.cursor);
            const page = this.boardPages[index];
            if (page === undefined) {
              return this.unknown(url);
            }
            if (page === null) {
              throw new Error("scripted board page failure");
            }
            response = {
              data: {
                rateLimit: { cost: this.boardCost },
                organization: {
                  projectV2: {
                    id: "project",
                    readme: this.readme,
                    items: {
                      nodes: boardCards(page),
                      pageInfo: {
                        hasNextPage: index + 1 < this.boardPages.length,
                        endCursor: String(index + 1),
                      },
                    },
                  },
                },
              },
            };
          } else {
            expect(payload.variables).toEqual({
              owner: "example",
              number: 5,
              cursor: pageCursor(payload.variables.cursor),
            });
            let pageSize = 0;
            visit(parse(String(payload.query)), {
              Field(field) {
                if (field.name.value === "items") {
                  const first = field.arguments?.find((arg) => arg.name.value === "first")?.value;
                  if (first?.kind !== Kind.INT) {
                    throw new Error("Missing board page size");
                  }
                  pageSize = Number(first.value);
                }
              },
            });
            expect(pageSize).toBeGreaterThanOrEqual(10);
            expect(pageSize).toBeLessThanOrEqual(100);
            const cards = this.boardSnapshot ?? this.cards;
            const start = Number(payload.variables.cursor);
            response = this.queryError
              ? { errors: [{ message: "scripted invalid query" }] }
              : {
                  data: {
                    rateLimit: { cost: this.boardCost },
                    organization: {
                      projectV2: {
                        id: "project",
                        readme: this.readme,
                        items: {
                          nodes: boardCards(cards.slice(start, start + pageSize)),
                          pageInfo: {
                            hasNextPage: start + pageSize < cards.length,
                            endCursor: String(start + pageSize),
                          },
                        },
                      },
                    },
                  },
                };
          }
        } else {
          if ((this.enableWrites || route.endsWith("/assignees")) && init?.method !== "GET") {
            const body = object(JSON.parse(String(init?.body ?? "{}")));
            if (route === "/repos/example/project/pulls" && init?.method === "POST") {
              const card = this.card(27, "Backlog", "PullRequest");
              object(card.content).id = "pr";
              this.cards.push(card);
              this.pulls = [
                {
                  number: 27,
                  head: { ref: "8-task", sha },
                  base: { ref: "dev" },
                  created_at: this.iso(),
                  user: this.writeActor,
                },
              ];
              this.issues.push({ number: 27, pull_request: {}, labels: [] });
              return new Response(JSON.stringify({ number: 27, node_id: "pr" }));
            }
            if (route === "/repos/example/project/issues/27/labels" && init?.method === "POST") {
              return new Response("{}");
            }
            const match =
              /^\/repos\/example\/project\/(issues|pulls)\/(\d+)(?:\/(comments|assignees|merge))?$/.exec(
                route
              );
            const number = Number(match?.[2]);
            const card = this.cards.find((card) => object(card.content).number === number);
            if (!match || !card) {
              return this.unknown(url);
            }
            const content = object(card.content);
            const suffix = match[3];
            if (!suffix && match[1] === "pulls" && init?.method === "PATCH") {
              expect(typeof body.body).toBe("string");
              content.body = body.body;
              return new Response(JSON.stringify({ number, node_id: content.id, body: body.body }));
            }
            if (suffix === "comments" && init?.method === "POST") {
              const comment = {
                ...recordedComment,
                id: recordedComment.id + this.comments["example/project"].length,
                node_id: `${recordedComment.node_id}-${this.comments["example/project"].length}`,
                user: this.writeActor,
                body: body.body,
                issue_url: `https://api.github.com/repos/example/project/issues/${number}`,
                html_url: `https://github.com/example/project/pull/${number}#issuecomment-${recordedComment.id + this.comments["example/project"].length}`,
                created_at: this.iso().replace(/\.\d{3}Z$/, "Z"),
                updated_at: this.iso().replace(/\.\d{3}Z$/, "Z"),
              };
              this.comments["example/project"].push(comment);
              return new Response(JSON.stringify(comment));
            }
            if (suffix === "assignees" && ["POST", "DELETE"].includes(init?.method ?? "")) {
              const adding = init?.method === "POST";
              let assigned = (object(content.assignees).nodes as ObjectData[]).map((person) =>
                String(person.login)
              );
              for (const login of body.assignees as string[]) {
                assigned = adding
                  ? [...new Set([...assigned, login])]
                  : assigned.filter((entry) => entry !== login);
                this.assignmentEvents.push({
                  ...recordedActions.timelineItems.nodes[adding ? 0 : 1],
                  __typename: adding ? "AssignedEvent" : "UnassignedEvent",
                  createdAt: this.iso(),
                  actor: {
                    __typename: this.writeActor.type,
                    login: this.writeActor.login,
                    databaseId: this.writeActor.id,
                  },
                  assignee: { login, databaseId: login === "owner" ? 101 : 999 },
                });
              }
              content.assignees = { nodes: assigned.map((login) => ({ login })) };
              return new Response(
                JSON.stringify({ assignees: assigned.map((login) => ({ login })) })
              );
            }
            if (suffix === "merge" && init?.method === "PUT") {
              this.pulls = [];
              this.gone = {
                merged: true,
                merged_at: this.iso(),
                merged_by: this.writeActor,
                user: user(),
                state: "closed",
                closed_at: this.iso(),
              };
              content.state = "MERGED";
              return new Response(JSON.stringify({ merged: true }));
            }
            if (!suffix && init?.method === "PATCH" && body.state === "closed") {
              content.state = "CLOSED";
              content.closedAt = this.iso();
              content.closure = { nodes: [{ actor: { login: this.writeActor.login } }] };
              return new Response(JSON.stringify({ number, node_id: content.id, state: "closed" }));
            }
            return this.unknown(url);
          }
          expect(init?.method).toBe("GET");
          if (this.secondary) {
            this.secondary = false;
            return new Response("{}", { status: 429, headers: { "retry-after": "60" } });
          }
          if (route === "/user") {
            response = this.viewer;
          } else if (route === "/repos/example/project/pulls") {
            response = this.pulls;
          } else if (
            route === "/repos/example/project/issues" &&
            url.searchParams.has("assignee")
          ) {
            response = this.assigned["example/project"];
          } else if (
            route === "/repos/vworlds/vmethod/issues" &&
            url.searchParams.has("assignee")
          ) {
            response = this.assigned["vworlds/vmethod"];
          } else if (route === "/repos/example/project/issues") {
            response = this.issues;
          } else if (route === "/repos/vworlds/vmethod/issues") {
            response = this.newItems;
          } else if (route === "/repos/example/project/issues/comments") {
            response = this.comments["example/project"].filter(
              (c) =>
                Date.parse(String(c.updated_at)) >=
                Date.parse(String(url.searchParams.get("since")))
            );
          } else if (route === "/repos/vworlds/vmethod/issues/comments") {
            response = this.comments["vworlds/vmethod"];
          } else if (
            route === "/repos/example/project/pulls/24" ||
            route === "/repos/example/project/pulls/31" ||
            (this.enableWrites && /^\/repos\/example\/project\/pulls\/27$/.test(route))
          ) {
            response = this.pulls.length
              ? {
                  mergeable: this.mergeable,
                  mergeable_state: this.baseMoved ? "behind" : "clean",
                  base: { sha: "b".repeat(40) },
                }
              : this.gone;
          } else if (
            route === "/repos/example/project/pulls/24/commits" ||
            route === "/repos/example/project/pulls/31/commits" ||
            (this.enableWrites && route === "/repos/example/project/pulls/27/commits")
          ) {
            response = this.commits;
          } else if (
            route ===
            `/repos/example/project/commits/${String(object(this.pulls[0]?.head).sha)}/check-runs`
          ) {
            response = { check_runs: this.checks };
          } else if (
            route === "/repos/example/project/issues/24/comments" ||
            route === "/repos/example/project/issues/31/comments" ||
            (this.enableWrites && route === "/repos/example/project/issues/27/comments")
          ) {
            response = this.history;
          } else if (/^\/repos\/example\/project\/issues\/(?:6|7|8|24|27|37|39)$/.test(route)) {
            const matched = this.cards.find(
              (card) => object(card.content).number === Number(route.split("/").at(-1))
            );
            response = {
              ...(this.issues.find((i) => i.number === Number(route.split("/").at(-1))) ?? {
                title: "Card title",
                labels: [],
              }),
              ...(this.enableWrites
                ? {
                    assignees: object(object(matched?.content).assignees).nodes,
                    node_id: object(matched?.content).id,
                  }
                : {}),
            };
          } else if (
            /^\/repos\/example\/project\/issues\/(?:6|7|8)\/dependencies\/blocked_by$/.test(route)
          ) {
            response = this.blockers;
          } else {
            return this.unknown(url);
          }
        }
      } else {
        return this.unknown(url);
      }
      return new Response(JSON.stringify(response), {
        headers: route === "/graphql" ? this.headers : {},
      });
    },
  };
  boardCard(card: ObjectData): ObjectData {
    return {
      id: card.id,
      isArchived: card.isArchived === true,
      project: { id: "project" },
      content: { ...object(card.content), closedAt: null },
      fieldValues: {
        nodes: this.fields.map((field) => ({
          field: { name: field.name },
          ...(field.name === "Status"
            ? { name: object(card.status).name }
            : field.name === "Estimate"
              ? { number: object(card.estimate).number }
              : { text: object(card.progress).text }),
        })),
        pageInfo: { hasNextPage: false },
      },
    };
  }
  /** Mirror successful wire effects independently of the journal. Canned gateway
   * fixtures still validate every request; watch reads this resulting API state.
   */
  attachWriter(
    writer: { root: string; env: NodeJS.ProcessEnv; deps: Dependencies },
    stateName = "example-state"
  ): void {
    this.root = writer.root;
    this.env = { ...this.env, ...writer.env };
    this.config.stateName = stateName;
    this.config.vmethod = { repo: "off" };
    this.dir = join(String(writer.env.XDG_STATE_HOME), "vmethod", stateName);
    this.clock = writer.deps.now();
    this.fields = structuredClone(recordedBoard.fields.nodes);
    const fetch = writer.deps.fetch;
    writer.deps.fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (!response.ok || init?.method === "GET") {
        return response;
      }
      const url = new URL(String(input));
      const body = object(JSON.parse(String(init?.body ?? "{}")));
      const result = object(await response.clone().json());
      if (url.pathname === "/graphql") {
        const operation = parse(String(body.query)).definitions[0];
        if (
          operation.kind === Kind.OPERATION_DEFINITION &&
          operation.operation === "mutation" &&
          operation.name?.value === "BoardSetCards" &&
          !result.errors
        ) {
          for (const raw of Object.values(object(body.variables))) {
            const mutation = object(raw);
            const card = this.cards.find((card) => card.id === mutation.itemId);
            const field = this.fields.find((field) => field.id === mutation.fieldId);
            if (!card || !field) {
              throw new Error("Unmapped recorded board write in watch mirror");
            }
            const value = object(mutation.value);
            const option = (Array.isArray(field.options) ? field.options : [])
              .map(object)
              .find((option) => option.id === value.singleSelectOptionId);
            const scalar = value.number ?? value.text ?? option?.name ?? null;
            if (field.name === "Status") {
              card.status = { ...recordedActions.status, name: scalar, updatedAt: this.iso() };
            } else if (field.name === "Estimate") {
              card.estimate = { number: scalar };
            }
          }
        }
      } else if (/\/issues$/.test(url.pathname) && init?.method === "POST") {
        const number = Number(result.number);
        const card = this.card(number);
        card.id = recordedBoard.items.nodes[0].id;
        object(card.content).id = result.node_id;
        this.cards.push(card);
        this.issues.push({ number, labels: [] });
      } else if (
        /\/issues\/\d+$/.test(url.pathname) &&
        ["closed", "open"].includes(String(body.state))
      ) {
        const number = Number(url.pathname.split("/").at(-1));
        const card = this.cards.find((card) => object(card.content).number === number);
        if (!card) {
          throw new Error("Unmapped recorded issue closure in watch mirror");
        }
        object(card.content).state = body.state === "closed" ? "CLOSED" : "OPEN";
        object(card.content).closedAt = body.state === "closed" ? this.iso() : null;
        object(card.content).closure = {
          nodes: body.state === "closed" ? [{ actor: { login: this.writeActor.login } }] : [],
        };
      } else if (
        /\/repos\/vworlds\/vmethod\/pulls$/.test(url.pathname) &&
        init?.method === "POST"
      ) {
        this.newItems.push({
          number: result.number,
          created_at: this.iso(),
          user: result.user,
          pull_request: {},
          html_url: `https://github.com/vworlds/vmethod/pull/${result.number}`,
        });
      }
      return response;
    };
  }
  unknown(url: URL): never {
    this.unexpected.push(String(url));
    throw new Error(`Unexpected request ${url}`);
  }
  /** Overrides the worker checkout's registered task worktrees for the next loops. */
  workerTrees?: () => Promise<{ path: string; branch: string }[]>;
  loop(input: SessionInput = {}): EventLoop {
    const digest = new Digest(this.env, "watch-test", this.deps.now);
    const ordering = new BoardService(
      this.config,
      new GitHubClient(this.config, this.env, this.deps),
      this.deps
    );
    const loop = new EventLoop(
      {
        root: this.root,
        env: this.env,
        config: this.config,
        deps: this.deps,
        filter: new PeopleFilter(this.watchPeople, "example", digest, ["vworlds/vmethod"]),
        digest,
        github: new GitHubClient(this.config, this.env, this.deps),
        // Directories under <root>/.worktrees stand in for the worker checkout's
        // registered task worktrees, named <prefix><branch>.
        workerTrees: async () => {
          if (this.workerTrees) {
            return this.workerTrees();
          }
          const parent = join(this.root, ".worktrees");
          const prefix = String(object(this.config.branches).worktreePrefix ?? "auto-");
          return existsSync(parent)
            ? readdirSync(parent).map((name) => ({
                path: join(parent, name),
                branch: name.startsWith(prefix) ? name.slice(prefix.length) : name,
              }))
            : [];
        },
        workerStatus: async (pr) => {
          this.staleWorkerReads.push(pr);
          if (this.workerStatus) {
            return this.workerStatus(pr);
          }
          if (this.staleWorker instanceof Error) {
            throw this.staleWorker;
          }
          return this.staleWorker;
        },
        workerLimits: this.workerLimits,
        workerSend: async (pr, text) => {
          this.workerSends.push({ pr, text });
        },
        workerMetric: async (pr, event) => {
          this.workerMetrics.push({ pr, event });
        },
        resolveConflicts: this.resolveConflicts,
        conflictPending: this.conflictPending,
        conflictFixing: this.conflictFixing,
        board: {
          orderExecuting: async (cards, activity, _projectId, nodes) => {
            await ordering.orderExecuting(cards, activity, "project", nodes);
          },
          set: async (input) => {
            if (this.failSet) {
              throw new Error("scripted Progress write failure");
            }
            this.writes.push(input);
            const card = this.cards.find((c) => c.id === input.itemId)!;
            if (input.field === "Status") {
              card.status = { name: input.value };
              card.progress = { text: input.progress };
            } else if (input.field === "Cost") {
              card.cost = { number: input.value };
            } else {
              card.progress = { text: input.value };
            }
            return "updated";
          },
          moveToTop: async (itemId) => {
            const index = this.cards.findIndex((card) => card.id === itemId);
            if (index > 0) {
              const [moved] = this.cards.splice(index, 1);
              this.cards.unshift(moved);
            }
            this.orders.push({ itemId, afterId: null });
          },
        },
      },
      input
    );
    this.loops.push(loop);
    return loop;
  }
  task(): void {
    this.pulls = [
      {
        number: 24,
        title: "Card title",
        head: { ref: "6-watch", sha },
        base: { ref: "dev" },
        created_at: this.iso(-60_000),
        user: user(),
      },
    ];
    this.issues = [
      { number: 6, labels: [] },
      { number: 24, pull_request: {}, body: "Part of #6", labels: [] },
    ];
    this.cards = [this.card(24, "Executing", "PullRequest")];
  }
  card(number = 6, status = "Backlog", kind = "Issue", overrides: ObjectData = {}): ObjectData {
    return {
      id: `PVTI_${number}`,
      status: { ...recordedActions.status, name: status, updatedAt: this.iso() },
      estimate: { number: 3 },
      progress: { text: kind === "Issue" ? "" : "🤖🔨 🔁2️⃣" },
      content: {
        __typename: kind,
        id: `content-${number}`,
        number,
        state: "OPEN",
        title: "Card title",
        author: actor(1),
        repository: { nameWithOwner: "example/project", owner: { login: "example" } },
        assignees: { nodes: [] },
        labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        ...(kind === "Issue"
          ? {
              blockedBy: {
                nodes: [],
                totalCount: 0,
                pageInfo: { hasNextPage: false, endCursor: null },
              },
              subIssues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            }
          : {
              body: "",
              closingIssuesReferences: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
              reviews: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            }),
      },
      ...overrides,
    };
  }
  comment(body: string, index = 1, id = this.comments["example/project"].length + 1): ObjectData {
    const value = {
      ...recordedComment,
      id,
      node_id: `${recordedComment.node_id}-${id}`,
      body,
      user: user(index),
      issue_url: "https://api.github.com/repos/example/project/issues/24",
      html_url: `https://github.com/example/project/pull/24#issuecomment-${id}`,
      created_at: this.iso(),
      updated_at: this.iso(),
    };
    this.comments["example/project"].push(value);
    return value;
  }
  iso(offset = 0): string {
    return new Date(this.clock + offset).toISOString();
  }
  advance(ms = 60_000): void {
    this.clock += ms;
  }
  async tick(loop: EventLoop) {
    return (await loop.nextEvents({ timeoutSeconds: 1 })).events;
  }
  async once(loop: EventLoop): Promise<WatchEvent[]> {
    const events: WatchEvent[] = [];
    let reminders = 0;
    const printed: string[] = [];
    await watchClient(
      {
        call: async (operation, input) => {
          if (operation !== "nextEvents") {
            throw new Error(`Unexpected watch operation ${operation}`);
          }
          const batch = await loop.nextEvents(input as Operations["nextEvents"]["input"]);
          if ((input as Operations["nextEvents"]["input"]).pollOnce) {
            events.push(...batch.events);
            if (batch.reminder) {
              reminders++;
            }
          }
          return batch as never;
        },
      },
      ["--once"],
      { VMETHOD_ROLE: "orchestrator" },
      async (line) => {
        printed.push(line);
      }
    );
    expect(printed.filter((line) => !line.startsWith("vmethod "))).toHaveLength(
      events.length + reminders
    );
    return events;
  }
  async ack(loop: EventLoop, events: { id: string }[]) {
    await loop.nextEvents({ timeoutSeconds: 0, ack: events.map((e) => e.id) });
  }
  worktree(): void {
    mkdirSync(join(this.root, ".worktrees/auto-6-watch"), { recursive: true });
    this.active = { ses_test: true };
  }
  marker(name: string): string {
    return readFileSync(join(this.dir, name), "utf8").trim();
  }
  done(): void {
    for (const loop of this.loops) {
      loop.close();
    }
    expect(this.unexpected).toEqual([]);
  }
}
