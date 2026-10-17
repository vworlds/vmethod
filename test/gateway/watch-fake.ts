import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { parse, Kind } from "graphql";
import type { Config } from "../../src/config.js";
import { EventLoop, type EventDeps, type SessionInput } from "../../src/gateway/events.js";
import { GitHubClient } from "../../src/gateway/client.js";
import { Digest } from "../../src/gateway/digest.js";
import { PeopleFilter, object, type ObjectData } from "../../src/gateway/people.js";
import { fixture } from "../helpers.js";
import { actor, people, sha } from "./helpers.js";

export function proc(start = 42): string {
  return `1 (worker (with spaces)) S ${Array(18).fill("0").join(" ")} ${start} 0`;
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
    credentials: { githubToken: "TOKEN" },
    gateway: { maxRetries: 0 },
  };
  env = {
    XDG_STATE_HOME: join(this.root, "state"),
    TOKEN: "fake-secret",
    OPENCODE_BASE_URL: "http://opencode.invalid",
    OPENCODE_SERVER_USERNAME: "fake",
    OPENCODE_SERVER_PASSWORD: "fake",
  };
  dir = join(this.env.XDG_STATE_HOME, "vmethod", "watch-test");
  pulls: ObjectData[] = [];
  issues: ObjectData[] = [];
  comments: Record<string, ObjectData[]> = { "example/project": [], "vworlds/vmethod": [] };
  assigned: Record<string, ObjectData[]> = { "example/project": [], "vworlds/vmethod": [] };
  newItems: ObjectData[] = [];
  cards: ObjectData[] = [];
  readme = "";
  mergeable: boolean | null = true;
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
  sleeps: number[] = [];
  writes: ObjectData[] = [];
  loops: EventLoop[] = [];
  processStart = 42;
  legacyBatches: number[][] = [];
  legacyItems = new Map<number, string>([
    [6, "Issue"],
    [24, "PullRequest"],
  ]);
  legacyError = false;
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
    report: (message) => this.reports.push(message),
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
          response = { location: { directory: join(this.root, ".worktrees/auto-6-watch") } };
        } else if (route === "/api/session/ses_test/permission") {
          response = this.permissions;
        } else if (route === "/api/session/ses_test/message" && url.search === "?limit=20") {
          response = this.messages;
        } else {
          return this.unknown(url);
        }
      } else if (url.origin === "https://api.github.com") {
        if (this.fail) {
          throw new Error("scripted transport failure");
        }
        if (route === "/graphql") {
          expect(init?.method).toBe("POST");
          const payload = JSON.parse(String(init?.body));
          const operation = parse(payload.query).definitions[0];
          expect(operation.kind).toBe(Kind.OPERATION_DEFINITION);
          if (
            operation.kind === Kind.OPERATION_DEFINITION &&
            operation.name?.value === "WatchLegacy"
          ) {
            expect(payload.variables).toEqual({ owner: "example", name: "project" });
            const repository = operation.selectionSet.selections[0];
            expect(repository.kind).toBe(Kind.FIELD);
            if (repository.kind !== Kind.FIELD || !repository.selectionSet) {
              return this.unknown(url);
            }
            const batch = repository.selectionSet.selections.map((field) => {
              expect(field.kind).toBe(Kind.FIELD);
              if (field.kind !== Kind.FIELD) {
                throw new Error("Expected legacy lookup field");
              }
              expect(field.name.value).toBe("issueOrPullRequest");
              const number = field.arguments?.find((arg) => arg.name.value === "number")?.value;
              if (number?.kind !== Kind.INT) {
                throw new Error("Expected integer number");
              }
              expect(field.alias?.value).toBe(`n${number.value}`);
              return Number(number.value);
            });
            this.legacyBatches.push(batch);
            // GitHub issueOrPullRequest projects number/type/repository; missing numbers
            // return null plus a NOT_FOUND error at the aliased field path.
            const errors = batch
              .filter((number) => !this.legacyItems.has(number))
              .map((number) => ({
                type: "NOT_FOUND",
                path: ["repository", `n${number}`],
                message: `Could not resolve to an Issue or PullRequest with the number of ${number}.`,
              }));
            return new Response(
              JSON.stringify({
                data: {
                  repository: Object.fromEntries(
                    batch.map((number) => [
                      `n${number}`,
                      this.legacyItems.has(number)
                        ? {
                            __typename: this.legacyItems.get(number),
                            number,
                            repository: { nameWithOwner: "example/project" },
                          }
                        : null,
                    ])
                  ),
                },
                ...(this.legacyError
                  ? { errors: [{ type: "FORBIDDEN", message: "Resource not accessible" }] }
                  : errors.length
                    ? { errors }
                    : {}),
              }),
              { headers: this.headers }
            );
          }
          if (
            operation.kind !== Kind.OPERATION_DEFINITION ||
            operation.name?.value !== "WatchBoard"
          ) {
            return this.unknown(url);
          }
          expect(payload.variables).toEqual({ owner: "example", number: 5, cursor: null });
          response = this.queryError
            ? { errors: [{ message: "scripted invalid query" }] }
            : {
                data: {
                  organization: {
                    projectV2: {
                      id: "project",
                      readme: this.readme,
                      items: { nodes: this.cards, pageInfo: { hasNextPage: false } },
                    },
                  },
                },
              };
        } else {
          expect(init?.method).toBe("GET");
          if (this.secondary) {
            this.secondary = false;
            return new Response("{}", { status: 429, headers: { "retry-after": "60" } });
          }
          if (route === "/user") {
            response = { login: "me", id: 999 };
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
              (c) => String(c.updated_at) >= String(url.searchParams.get("since"))
            );
          } else if (route === "/repos/vworlds/vmethod/issues/comments") {
            response = this.comments["vworlds/vmethod"];
          } else if (route === "/repos/example/project/pulls/24") {
            response = this.pulls.length ? { mergeable: this.mergeable } : this.gone;
          } else if (route === "/repos/example/project/pulls/24/commits") {
            response = this.commits;
          } else if (
            route ===
            `/repos/example/project/commits/${String(object(this.pulls[0]?.head).sha)}/check-runs`
          ) {
            response = { check_runs: this.checks };
          } else if (route === "/repos/example/project/issues/24/comments") {
            response = this.history;
          } else if (/^\/repos\/example\/project\/issues\/(?:6|7|8|24)$/.test(route)) {
            response = this.issues.find((i) => i.number === Number(route.split("/").at(-1))) ?? {
              title: "Card title",
              labels: [],
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
  unknown(url: URL): never {
    this.unexpected.push(String(url));
    throw new Error(`Unexpected request ${url}`);
  }
  loop(input: SessionInput = {}): EventLoop {
    const digest = new Digest(this.env, "watch-test", this.deps.now);
    const loop = new EventLoop(
      {
        root: this.root,
        env: this.env,
        config: this.config,
        deps: this.deps,
        filter: new PeopleFilter(people, "example", digest, ["vworlds/vmethod"]),
        digest,
        github: new GitHubClient(this.config, this.env, this.deps),
        board: {
          set: async (input) => {
            if (this.failSet) {
              throw new Error("scripted Progress write failure");
            }
            this.writes.push(input);
            const card = this.cards.find((c) => c.id === input.itemId)!;
            if (input.field === "Status") {
              card.status = { name: input.value };
              card.progress = { text: input.progress };
            } else {
              card.progress = { text: input.value };
            }
            return "updated";
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
    this.cards = [this.card(24, "In progress", "PullRequest")];
  }
  card(number = 6, status = "Backlog", kind = "Issue", overrides: ObjectData = {}): ObjectData {
    return {
      id: `PVTI_${number}`,
      status: { name: status },
      estimate: { number: 3 },
      progress: { text: "🤖🔨 🔁2️⃣" },
      content: {
        __typename: kind,
        number,
        state: "OPEN",
        title: "Card title",
        author: actor(1),
        repository: { nameWithOwner: "example/project", owner: { login: "example" } },
        assignees: { nodes: [] },
      },
      ...overrides,
    };
  }
  comment(body: string, index = 1, id = this.comments["example/project"].length + 1): ObjectData {
    const value = {
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
