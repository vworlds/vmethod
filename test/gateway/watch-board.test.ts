import { expect, test } from "vitest";
import { Kind, parse, visit, type FieldNode } from "graphql";
import { GitHubClient } from "../../src/gateway/client.js";
import { WatchBoard } from "../../src/gateway/watch-board.js";
import { object, type ObjectData } from "../../src/gateway/people.js";
import { WatchFake } from "./watch-fake.js";

const activity = { issue: "", pr: "" };
const argument = (field: FieldNode, name: string): string => {
  const value = field.arguments?.find((arg) => arg.name.value === name)?.value;
  if (value?.kind !== Kind.INT && value?.kind !== Kind.STRING) {
    throw new Error(`Missing literal argument ${name}`);
  }
  return value.value;
};

/** Project the recorded watch card shapes through real GraphQL connection paging.
 * WatchFake.card owns the recording provenance; only list lengths/IDs are varied.
 */
class BoardAPI {
  fixture = new WatchFake();
  cards: ObjectData[] = [];
  requests: { size: number; cursor: unknown }[] = [];
  overflowBatches: number[] = [];
  invalidCursor = false;
  failOverflow = false;
  cost = 2;
  remaining = 5000;
  client = new GitHubClient(this.fixture.config, this.fixture.env, {
    ...this.fixture.deps,
    fetch: async (input, init) => {
      expect(String(input)).toBe("https://api.github.com/graphql");
      const { query, variables } = JSON.parse(String(init?.body));
      const document = parse(query);
      const operation = document.definitions[0];
      if (operation.kind !== Kind.OPERATION_DEFINITION) {
        throw new Error("Expected operation");
      }
      const connection = (field: FieldNode, source: ObjectData[]): ObjectData => {
        const size = Number(argument(field, "first"));
        const after = field.arguments?.find((arg) => arg.name.value === "after")?.value;
        const start = after?.kind === Kind.STRING ? Number(after.value) : 0;
        return {
          nodes: source.slice(start, start + size),
          pageInfo: { hasNextPage: start + size < source.length, endCursor: String(start + size) },
        };
      };
      let data: ObjectData;
      if (operation.name?.value === "WatchBoard") {
        let size = 0;
        const lists = new Map<string, FieldNode>();
        visit(document, {
          Field(field) {
            if (field.name.value === "items") {
              size = Number(argument(field, "first"));
            } else if (["labels", "blockedBy", "subIssues", "reviews"].includes(field.name.value)) {
              lists.set(field.name.value, field);
            }
          },
        });
        expect(size).toBeGreaterThanOrEqual(10);
        expect(size).toBeLessThanOrEqual(100);
        this.requests.push({ size, cursor: variables.cursor });
        const start = Number(variables.cursor);
        const cards = structuredClone(this.cards.slice(start, start + size));
        for (const card of cards) {
          const content = object(card.content);
          for (const [name, field] of lists) {
            if (name in content) {
              const original = object(content[name]);
              content[name] = { ...original, ...connection(field, original.nodes as ObjectData[]) };
            }
          }
        }
        data = {
          organization: {
            projectV2: {
              id: "project",
              readme: "board readme",
              items: {
                nodes: cards,
                pageInfo: {
                  hasNextPage: start + size < this.cards.length,
                  endCursor: this.invalidCursor ? "0" : String(start + size),
                },
              },
            },
          },
        };
      } else if (operation.name?.value === "WatchBoardLists") {
        if (this.failOverflow) {
          throw new Error("overflow unavailable");
        }
        data = {};
        let count = 0;
        for (const selection of operation.selectionSet.selections) {
          if (selection.kind !== Kind.FIELD || selection.name.value !== "node") {
            continue;
          }
          const id = argument(selection, "id");
          const content = object(
            this.cards.find((card) => object(card.content).id === id)?.content
          );
          visit(selection, {
            Field(field) {
              if (["labels", "blockedBy", "subIssues", "reviews"].includes(field.name.value)) {
                const source = object(content[field.name.value]).nodes as ObjectData[];
                data[selection.alias!.value] = { [field.name.value]: connection(field, source) };
                count++;
              }
            },
          });
        }
        this.overflowBatches.push(count);
      } else {
        throw new Error(`Unexpected query ${query}`);
      }
      this.remaining -= this.cost;
      return Response.json(
        { data: { ...data, rateLimit: { cost: this.cost } } },
        {
          headers: {
            "x-ratelimit-resource": "graphql",
            "x-ratelimit-remaining": String(this.remaining),
            "x-ratelimit-reset": String(this.fixture.clock / 1000 + 3600),
            "x-ratelimit-limit": "5000",
          },
        }
      );
    },
  });
  reader = new WatchBoard(this.client);

  populate(count: number): void {
    this.cards = Array.from({ length: count }, (_, index) => this.fixture.card(index + 1, "Done"));
  }
}

test("board growth reads the extra page, trains count plus ten, and shrinking lowers it", async () => {
  const api = new BoardAPI();
  api.populate(5);
  expect((await api.reader.read("example", 5, activity)).nodes).toHaveLength(5);
  expect(api.requests).toEqual([{ size: 10, cursor: null }]);
  expect(api.reader.pages).toBe(1);
  expect(api.reader.overflow).toBe(0);
  api.populate(16);
  expect((await api.reader.read("example", 5, activity)).nodes).toHaveLength(16);
  expect(api.requests.slice(1)).toEqual([
    { size: 15, cursor: null },
    { size: 15, cursor: "15" },
  ]);
  expect(api.reader.sizes.items).toBe(26);
  expect(api.reader.cost).toBe(4);
  expect(api.reader.pages).toBe(2);
  expect(api.reader.overflow).toBe(0);
  await api.reader.read("example", 5, activity);
  expect(api.requests.at(-1)).toEqual({ size: 26, cursor: null });
  expect(api.reader.cost).toBe(2);
  expect(api.reader.pages).toBe(1);
  expect(api.client.budget().resources.graphql.remaining).toBe(4992);
  api.populate(2);
  await api.reader.read("example", 5, activity);
  expect(api.reader.sizes.items).toBe(12);
  api.populate(0);
  await api.reader.read("example", 5, activity);
  expect(api.reader.sizes.items).toBe(10);
});

test("nested lists are completed in batches, sized to the largest plus margin, and shrink", async () => {
  const api = new BoardAPI();
  api.populate(2);
  api.cards[1] = api.fixture.card(2, "Done", "PullRequest");
  const issue = object(api.cards[0].content);
  const pr = object(api.cards[1].content);
  issue.labels = { nodes: Array.from({ length: 11 }, (_, i) => ({ name: `label-${i}` })) };
  issue.blockedBy = {
    totalCount: 12,
    nodes: Array.from({ length: 12 }, (_, i) => ({
      number: i + 1,
      state: "OPEN",
      repository: { nameWithOwner: "example/project" },
    })),
  };
  issue.subIssues = { nodes: Array.from({ length: 13 }, (_, i) => ({ id: `I${i}` })) };
  pr.reviews = {
    nodes: Array.from({ length: 14 }, (_, i) => ({
      id: `R${i}`,
      state: "APPROVED",
      commit: { oid: "head" },
      author: { __typename: "User", login: "owner", databaseId: 101 },
    })),
  };
  const result = await api.reader.read("example", 5, activity);
  expect(api.overflowBatches).toEqual([4]);
  expect(api.reader.pages).toBe(1);
  expect(api.reader.overflow).toBe(1);
  expect(api.reader.cost).toBe(4);
  expect(api.reader.sizes).toEqual({
    items: 12,
    labels: 21,
    blockedBy: 22,
    subIssues: 23,
    reviews: 24,
  });
  expect(object(object(result.nodes[0].content).blockedBy).nodes).toEqual(
    object(issue.blockedBy).nodes
  );
  expect(object(object(result.nodes[1].content).reviews).nodes).toEqual(object(pr.reviews).nodes);
  await api.reader.read("example", 5, activity);
  expect(api.overflowBatches).toEqual([4]);
  expect(api.reader.pages).toBe(1);
  expect(api.reader.overflow).toBe(0);
  expect(api.reader.cost).toBe(2);
  api.populate(1);
  await api.reader.read("example", 5, activity);
  expect(api.reader.sizes).toEqual({
    items: 11,
    labels: 10,
    blockedBy: 10,
    subIssues: 10,
    reviews: 10,
  });
});

test("page sizes cap at 100 and all cards above the cap are read", async () => {
  const api = new BoardAPI();
  api.populate(201);
  expect((await api.reader.read("example", 5, activity)).nodes).toHaveLength(201);
  expect(api.reader.sizes.items).toBe(100);
  api.requests = [];
  await api.reader.read("example", 5, activity);
  expect(api.requests).toEqual([
    { size: 100, cursor: null },
    { size: 100, cursor: "100" },
    { size: 100, cursor: "200" },
  ]);
});

test("full nested pages without successors do not trigger reads; oversized lists cap at 100", async () => {
  const api = new BoardAPI();
  api.populate(1);
  const issue = object(api.cards[0].content);
  issue.labels = { nodes: Array.from({ length: 10 }, (_, i) => ({ name: `L${i}` })) };
  await api.reader.read("example", 5, activity);
  expect(api.overflowBatches).toEqual([]);
  issue.labels = { nodes: Array.from({ length: 101 }, (_, i) => ({ name: `L${i}` })) };
  const result = await api.reader.read("example", 5, activity);
  expect(object(object(result.nodes[0].content).labels).nodes).toHaveLength(101);
  expect(api.reader.sizes.labels).toBe(100);
  api.overflowBatches = [];
  await api.reader.read("example", 5, activity);
  expect(api.overflowBatches).toEqual([1]);
});

test.each([
  { data: {}, message: "measured watcher query cost" },
  { data: { rateLimit: { cost: 1 } }, message: "Missing board project" },
  {
    data: { rateLimit: { cost: 1 }, organization: { projectV2: { id: "project" } } },
    message: "board connection",
  },
])("invalid responses fail visibly: $message", async ({ data, message }) => {
  const api = new BoardAPI();
  const client = new GitHubClient(api.fixture.config, api.fixture.env, {
    ...api.fixture.deps,
    fetch: async () => Response.json({ data }),
  });
  await expect(new WatchBoard(client).read("example", 5, activity)).rejects.toThrow(message);
});

test("cursor loops and overflow failures refuse partial snapshots and do not train sizes", async () => {
  const api = new BoardAPI();
  api.populate(11);
  api.invalidCursor = true;
  await expect(api.reader.read("example", 5, activity)).rejects.toThrow("pagination cursor");
  expect(api.reader.sizes.items).toBe(10);
  api.invalidCursor = false;
  api.populate(1);
  object(api.cards[0].content).labels = {
    nodes: Array.from({ length: 11 }, () => ({ name: "label" })),
  };
  api.failOverflow = true;
  await expect(api.reader.read("example", 5, activity)).rejects.toThrow("network request failed");
  expect(api.reader.sizes.labels).toBe(10);
  expect(api.reader.cost).toBe(2);
});
