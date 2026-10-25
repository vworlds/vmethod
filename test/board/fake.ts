import { expect } from "vitest";
import { fixture } from "../helpers.js";
import { Kind, parse } from "graphql";
import { BoardService } from "../../src/gateway/board.js";
import { GitHubClient, type Dependencies } from "../../src/gateway/client.js";
import { readState, writeState } from "../../src/board/readme.js";
import { loadMigrations } from "../../src/board/migrations.js";
import { object, type ObjectData } from "../../src/gateway/people.js";
import type { Card, Field, Migration, Option } from "../../src/board/types.js";

const connection = (nodes: unknown[]) => ({
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null },
});
export const baseline = loadMigrations()[0];

/** A stateful server reached only through injected fetch. Unknown requests are
 * recorded independently of client retries so a caught exception cannot hide one. */
export class FakeBoard {
  // Each fake owns its journal too; parallel suites must never touch real user state.
  private readonly state = fixture();
  clock = Date.UTC(2026, 9, 16);
  readme = "Human notes\n";
  fields: Field[] = Object.entries(baseline.expect.fields).map(([name, shape], index) => ({
    id: `field-${index}`,
    name,
    createdAt: Date.UTC(2026, 0, 1),
    type: shape.type,
    options: (shape.options ?? []).map((name, option) => ({
      id: `option-${index}-${option}`,
      name: typeof name === "string" ? name : name.name,
      color: "GRAY",
      description: "",
    })),
  }));
  cards: Card[] = [];
  reports: string[] = [];
  announcements: string[] = [];
  requests: string[] = [];
  mutations: string[] = [];
  unexpected: string[] = [];
  sleeps: number[] = [];
  files = new Map<string, string>();
  refs = new Map<string, string[]>();
  dropCreate = false;
  raceCreate = false;
  failMove = false;
  /** Whether the next position mutation fails, exercising the best-effort report. */
  failOrder = false;
  ignoreMoves = false;
  dropOptions = false;
  corruptOptions = false;
  failExpect = false;
  budgetAfterBatch = false;
  low = false;
  stealBeforeBump = false;
  pageSize = 100;
  recordedFields?: ObjectData;
  failBatch = 0;
  batches = 0;
  editsBeforeReadme = false;
  counter = 0;
  config = {
    repo: "example/project",
    org: "example",
    baseBranch: "dev",
    board: {
      owner: "example",
      number: 5,
      repos: ["example/project"] as string[],
      announce: undefined as string | undefined,
    },
    credentials: { githubToken: "FAKE_TOKEN" },
    gateway: { maxRetries: 0 },
  };
  deps: Dependencies = {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://api.github.com");
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeDefined();
      if (url.pathname !== "/graphql") {
        return this.rest(url, init);
      }
      expect(init?.method).toBe("POST");
      const payload = JSON.parse(String(init?.body)) as {
        query: string;
        variables: ObjectData;
      };
      const document = parse(payload.query);
      const definition = document.definitions[0];
      if (
        document.definitions.length !== 1 ||
        definition.kind !== Kind.OPERATION_DEFINITION ||
        !definition.name
      ) {
        return this.unknown(payload.query);
      }
      const name = definition.name.value;
      this.requests.push(name);
      if (definition.operation === "mutation") {
        this.mutations.push(name);
      }
      const variables = payload.variables;
      const arg = object(variables.input);
      let data: ObjectData;
      switch (name) {
        case "BoardProject":
          expect(variables).toEqual({ owner: "example", number: 5 });
          if (this.editsBeforeReadme) {
            this.readme = this.readme.replace("Human notes", "Human notes updated");
            this.editsBeforeReadme = false;
          }
          data = {
            organization: { projectV2: { id: "project", readme: this.readme } },
          };
          break;
        case "BoardFields":
          expect(variables.id).toBe("project");
          data = this.recordedFields ?? {
            node: {
              fields: this.page(
                this.fields.map((field) => ({
                  id: field.id,
                  name: field.name,
                  createdAt: new Date(field.createdAt).toISOString(),
                  dataType: field.type.toUpperCase(),
                  ...(field.type === "single_select" ? { options: field.options } : {}),
                })),
                variables.cursor
              ),
            },
          };
          break;
        case "BoardViewer":
          data = { viewer: { login: "migrator" } };
          break;
        case "BoardCreateField": {
          expect(arg.projectId).toBe("project");
          // A concurrent winner lands between this run's snapshot and its
          // create: the create must then fail with the name taken.
          if (this.raceCreate) {
            this.raceCreate = false;
            this.fields.push({
              id: `raced-${++this.counter}`,
              name: String(arg.name),
              createdAt: this.clock,
              type: "text",
              options: [],
            });
          }
          if (this.fields.some((field) => field.name === arg.name)) {
            return this.error("Name already taken");
          }
          const id = `new-${++this.counter}`;
          this.fields.push({
            id,
            name: String(arg.name),
            createdAt: this.clock,
            type: String(arg.dataType).toLowerCase() as Field["type"],
            options: Array.isArray(arg.singleSelectOptions)
              ? arg.singleSelectOptions.map(
                  (option, index) =>
                    ({
                      ...object(option),
                      id: `${id}-${index}`,
                    }) as unknown as Option
                )
              : [],
          });
          if (this.dropCreate) {
            this.dropCreate = false;
            throw new Error("Lost create response");
          }
          data = { createProjectV2Field: { projectV2Field: { id } } };
          break;
        }
        case "BoardReadme":
          expect(arg.projectId).toBe("project");
          this.readme = String(arg.readme);
          data = { updateProjectV2: { projectV2: { id: "project" } } };
          break;
        case "BoardDeleteField": {
          // Real DeleteProjectV2FieldPayload has only clientMutationId and projectV2Field.
          const selected = /deleteProjectV2Field\([^)]*\)\s*\{([^}]*)\}/.exec(
            String(payload.query)
          );
          const unknown = (selected?.[1] ?? "")
            .split(/\s+/)
            .filter((name) => name && !["clientMutationId", "projectV2Field"].includes(name));
          if (unknown.length) {
            return this.error(
              `Field '${unknown[0]}' doesn't exist on type 'DeleteProjectV2FieldPayload'`
            );
          }
          const field = this.fields.find((field) => field.id === arg.fieldId);
          if (!field) {
            return this.error("Field missing");
          }
          this.fields = this.fields.filter((entry) => entry !== field);
          data = { deleteProjectV2Field: { clientMutationId: null } };
          break;
        }
        case "BoardOptions": {
          const field = this.fields.find((field) => field.id === arg.fieldId);
          if (!field || !Array.isArray(arg.singleSelectOptions)) {
            return this.unknown(payload.query);
          }
          const previous = field.options;
          field.options = arg.singleSelectOptions.map((value) => {
            const option = object(value);
            if (option.id !== undefined) {
              expect(previous.some(({ id }) => id === option.id)).toBe(true);
            }
            return {
              id: typeof option.id === "string" ? option.id : `new-option-${++this.counter}`,
              name: String(option.name),
              color: String(option.color),
              description: String(option.description),
            };
          });
          // GitHub retains values only for retained IDs; no ID creates a new option.
          for (const card of this.cards) {
            const old = previous.find(({ name }) => name === card.values[field.name]);
            card.values[field.name] = this.corruptOptions
              ? null
              : (field.options.find(({ id }) => id === old?.id)?.name ?? null);
          }
          if (this.dropOptions) {
            this.dropOptions = false;
            throw new Error("Lost options response");
          }
          if (this.failExpect) {
            field.options.reverse();
          }
          data = { updateProjectV2Field: { projectV2Field: { id: field.id } } };
          break;
        }
        case "BoardCards":
          expect(variables.id).toBe("project");
          data = {
            node: {
              items: this.page(
                this.cards.map((card) => ({
                  id: card.id,
                  fieldValues: this.values(card),
                  content: {
                    __typename: card.kind,
                    id: card.contentId,
                    number: card.number,
                    closedAt: card.closedAt,
                    repository: card.repo ? { nameWithOwner: card.repo } : null,
                    assignees: connection(card.assignees.map((login) => ({ login }))),
                  },
                })),
                variables.cursor
              ),
            },
          };
          break;
        case "BoardItem": {
          const card = this.cards.find((card) => card.id === variables.id);
          data = {
            node: card
              ? {
                  id: card.id,
                  project: { id: "project" },
                  fieldValues: this.values(card),
                  content: {
                    __typename: card.kind,
                    repository: card.repo ? { nameWithOwner: card.repo } : null,
                    assignees: connection(card.assignees.map((login) => ({ login }))),
                  },
                }
              : null,
          };
          break;
        }
        case "BoardValues": {
          const card = this.cards.find((card) => card.id === variables.id);
          if (!card) {
            return this.unknown(payload.query);
          }
          data = { node: { fieldValues: this.values(card, variables.cursor) } };
          break;
        }
        case "BoardSetCards": {
          this.batches++;
          if (this.failMove || this.batches === this.failBatch) {
            this.failMove = false;
            return this.error("Interrupted move");
          }
          data = {};
          for (const selection of definition.selectionSet.selections) {
            if (
              selection.kind !== Kind.FIELD ||
              !["updateProjectV2ItemFieldValue", "clearProjectV2ItemFieldValue"].includes(
                selection.name.value
              )
            ) {
              return this.unknown(payload.query);
            }
            const alias = selection.alias?.value;
            const input = object(variables[String(alias)]);
            expect(input.projectId).toBe("project");
            const card = this.cards.find((card) => card.id === input.itemId);
            const field = this.fields.find((field) => field.id === input.fieldId);
            if (!card || !field) {
              return this.unknown(payload.query);
            }
            if (card.archived) {
              return this.error("The item is archived and cannot be updated");
            }
            const value = object(input.value);
            if (!this.ignoreMoves) {
              card.values[field.name] =
                selection.name.value === "clearProjectV2ItemFieldValue"
                  ? null
                  : field.type === "single_select"
                    ? (field.options.find((option) => option.id === value.singleSelectOptionId)
                        ?.name ?? null)
                    : ((value.text ?? value.number) as string | number);
            }
            data[String(alias)] = { projectV2Item: { id: card.id } };
          }
          if (this.budgetAfterBatch) {
            this.budgetAfterBatch = false;
            this.low = true;
          }
          if (this.stealBeforeBump) {
            const state = readState(this.readme);
            state.lock = "other-run rival since 2026-10-16T00:00:00.000Z";
            this.readme = writeState(this.readme, state);
          }
          break;
        }
        case "BoardPosition": {
          // GitHub keeps one manual order per project: `afterId: null` is the top.
          expect(arg.projectId).toBe("project");
          expect(arg.itemId).toBeTypeOf("string");
          if (this.failOrder) {
            this.failOrder = false;
            return this.error("Interrupted order update");
          }
          const index = this.cards.findIndex((card) => card.id === arg.itemId);
          if (index < 0) {
            return this.unknown(payload.query);
          }
          const [moved] = this.cards.splice(index, 1);
          if (arg.afterId === null || arg.afterId === undefined) {
            this.cards.unshift(moved);
          } else {
            const after = this.cards.findIndex((card) => card.id === arg.afterId);
            if (after < 0) {
              return this.unknown(payload.query);
            }
            this.cards.splice(after + 1, 0, moved);
          }
          data = { BoardPosition: { clientMutationId: null } };
          break;
        }
        case "BoardArchive": {
          expect(arg.projectId).toBe("project");
          this.cards = this.cards.filter((card) => card.id !== arg.itemId);
          data = { archiveProjectV2Item: { item: { id: arg.itemId } } };
          break;
        }
        case "BoardContent": {
          const card = this.cards.find((card) => card.contentId === variables.id);
          data = {
            node: card ? { __typename: card.kind, repository: { nameWithOwner: card.repo } } : null,
          };
          break;
        }
        case "BoardContentItems": {
          const card = this.cards.find((card) => card.contentId === variables.id);
          data = {
            node: card
              ? {
                  projectItems: {
                    nodes: [
                      {
                        id: card.id,
                        isArchived: false,
                        project: { id: "project" },
                        fieldValues: this.values(card),
                        content: {
                          __typename: card.kind,
                          id: card.contentId,
                          repository: { nameWithOwner: card.repo },
                          assignees: connection(card.assignees.map((login) => ({ login }))),
                        },
                      },
                    ],
                    pageInfo: { hasNextPage: false },
                  },
                }
              : { projectItems: { nodes: [], pageInfo: { hasNextPage: false } } },
          };
          break;
        }
        case "BoardAdd": {
          expect(arg.projectId).toBe("project");
          const card = this.cards.find((card) => card.contentId === arg.contentId);
          if (!card) {
            return this.unknown(payload.query);
          }
          data = { addProjectV2ItemById: { item: { id: card.id } } };
          break;
        }
        case "BoardWorkflows":
          data = {
            node: {
              workflows: connection([
                { name: "Item closed → Done", enabled: true },
                { name: "Disabled", enabled: false },
              ]),
            },
          };
          break;
        default:
          return this.unknown(payload.query);
      }
      return Response.json(
        { data },
        {
          headers: this.low
            ? {
                "x-ratelimit-remaining": "101",
                "x-ratelimit-reset": String(this.clock / 1000 + 3600),
              }
            : {},
        }
      );
    },
    exec: async () => {
      throw new Error("Unexpected exec");
    },
    now: () => this.clock,
    sleep: async (ms) => {
      this.sleeps.push(ms);
      this.clock += ms;
      this.low = false;
    },
    report: (message) => {
      this.reports.push(message);
    },
  };
  private unknown(request: string): never {
    this.unexpected.push(request);
    throw new Error(`Unexpected fake request ${request}`);
  }
  private page(values: unknown[], cursor?: unknown) {
    const offset = cursor === null || cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      return this.unknown(`cursor ${String(cursor)}`);
    }
    const end = offset + this.pageSize;
    return {
      nodes: values.slice(offset, end),
      pageInfo: {
        hasNextPage: end < values.length,
        endCursor: end < values.length ? String(end) : null,
      },
    };
  }
  private values(card: Card, cursor?: unknown) {
    return this.page(
      Object.entries(card.values).map(([name, value]) => ({
        field: { name },
        ...(this.fields.find((field) => field.name === name)?.type === "single_select"
          ? { name: value }
          : typeof value === "number"
            ? { number: value }
            : { text: value }),
      })),
      cursor
    );
  }
  private error(message: string): Response {
    return Response.json({ errors: [{ message }] });
  }
  private rest(url: URL, init?: RequestInit): Response {
    this.requests.push(url.pathname + url.search);
    if (init?.method === "POST" && url.pathname === "/repos/example/project/issues/9/comments") {
      this.announcements.push(String(object(JSON.parse(String(init.body))).body));
      return Response.json({ id: 1 });
    }
    if (init?.method !== "GET") {
      return this.unknown(String(url));
    }
    const repo = /^\/repos\/(example\/[^/]+)$/.exec(url.pathname);
    if (repo) {
      return Response.json({ default_branch: "master" });
    }
    const file = /^\/repos\/(example\/[^/]+)\/contents\/(.+)$/.exec(url.pathname);
    if (file) {
      const key = `${file[1]}@${url.searchParams.get("ref")}:${file[2]}`;
      const content = this.files.get(key);
      if (content === undefined) {
        return this.unknown(key);
      }
      return Response.json({
        encoding: "base64",
        content: Buffer.from(content).toString("base64"),
      });
    }
    const refs = /^\/repos\/(example\/[^/]+)\/git\/matching-refs\/heads\/(.+)$/.exec(url.pathname);
    if (refs) {
      return Response.json(
        (this.refs.get(`${refs[1]}:${decodeURIComponent(refs[2])}`) ?? []).map((ref) => ({
          ref: `refs/heads/${ref}`,
        }))
      );
    }
    return this.unknown(String(url));
  }
  stamp(version: number, minCompatible = 0): void {
    this.readme = writeState("Human notes\n", { version, minCompatible, aliases: {} }, true);
  }
  card(id = "card", repo = "example/project"): Card {
    const card = {
      id,
      repo,
      kind: "Issue",
      assignees: ["owner"],
      values: {
        Status: "Backlog",
        Estimate: 13,
        Model: "sol",
        Progress: "🤖👍  🔁1️⃣2️⃣ 🔴 ",
      },
    };
    this.cards.push(card);
    return card;
  }
  service(migrations: Migration[] = [baseline]): BoardService {
    return new BoardService(
      this.config,
      new GitHubClient(
        this.config,
        { FAKE_TOKEN: "offline", XDG_STATE_HOME: this.state },
        this.deps
      ),
      this.deps,
      migrations,
      migrations.length
    );
  }
  done(): void {
    expect(this.unexpected).toEqual([]);
  }
  /** The vmethod repository itself: its lock root is the package, with no self-dependency. */
  pinSelf(repo: string, branch: string): void {
    this.files.set(
      `${repo}@${branch}:package-lock.json`,
      JSON.stringify({ packages: { "": { name: "@vworlds/vmethod", version: "0.0.0-dev" } } })
    );
    this.files.set(
      `${repo}@master:vmethod.yaml`,
      "baseBranch: dev\nbranches:\n  trackPrefix: track/\n  packPrefix: pack/\n"
    );
  }
  pin(repo: string, branch: string, version: string): void {
    this.files.set(
      `${repo}@${branch}:package-lock.json`,
      JSON.stringify({
        packages: {
          "": { devDependencies: { "@vworlds/vmethod": version } },
          "node_modules/@vworlds/vmethod": { version },
        },
      })
    );
    this.files.set(
      `${repo}@master:vmethod.yaml`,
      "baseBranch: dev\nbranches:\n  trackPrefix: track/\n  packPrefix: pack/\n"
    );
  }
}
